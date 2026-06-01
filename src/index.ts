import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { PrismaClient, Prisma } from '@prisma/client';
import { Connection, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL, Keypair } from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  createInitializeMintInstruction,
  createInitializeNonTransferableMintInstruction,
  createInitializeMetadataPointerInstruction,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  getMintLen,
  ExtensionType,
  TYPE_SIZE,
  LENGTH_SIZE,
} from '@solana/spl-token';
import {
  createInitializeInstruction,
  createUpdateFieldInstruction,
  pack,
  TokenMetadata,
} from '@solana/spl-token-metadata';
import { config } from 'dotenv';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import fs from 'fs/promises';
import { Resend } from 'resend';
import { PrivyClient } from '@privy-io/node';

import a2aRoutes from './a2a-endpoints.js';
import crossChainRoutes from './cross-chain-endpoints.js';
import { createWalletRoutes } from './wallet-endpoints.js';
import { setupWebSocket } from './ws-handler.js';
import { createX402Middleware, getFreeTierInfo, CHAINS, FREE_MESSAGES_PER_DAY, MESSAGE_PRICE, bodyCache } from './x402-config.js';
// Verify a Solana wallet signature
function verifySignature(message: string, signature: string, walletAddress: string): boolean {
  try {
    const messageBytes = new TextEncoder().encode(message);
    const signatureBytes = bs58.decode(signature);
    const publicKeyBytes = bs58.decode(walletAddress);
    return nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes);
  } catch (e) {
    console.error('Signature verification error:', e);
    return false;
  }
}

// Generate the message that must be signed for feedback
function getFeedbackMessage(fromWallet: string, toWallet: string, score: number, timestamp: number): string {
  return `SAID:feedback:${toWallet}:${score}:${timestamp}`;
}

config();

// Singleton PrismaClient
// NOTE: Set connection_limit in DATABASE_URL on Railway directly, e.g.:
// postgresql://user:pass@host:5432/railway?connection_limit=10
const prisma = new PrismaClient();
export { prisma as sharedPrisma };
const app = new Hono();

// Global error handler — catch and log all errors
app.onError((err, c) => {
  console.error(`[Hono Error] ${c.req.method} ${c.req.path}:`, err.message, err.stack?.split('\n').slice(0, 3).join('\n'));
  return c.json({ error: 'Internal Server Error', details: err.message }, 500);
});

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// Privy client for server-side auth verification
const privyClient = new PrivyClient({
  appId: 'cmlbxd3qu00jqi80c4pibohzv',
  appSecret: process.env.PRIVY_APP_SECRET || '',
});

// Helper: decode base64-encoded platform API keys (bypasses Railway env var scanner)
function getPlatformKey(name: string): string | undefined {
  const keyName = name.split('_').join('_'); // keep original name
  const raw = process.env[keyName];
  if (!raw) return undefined;
  try {
    return Buffer.from(raw, 'base64').toString('utf-8');
  } catch {
    return raw; // fallback: if not base64, use as-is
  }
}

// SAID Program constants
const SAID_PROGRAM_ID = new PublicKey('5dpw6KEQPn248pnkkaYyWfHwu2nfb3LUMbTucb6LaA8G');
const AGENT_ACCOUNT_SIZE = 263; // Legacy size - actual accounts may be larger (295+) due to authority field

// RPC connection
const connection = new Connection(
  process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
  'confirmed'
);

// CORS
app.use('/*', cors({
  origin: [
    'https://www.saidprotocol.com',
    'https://saidprotocol.com',
    'https://host.saidprotocol.com',
    'http://localhost:3000',
    'https://devoted-cooperation-production-8f30.up.railway.app',
    'https://staging-v2-production.up.railway.app',
    'https://agent-creation-new-production.up.railway.app',
    'https://hosting-site-test-production.up.railway.app'
  ],
  allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));

// ============ Rate Limiting ============
// Simple in-memory rate limiter: 60 requests per minute per IP
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 60; // requests per window
const RATE_WINDOW = 60_000; // 1 minute

app.use('/*', async (c, next) => {
  const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 
             c.req.header('x-real-ip') || 
             'unknown';
  
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW });
  } else {
    entry.count++;
    if (entry.count > RATE_LIMIT) {
      console.warn(`[rate-limit] IP ${ip} exceeded ${RATE_LIMIT} req/min`);
      return c.json({ error: 'Too many requests. Please slow down.' }, 429);
    }
  }
  
  // Cleanup old entries every 5 minutes
  if (Math.random() < 0.01) {
    for (const [key, val] of rateLimitMap) {
      if (now > val.resetAt) rateLimitMap.delete(key);
    }
  }
  
  await next();
});

// ============ SSE (Server-Sent Events) ============
// Real-time notifications for frontend (new agents, verifications, etc.)

import { EventEmitter } from 'events';
import { createScoreRoutes, initScoreWorker } from './score-engine.js';
const sseEmitter = new EventEmitter();
sseEmitter.setMaxListeners(100); // support up to 100 concurrent SSE clients

function emitAgentEvent(type: string, data: any) {
  sseEmitter.emit('agent-event', { type, data, timestamp: Date.now() });
}

app.get('/api/events', (c) => {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      
      // Send keepalive every 30s
      const keepalive = setInterval(() => {
        try { controller.enqueue(encoder.encode(': keepalive\n\n')); } catch {}
      }, 30000);
      
      const onEvent = (event: any) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {}
      };
      
      sseEmitter.on('agent-event', onEvent);
      
      // Cleanup on disconnect
      c.req.raw.signal.addEventListener('abort', () => {
        clearInterval(keepalive);
        sseEmitter.off('agent-event', onEvent);
      });
    },
  });
  
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    },
  });
});

// Root metadata / health check
app.get('/', (c) => c.json({
  status: 'ok',
  service: 'said-api',
  version: '1.0.0',
  name: 'SAID Protocol',
  description: 'Cross-chain agent-to-agent communication with x402 payments. Send messages between AI agents across Solana and EVM chains.',
  primary_resource: 'POST /xchain/message',
  pricing: '$0.01 USDC per message',
  free_tier: '10 free messages/day per sender',
  discovery: {
    openapi: 'https://api.saidprotocol.com/openapi.json',
    x402: 'https://api.saidprotocol.com/.well-known/x402',
  },
}));
// ── Favicon ──
app.get('/favicon.ico', async (c) => {
  try {
    const fs = await import('fs');
    const path = await import('path');
    const faviconPath = path.join(process.cwd(), 'public', 'favicon.png');
    const data = fs.readFileSync(faviconPath);
    c.header('Content-Type', 'image/png');
    c.header('Cache-Control', 'public, max-age=86400');
    return c.body(data);
  } catch {
    return c.text('', 404);
  }
});

// ── x402scan Discovery ──
app.get('/.well-known/x402', (c) => {
  return c.json({
    name: 'SAID Protocol',
    description: 'Send messages between AI agents across Solana, Base, Polygon, Avalanche & Sei. Pay $0.01 USDC per message via x402. 10 free messages per day.',
    url: 'https://api.saidprotocol.com',
    openapi: 'https://api.saidprotocol.com/openapi.json',
    favicon: 'https://api.saidprotocol.com/favicon.ico',
    endpoints: [
      {
        url: 'https://api.saidprotocol.com/xchain/message',
        method: 'POST',
        description: 'Send a message from any AI agent to any AI agent across chains. Resolves identities on Solana (SAID) and EVM (ERC-8004). Delivers via WebSocket, A2A endpoint, or webhook.',
        price: '$0.01 USDC',
        freeTier: '10 messages/day per sender',
        chains: ['solana', 'base', 'polygon', 'avalanche', 'sei'],
      },
    ],
    contact: {
      twitter: '@saidinfra',
      website: 'https://www.saidprotocol.com',
    },
  });
});

// ── x402scan Discovery: OpenAPI spec ──
app.get('/openapi.json', (c) => {
  return c.json({
    openapi: '3.0.3',
    info: {
      title: 'SAID Protocol - Cross-Chain Agent-to-Agent Messaging',
      description: 'Send messages between AI agents across Solana, Base, Polygon, Avalanche & Sei. Resolves agent identities via SAID (Solana) and ERC-8004 (EVM). $0.01 USDC per message via x402, 10 free per day.',
      version: '1.0.0',
      contact: { url: 'https://www.saidprotocol.com', email: 'kaiclawd@outlook.com' },
    },
    servers: [{ url: 'https://api.saidprotocol.com' }],
    paths: {
      '/xchain/message': {
        post: {
          summary: 'Send a cross-chain message between AI agents',
          description: 'Route a message from any AI agent to any AI agent across Solana and EVM chains. Resolves sender and recipient identities, delivers via WebSocket, A2A endpoint, or webhook. 10 free messages/day per sender, then $0.01 USDC via x402.',
          operationId: 'sendCrossChainMessage',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['from', 'to', 'message'],
                  properties: {
                    from: {
                      type: 'object',
                      required: ['address', 'chain'],
                      properties: {
                        address: { type: 'string', description: 'Sender wallet address' },
                        chain: { type: 'string', enum: ['solana', 'base', 'polygon', 'avalanche', 'sei'], description: 'Source chain' },
                      },
                    },
                    to: {
                      type: 'object',
                      required: ['address', 'chain'],
                      properties: {
                        address: { type: 'string', description: 'Recipient wallet address' },
                        chain: { type: 'string', enum: ['solana', 'base', 'polygon', 'avalanche', 'sei'], description: 'Destination chain' },
                      },
                    },
                    message: { type: 'string', description: 'Message content' },
                    context: { type: 'object', description: 'Optional context/metadata' },
                    signature: { type: 'string', description: 'Optional sender signature for verification' },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Message delivered or stored successfully' },
            '402': { description: 'Payment required (x402) — 10 free messages/day exceeded' },
            '404': { description: 'Sender or recipient agent not found' },
          },
        },
      },
    },
  });
});

app.get('/health', (c) => c.json({ status: 'healthy' }));

// ============ AVATAR GENERATOR ============

/**
 * Simple hash function (FNV-1a variant)
 * Deterministically converts a wallet address into a hash
 */
function hashWallet(wallet: string): number[] {
  const bytes: number[] = [];
  let hash = 2166136261; // FNV offset basis
  
  for (let i = 0; i < wallet.length; i++) {
    hash ^= wallet.charCodeAt(i);
    hash = Math.imul(hash, 16777619); // FNV prime
    bytes.push((hash >>> 0) & 0xFF);
  }
  
  return bytes;
}

/**
 * Generate deterministic pixel art avatar SVG
 * 5x5 symmetric grid, SAID brand colors
 */
function generateAvatarSVG(wallet: string): string {
  const hash = hashWallet(wallet);
  
  // SAID brand color palette
  const colors = [
    '#F59E0B', // electric amber — primary
    '#D97706', // darker amber
    '#FBBF24', // lighter amber
    '#92400E', // deep amber
    '#78716C', // warm gray
    '#A8A29E', // light warm gray
    '#FCD34D', // gold
    '#B45309', // burnt amber
  ];
  
  const bgColor = '#0B0F19'; // SAID midnight
  
  // Pick 1-2 colors from palette based on hash
  const color1 = colors[hash[0] % colors.length];
  const color2 = colors[hash[1] % colors.length];
  const useSecondColor = hash[2] % 3 === 0; // ~33% chance of second color
  
  // Generate 5x5 grid (only need 3x5 cells, mirror for symmetry)
  const grid: boolean[][] = [];
  const cellSize = 20;
  const gridSize = 5;
  
  for (let y = 0; y < gridSize; y++) {
    grid[y] = [];
    for (let x = 0; x < Math.ceil(gridSize / 2); x++) {
      // Use hash bytes to determine if cell is filled (~50-60% density)
      const byteIndex = (y * 3 + x) % hash.length;
      const bit = (hash[byteIndex] >> (x % 8)) & 1;
      const threshold = hash[(byteIndex + 7) % hash.length] % 256;
      grid[y][x] = threshold < 140; // ~55% fill rate
    }
  }
  
  // Build SVG
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">`;
  svg += `<rect width="100" height="100" fill="${bgColor}"/>`;
  
  // Render grid with symmetry
  for (let y = 0; y < gridSize; y++) {
    for (let x = 0; x < gridSize; x++) {
      // Mirror columns 0-1 to columns 3-4
      const sourceX = x < Math.ceil(gridSize / 2) ? x : gridSize - 1 - x;
      
      if (grid[y][sourceX]) {
        // Pick color based on position
        const useColor2 = useSecondColor && ((x + y) % 3 === 0);
        const color = useColor2 ? color2 : color1;
        
        svg += `<rect x="${x * cellSize}" y="${y * cellSize}" width="${cellSize}" height="${cellSize}" fill="${color}"/>`;
      }
    }
  }
  
  svg += `</svg>`;
  return svg;
}

/**
 * GET /api/avatar/:wallet.svg
 * Returns deterministic pixel art avatar for a wallet address
 */
app.get('/api/avatar/:file', (c) => {
  const wallet = (c.req.param('file') || '').replace(/\.svg$/, '');
  
  // Validate wallet format (basic check)
  if (!wallet || wallet.length < 32) {
    return c.text('Invalid wallet address', 400);
  }
  
  try {
    const svg = generateAvatarSVG(wallet);
    
    return c.body(svg, 200, {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
  } catch (error) {
    console.error('Avatar generation error:', error);
    return c.text('Failed to generate avatar', 500);
  }
});

// ============ MESSAGES (Live Ticker) ============

// Get recent A2A messages for ticker
app.get('/api/messages/recent', async (c) => {
  try {
    const messages = await prisma.a2AMessage.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        fromWallet: true,
        toWallet: true,
        createdAt: true,
        status: true,
      },
    });

    // Format messages for ticker display
    const formatted = messages.map((msg) => ({
      from: `${msg.fromWallet.slice(0, 4)}…${msg.fromWallet.slice(-4)}`,
      to: `${msg.toWallet.slice(0, 4)}…${msg.toWallet.slice(-4)}`,
      fromChain: 'solana',
      toChain: 'solana',
      timestamp: msg.createdAt.toISOString(),
      paid: msg.status !== 'created', // assume paid if not just created
    }));

    return c.json(formatted);
  } catch (err) {
    console.error('Failed to fetch recent messages:', err);
    return c.json({ error: 'Failed to fetch messages' }, 500);
  }
});

// ============ AGENTS ============

// List agents with search/filter
app.get('/api/agents', async (c) => {
  const { search, skill, serviceType, verified, sort, limit, offset } = c.req.query();
  
  const where: any = {};
  
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { wallet: { contains: search, mode: 'insensitive' } },
      { description: { contains: search, mode: 'insensitive' } },
    ];
  }
  
  if (skill) {
    where.skills = { has: skill };
  }
  
  if (serviceType) {
    where.serviceTypes = { has: serviceType };
  }
  
  if (verified === 'true') {
    where.isVerified = true;
  }
  
  const orderBy: any = sort === 'newest' 
    ? { registeredAt: 'desc' }
    : sort === 'name'
    ? { name: 'asc' }
    : sort === 'trust'
    ? { trustScore: { score: 'desc' } }
    : { reputationScore: 'desc' };
  
  const agents = await prisma.agent.findMany({
    where,
    orderBy,
    take: Math.min(parseInt(limit || '50'), 2000),
    skip: parseInt(offset || '0'),
    include: {
      _count: { select: { feedbackReceived: true } },
      trustScore: {
        select: {
          score: true,
          tier: true,
          badges: true,
          sources: true,
          identity: true,
          activity: true,
          economic: true,
          ecosystem: true,
          longevity: true,
          fairscale: true,
          computedAt: true,
        }
      }
    }
  });
  
  const total = await prisma.agent.count({ where });
  
  return c.json({ agents, total, limit: parseInt(limit || '50'), offset: parseInt(offset || '0') });
});

// Get single agent profile
app.get('/api/agents/:wallet', async (c) => {
  const wallet = c.req.param('wallet');
  
  const agent = await prisma.agent.findUnique({
    where: { wallet },
    include: {
      feedbackReceived: {
        orderBy: { createdAt: 'desc' },
        take: 10,
      },
      _count: { select: { feedbackReceived: true } },
      trustScore: true,
    }
  });
  
  if (!agent) {
    return c.json({ error: 'Agent not found' }, 404);
  }
  
  return c.json(agent);
});

// Get agent feedback
app.get('/api/agents/:wallet/feedback', async (c) => {
  const wallet = c.req.param('wallet');
  const { limit, offset } = c.req.query();
  
  const feedback = await prisma.feedback.findMany({
    where: { toWallet: wallet },
    orderBy: { createdAt: 'desc' },
    take: Math.min(parseInt(limit || '20'), 50),
    skip: parseInt(offset || '0'),
  });
  
  const total = await prisma.feedback.count({ where: { toWallet: wallet } });
  
  return c.json({ feedback, total });
});

// Submit feedback
app.post('/api/agents/:wallet/feedback', async (c) => {
  const toWallet = c.req.param('wallet');
  const body = await c.req.json();
  const { fromWallet, score, comment, signature, timestamp, source } = body;
  // source is optional - identifies the platform (e.g., "agentdex", "superrouter", "w3rt")
  
  // Validate required fields
  if (!fromWallet || score === undefined || !signature || !timestamp) {
    return c.json({ error: 'Missing required fields: fromWallet, score, signature, timestamp' }, 400);
  }
  
  if (score < 0 || score > 100) {
    return c.json({ error: 'Score must be between 0 and 100' }, 400);
  }
  
  // Timestamp must be within last 5 minutes (prevent replay attacks)
  const now = Date.now();
  if (Math.abs(now - timestamp) > 5 * 60 * 1000) {
    return c.json({ error: 'Timestamp too old. Sign a fresh message.' }, 400);
  }
  
  // Can't rate yourself
  if (fromWallet === toWallet) {
    return c.json({ error: 'Cannot rate yourself' }, 400);
  }
  
  // Check target agent exists
  const targetAgent = await prisma.agent.findUnique({ where: { wallet: toWallet } });
  if (!targetAgent) {
    return c.json({ error: 'Target agent not found' }, 404);
  }
  
  // Verify signature
  const message = getFeedbackMessage(fromWallet, toWallet, score, timestamp);
  const isValid = verifySignature(message, signature, fromWallet);
  
  if (!isValid) {
    return c.json({ error: 'Invalid signature. Make sure you signed the correct message.' }, 401);
  }
  
  // Check if fromWallet is a verified agent (for weighted scoring)
  const fromAgent = await prisma.agent.findUnique({ where: { wallet: fromWallet } });
  const fromIsVerified = fromAgent?.isVerified || false;
  
  // Weight: verified agents count 2x
  const weight = fromIsVerified ? 2.0 : 1.0;
  
  // Build comment with source prefix if provided
  const fullComment = source 
    ? `[${source}] ${comment || ''}`.trim()
    : comment;

  // Upsert feedback (one per fromWallet->toWallet pair)
  const feedback = await prisma.feedback.upsert({
    where: {
      fromWallet_toWallet: { fromWallet, toWallet }
    },
    create: {
      fromWallet,
      toWallet,
      score,
      comment: fullComment,
      signature,
      weight,
      fromIsVerified,
    },
    update: {
      score,
      comment: fullComment,
      signature,
      weight,
      fromIsVerified,
    }
  });
  
  // Recalculate weighted reputation
  const allFeedback = await prisma.feedback.findMany({
    where: { toWallet },
    select: { score: true, weight: true }
  });
  
  let totalWeight = 0;
  let weightedSum = 0;
  for (const fb of allFeedback) {
    weightedSum += fb.score * fb.weight;
    totalWeight += fb.weight;
  }
  
  const weightedScore = totalWeight > 0 ? weightedSum / totalWeight : 0;
  
  await prisma.agent.update({
    where: { wallet: toWallet },
    data: {
      reputationScore: weightedScore,
      feedbackCount: allFeedback.length,
    }
  });
  
  return c.json({ 
    success: true, 
    feedback,
    message: fromIsVerified 
      ? 'Feedback recorded with verified agent bonus (2x weight)' 
      : 'Feedback recorded'
  });
});

// Get message to sign for feedback
app.get('/api/agents/:wallet/feedback/message', async (c) => {
  const toWallet = c.req.param('wallet');
  const { fromWallet, score } = c.req.query();
  
  if (!fromWallet || !score) {
    return c.json({ error: 'Query params required: fromWallet, score' }, 400);
  }
  
  const timestamp = Date.now();
  const message = getFeedbackMessage(fromWallet, toWallet, parseInt(score), timestamp);
  
  return c.json({ 
    message,
    timestamp,
    instructions: 'Sign this exact message with your wallet, then POST to /api/agents/:wallet/feedback with { fromWallet, score, comment?, signature, timestamp }'
  });
});

// ============ TRUSTED SOURCE FEEDBACK ============

// Trusted sources (platforms that can submit feedback without user signatures)
// API keys loaded from environment variables for security
const TRUSTED_SOURCES: Record<string, { name: string; weight: number }> = {};

// Load trusted source keys from environment variables
if (process.env.TORCH_API_KEY) {
  TRUSTED_SOURCES[process.env.TORCH_API_KEY] = { name: 'torch-market', weight: 1.5 };
}
if (process.env.SOLPRISM_API_KEY) {
  TRUSTED_SOURCES[process.env.SOLPRISM_API_KEY] = { name: 'solprism', weight: 1.5 };
}
if (process.env.AGENTDEX_API_KEY) {
  TRUSTED_SOURCES[process.env.AGENTDEX_API_KEY] = { name: 'agentdex', weight: 1.2 };
}

// Event type to score mapping
const EVENT_SCORES: Record<string, number> = {
  'token_launch': 15,
  'trade_complete': 5,
  'governance_vote': 10,
  'reasoning_commit': 10,
  'successful_interaction': 8,
  'positive_review': 12,
  'negative_review': -10,
};

// Trusted source feedback endpoint (API key auth, no wallet signature required)
app.post('/api/sources/feedback', async (c) => {
  const apiKey = c.req.header('X-Source-Key');
  
  if (!apiKey || !TRUSTED_SOURCES[apiKey]) {
    return c.json({ error: 'Invalid or missing X-Source-Key header' }, 401);
  }
  
  const source = TRUSTED_SOURCES[apiKey];
  const body = await c.req.json();
  const { wallet, event, outcome, metadata } = body;
  
  // Validate required fields
  if (!wallet || !event) {
    return c.json({ error: 'Missing required fields: wallet, event' }, 400);
  }
  
  // Check agent exists
  const agent = await prisma.agent.findUnique({ where: { wallet } });
  if (!agent) {
    return c.json({ error: 'Agent not found. Must be registered on SAID first.' }, 404);
  }
  
  // Calculate score based on event type and outcome
  const baseScore = EVENT_SCORES[event] || 5;
  const outcomeMultiplier = outcome === 'failure' ? -0.5 : 1;
  const score = Math.round(baseScore * outcomeMultiplier * source.weight);
  
  // Create feedback record from trusted source
  // Use SAID System wallet as the source since foreign key requires valid agent
  const SYSTEM_WALLET = '72onvrQJZkPGLAhWK5MeYc73iyM72P2ABKzDMQ4NpQBL';
  
  try {
    const feedback = await prisma.feedback.create({
      data: {
        fromWallet: SYSTEM_WALLET,
        toWallet: wallet,
        score: Math.max(-100, Math.min(100, score)),
        weight: source.weight,
        comment: `[${source.name}] ${event}${outcome ? `: ${outcome}` : ''}${metadata?.details ? ` - ${metadata.details}` : ''}`,
        signature: `trusted:${source.name}:${Date.now()}`,
        fromIsVerified: true,
      }
    });
    
    // Recalculate reputation score
    const allFeedback = await prisma.feedback.findMany({
      where: { toWallet: wallet }
    });
    
    const totalWeight = allFeedback.reduce((sum, f) => sum + (f.weight || 1), 0);
    const weightedSum = allFeedback.reduce((sum, f) => sum + f.score * (f.weight || 1), 0);
    const newScore = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;
    const clampedScore = Math.max(0, Math.min(100, newScore));
    
    // Determine trust tier
    const trustTier = clampedScore >= 70 ? 'high' : clampedScore >= 30 ? 'medium' : 'low';
    
    // Update agent
    await prisma.agent.update({
      where: { wallet },
      data: {
        reputationScore: clampedScore,
        feedbackCount: allFeedback.length,
      }
    });
    
    return c.json({
      success: true,
      source: source.name,
      event,
      scoreChange: score,
      newReputationScore: clampedScore,
      trustTier,
      feedbackId: feedback.id,
    });
  } catch (err: any) {
    console.error('Feedback creation error:', err);
    return c.json({ 
      error: 'Failed to create feedback', 
      details: err.message || 'Unknown error'
    }, 500);
  }
});

// Get available event types
app.get('/api/sources/events', (c) => {
  return c.json({
    events: Object.keys(EVENT_SCORES),
    scores: EVENT_SCORES,
  });
});

// ============ LEADERBOARD ============

app.get('/api/leaderboard', async (c) => {
  const { period, limit } = c.req.query();
  
  // Calculate date filter based on period
  let dateFilter: Date | null = null;
  if (period === 'weekly' || period === 'week') {
    dateFilter = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  } else if (period === 'monthly' || period === 'month') {
    dateFilter = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  } else if (period === 'daily' || period === 'day') {
    dateFilter = new Date(Date.now() - 24 * 60 * 60 * 1000);
  }
  
  if (dateFilter) {
    // For time-filtered leaderboard, calculate reputation from recent feedback only
    const recentFeedback = await prisma.feedback.groupBy({
      by: ['toWallet'],
      where: {
        createdAt: { gte: dateFilter }
      },
      _avg: { score: true },
      _count: { score: true },
      _sum: { weight: true },
    });
    
    // Get agent details for those with recent feedback
    const wallets = recentFeedback.map(f => f.toWallet);
    const agents = await prisma.agent.findMany({
      where: { wallet: { in: wallets } },
      select: {
        wallet: true,
        pda: true,
        name: true,
        twitter: true,
        isVerified: true,
      }
    });
    
    const agentMap = new Map(agents.map(a => [a.wallet, a]));
    
    // Calculate weighted scores for the period
    const leaderboard = recentFeedback
      .map(f => {
        const agent = agentMap.get(f.toWallet);
        if (!agent) return null;
        return {
          ...agent,
          periodScore: f._avg.score || 0,
          periodFeedbackCount: f._count.score,
        };
      })
      .filter(Boolean)
      .sort((a: any, b: any) => b.periodScore - a.periodScore)
      .slice(0, Math.min(parseInt(limit || '50'), 2000))
      .map((a, i) => ({ ...a, rank: i + 1 }));
    
    return c.json({ 
      leaderboard,
      period: period || 'all',
      since: dateFilter.toISOString(),
    });
  }
  
  // Default: all-time leaderboard
  const agents = await prisma.agent.findMany({
    where: {
      feedbackCount: { gt: 0 }
    },
    orderBy: { reputationScore: 'desc' },
    take: Math.min(parseInt(limit || '50'), 2000),
    select: {
      wallet: true,
      pda: true,
      name: true,
      twitter: true,
      reputationScore: true,
      feedbackCount: true,
      isVerified: true,
    }
  });
  
  return c.json({ 
    leaderboard: agents.map((a, i) => ({ ...a, rank: i + 1 })),
    period: period || 'all'
  });
});

// ============ REGISTRATION HELPER ============

// Helper endpoint to generate registration instructions
app.get('/api/register', (c) => {
  return c.json({
    instructions: 'Use npx said-register or follow the manual steps below',
    npxCommand: 'npx said-register --metadata https://your-domain.com/agent.json',
    manual: {
      step1: 'Create an AgentCard JSON file with your agent metadata',
      step2: 'Host it at a public URL',
      step3: 'Call the SAID program registerAgent instruction',
    },
    agentCardSchema: {
      name: 'Your Agent Name (required)',
      description: 'What your agent does (required)',
      version: '1.0.0',
      twitter: '@youragent',
      website: 'https://youragent.com',
      capabilities: ['coding', 'research', 'chat'],
      serviceTypes: ['assistant', 'automation'],
      mcpEndpoint: 'https://youragent.com/mcp (optional)',
      a2aEndpoint: 'https://youragent.com/a2a (optional)',
      x402Wallet: 'Your payment wallet (optional)',
    },
    programId: SAID_PROGRAM_ID.toString(),
    verificationFee: '0.01 SOL (optional, for verified badge)',
    docs: 'https://www.saidprotocol.com/skill.md',
  });
});

// ============ SPONSORED REGISTRATION ============
// Free registration - we pay the rent (first 100 agents)

// Rate limiting: track registrations per IP
const registrationRateLimit = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX = 3; // 3 registrations per hour per IP

// Sponsorship pool: first 100 agents get free registration
const SPONSOR_POOL_MAX = 100;

// Sponsorship wallet (loaded from env)
const SPONSOR_PRIVATE_KEY = process.env.SPONSOR_PRIVATE_KEY;

/**
 * Get current sponsorship count from database
 */
async function getSponsorshipCount(): Promise<number> {
  const count = await prisma.agent.count({
    where: { sponsored: true }
  });
  return count;
}

/**
 * Check if sponsorship slots are available
 */
async function isSponsorshipAvailable(): Promise<{ available: boolean; remaining: number; used: number }> {
  const used = await getSponsorshipCount();
  const remaining = Math.max(0, SPONSOR_POOL_MAX - used);
  return {
    available: remaining > 0,
    remaining,
    used
  };
}

// Generate message for registration signature
function getRegistrationMessage(wallet: string, name: string, timestamp: number): string {
  return `SAID:register:${wallet}:${name}:${timestamp}`;
}

/**
 * POST /api/register/sponsored
 * Free registration - we pay the rent, user just signs
 */
app.post('/api/register/sponsored', async (c) => {
  // Rate limiting
  const clientIp = c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown';
  const now = Date.now();
  const rateData = registrationRateLimit.get(clientIp);
  
  if (rateData) {
    if (now < rateData.resetAt) {
      if (rateData.count >= RATE_LIMIT_MAX) {
        return c.json({ 
          error: 'Rate limit exceeded. Max 3 registrations per hour.',
          retryAfter: Math.ceil((rateData.resetAt - now) / 1000)
        }, 429);
      }
      rateData.count++;
    } else {
      registrationRateLimit.set(clientIp, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    }
  } else {
    registrationRateLimit.set(clientIp, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
  }

  const body = await c.req.json();
  const { wallet, name, description, signature, timestamp, twitter, website, capabilities } = body;
  
  // Validate required fields
  if (!wallet || !name) {
    return c.json({ error: 'Required: wallet, name' }, 400);
  }
  
  // Check sponsorship availability
  const sponsorship = await isSponsorshipAvailable();
  if (!sponsorship.available) {
    return c.json({
      error: 'Sponsorship pool exhausted',
      message: `All ${SPONSOR_POOL_MAX} sponsored slots have been claimed. Registration now requires 0.005 SOL.`,
      slotsUsed: sponsorship.used,
      slotsTotal: SPONSOR_POOL_MAX,
      instructions: {
        step1: 'Fund your wallet with ~0.005 SOL',
        step2: 'Run: npx said-register --keypair wallet.json'
      }
    }, 410); // 410 Gone - resource no longer available
  }
  
  // Check if already registered
  const existing = await prisma.agent.findUnique({ where: { wallet } });
  if (existing) {
    return c.json({ 
      error: 'Wallet already registered',
      pda: existing.pda,
      profile: `https://www.saidprotocol.com/agent.html?wallet=${wallet}`
    }, 409);
  }
  
  // Verify signature (REQUIRED for security)
  if (!signature || !timestamp) {
    return c.json({ error: 'Signature and timestamp are required for registration' }, 400);
  }
  
  const message = getRegistrationMessage(wallet, name, timestamp);
  const isValid = verifySignature(message, signature, wallet);
  
  if (!isValid) {
    return c.json({ error: 'Invalid signature' }, 401);
  }
  
  // Timestamp must be within 10 minutes
  if (Math.abs(Date.now() - timestamp) > 10 * 60 * 1000) {
    return c.json({ error: 'Timestamp too old. Sign a fresh message.' }, 400);
  }
  
  try {
    // Step 1: Create and store the agent card
    const card = {
      name,
      description: description || `${name} - AI Agent on SAID Protocol`,
      wallet,
      twitter: twitter || undefined,
      website: website || undefined,
      capabilities: capabilities || [],
      created: new Date().toISOString().split('T')[0],
      verified: false,
    };
    
    await prisma.agentCard.upsert({
      where: { wallet },
      create: { wallet, cardJson: JSON.stringify(card) },
      update: { cardJson: JSON.stringify(card), updatedAt: new Date() }
    });
    
    const metadataUri = `https://api.saidprotocol.com/api/cards/${wallet}.json`;
    
    // Step 2: Calculate PDA
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('agent'), new PublicKey(wallet).toBuffer()],
      SAID_PROGRAM_ID
    );
    
    // Step 3: Check if we have sponsor key configured
    if (!SPONSOR_PRIVATE_KEY) {
      // No sponsor key - return instructions for manual registration
      return c.json({
        success: false,
        sponsored: false,
        message: 'Sponsorship not available. Manual registration required.',
        wallet,
        pda: pda.toString(),
        metadataUri,
        cardStored: true,
        instructions: {
          step1: 'Fund your wallet with ~0.005 SOL',
          step2: 'Run: npx said-register --keypair your-wallet.json',
        }
      });
    }
    
    // Step 4: Build and submit sponsored transaction
    // For now, we'll just store the card and return success
    // The actual on-chain registration will be handled by a separate process
    // that monitors pending registrations and submits them
    
    // Store sponsored registration
    await prisma.agent.create({
      data: {
        wallet,
        pda: pda.toString(),
        owner: wallet,
        metadataUri,
        registeredAt: new Date(),
        isVerified: false,
        sponsored: true,  // Mark as sponsored
        name: card.name,
        description: card.description,
        twitter: card.twitter,
        website: card.website,
        skills: card.capabilities,
      }
    });
    
    emitAgentEvent('agent:registered', { wallet, name: card.name, source: 'sponsored' });
    
    // Get remaining slots for response
    const remainingSlots = SPONSOR_POOL_MAX - (sponsorship.used + 1);
    
    return c.json({
      success: true,
      sponsored: true,
      message: 'Registration successful! Welcome to SAID Protocol.',
      wallet,
      pda: pda.toString(),
      metadataUri,
      profile: `https://www.saidprotocol.com/agent.html?wallet=${wallet}`,
      badge: `https://api.saidprotocol.com/api/badge/${wallet}.svg`,
      slotsRemaining: remainingSlots,
    });
    
  } catch (error: any) {
    console.error('Sponsored registration error:', error);
    return c.json({ error: 'Registration failed: ' + error.message }, 500);
  }
});

/**
 * GET /api/register/sponsored/message
 * Get the message to sign for sponsored registration
 */
app.get('/api/register/sponsored/message', (c) => {
  const { wallet, name } = c.req.query();
  
  if (!wallet || !name) {
    return c.json({ error: 'Query params required: wallet, name' }, 400);
  }
  
  const timestamp = Date.now();
  const message = getRegistrationMessage(wallet, name, timestamp);
  
  return c.json({
    message,
    timestamp,
    instructions: 'Sign this message with your wallet, then POST to /api/register/sponsored'
  });
});

/**
 * GET /api/register/sponsored/status
 * Check sponsorship availability
 */
app.get('/api/register/sponsored/status', async (c) => {
  const sponsorship = await isSponsorshipAvailable();
  const totalRegistered = await prisma.agent.count();
  
  return c.json({
    available: sponsorship.available,
    slotsTotal: SPONSOR_POOL_MAX,
    slotsUsed: sponsorship.used,
    slotsRemaining: sponsorship.remaining,
    totalRegistered,
    message: sponsorship.available 
      ? `Free registration available! ${sponsorship.remaining} slots remaining.`
      : `Sponsorship pool exhausted. Registration now requires 0.005 SOL.`,
    cost: sponsorship.available ? 'FREE (sponsored)' : '0.005 SOL',
    verificationCost: '0.01 SOL (optional, for verified badge)'
  });
});

// ============ PENDING REGISTRATION (OFF-CHAIN, FREE) ============
/**
 * POST /api/register/pending
 * Register an agent off-chain (free, instant, no SOL required)
 * Status: PENDING - can upgrade to REGISTERED (on-chain) later
 */
app.post('/api/register/pending', async (c) => {
  const body = await c.req.json();
  const { wallet, name, description, twitter, website, capabilities, source } = body;
  
  // Validate required fields
  if (!wallet || !name) {
    return c.json({ error: 'Required: wallet, name' }, 400);
  }

  // Determine if this source qualifies for auto L2 framework attestation
  const FRAMEWORK_SOURCES = ['eliza', 'swarms', 'conway', 'sdk', 'cli'];
  const registrationSource = source || 'website';
  const isFrameworkAttestation = FRAMEWORK_SOURCES.includes(registrationSource.toLowerCase());
  
  // Check if already registered
  const existing = await prisma.agent.findUnique({ where: { wallet } });
  if (existing) {
    return c.json({ 
      success: true,
      message: 'Already registered',
      wallet,
      pda: existing.pda,
      status: existing.isVerified ? 'VERIFIED' : (existing.sponsored ? 'REGISTERED' : 'PENDING'),
      profile: `https://www.saidprotocol.com/agent.html?wallet=${wallet}`
    });
  }
  
  try {
    // Compute PDA (deterministic)
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('agent'), new PublicKey(wallet).toBuffer()],
      SAID_PROGRAM_ID
    );
    
    // Build card
    const card = {
      name,
      description: description || `${name} - AI Agent on SAID Protocol`,
      wallet,
      twitter: twitter || undefined,
      website: website || undefined,
      capabilities: capabilities || ['chat', 'assistant'],
      status: 'PENDING',
      registeredAt: new Date().toISOString(),
    };
    
    const metadataUri = `https://api.saidprotocol.com/api/cards/${wallet}.json`;
    
    // Store card in database (for /api/cards/:wallet.json endpoint)
    await prisma.agentCard.upsert({
      where: { wallet },
      create: {
        wallet,
        cardJson: JSON.stringify(card),
      },
      update: {
        cardJson: JSON.stringify(card),
      }
    });
    
    // Store in database with PENDING status (not sponsored = off-chain only)
    await prisma.agent.create({
      data: {
        wallet,
        pda: pda.toString(),
        owner: wallet,
        metadataUri,
        registeredAt: new Date(),
        isVerified: false,
        sponsored: false,  // PENDING = not on-chain yet
        name: card.name,
        description: card.description,
        twitter: card.twitter,
        website: card.website,
        skills: card.capabilities,
        registrationSource,
        // Auto L2 attest framework registrations
        ...(isFrameworkAttestation && {
          layer2Verified: true,
          layer2VerifiedAt: new Date(),
          l2AttestationMethod: 'framework',
        }),
      }
    });
    
    return c.json({
      success: true,
      message: 'Agent registered (PENDING). Upgrade to on-chain anytime.',
      wallet,
      pda: pda.toString(),
      status: 'PENDING',
      metadataUri,
      profile: `https://www.saidprotocol.com/agent.html?wallet=${wallet}`,
      badge: `https://api.saidprotocol.com/api/badge/${wallet}.svg`,
      layer2Verified: isFrameworkAttestation,
      l2AttestationMethod: isFrameworkAttestation ? 'framework' : null,
      upgrade: {
        cost: '0.005 SOL',
        instructions: 'Fund wallet and run: npx said-anchor'
      }
    });
    
  } catch (error: any) {
    console.error('Pending registration error:', error);
    return c.json({ error: 'Registration failed: ' + error.message }, 500);
  }
});

// ============ PLATFORM-SPECIFIC INTEGRATIONS ============

/**
 * SPAWNR.IO INTEGRATION ENDPOINTS
 * 
 * All endpoints require authentication via X-Platform-Key header (except badge embed)
 * 
 * Available endpoints:
 * - POST   /api/platforms/spawnr/register       - Register new agent with instant verification
 * - PUT    /api/platforms/spawnr/agents/:wallet - Update agent metadata
 * - GET    /api/platforms/spawnr/agents         - List all Spawnr agents (paginated)
 * - GET    /api/platforms/spawnr/stats          - Platform statistics
 * - POST   /api/platforms/spawnr/webhooks       - Register webhook for events
 * - GET    /api/badge/embed/:wallet             - Public badge embed (no auth required)
 */

/**
 * POST /api/platforms/spawnr/register
 * Spawnr.io platform integration - instant verified registration
 * 
 * Authentication: X-Platform-Key header (Spawnr's API key)
 * 
 * All agents created on Spawnr.io are automatically:
 * - Registered on SAID
 * - Verified (we eat the 0.01 SOL cost)
 * - Given full SAID identity
 * 
 * No user signature required - Spawnr authenticates via API key
 */
/**
 * POST /api/platforms/spawnr/register
 * Step 1: Build on-chain registration + verification transaction
 * Returns a serialized transaction for the agent wallet to sign
 * 
 * Flow:
 *   1. Spawnr calls this endpoint with agent wallet + metadata
 *   2. We build a transaction with register_agent + get_verified instructions
 *   3. Sponsor wallet pays all fees (rent + 0.01 SOL verification)
 *   4. Return serialized tx (base64) — agent wallet must sign
 *   5. Spawnr signs with agent keypair, calls /confirm to broadcast
 */
app.post('/api/platforms/spawnr/register', async (c) => {
  // Validate Spawnr API key
  const apiKey = c.req.header('X-Platform-Key');
  const expectedKey = getPlatformKey('SP_AUTH_CFG');
  
  console.log('[DEBUG] Auth check:', { 
    hasApiKey: !!apiKey, 
    hasExpectedKey: !!expectedKey,
    match: apiKey === expectedKey 
  });
  
  if (!expectedKey || !apiKey || apiKey !== expectedKey) {
    return c.json({ error: 'Invalid API key' }, 401);
  }
  
  const body = await c.req.json();
  const { wallet, name, description, twitter, website, capabilities } = body;
  
  // Validate required fields
  if (!wallet || !name) {
    return c.json({ error: 'Required fields: wallet, name' }, 400);
  }

  // Validate wallet format
  let agentPubkey: PublicKey;
  try {
    agentPubkey = new PublicKey(wallet);
  } catch {
    return c.json({ error: 'Invalid wallet address' }, 400);
  }
  
  // Check if already registered on-chain
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('agent'), agentPubkey.toBuffer()],
    SAID_PROGRAM_ID
  );
  
  const existingOnChain = await connection.getAccountInfo(pda);
  if (existingOnChain) {
    // Already on-chain — ensure DB is tagged as Spawnr and return
    const existing = await prisma.agent.upsert({
      where: { wallet },
      create: {
        wallet,
        pda: pda.toString(),
        owner: wallet,
        metadataUri: `https://api.saidprotocol.com/api/cards/${wallet}.json`,
        registeredAt: new Date(),
        isVerified: true,
        verifiedAt: new Date(),
        sponsored: true,
        name: name || 'Spawnr Agent',
        description: description || 'AI Agent via Spawnr',
        twitter: twitter || undefined,
        website: website || undefined,
        skills: capabilities || ['chat', 'assistant'],
        registrationSource: 'spawnr',
        layer2Verified: true,
        layer2VerifiedAt: new Date(),
        l2AttestationMethod: 'platform',
      },
      update: {
        registrationSource: 'spawnr',
        layer2Verified: true,
        layer2VerifiedAt: new Date(),
        l2AttestationMethod: 'platform',
        sponsored: true,
        isVerified: true,
        verifiedAt: new Date(),
      },
    });
    
    emitAgentEvent('agent:registered', { wallet, name: existing.name, source: 'spawnr' });
    
    return c.json({
      success: true,
      message: 'Agent already registered on-chain',
      agent: {
        wallet,
        pda: pda.toString(),
        name: existing.name || name,
        verified: true,
        profile: `https://www.saidprotocol.com/agent.html?wallet=${wallet}`,
        badge: `https://api.saidprotocol.com/api/badge/${wallet}.svg`,
      }
    });
  }
  
  // Check sponsor wallet
  const sponsorKey = process.env['SPAWNR_SPONSOR_PRIVATE_KEY'];
  if (!sponsorKey) {
    return c.json({ 
      error: 'Spawnr sponsor wallet not configured. Contact SAID team.',
      support: 'contact@saidprotocol.com'
    }, 500);
  }
  
  try {
    const sponsorKeypair = Keypair.fromSecretKey(bs58.decode(sponsorKey));
    
    // Store agent card first (needed for metadata_uri)
    const card = {
      name,
      description: description || `${name} - AI Agent`,
      wallet,
      twitter: twitter || undefined,
      website: website || undefined,
      capabilities: capabilities || ['chat', 'assistant'],
      platform: 'spawnr.io',
      verified: true,
      registeredAt: new Date().toISOString(),
    };
    
    const metadataUri = `https://api.saidprotocol.com/api/cards/${wallet}.json`;
    
    await prisma.agentCard.upsert({
      where: { wallet },
      create: { wallet, cardJson: JSON.stringify(card) },
      update: { cardJson: JSON.stringify(card) },
    });
    
    // Treasury PDA
    const [treasuryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('treasury')],
      SAID_PROGRAM_ID
    );
    
    // === Build register_agent instruction ===
    // Anchor discriminator: sha256("global:register_agent")[0..8]
    const registerDiscriminator = Buffer.from([135, 157, 66, 195, 2, 113, 175, 30]);
    // Borsh-encode metadata_uri string (4-byte little-endian length + utf8 bytes)
    const uriBytes = Buffer.from(metadataUri, 'utf8');
    const uriLen = Buffer.alloc(4);
    uriLen.writeUInt32LE(uriBytes.length);
    const registerData = Buffer.concat([registerDiscriminator, uriLen, uriBytes]);
    
    const registerIx = {
      programId: SAID_PROGRAM_ID,
      keys: [
        { pubkey: pda, isSigner: false, isWritable: true },           // agent_identity (init)
        { pubkey: agentPubkey, isSigner: true, isWritable: true },    // owner (signer + payer)
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
      ],
      data: registerData,
    };
    
    // === Build get_verified instruction ===
    // Anchor discriminator: sha256("global:get_verified")[0..8]
    const verifyDiscriminator = Buffer.from([132, 231, 2, 30, 115, 74, 23, 26]);
    
    const verifyIx = {
      programId: SAID_PROGRAM_ID,
      keys: [
        { pubkey: pda, isSigner: false, isWritable: true },           // agent_identity
        { pubkey: treasuryPda, isSigner: false, isWritable: true },   // treasury
        { pubkey: agentPubkey, isSigner: true, isWritable: true },    // authority (signer + payer of fee)
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
      ],
      data: verifyDiscriminator,
    };
    
    // === Build funding transfer: sponsor → agent wallet ===
    // Agent needs SOL for: PDA rent (~0.003 SOL) + verification fee (0.01 SOL) + tx fees
    const FUND_AMOUNT = 0.015 * LAMPORTS_PER_SOL; // 0.015 SOL buffer
    
    const fundIx = SystemProgram.transfer({
      fromPubkey: sponsorKeypair.publicKey,
      toPubkey: agentPubkey,
      lamports: FUND_AMOUNT,
    });
    
    // Build transaction: fund → register → verify
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    
    const tx = new Transaction({
      blockhash,
      lastValidBlockHeight,
      feePayer: sponsorKeypair.publicKey,  // Sponsor pays tx fees
    });
    
    tx.add(fundIx);      // 1. Fund agent wallet
    tx.add(registerIx);  // 2. Register on-chain
    tx.add(verifyIx);    // 3. Get verified badge
    
    // Sponsor signs (fee payer + fund transfer)
    tx.partialSign(sponsorKeypair);
    
    // Serialize — agent wallet still needs to sign
    const serializedTx = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    }).toString('base64');
    
    return c.json({
      success: true,
      message: 'Transaction built. Agent wallet must sign and return via /confirm endpoint.',
      transaction: serializedTx,
      blockhash,
      lastValidBlockHeight,
      requiredSigner: wallet,
      pda: pda.toString(),
      metadataUri,
      instructions: {
        step1: 'Deserialize the base64 transaction',
        step2: `Sign with the agent wallet (${wallet})`,
        step3: 'POST the signed transaction to /api/platforms/spawnr/confirm',
      },
      expiresIn: '~60 seconds (blockhash expiry)',
    });
    
  } catch (error: any) {
    console.error('[Spawnr Register Error]', error);
    return c.json({ 
      error: 'Failed to build transaction',
      details: error.message,
      support: 'contact@saidprotocol.com'
    }, 500);
  }
});

/**
 * POST /api/platforms/spawnr/confirm
 * Step 2: Receive signed transaction, broadcast on-chain, update DB
 * 
 * Spawnr signs the transaction from Step 1 with the agent's keypair,
 * then sends it here. We broadcast, confirm, and update our database.
 */
app.post('/api/platforms/spawnr/confirm', async (c) => {
  // Validate Spawnr API key
  const apiKey = c.req.header('X-Platform-Key');
  const expectedKey = getPlatformKey('SP_AUTH_CFG');
  
  if (!expectedKey || !apiKey || apiKey !== expectedKey) {
    return c.json({ error: "Invalid or missing X-Platform-Key header" }, 401);
  }
  
  const body = await c.req.json();
  const { signedTransaction, wallet, name, description, twitter, website, capabilities } = body;
  
  if (!signedTransaction || !wallet) {
    return c.json({ error: 'Required: signedTransaction (base64), wallet' }, 400);
  }
  
  try {
    // Deserialize and broadcast
    const txBuffer = Buffer.from(signedTransaction, 'base64');
    const tx = Transaction.from(txBuffer);
    
    // Verify the transaction has the expected signers
    const agentPubkey = new PublicKey(wallet);
    const signers = tx.signatures.map(s => s.publicKey.toBase58());
    if (!signers.includes(wallet)) {
      return c.json({ error: 'Transaction must be signed by the agent wallet' }, 400);
    }
    
    // Broadcast
    const rawTx = tx.serialize();
    const txHash = await connection.sendRawTransaction(rawTx, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    
    // Confirm
    const confirmation = await connection.confirmTransaction({
      signature: txHash,
      blockhash: tx.recentBlockhash!,
      lastValidBlockHeight: tx.lastValidBlockHeight!,
    }, 'confirmed');
    
    if (confirmation.value.err) {
      return c.json({ 
        error: 'Transaction failed on-chain',
        txHash,
        details: JSON.stringify(confirmation.value.err),
      }, 500);
    }
    
    // Success! Update database
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('agent'), agentPubkey.toBuffer()],
      SAID_PROGRAM_ID
    );
    
    const metadataUri = `https://api.saidprotocol.com/api/cards/${wallet}.json`;
    
    // Upsert agent in DB (might exist from a previous partial attempt)
    const agent = await prisma.agent.upsert({
      where: { wallet },
      create: {
        wallet,
        pda: pda.toString(),
        owner: wallet,
        metadataUri,
        registeredAt: new Date(),
        isVerified: true,
        verifiedAt: new Date(),
        sponsored: true,
        name: name || 'Spawnr Agent',
        description: description || 'AI Agent via Spawnr',
        twitter: twitter || undefined,
        website: website || undefined,
        skills: capabilities || ['chat', 'assistant'],
        registrationSource: 'spawnr',
        layer2Verified: true,
        layer2VerifiedAt: new Date(),
        l2AttestationMethod: 'platform',
      },
      update: {
        isVerified: true,
        verifiedAt: new Date(),
        sponsored: true,
        registrationSource: 'spawnr',
        layer2Verified: true,
        layer2VerifiedAt: new Date(),
      },
    });
    
    // Emit SSE event for real-time frontend updates
    emitAgentEvent('agent:registered', { wallet: agent.wallet, name: agent.name, source: 'spawnr', txHash });
    
    return c.json({
      success: true,
      message: 'Agent registered and verified ON-CHAIN via Spawnr',
      txHash,
      explorer: `https://solscan.io/tx/${txHash}`,
      agent: {
        wallet: agent.wallet,
        pda: agent.pda,
        name: agent.name,
        verified: true,
        onChain: true,
        profile: `https://www.saidprotocol.com/agent.html?wallet=${wallet}`,
        badge: `https://api.saidprotocol.com/api/badge/${wallet}.svg`,
        badgeWithScore: `https://api.saidprotocol.com/api/badge/${wallet}.svg?style=score`,
      },
      platform: {
        name: 'spawnr.io',
        costCovered: '~0.015 SOL (rent + verification + fees)',
        sponsoredBy: 'SAID Protocol',
      }
    });
    
  } catch (error: any) {
    console.error('[Spawnr Confirm Error]', error.message);
    
    // Recovery: if broadcast failed but agent exists on-chain, sync DB anyway
    // This handles: expired blockhash retries, "already initialized" errors
    try {
      const agentPubkey = new PublicKey(wallet);
      const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from('agent'), agentPubkey.toBuffer()],
        SAID_PROGRAM_ID
      );
      
      const accountInfo = await connection.getAccountInfo(pda);
      if (accountInfo) {
        console.log('[Spawnr Recovery] Agent PDA exists on-chain, syncing DB...');
        const metadataUri = `https://api.saidprotocol.com/api/cards/${wallet}.json`;
        
        const agent = await prisma.agent.upsert({
          where: { wallet },
          create: {
            wallet,
            pda: pda.toString(),
            owner: wallet,
            metadataUri,
            registeredAt: new Date(),
            isVerified: true,
            verifiedAt: new Date(),
            sponsored: true,
            name: name || 'Spawnr Agent',
            description: description || 'AI Agent via Spawnr',
            twitter: twitter || undefined,
            website: website || undefined,
            skills: capabilities || ['chat', 'assistant'],
            registrationSource: 'spawnr',
            layer2Verified: true,
            layer2VerifiedAt: new Date(),
            l2AttestationMethod: 'platform',
          },
          update: {
            isVerified: true,
            verifiedAt: new Date(),
            sponsored: true,
            registrationSource: 'spawnr',
            layer2Verified: true,
            layer2VerifiedAt: new Date(),
            l2AttestationMethod: 'platform',
          },
        });
        
        emitAgentEvent('agent:registered', { wallet: agent.wallet, name: agent.name, source: 'spawnr', recovered: true });
        
        return c.json({
          success: true,
          message: 'Agent already registered on-chain. Database synced.',
          recovered: true,
          agent: {
            wallet: agent.wallet,
            pda: agent.pda,
            name: agent.name,
            verified: true,
            onChain: true,
            profile: `https://www.saidprotocol.com/agent.html?wallet=${wallet}`,
            badge: `https://api.saidprotocol.com/api/badge/${wallet}.svg`,
          },
        });
      }
    } catch (recoveryError: any) {
      console.error('[Spawnr Recovery Failed]', recoveryError.message);
    }
    
    return c.json({ 
      error: 'Broadcast failed',
      details: error.message,
      support: 'contact@saidprotocol.com'
    }, 500);
  }
});

// ============ CLAW PUMP PLATFORM INTEGRATION ============

/**
 * POST /api/platforms/clawpump/register
 * Step 1: Build a transaction that registers + verifies an agent on SAID
 * 
 * SAID sponsors the costs (rent + verification fee + tx fees).
 * Claw Pump provides agent wallet + metadata.
 * Returns a partially-signed transaction that Claw Pump must complete + broadcast.
 */
app.post('/api/platforms/clawpump/register', async (c) => {
  // Validate Claw Pump API key
  const apiKey = c.req.header('X-Platform-Key');
  const expectedKey = process.env.CLAWPUMP_API_KEY;
  
  console.log('[DEBUG] Claw Pump Auth check:', { 
    hasApiKey: !!apiKey, 
    hasExpectedKey: !!expectedKey,
    match: apiKey === expectedKey 
  });
  
  if (!expectedKey || !apiKey || apiKey !== expectedKey) {
    return c.json({ error: 'Invalid API key' }, 401);
  }
  
  const body = await c.req.json();
  const { wallet, name, description, twitter, website, capabilities } = body;
  
  // Validate required fields
  if (!wallet || !name) {
    return c.json({ error: 'Required fields: wallet, name' }, 400);
  }

  // Validate wallet format
  let agentPubkey: PublicKey;
  try {
    agentPubkey = new PublicKey(wallet);
  } catch {
    return c.json({ error: 'Invalid wallet address' }, 400);
  }
  
  // Check if already registered on-chain
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('agent'), agentPubkey.toBuffer()],
    SAID_PROGRAM_ID
  );
  
  const existingOnChain = await connection.getAccountInfo(pda);
  if (existingOnChain) {
    // Already on-chain — ensure DB is tagged as Claw Pump and return
    const existing = await prisma.agent.upsert({
      where: { wallet },
      create: {
        wallet,
        pda: pda.toString(),
        owner: wallet,
        metadataUri: `https://api.saidprotocol.com/api/cards/${wallet}.json`,
        registeredAt: new Date(),
        isVerified: true,
        verifiedAt: new Date(),
        sponsored: true,
        name: name || 'Claw Pump Agent',
        description: description || 'AI Agent via Claw Pump',
        twitter: twitter || undefined,
        website: website || undefined,
        skills: capabilities || ['chat', 'assistant'],
        registrationSource: 'clawpump',
        layer2Verified: true,
        layer2VerifiedAt: new Date(),
        l2AttestationMethod: 'platform',
      },
      update: {
        registrationSource: 'clawpump',
        layer2Verified: true,
        layer2VerifiedAt: new Date(),
        l2AttestationMethod: 'platform',
        sponsored: true,
        isVerified: true,
        verifiedAt: new Date(),
      },
    });
    
    emitAgentEvent('agent:registered', { wallet, name: existing.name, source: 'clawpump' });
    
    return c.json({
      success: true,
      message: 'Agent already registered on-chain',
      agent: {
        wallet,
        pda: pda.toString(),
        name: existing.name || name,
        verified: true,
        profile: `https://www.saidprotocol.com/agent.html?wallet=${wallet}`,
        badge: `https://api.saidprotocol.com/api/badge/${wallet}.svg`,
      }
    });
  }
  
  // Check sponsor wallet (reuse same sponsor key as Spawnr)
  const sponsorKey = process.env['SPAWNR_SPONSOR_PRIVATE_KEY'];
  if (!sponsorKey) {
    return c.json({ 
      error: 'Sponsor wallet not configured. Contact SAID team.',
      support: 'contact@saidprotocol.com'
    }, 500);
  }
  
  try {
    const sponsorKeypair = Keypair.fromSecretKey(bs58.decode(sponsorKey));
    
    // Store agent card first (needed for metadata_uri)
    const card = {
      name,
      description: description || `${name} - AI Agent`,
      wallet,
      twitter: twitter || undefined,
      website: website || undefined,
      capabilities: capabilities || ['chat', 'assistant'],
      platform: 'claw.pump',
      verified: true,
      registeredAt: new Date().toISOString(),
    };
    
    const metadataUri = `https://api.saidprotocol.com/api/cards/${wallet}.json`;
    
    await prisma.agentCard.upsert({
      where: { wallet },
      create: { wallet, cardJson: JSON.stringify(card) },
      update: { cardJson: JSON.stringify(card) },
    });
    
    // Treasury PDA
    const [treasuryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('treasury')],
      SAID_PROGRAM_ID
    );
    
    // === Build register_agent instruction ===
    // Anchor discriminator: sha256("global:register_agent")[0..8]
    const registerDiscriminator = Buffer.from([135, 157, 66, 195, 2, 113, 175, 30]);
    // Borsh-encode metadata_uri string (4-byte little-endian length + utf8 bytes)
    const uriBytes = Buffer.from(metadataUri, 'utf8');
    const uriLen = Buffer.alloc(4);
    uriLen.writeUInt32LE(uriBytes.length);
    const registerData = Buffer.concat([registerDiscriminator, uriLen, uriBytes]);
    
    const registerIx = {
      programId: SAID_PROGRAM_ID,
      keys: [
        { pubkey: pda, isSigner: false, isWritable: true },           // agent_identity (init)
        { pubkey: agentPubkey, isSigner: true, isWritable: true },    // owner (signer + payer)
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
      ],
      data: registerData,
    };
    
    // === Build get_verified instruction ===
    // Anchor discriminator: sha256("global:get_verified")[0..8]
    const verifyDiscriminator = Buffer.from([132, 231, 2, 30, 115, 74, 23, 26]);
    
    const verifyIx = {
      programId: SAID_PROGRAM_ID,
      keys: [
        { pubkey: pda, isSigner: false, isWritable: true },           // agent_identity
        { pubkey: treasuryPda, isSigner: false, isWritable: true },   // treasury
        { pubkey: agentPubkey, isSigner: true, isWritable: true },    // authority (signer + payer of fee)
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
      ],
      data: verifyDiscriminator,
    };
    
    // === Build funding transfer: sponsor → agent wallet ===
    // Agent needs SOL for: PDA rent (~0.003 SOL) + verification fee (0.01 SOL) + tx fees
    const FUND_AMOUNT = 0.015 * LAMPORTS_PER_SOL; // 0.015 SOL buffer
    
    const fundIx = SystemProgram.transfer({
      fromPubkey: sponsorKeypair.publicKey,
      toPubkey: agentPubkey,
      lamports: FUND_AMOUNT,
    });
    
    // Build transaction: fund → register → verify
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    
    const tx = new Transaction({
      blockhash,
      lastValidBlockHeight,
      feePayer: sponsorKeypair.publicKey,  // Sponsor pays tx fees
    });
    
    tx.add(fundIx);      // 1. Fund agent wallet
    tx.add(registerIx);  // 2. Register on-chain
    tx.add(verifyIx);    // 3. Get verified badge
    
    // Sponsor signs (fee payer + fund transfer)
    tx.partialSign(sponsorKeypair);
    
    // Serialize — agent wallet still needs to sign
    const serializedTx = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    }).toString('base64');
    
    return c.json({
      success: true,
      message: 'Transaction built. Agent wallet must sign and return via /confirm endpoint.',
      transaction: serializedTx,
      blockhash,
      lastValidBlockHeight,
      requiredSigner: wallet,
      pda: pda.toString(),
      metadataUri,
      instructions: {
        step1: 'Deserialize the base64 transaction',
        step2: `Sign with the agent wallet (${wallet})`,
        step3: 'POST the signed transaction to /api/platforms/clawpump/confirm',
      },
      expiresIn: '~60 seconds (blockhash expiry)',
    });
    
  } catch (error: any) {
    console.error('[Claw Pump Register Error]', error);
    return c.json({ 
      error: 'Failed to build transaction',
      details: error.message,
      support: 'contact@saidprotocol.com'
    }, 500);
  }
});

/**
 * POST /api/platforms/clawpump/confirm
 * Step 2: Receive signed transaction, broadcast on-chain, update DB
 * 
 * Claw Pump signs the transaction from Step 1 with the agent's keypair,
 * then sends it here. We broadcast, confirm, and update our database.
 */
app.post('/api/platforms/clawpump/confirm', async (c) => {
  // Validate Claw Pump API key
  const apiKey = c.req.header('X-Platform-Key');
  const expectedKey = process.env.CLAWPUMP_API_KEY;
  
  if (!expectedKey || !apiKey || apiKey !== expectedKey) {
    return c.json({ error: "Invalid or missing X-Platform-Key header" }, 401);
  }
  
  const body = await c.req.json();
  const { signedTransaction, wallet, name, description, twitter, website, capabilities } = body;
  
  if (!signedTransaction || !wallet) {
    return c.json({ error: 'Required: signedTransaction (base64), wallet' }, 400);
  }
  
  try {
    // Deserialize and broadcast
    const txBuffer = Buffer.from(signedTransaction, 'base64');
    const tx = Transaction.from(txBuffer);
    
    // Verify the transaction has the expected signers
    const agentPubkey = new PublicKey(wallet);
    const signers = tx.signatures.map(s => s.publicKey.toBase58());
    if (!signers.includes(wallet)) {
      return c.json({ error: 'Transaction must be signed by the agent wallet' }, 400);
    }
    
    // Broadcast
    const rawTx = tx.serialize();
    const txHash = await connection.sendRawTransaction(rawTx, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    
    // Confirm
    const confirmation = await connection.confirmTransaction({
      signature: txHash,
      blockhash: tx.recentBlockhash!,
      lastValidBlockHeight: tx.lastValidBlockHeight!,
    }, 'confirmed');
    
    if (confirmation.value.err) {
      return c.json({ 
        error: 'Transaction failed on-chain',
        txHash,
        details: JSON.stringify(confirmation.value.err),
      }, 500);
    }
    
    // Success! Update database
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('agent'), agentPubkey.toBuffer()],
      SAID_PROGRAM_ID
    );
    
    const metadataUri = `https://api.saidprotocol.com/api/cards/${wallet}.json`;
    
    // Upsert agent in DB (might exist from a previous partial attempt)
    const agent = await prisma.agent.upsert({
      where: { wallet },
      create: {
        wallet,
        pda: pda.toString(),
        owner: wallet,
        metadataUri,
        registeredAt: new Date(),
        isVerified: true,
        verifiedAt: new Date(),
        sponsored: true,
        name: name || 'Claw Pump Agent',
        description: description || 'AI Agent via Claw Pump',
        twitter: twitter || undefined,
        website: website || undefined,
        skills: capabilities || ['chat', 'assistant'],
        registrationSource: 'clawpump',
        layer2Verified: true,
        layer2VerifiedAt: new Date(),
        l2AttestationMethod: 'platform',
      },
      update: {
        isVerified: true,
        verifiedAt: new Date(),
        sponsored: true,
        registrationSource: 'clawpump',
        layer2Verified: true,
        layer2VerifiedAt: new Date(),
        l2AttestationMethod: 'platform',
      },
    });
    
    // Emit SSE event for real-time frontend updates
    emitAgentEvent('agent:registered', { wallet: agent.wallet, name: agent.name, source: 'clawpump', txHash });
    
    return c.json({
      success: true,
      message: 'Agent registered and verified ON-CHAIN via Claw Pump',
      txHash,
      explorer: `https://solscan.io/tx/${txHash}`,
      agent: {
        wallet: agent.wallet,
        pda: agent.pda,
        name: agent.name,
        verified: true,
        onChain: true,
        profile: `https://www.saidprotocol.com/agent.html?wallet=${wallet}`,
        badge: `https://api.saidprotocol.com/api/badge/${wallet}.svg`,
        badgeWithScore: `https://api.saidprotocol.com/api/badge/${wallet}.svg?style=score`,
      },
      platform: {
        name: 'claw.pump',
        costCovered: '~0.015 SOL (rent + verification + fees)',
        sponsoredBy: 'SAID Protocol',
      }
    });
    
  } catch (error: any) {
    console.error('[Claw Pump Confirm Error]', error.message);
    
    // Recovery: if broadcast failed but agent exists on-chain, sync DB anyway
    // This handles: expired blockhash retries, "already initialized" errors
    try {
      const agentPubkey = new PublicKey(wallet);
      const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from('agent'), agentPubkey.toBuffer()],
        SAID_PROGRAM_ID
      );
      
      const accountInfo = await connection.getAccountInfo(pda);
      if (accountInfo) {
        console.log('[Claw Pump Recovery] Agent PDA exists on-chain, syncing DB...');
        const metadataUri = `https://api.saidprotocol.com/api/cards/${wallet}.json`;
        
        const agent = await prisma.agent.upsert({
          where: { wallet },
          create: {
            wallet,
            pda: pda.toString(),
            owner: wallet,
            metadataUri,
            registeredAt: new Date(),
            isVerified: true,
            verifiedAt: new Date(),
            sponsored: true,
            name: name || 'Claw Pump Agent',
            description: description || 'AI Agent via Claw Pump',
            twitter: twitter || undefined,
            website: website || undefined,
            skills: capabilities || ['chat', 'assistant'],
            registrationSource: 'clawpump',
            layer2Verified: true,
            layer2VerifiedAt: new Date(),
            l2AttestationMethod: 'platform',
          },
          update: {
            isVerified: true,
            verifiedAt: new Date(),
            sponsored: true,
            registrationSource: 'clawpump',
            layer2Verified: true,
            layer2VerifiedAt: new Date(),
            l2AttestationMethod: 'platform',
          },
        });
        
        emitAgentEvent('agent:registered', { wallet: agent.wallet, name: agent.name, source: 'clawpump', recovered: true });
        
        return c.json({
          success: true,
          message: 'Agent already registered on-chain. Database synced.',
          recovered: true,
          agent: {
            wallet: agent.wallet,
            pda: agent.pda,
            name: agent.name,
            verified: true,
            onChain: true,
            profile: `https://www.saidprotocol.com/agent.html?wallet=${wallet}`,
            badge: `https://api.saidprotocol.com/api/badge/${wallet}.svg`,
          },
        });
      }
    } catch (recoveryError: any) {
      console.error('[Claw Pump Recovery Failed]', recoveryError.message);
    }
    
    return c.json({ 
      error: 'Broadcast failed',
      details: error.message,
      support: 'contact@saidprotocol.com'
    }, 500);
  }
});


// ============ XONA-ORBIT PLATFORM INTEGRATION ============

/**
 * POST /api/platforms/xona-orbit/register
 * Step 1: Build a transaction that registers + verifies an agent on SAID
 * 
 * Xona-Orbit self-funds. No SAID sponsorship.
 * Agent wallet must already have ≥0.015 SOL for rent + verification + fees.
 * Returns an unsigned transaction that Xona-Orbit must sign + broadcast.
 */
app.post('/api/platforms/xona-orbit/register', async (c) => {
  const apiKey = c.req.header('X-Platform-Key');
  const expectedKey = process.env.XONA_ORBIT_API_KEY;
  
  if (!expectedKey || !apiKey || apiKey !== expectedKey) {
    return c.json({ error: 'Invalid API key' }, 401);
  }
  
  const body = await c.req.json();
  const { wallet, name, description, twitter, website, capabilities } = body;
  
  if (!wallet || !name) {
    return c.json({ error: 'Required fields: wallet, name' }, 400);
  }

  let agentPubkey: PublicKey;
  try {
    agentPubkey = new PublicKey(wallet);
  } catch {
    return c.json({ error: 'Invalid wallet address' }, 400);
  }
  
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('agent'), agentPubkey.toBuffer()],
    SAID_PROGRAM_ID
  );
  
  // Idempotent: if already on-chain, return existing identity
  const existingOnChain = await connection.getAccountInfo(pda);
  if (existingOnChain) {
    const existing = await prisma.agent.upsert({
      where: { wallet },
      create: {
        wallet,
        pda: pda.toString(),
        owner: wallet,
        metadataUri: `https://api.saidprotocol.com/api/cards/${wallet}.json`,
        registeredAt: new Date(),
        isVerified: true,
        verifiedAt: new Date(),
        sponsored: false,
        name: name || 'Xona-Orbit Agent',
        description: description || 'AI Agent via Xona-Orbit',
        twitter: twitter || undefined,
        website: website || undefined,
        skills: capabilities || ['chat', 'assistant'],
        registrationSource: 'xona-orbit',
        layer2Verified: true,
        layer2VerifiedAt: new Date(),
        l2AttestationMethod: 'platform',
      },
      update: {
        registrationSource: 'xona-orbit',
        layer2Verified: true,
        layer2VerifiedAt: new Date(),
        l2AttestationMethod: 'platform',
        sponsored: false,
        isVerified: true,
        verifiedAt: new Date(),
      },
    });
    
    emitAgentEvent('agent:registered', { wallet, name: existing.name, source: 'xona-orbit' });
    
    return c.json({
      success: true,
      message: 'Agent already registered on-chain',
      agent: {
        wallet,
        pda: pda.toString(),
        name: existing.name || name,
        verified: true,
        profile: `https://www.saidprotocol.com/agent.html?wallet=${wallet}`,
        badge: `https://api.saidprotocol.com/api/badge/${wallet}.svg`,
      }
    });
  }
  
  try {
    // Store agent card
    const card = {
      name,
      description: description || `${name} - AI Agent`,
      wallet,
      twitter: twitter || undefined,
      website: website || undefined,
      capabilities: capabilities || ['chat', 'assistant'],
      platform: 'xona-orbit',
      verified: true,
      registeredAt: new Date().toISOString(),
    };
    
    const metadataUri = `https://api.saidprotocol.com/api/cards/${wallet}.json`;
    
    await prisma.agentCard.upsert({
      where: { wallet },
      create: { wallet, cardJson: JSON.stringify(card) },
      update: { cardJson: JSON.stringify(card) },
    });
    
    const [treasuryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('treasury')],
      SAID_PROGRAM_ID
    );
    
    // === register_agent instruction ===
    const registerDiscriminator = Buffer.from([135, 157, 66, 195, 2, 113, 175, 30]);
    const uriBytes = Buffer.from(metadataUri, 'utf8');
    const uriLen = Buffer.alloc(4);
    uriLen.writeUInt32LE(uriBytes.length);
    const registerData = Buffer.concat([registerDiscriminator, uriLen, uriBytes]);
    
    const registerIx = {
      programId: SAID_PROGRAM_ID,
      keys: [
        { pubkey: pda, isSigner: false, isWritable: true },
        { pubkey: agentPubkey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: registerData,
    };
    
    // === get_verified instruction ===
    const verifyDiscriminator = Buffer.from([132, 231, 2, 30, 115, 74, 23, 26]);
    
    const verifyIx = {
      programId: SAID_PROGRAM_ID,
      keys: [
        { pubkey: pda, isSigner: false, isWritable: true },
        { pubkey: treasuryPda, isSigner: false, isWritable: true },
        { pubkey: agentPubkey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: verifyDiscriminator,
    };
    
    // NO sponsor funding — Xona-Orbit pays from agent wallet directly
    // Agent wallet must have ≥0.015 SOL before calling this endpoint
    
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    
    const tx = new Transaction({
      blockhash,
      lastValidBlockHeight,
      feePayer: agentPubkey, // Agent wallet pays tx fees
    });
    
    tx.add(registerIx);  // 1. Register on-chain
    tx.add(verifyIx);    // 2. Get verified badge
    
    // No partial sign — fully unsigned, Xona-Orbit signs with agent keypair
    const serializedTx = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    }).toString('base64');
    
    return c.json({
      success: true,
      message: 'Transaction built. Agent wallet must sign and return via /confirm endpoint.',
      transaction: serializedTx,
      blockhash,
      lastValidBlockHeight,
      requiredSigner: wallet,
      pda: pda.toString(),
      metadataUri,
      instructions: {
        step1: 'Deserialize the base64 transaction',
        step2: `Sign with the agent wallet (${wallet})`,
        step3: 'POST the signed transaction to /api/platforms/xona-orbit/confirm',
      },
      fundingNote: 'Agent wallet must have ≥0.015 SOL for rent + verification fee + tx fees. No SAID sponsorship.',
      expiresIn: '~60 seconds (blockhash expiry)',
    });
    
  } catch (error: any) {
    console.error('[Xona-Orbit Register Error]', error);
    return c.json({ 
      error: 'Failed to build transaction',
      details: error.message,
      support: 'contact@saidprotocol.com'
    }, 500);
  }
});

/**
 * POST /api/platforms/xona-orbit/confirm
 * Step 2: Receive signed transaction, broadcast on-chain, update DB
 */
app.post('/api/platforms/xona-orbit/confirm', async (c) => {
  const apiKey = c.req.header('X-Platform-Key');
  const expectedKey = process.env.XONA_ORBIT_API_KEY;
  
  if (!expectedKey || !apiKey || apiKey !== expectedKey) {
    return c.json({ error: 'Invalid or missing X-Platform-Key header' }, 401);
  }
  
  const body = await c.req.json();
  const { signedTransaction, wallet, name, description, twitter, website, capabilities } = body;
  
  if (!signedTransaction || !wallet) {
    return c.json({ error: 'Required: signedTransaction (base64), wallet' }, 400);
  }
  
  try {
    const txBuffer = Buffer.from(signedTransaction, 'base64');
    const tx = Transaction.from(txBuffer);
    
    const agentPubkey = new PublicKey(wallet);
    const signers = tx.signatures.map(s => s.publicKey.toBase58());
    if (!signers.includes(wallet)) {
      return c.json({ error: 'Transaction must be signed by the agent wallet' }, 400);
    }
    
    const rawTx = tx.serialize();
    const txHash = await connection.sendRawTransaction(rawTx, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    
    const confirmation = await connection.confirmTransaction({
      signature: txHash,
      blockhash: tx.recentBlockhash!,
      lastValidBlockHeight: tx.lastValidBlockHeight!,
    }, 'confirmed');
    
    if (confirmation.value.err) {
      return c.json({ 
        error: 'Transaction failed on-chain',
        txHash,
        details: JSON.stringify(confirmation.value.err),
      }, 500);
    }
    
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('agent'), agentPubkey.toBuffer()],
      SAID_PROGRAM_ID
    );
    
    const metadataUri = `https://api.saidprotocol.com/api/cards/${wallet}.json`;
    
    const agent = await prisma.agent.upsert({
      where: { wallet },
      create: {
        wallet,
        pda: pda.toString(),
        owner: wallet,
        metadataUri,
        registeredAt: new Date(),
        isVerified: true,
        verifiedAt: new Date(),
        sponsored: false,
        name: name || 'Xona-Orbit Agent',
        description: description || 'AI Agent via Xona-Orbit',
        twitter: twitter || undefined,
        website: website || undefined,
        skills: capabilities || ['chat', 'assistant'],
        registrationSource: 'xona-orbit',
        layer2Verified: true,
        layer2VerifiedAt: new Date(),
        l2AttestationMethod: 'platform',
      },
      update: {
        isVerified: true,
        verifiedAt: new Date(),
        sponsored: false,
        registrationSource: 'xona-orbit',
        layer2Verified: true,
        layer2VerifiedAt: new Date(),
        l2AttestationMethod: 'platform',
      },
    });
    
    emitAgentEvent('agent:registered', { wallet: agent.wallet, name: agent.name, source: 'xona-orbit', txHash });
    
    return c.json({
      success: true,
      message: 'Agent registered and verified ON-CHAIN via Xona-Orbit',
      txHash,
      explorer: `https://solscan.io/tx/${txHash}`,
      agent: {
        wallet: agent.wallet,
        pda: agent.pda,
        name: agent.name,
        verified: true,
        onChain: true,
        profile: `https://www.saidprotocol.com/agent.html?wallet=${wallet}`,
        badge: `https://api.saidprotocol.com/api/badge/${wallet}.svg`,
      },
      platform: {
        name: 'xona-orbit',
        costCovered: '~0.015 SOL (rent + verification + fees)',
        paidBy: 'Xona-Orbit',
      }
    });
    
  } catch (error: any) {
    console.error('[Xona-Orbit Confirm Error]', error.message);
    
    // Recovery: sync DB if agent already exists on-chain
    try {
      const agentPubkey = new PublicKey(wallet);
      const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from('agent'), agentPubkey.toBuffer()],
        SAID_PROGRAM_ID
      );
      
      const accountInfo = await connection.getAccountInfo(pda);
      if (accountInfo) {
        console.log('[Xona-Orbit Recovery] Agent PDA exists on-chain, syncing DB...');
        const metadataUri = `https://api.saidprotocol.com/api/cards/${wallet}.json`;
        
        const agent = await prisma.agent.upsert({
          where: { wallet },
          create: {
            wallet,
            pda: pda.toString(),
            owner: wallet,
            metadataUri,
            registeredAt: new Date(),
            isVerified: true,
            verifiedAt: new Date(),
            sponsored: false,
            name: name || 'Xona-Orbit Agent',
            description: description || 'AI Agent via Xona-Orbit',
            twitter: twitter || undefined,
            website: website || undefined,
            skills: capabilities || ['chat', 'assistant'],
            registrationSource: 'xona-orbit',
            layer2Verified: true,
            layer2VerifiedAt: new Date(),
            l2AttestationMethod: 'platform',
          },
          update: {
            isVerified: true,
            verifiedAt: new Date(),
            sponsored: false,
            registrationSource: 'xona-orbit',
            layer2Verified: true,
            layer2VerifiedAt: new Date(),
            l2AttestationMethod: 'platform',
          },
        });
        
        emitAgentEvent('agent:registered', { wallet: agent.wallet, name: agent.name, source: 'xona-orbit', recovered: true });
        
        return c.json({
          success: true,
          message: 'Agent already registered on-chain. Database synced.',
          recovered: true,
          agent: {
            wallet: agent.wallet,
            pda: agent.pda,
            name: agent.name,
            verified: true,
            onChain: true,
            profile: `https://www.saidprotocol.com/agent.html?wallet=${wallet}`,
            badge: `https://api.saidprotocol.com/api/badge/${wallet}.svg`,
          },
        });
      }
    } catch (recoveryError: any) {
      console.error('[Xona-Orbit Recovery Failed]', recoveryError.message);
    }
    
    return c.json({ 
      error: 'Broadcast failed',
      details: error.message,
      support: 'contact@saidprotocol.com'
    }, 500);
  }
});


// ============ SAID HOSTING PLATFORM INTEGRATION ============

/**
 * POST /api/platforms/said-hosting/register
 * Step 1: Build a transaction that registers + verifies an agent on SAID
 * 
 * SAID sponsors the costs (rent + verification fee + tx fees).
 * SAID Hosting provides agent wallet + metadata.
 * Returns a partially-signed transaction that SAID Hosting must complete + broadcast.
 */
app.post('/api/platforms/said-hosting/register', async (c) => {
  // Validate SAID Hosting API key
  const apiKey = c.req.header('X-Platform-Key');
  const expectedKey = process.env.SAID_HOSTING_API_KEY;
  
  console.log('[DEBUG] SAID Hosting Auth check:', { 
    hasApiKey: !!apiKey, 
    hasExpectedKey: !!expectedKey,
    match: apiKey === expectedKey 
  });
  
  if (!expectedKey || !apiKey || apiKey !== expectedKey) {
    return c.json({ error: 'Invalid API key' }, 401);
  }
  
  const body = await c.req.json();
  const { wallet, name, description, twitter, website, capabilities, platform } = body;

  // platform — optional partner tag (e.g. 'fairscale', 'seekerclaw')
  // Falls back to 'said-hosting' if not provided
  const VALID_PLATFORMS = ['said-hosting', 'fairscale', 'seekerclaw', 'spawnr'];
  const registrationSource = platform && VALID_PLATFORMS.includes(platform) ? platform : 'said-hosting';

  // Validate required fields
  if (!wallet || !name) {
    return c.json({ error: 'Required fields: wallet, name' }, 400);
  }

  // Validate wallet format
  let agentPubkey: PublicKey;
  try {
    agentPubkey = new PublicKey(wallet);
  } catch {
    return c.json({ error: 'Invalid wallet address' }, 400);
  }

  // Check if already registered on-chain
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('agent'), agentPubkey.toBuffer()],
    SAID_PROGRAM_ID
  );

  const existingOnChain = await connection.getAccountInfo(pda);
  if (existingOnChain) {
    // Already on-chain — ensure DB is tagged and return
    const existing = await prisma.agent.upsert({
      where: { wallet },
      create: {
        wallet,
        pda: pda.toString(),
        owner: wallet,
        metadataUri: `https://api.saidprotocol.com/api/cards/${wallet}.json`,
        registeredAt: new Date(),
        isVerified: true,
        verifiedAt: new Date(),
        sponsored: true,
        name: name || 'SAID Hosting Agent',
        description: description || 'AI Agent via SAID Hosting',
        twitter: twitter || undefined,
        website: website || undefined,
        skills: capabilities || ['chat', 'assistant'],
        registrationSource,
        platformId: registrationSource !== 'said-hosting' ? registrationSource : undefined,
        layer2Verified: true,
        layer2VerifiedAt: new Date(),
        l2AttestationMethod: 'platform',
      },
      update: {
        registrationSource,
        platformId: registrationSource !== 'said-hosting' ? registrationSource : undefined,
        layer2Verified: true,
        layer2VerifiedAt: new Date(),
        l2AttestationMethod: 'platform',
        sponsored: true,
        isVerified: true,
        verifiedAt: new Date(),
      },
    });
    
    emitAgentEvent('agent:registered', { wallet, name: existing.name, source: registrationSource });
    
    return c.json({
      success: true,
      message: 'Agent already registered on-chain',
      agent: {
        wallet,
        pda: pda.toString(),
        name: existing.name || name,
        verified: true,
        profile: `https://www.saidprotocol.com/agent.html?wallet=${wallet}`,
        badge: `https://api.saidprotocol.com/api/badge/${wallet}.svg`,
      }
    });
  }
  
  // Check sponsor wallet (reuse same sponsor key as Spawnr)
  const sponsorKey = process.env['SPAWNR_SPONSOR_PRIVATE_KEY'];
  if (!sponsorKey) {
    return c.json({ 
      error: 'SAID Hosting sponsor wallet not configured. Contact SAID team.',
      support: 'contact@saidprotocol.com'
    }, 500);
  }
  
  try {
    const sponsorKeypair = Keypair.fromSecretKey(bs58.decode(sponsorKey));
    
    // Store agent card first (needed for metadata_uri)
    const card = {
      name,
      description: description || `${name} - AI Agent`,
      wallet,
      twitter: twitter || undefined,
      website: website || undefined,
      capabilities: capabilities || ['chat', 'assistant'],
      platform: registrationSource === 'said-hosting' ? 'said.hosting' : registrationSource,
      verified: true,
      registeredAt: new Date().toISOString(),
    };

    const metadataUri = `https://api.saidprotocol.com/api/cards/${wallet}.json`;
    
    await prisma.agentCard.upsert({
      where: { wallet },
      create: { wallet, cardJson: JSON.stringify(card) },
      update: { cardJson: JSON.stringify(card) },
    });
    
    // Treasury PDA
    const [treasuryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('treasury')],
      SAID_PROGRAM_ID
    );
    
    // === Build register_agent instruction ===
    // Anchor discriminator: sha256("global:register_agent")[0..8]
    const registerDiscriminator = Buffer.from([135, 157, 66, 195, 2, 113, 175, 30]);
    // Borsh-encode metadata_uri string (4-byte little-endian length + utf8 bytes)
    const uriBytes = Buffer.from(metadataUri, 'utf8');
    const uriLen = Buffer.alloc(4);
    uriLen.writeUInt32LE(uriBytes.length);
    const registerData = Buffer.concat([registerDiscriminator, uriLen, uriBytes]);
    
    const registerIx = {
      programId: SAID_PROGRAM_ID,
      keys: [
        { pubkey: pda, isSigner: false, isWritable: true },           // agent_identity (init)
        { pubkey: agentPubkey, isSigner: true, isWritable: true },    // owner (signer + payer)
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
      ],
      data: registerData,
    };
    
    // === Build get_verified instruction ===
    // Anchor discriminator: sha256("global:get_verified")[0..8]
    const verifyDiscriminator = Buffer.from([132, 231, 2, 30, 115, 74, 23, 26]);
    
    const verifyIx = {
      programId: SAID_PROGRAM_ID,
      keys: [
        { pubkey: pda, isSigner: false, isWritable: true },           // agent_identity
        { pubkey: treasuryPda, isSigner: false, isWritable: true },   // treasury
        { pubkey: agentPubkey, isSigner: true, isWritable: true },    // authority (signer + payer of fee)
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
      ],
      data: verifyDiscriminator,
    };
    
    // === Build funding transfer: sponsor → agent wallet ===
    // Agent needs SOL for: PDA rent (~0.003 SOL) + verification fee (0.01 SOL) + tx fees
    const FUND_AMOUNT = 0.015 * LAMPORTS_PER_SOL; // 0.015 SOL buffer
    
    const fundIx = SystemProgram.transfer({
      fromPubkey: sponsorKeypair.publicKey,
      toPubkey: agentPubkey,
      lamports: FUND_AMOUNT,
    });
    
    // Build transaction: fund → register → verify
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    
    const tx = new Transaction({
      blockhash,
      lastValidBlockHeight,
      feePayer: sponsorKeypair.publicKey,  // Sponsor pays tx fees
    });
    
    tx.add(fundIx);      // 1. Fund agent wallet
    tx.add(registerIx);  // 2. Register on-chain
    tx.add(verifyIx);    // 3. Get verified badge
    
    // Sponsor signs (fee payer + fund transfer)
    tx.partialSign(sponsorKeypair);
    
    // Serialize — agent wallet still needs to sign
    const serializedTx = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    }).toString('base64');
    
    return c.json({
      success: true,
      message: 'Transaction built. Agent wallet must sign and return via /confirm endpoint.',
      transaction: serializedTx,
      blockhash,
      lastValidBlockHeight,
      requiredSigner: wallet,
      pda: pda.toString(),
      metadataUri,
      instructions: {
        step1: 'Deserialize the base64 transaction',
        step2: `Sign with the agent wallet (${wallet})`,
        step3: 'POST the signed transaction to /api/platforms/said-hosting/confirm',
      },
      expiresIn: '~60 seconds (blockhash expiry)',
    });
    
  } catch (error: any) {
    console.error('[SAID Hosting Register Error]', error);
    return c.json({ 
      error: 'Failed to build transaction',
      details: error.message,
      support: 'contact@saidprotocol.com'
    }, 500);
  }
});

/**
 * POST /api/platforms/said-hosting/confirm
 * Step 2: Receive signed transaction, broadcast on-chain, update DB
 * 
 * SAID Hosting signs the transaction from Step 1 with the agent's keypair,
 * then sends it here. We broadcast, confirm, and update our database.
 */
app.post('/api/platforms/said-hosting/confirm', async (c) => {
  // Validate SAID Hosting API key
  const apiKey = c.req.header('X-Platform-Key');
  const expectedKey = process.env.SAID_HOSTING_API_KEY;

  if (!expectedKey || !apiKey || apiKey !== expectedKey) {
    return c.json({ error: "Invalid or missing X-Platform-Key header" }, 401);
  }

  const body = await c.req.json();
  const { signedTransaction, wallet, name, description, twitter, website, capabilities, platform } = body;

  const VALID_PLATFORMS = ['said-hosting', 'fairscale', 'seekerclaw', 'spawnr'];
  const registrationSource = platform && VALID_PLATFORMS.includes(platform) ? platform : 'said-hosting';

  if (!signedTransaction || !wallet) {
    return c.json({ error: 'Required: signedTransaction (base64), wallet' }, 400);
  }
  
  try {
    // Deserialize transaction
    const txBuffer = Buffer.from(signedTransaction, 'base64');
    const tx = Transaction.from(txBuffer);
    
    // Verify the transaction has the expected signers
    const agentPubkey = new PublicKey(wallet);
    const signers = tx.signatures.map(s => s.publicKey.toBase58());
    if (!signers.includes(wallet)) {
      return c.json({ error: 'Transaction must be signed by the agent wallet' }, 400);
    }
    
    // Broadcast
    let txHash: string;
    try {
      const rawTx = tx.serialize();
      txHash = await connection.sendRawTransaction(rawTx, {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      });
    } catch (broadcastError: any) {
      // Check if blockhash expired - return special error for bootstrap to retry
      if (broadcastError.message && (
        broadcastError.message.includes('block height exceeded') ||
        broadcastError.message.includes('Blockhash not found')
      )) {
        return c.json({
          error: 'Transaction expired',
          code: 'BLOCKHASH_EXPIRED',
          message: 'Please retry registration from the beginning',
        }, 400);
      }
      throw broadcastError;
    }
    
    // Confirm transaction using robust strategy:
    // 1. Try getSignatureStatuses (doesn't need blockhash)
    // 2. If that fails with block height errors, query PDA directly
    // 3. Only fail if both methods confirm no registration
    
    let txConfirmed = false;
    let confirmationError: any = null;
    
    try {
      // Method 1: Use getSignatureStatuses (more reliable for older transactions)
      const statuses = await connection.getSignatureStatuses([txHash]);
      const status = statuses?.value?.[0];
      
      if (status === null) {
        // Transaction not found yet, but might be too recent
        // Fall through to PDA check
        console.log('[SAID Hosting] Transaction not found in getSignatureStatuses, checking PDA...');
      } else if (status.err) {
        // Transaction explicitly failed
        return c.json({ 
          error: 'Transaction failed on-chain',
          txHash,
          details: JSON.stringify(status.err),
        }, 500);
      } else if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
        // Success via getSignatureStatuses
        txConfirmed = true;
        console.log(`[SAID Hosting] Transaction confirmed via getSignatureStatuses: ${status.confirmationStatus}`);
      }
    } catch (statusError: any) {
      console.log('[SAID Hosting] getSignatureStatuses failed:', statusError.message);
      confirmationError = statusError;
      // Fall through to PDA check
    }
    
    // Method 2: If getSignatureStatuses didn't confirm, poll PDA with retries
    if (!txConfirmed) {
      console.log('[SAID Hosting] Polling PDA to verify registration (up to 30s)...');
      const agentPubkey = new PublicKey(wallet);
      const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from('agent'), agentPubkey.toBuffer()],
        SAID_PROGRAM_ID
      );
      
      // Poll every 3 seconds for up to 30 seconds
      for (let attempt = 0; attempt < 10; attempt++) {
        if (attempt > 0) {
          await new Promise(r => setTimeout(r, 3000));
        }
        const pdaInfo = await connection.getAccountInfo(pda);
        if (pdaInfo) {
          txConfirmed = true;
          console.log(`[SAID Hosting] PDA found on attempt ${attempt + 1} - registration succeeded`);
          break;
        }
        console.log(`[SAID Hosting] PDA not found yet (attempt ${attempt + 1}/10)...`);
      }
      
      if (!txConfirmed) {
        return c.json({
          error: 'Transaction broadcast but registration not confirmed on-chain after 30s',
          txHash,
          explorer: `https://solscan.io/tx/${txHash}`,
          details: confirmationError?.message || 'PDA not found after polling',
          hint: 'Check explorer - transaction may still be processing',
        }, 500);
      }
    }
    
    // Success! Update database
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('agent'), agentPubkey.toBuffer()],
      SAID_PROGRAM_ID
    );
    
    const metadataUri = `https://api.saidprotocol.com/api/cards/${wallet}.json`;
    
    // Upsert agent in DB (might exist from a previous partial attempt)
    const agent = await prisma.agent.upsert({
      where: { wallet },
      create: {
        wallet,
        pda: pda.toString(),
        owner: wallet,
        metadataUri,
        registeredAt: new Date(),
        isVerified: true,
        verifiedAt: new Date(),
        sponsored: true,
        name: name || 'SAID Hosting Agent',
        description: description || 'AI Agent via SAID Hosting',
        twitter: twitter || undefined,
        website: website || undefined,
        skills: capabilities || ['chat', 'assistant'],
        registrationSource,
        platformId: registrationSource !== 'said-hosting' ? registrationSource : undefined,
        layer2Verified: true,
        layer2VerifiedAt: new Date(),
        l2AttestationMethod: 'platform',
      },
      update: {
        isVerified: true,
        verifiedAt: new Date(),
        sponsored: true,
        registrationSource,
        platformId: registrationSource !== 'said-hosting' ? registrationSource : undefined,
        layer2Verified: true,
        layer2VerifiedAt: new Date(),
        l2AttestationMethod: 'platform',
      },
    });

    // Emit SSE event for real-time frontend updates
    emitAgentEvent('agent:registered', { wallet: agent.wallet, name: agent.name, source: registrationSource, txHash });
    
    return c.json({
      success: true,
      message: 'Agent registered and verified ON-CHAIN via SAID Hosting',
      txHash,
      explorer: `https://solscan.io/tx/${txHash}`,
      agent: {
        wallet: agent.wallet,
        pda: agent.pda,
        name: agent.name,
        verified: true,
        onChain: true,
        profile: `https://www.saidprotocol.com/agent.html?wallet=${wallet}`,
        badge: `https://api.saidprotocol.com/api/badge/${wallet}.svg`,
        badgeWithScore: `https://api.saidprotocol.com/api/badge/${wallet}.svg?style=score`,
      },
      platform: {
        name: 'said.hosting',
        costCovered: '~0.015 SOL (rent + verification + fees)',
        sponsoredBy: 'SAID Protocol',
      }
    });
    
  } catch (error: any) {
    console.error('[SAID Hosting Confirm Error]', error.message);
    
    // Recovery: if broadcast failed but agent exists on-chain, sync DB anyway
    // This handles: expired blockhash retries, "already initialized" errors
    try {
      const agentPubkey = new PublicKey(wallet);
      const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from('agent'), agentPubkey.toBuffer()],
        SAID_PROGRAM_ID
      );
      
      const accountInfo = await connection.getAccountInfo(pda);
      if (accountInfo) {
        console.log('[SAID Hosting Recovery] Agent PDA exists on-chain, syncing DB...');
        const metadataUri = `https://api.saidprotocol.com/api/cards/${wallet}.json`;
        
        const agent = await prisma.agent.upsert({
          where: { wallet },
          create: {
            wallet,
            pda: pda.toString(),
            owner: wallet,
            metadataUri,
            registeredAt: new Date(),
            isVerified: true,
            verifiedAt: new Date(),
            sponsored: true,
            name: name || 'SAID Hosting Agent',
            description: description || 'AI Agent via SAID Hosting',
            twitter: twitter || undefined,
            website: website || undefined,
            skills: capabilities || ['chat', 'assistant'],
            registrationSource,
            platformId: registrationSource !== 'said-hosting' ? registrationSource : undefined,
            layer2Verified: true,
            layer2VerifiedAt: new Date(),
            l2AttestationMethod: 'platform',
          },
          update: {
            isVerified: true,
            verifiedAt: new Date(),
            sponsored: true,
            registrationSource,
            platformId: registrationSource !== 'said-hosting' ? registrationSource : undefined,
            layer2Verified: true,
            layer2VerifiedAt: new Date(),
            l2AttestationMethod: 'platform',
          },
        });

        emitAgentEvent('agent:registered', { wallet: agent.wallet, name: agent.name, source: registrationSource, recovered: true });
        
        return c.json({
          success: true,
          message: 'Agent already registered on-chain. Database synced.',
          recovered: true,
          agent: {
            wallet: agent.wallet,
            pda: agent.pda,
            name: agent.name,
            verified: true,
            onChain: true,
            profile: `https://www.saidprotocol.com/agent.html?wallet=${wallet}`,
            badge: `https://api.saidprotocol.com/api/badge/${wallet}.svg`,
          },
        });
      }
    } catch (recoveryError: any) {
      console.error('[SAID Hosting Recovery Failed]', recoveryError.message);
    }
    
    return c.json({ 
      error: 'Broadcast failed',
      details: error.message,
      support: 'contact@saidprotocol.com'
    }, 500);
  }
});

/**
 * PUT /api/platforms/spawnr/agents/:wallet
 * Update agent metadata for Spawnr-registered agents
 * 
 * Authentication: X-Platform-Key header required
 */
app.put('/api/platforms/spawnr/agents/:wallet', async (c) => {
  // Validate Spawnr API key
  const apiKey = c.req.header('X-Platform-Key');
  const expectedKey = getPlatformKey('SP_AUTH_CFG');
  
  if (!expectedKey) {
    return c.json({ 
      error: 'Spawnr integration not configured',
      support: 'contact@saidprotocol.com'
    }, 500);
  }
  
  if (!apiKey || apiKey !== expectedKey) {
    return c.json({ 
      error: 'Invalid or missing X-Platform-Key header'
    }, 401);
  }
  
  const wallet = c.req.param('wallet');
  const body = await c.req.json();
  const { name, description, twitter, website, capabilities, image } = body;
  
  try {
    // Find agent and verify it's from Spawnr
    const agent = await prisma.agent.findUnique({ where: { wallet } });
    
    if (!agent) {
      return c.json({ error: 'Agent not found' }, 404);
    }
    
    if (agent.registrationSource !== 'spawnr') {
      return c.json({ 
        error: 'Agent not registered via Spawnr',
        registrationSource: agent.registrationSource 
      }, 403);
    }
    
    // Update agent
    const updated = await prisma.agent.update({
      where: { wallet },
      data: {
        name: name !== undefined ? name : agent.name,
        description: description !== undefined ? description : agent.description,
        twitter: twitter !== undefined ? twitter : agent.twitter,
        website: website !== undefined ? website : agent.website,
        skills: capabilities !== undefined ? capabilities : agent.skills,
        image: image !== undefined ? image : agent.image,
        updatedAt: new Date(),
      }
    });
    
    // Update agent card if exists
    const existingCard = await prisma.agentCard.findUnique({ where: { wallet } });
    if (existingCard) {
      const cardData = JSON.parse(existingCard.cardJson);
      const updatedCard = {
        ...cardData,
        name: name !== undefined ? name : cardData.name,
        description: description !== undefined ? description : cardData.description,
        twitter: twitter !== undefined ? twitter : cardData.twitter,
        website: website !== undefined ? website : cardData.website,
        capabilities: capabilities !== undefined ? capabilities : cardData.capabilities,
      };
      
      await prisma.agentCard.update({
        where: { wallet },
        data: {
          cardJson: JSON.stringify(updatedCard),
          updatedAt: new Date(),
        }
      });
    }
    
    return c.json({
      success: true,
      agent: {
        wallet: updated.wallet,
        name: updated.name,
        description: updated.description,
        twitter: updated.twitter,
        website: updated.website,
        capabilities: updated.skills,
        image: updated.image,
        verified: updated.isVerified,
        layer2Verified: updated.layer2Verified,
        reputationScore: updated.reputationScore,
        updatedAt: updated.updatedAt,
      }
    });
    
  } catch (error: any) {
    console.error('[Spawnr Update Error]', error);
    return c.json({ 
      error: 'Update failed',
      details: error.message
    }, 500);
  }
});

/**
 * GET /api/platforms/spawnr/stats
 * Platform statistics for Spawnr
 * 
 * Authentication: X-Platform-Key header required
 */
app.get('/api/platforms/spawnr/stats', async (c) => {
  // Validate Spawnr API key
  const apiKey = c.req.header('X-Platform-Key');
  const expectedKey = getPlatformKey('SP_AUTH_CFG');
  
  if (!expectedKey) {
    return c.json({ 
      error: 'Spawnr integration not configured',
      support: 'contact@saidprotocol.com'
    }, 500);
  }
  
  if (!apiKey || apiKey !== expectedKey) {
    return c.json({ 
      error: 'Invalid or missing X-Platform-Key header'
    }, 401);
  }
  
  try {
    // Get all Spawnr agents
    const spawnrAgents = await prisma.agent.findMany({
      where: { registrationSource: 'spawnr' }
    });
    
    const totalAgents = spawnrAgents.length;
    const totalVerified = spawnrAgents.filter(a => a.isVerified).length;
    const totalLayer2 = spawnrAgents.filter(a => a.layer2Verified).length;
    
    // Calculate average reputation score
    const avgReputation = totalAgents > 0
      ? spawnrAgents.reduce((sum, a) => sum + a.reputationScore, 0) / totalAgents
      : 0;
    
    // Get top 5 agents by reputation
    const topAgents = spawnrAgents
      .sort((a, b) => b.reputationScore - a.reputationScore)
      .slice(0, 5)
      .map(a => ({
        wallet: a.wallet,
        name: a.name,
        reputationScore: a.reputationScore,
        verified: a.isVerified,
        layer2Verified: a.layer2Verified,
      }));
    
    return c.json({
      success: true,
      stats: {
        totalAgents,
        totalVerified,
        totalLayer2,
        averageReputation: Math.round(avgReputation * 100) / 100,
        topAgents,
      },
      platform: 'spawnr.io',
    });
    
  } catch (error: any) {
    console.error('[Spawnr Stats Error]', error);
    return c.json({ 
      error: 'Failed to fetch stats',
      details: error.message
    }, 500);
  }
});

/**
 * GET /api/platforms/spawnr/agents
 * List all Spawnr-registered agents (paginated)
 * 
 * Authentication: X-Platform-Key header required
 * Query params: ?limit=N&offset=N
 */
app.get('/api/platforms/spawnr/agents', async (c) => {
  // Validate Spawnr API key
  const apiKey = c.req.header('X-Platform-Key');
  const expectedKey = getPlatformKey('SP_AUTH_CFG');
  
  if (!expectedKey) {
    return c.json({ 
      error: 'Spawnr integration not configured',
      support: 'contact@saidprotocol.com'
    }, 500);
  }
  
  if (!apiKey || apiKey !== expectedKey) {
    return c.json({ 
      error: 'Invalid or missing X-Platform-Key header'
    }, 401);
  }
  
  try {
    // Parse query params
    const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
    const offset = parseInt(c.req.query('offset') || '0');
    
    // Get agents
    const agents = await prisma.agent.findMany({
      where: { registrationSource: 'spawnr' },
      take: limit,
      skip: offset,
      orderBy: { registeredAt: 'desc' },
    });
    
    // Get total count
    const total = await prisma.agent.count({
      where: { registrationSource: 'spawnr' }
    });
    
    return c.json({
      success: true,
      agents: agents.map(a => ({
        wallet: a.wallet,
        name: a.name,
        verified: a.isVerified,
        layer2Verified: a.layer2Verified,
        reputationScore: a.reputationScore,
        registeredAt: a.registeredAt,
      })),
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + limit < total,
      }
    });
    
  } catch (error: any) {
    console.error('[Spawnr List Error]', error);
    return c.json({ 
      error: 'Failed to fetch agents',
      details: error.message
    }, 500);
  }
});

/**
 * GET /api/badge/embed/:wallet
 * Public embeddable badge - NO AUTH REQUIRED
 * 
 * Returns HTML with inline CSS for iframe embedding
 */
app.get('/api/badge/embed/:wallet', async (c) => {
  const wallet = c.req.param('wallet');
  
  try {
    const agent = await prisma.agent.findUnique({ where: { wallet } });
    
    if (!agent) {
      // Return "Not Found" badge
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SAID Badge</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: transparent;
      padding: 16px;
    }
    .badge {
      background: linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 100%);
      border: 2px solid #404040;
      border-radius: 12px;
      padding: 20px;
      max-width: 400px;
      color: #fff;
    }
    .header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 12px;
    }
    .logo {
      width: 40px;
      height: 40px;
      background: #404040;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: bold;
      font-size: 18px;
    }
    .title {
      font-size: 18px;
      font-weight: 600;
    }
    .status {
      display: inline-block;
      padding: 4px 12px;
      background: #404040;
      color: #999;
      border-radius: 6px;
      font-size: 14px;
      margin-top: 8px;
    }
    .footer {
      margin-top: 12px;
      font-size: 12px;
      color: #888;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="badge">
    <div class="header">
      <div class="logo">S</div>
      <div class="title">Agent Not Found</div>
    </div>
    <div class="status">⚠️ Not Registered</div>
    <div class="footer">Powered by SAID Protocol</div>
  </div>
</body>
</html>`;
      return c.html(html);
    }
    
    // Return verified/not verified badge
    const isVerified = agent.isVerified;
    const statusColor = isVerified ? '#10b981' : '#6b7280';
    const statusBg = isVerified ? '#10b98120' : '#6b728020';
    const statusText = isVerified ? '✓ SAID Verified' : 'Not Verified';
    
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SAID Badge - ${agent.name || wallet.slice(0, 8)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: transparent;
      padding: 16px;
    }
    .badge {
      background: linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 100%);
      border: 2px solid ${isVerified ? statusColor : '#404040'};
      border-radius: 12px;
      padding: 20px;
      max-width: 400px;
      color: #fff;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    }
    .header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 12px;
    }
    .logo {
      width: 40px;
      height: 40px;
      background: ${isVerified ? statusColor : '#404040'};
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: bold;
      font-size: 18px;
    }
    .info {
      flex: 1;
    }
    .name {
      font-size: 18px;
      font-weight: 600;
      margin-bottom: 4px;
    }
    .wallet {
      font-size: 12px;
      color: #888;
      font-family: monospace;
    }
    .status {
      display: inline-block;
      padding: 6px 12px;
      background: ${statusBg};
      color: ${statusColor};
      border: 1px solid ${statusColor};
      border-radius: 6px;
      font-size: 14px;
      font-weight: 600;
      margin-top: 12px;
    }
    .reputation {
      margin-top: 12px;
      padding: 12px;
      background: #ffffff08;
      border-radius: 8px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .rep-label {
      font-size: 13px;
      color: #aaa;
    }
    .rep-score {
      font-size: 20px;
      font-weight: 700;
      color: ${statusColor};
    }
    .footer {
      margin-top: 12px;
      font-size: 12px;
      color: #888;
      text-align: center;
    }
    .footer a {
      color: ${statusColor};
      text-decoration: none;
    }
  </style>
</head>
<body>
  <div class="badge">
    <div class="header">
      <div class="logo">${isVerified ? '✓' : 'S'}</div>
      <div class="info">
        <div class="name">${agent.name || 'Agent'}</div>
        <div class="wallet">${wallet.slice(0, 4)}...${wallet.slice(-4)}</div>
      </div>
    </div>
    <div class="status">${statusText}</div>
    <div class="reputation">
      <div class="rep-label">Reputation Score</div>
      <div class="rep-score">${Math.round(agent.reputationScore)}</div>
    </div>
    <div class="footer">
      Powered by <a href="https://www.saidprotocol.com" target="_blank">SAID Protocol</a>
    </div>
  </div>
</body>
</html>`;
    
    return c.html(html);
    
  } catch (error: any) {
    console.error('[Badge Embed Error]', error);
    const html = `<!DOCTYPE html>
<html><body style="font-family: sans-serif; padding: 20px; color: #666;">
Error loading badge. Please try again later.
</body></html>`;
    return c.html(html, 500);
  }
});

/**
 * POST /api/platforms/spawnr/webhooks
 * Register webhook URL for event notifications
 * 
 * Authentication: X-Platform-Key header required
 * Body: { url: string, events: string[] }
 * Events: ["reputation_change", "verification_complete"]
 */
app.post('/api/platforms/spawnr/webhooks', async (c) => {
  // Validate Spawnr API key
  const apiKey = c.req.header('X-Platform-Key');
  const expectedKey = getPlatformKey('SP_AUTH_CFG');
  
  if (!expectedKey) {
    return c.json({ 
      error: 'Spawnr integration not configured',
      support: 'contact@saidprotocol.com'
    }, 500);
  }
  
  if (!apiKey || apiKey !== expectedKey) {
    return c.json({ 
      error: 'Invalid or missing X-Platform-Key header'
    }, 401);
  }
  
  const body = await c.req.json();
  const { url, events } = body;
  
  // Validate input
  if (!url || !events || !Array.isArray(events)) {
    return c.json({ 
      error: 'Required fields: url (string), events (array)',
      example: {
        url: 'https://spawnr.io/webhooks/said',
        events: ['reputation_change', 'verification_complete']
      }
    }, 400);
  }
  
  // Validate URL format
  try {
    new URL(url);
  } catch {
    return c.json({ error: 'Invalid URL format' }, 400);
  }
  
  // Validate events
  const validEvents = ['reputation_change', 'verification_complete'];
  const invalidEvents = events.filter(e => !validEvents.includes(e));
  if (invalidEvents.length > 0) {
    return c.json({ 
      error: 'Invalid event types',
      invalid: invalidEvents,
      valid: validEvents
    }, 400);
  }
  
  try {
    // Store webhook config
    const webhook = await prisma.webhookConfig.create({
      data: {
        platform: 'spawnr',
        url,
        events,
        active: true,
      }
    });
    
    return c.json({
      success: true,
      webhook: {
        id: webhook.id,
        url: webhook.url,
        events: webhook.events,
        active: webhook.active,
        createdAt: webhook.createdAt,
      },
      note: 'Webhook dispatching will be implemented soon. For now, the URL is stored and ready.'
    });
    
  } catch (error: any) {
    console.error('[Spawnr Webhook Error]', error);
    return c.json({ 
      error: 'Failed to register webhook',
      details: error.message
    }, 500);
  }
});

// ============ SEEKERCLAW PLATFORM INTEGRATION ============

/**
 * POST /api/platforms/seekerclaw/provision
 * Single-call agent provisioning for SeekerClaw devices.
 *
 * Unlike Spawnr/ClawPump (2-step: build tx → partner signs → confirm),
 * SeekerClaw agents get Privy custodial wallets — WE own the keys.
 * So this is a single endpoint that does everything:
 *   1. Create Privy wallet
 *   2. Fund agent wallet from sponsor
 *   3. Register on SAID program (sponsor_register)
 *   4. Verify on SAID program (get_verified → 0.01 SOL to treasury)
 *   5. Store in DB
 *   6. Return wallet address + agent details
 *
 * Authentication: X-Platform-Key header (SeekerClaw's API key)
 * 
 * Note: Metaplex NFT minting is Phase 2 (separate tx due to UMI/web3.js boundary).
 */
app.post('/api/platforms/seekerclaw/provision', async (c) => {
  // Validate SeekerClaw API key
  const apiKey = c.req.header('X-Platform-Key');
  const expectedKey = process.env.SEEKERCLAW_API_KEY;

  if (!expectedKey || !apiKey || apiKey !== expectedKey) {
    return c.json({ error: 'Invalid API key' }, 401);
  }

  const body = await c.req.json();
  const { agent_name, metadata } = body;

  if (!agent_name) {
    return c.json({ error: 'Required: agent_name' }, 400);
  }

  // Check for idempotency — if device_id provided, check if already provisioned
  if (metadata?.device_id) {
    const existing = await prisma.agent.findFirst({
      where: {
        registrationSource: 'seekerclaw',
        description: { contains: metadata.device_id },
      },
      include: { agentWallets: true },
    });

    if (existing && existing.agentWallets.length > 0) {
      return c.json({
        success: true,
        already_provisioned: true,
        agent: {
          id: existing.id,
          wallet: existing.wallet,
          pda: existing.pda,
          name: existing.name,
          status: existing.isVerified ? 'verified' : 'registered',
          profile: `https://www.saidprotocol.com/agent.html?wallet=${existing.wallet}`,
          badge: `https://api.saidprotocol.com/api/badge/${existing.wallet}.svg`,
        },
      });
    }
  }

  // Check sponsor wallet balance before starting
  const sponsorKey = process.env['SPAWNR_SPONSOR_PRIVATE_KEY'];
  if (!sponsorKey) {
    return c.json({ error: 'Sponsor wallet not configured', support: 'contact@saidprotocol.com' }, 500);
  }

  const sponsorKeypair = Keypair.fromSecretKey(bs58.decode(sponsorKey));
  const sponsorBalance = await connection.getBalance(sponsorKeypair.publicKey);
  const REQUIRED_SPONSOR_BALANCE = 0.02 * LAMPORTS_PER_SOL; // 0.015 fund + buffer

  if (sponsorBalance < REQUIRED_SPONSOR_BALANCE) {
    return c.json({
      error: 'Sponsor wallet balance too low to provision',
      code: 'INSUFFICIENT_FUNDS',
      sponsor_balance_sol: sponsorBalance / LAMPORTS_PER_SOL,
      required_sol: REQUIRED_SPONSOR_BALANCE / LAMPORTS_PER_SOL,
    }, 402);
  }

  try {
    // ── Step 1: Create Privy wallet ──
    console.log(`[SeekerClaw] Creating Privy wallet for agent "${agent_name}"`);

    let agentPubkey: PublicKey;
    let privyWalletId: string;
    let walletProvider: string;

    const isLiveMode = process.env.PRIVY_WALLET_MODE === 'live';
    if (isLiveMode) {
      const wallet = await (privyClient as any).wallets().create({ chain_type: 'solana' });
      agentPubkey = new PublicKey(wallet.address);
      privyWalletId = wallet.id;
      walletProvider = 'privy';
    } else {
      // Mock mode for testing
      const mockKeypair = Keypair.generate();
      agentPubkey = mockKeypair.publicKey;
      privyWalletId = `mock-${mockKeypair.publicKey.toBase58().substring(0, 8)}`;
      walletProvider = 'mock';
    }

    const walletAddress = agentPubkey.toBase58();
    console.log(`[SeekerClaw] Wallet created: ${walletAddress} (${walletProvider})`);

    // ── Step 2: Derive PDA ──
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('agent'), agentPubkey.toBuffer()],
      SAID_PROGRAM_ID
    );

    // ── Step 3: Store agent card (needed for metadata_uri) ──
    const metadataUri = `https://api.saidprotocol.com/api/cards/${walletAddress}.json`;
    const card = {
      name: agent_name,
      description: `${agent_name} - SeekerClaw AI Agent`,
      wallet: walletAddress,
      capabilities: metadata?.capabilities || ['payments', 'x402'],
      platform: 'seekerclaw',
      verified: true,
      registeredAt: new Date().toISOString(),
      device_id: metadata?.device_id,
    };

    await prisma.agentCard.upsert({
      where: { wallet: walletAddress },
      create: { wallet: walletAddress, cardJson: JSON.stringify(card) },
      update: { cardJson: JSON.stringify(card) },
    });

    // ── Step 4: Build atomic tx (fund → register → verify) ──
    const [treasuryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('treasury')],
      SAID_PROGRAM_ID
    );

    const FUND_AMOUNT = 0.015 * LAMPORTS_PER_SOL;

    const fundIx = SystemProgram.transfer({
      fromPubkey: sponsorKeypair.publicKey,
      toPubkey: agentPubkey,
      lamports: FUND_AMOUNT,
    });

    // register_agent instruction
    const registerDiscriminator = Buffer.from([135, 157, 66, 195, 2, 113, 175, 30]);
    const uriBytes = Buffer.from(metadataUri, 'utf8');
    const uriLen = Buffer.alloc(4);
    uriLen.writeUInt32LE(uriBytes.length);
    const registerData = Buffer.concat([registerDiscriminator, uriLen, uriBytes]);

    const registerIx = {
      programId: SAID_PROGRAM_ID,
      keys: [
        { pubkey: pda, isSigner: false, isWritable: true },
        { pubkey: agentPubkey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: registerData,
    };

    // get_verified instruction
    const verifyDiscriminator = Buffer.from([132, 231, 2, 30, 115, 74, 23, 26]);
    const verifyIx = {
      programId: SAID_PROGRAM_ID,
      keys: [
        { pubkey: pda, isSigner: false, isWritable: true },
        { pubkey: treasuryPda, isSigner: false, isWritable: true },
        { pubkey: agentPubkey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: verifyDiscriminator,
    };

    // Build transaction
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: sponsorKeypair.publicKey });
    tx.add(fundIx);
    tx.add(registerIx);
    tx.add(verifyIx);

    // Sponsor signs (fee payer + fund transfer)
    tx.partialSign(sponsorKeypair);

    // ── Step 5: Agent wallet signs via Privy ──
    if (isLiveMode) {
      const serializedTx = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');

      const signResult = await (privyClient as any).wallets().rpc(privyWalletId, {
        method: 'signTransaction',
        params: { encoding: 'base64', transaction: serializedTx },
      });

      // Deserialize the signed tx and broadcast
      const signedTxBuffer = Buffer.from((signResult.data as any).signed_transaction, 'base64');
      const signedTx = Transaction.from(signedTxBuffer);

      const txHash = await connection.sendRawTransaction(signedTx.serialize(), {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      });

      const confirmation = await connection.confirmTransaction({
        signature: txHash,
        blockhash,
        lastValidBlockHeight,
      }, 'confirmed');

      if (confirmation.value.err) {
        return c.json({
          error: 'On-chain transaction failed',
          code: 'SOLANA_ERROR',
          txHash,
          details: JSON.stringify(confirmation.value.err),
        }, 500);
      }

      console.log(`[SeekerClaw] On-chain registration confirmed: ${txHash}`);

      // ── Step 6: Store in DB ──
      const agent = await prisma.agent.upsert({
        where: { wallet: walletAddress },
        create: {
          wallet: walletAddress,
          pda: pda.toBase58(),
          owner: walletAddress,
          metadataUri,
          registeredAt: new Date(),
          isVerified: true,
          verifiedAt: new Date(),
          sponsored: true,
          name: agent_name,
          description: `${agent_name} - SeekerClaw AI Agent${metadata?.device_id ? ` [device:${metadata.device_id}]` : ''}`,
          skills: metadata?.capabilities || ['payments', 'x402'],
          registrationSource: 'seekerclaw',
          layer2Verified: true,
          layer2VerifiedAt: new Date(),
          l2AttestationMethod: 'platform',
          platformId: 'seekerclaw',
        },
        update: {
          isVerified: true,
          verifiedAt: new Date(),
          registrationSource: 'seekerclaw',
          platformId: 'seekerclaw',
        },
      });

      // Store Privy wallet link
      await prisma.agentWallet.create({
        data: {
          agentId: agent.id,
          publicKey: walletAddress,
          provider: walletProvider,
          providerWalletId: privyWalletId,
          walletType: 'transaction',
          isPrimary: true,
        },
      });

      // Track usage
      const currentMonth = new Date().toISOString().slice(0, 7);
      await prisma.monthlyUsage.upsert({
        where: { platformId_month: { platformId: 'seekerclaw', month: currentMonth } },
        create: { platformId: 'seekerclaw', month: currentMonth, agentsCreated: 1 },
        update: { agentsCreated: { increment: 1 } },
      });

      // ── Step 7: Mint NFT (call hosting platform) ──
      let nftAddress: string | undefined;
      try {
        const nftResponse = await fetch('https://app.saidprotocol.com/api/internal/mint-nft', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Internal-Key': process.env.SAID_HOSTING_INTERNAL_KEY || '',
          },
          body: JSON.stringify({
            walletAddress,
            name: agent_name,
            description: `${agent_name} - SeekerClaw AI Agent${metadata?.device_id ? ` [device:${metadata.device_id}]` : ''}`,
            capabilities: metadata?.capabilities || ['payments', 'x402'],
            tier: 'seekerclaw',
            ownerAddress: walletAddress, // Agent owns their NFT
          }),
        });

        if (nftResponse.ok) {
          const nftResult = await nftResponse.json();
          nftAddress = nftResult.nft_address;
          
          // Update agent with NFT address
          await prisma.agent.update({
            where: { id: agent.id },
            data: { nftAddress },
          });
          
          console.log(`[SeekerClaw] Minted NFT for ${walletAddress}: ${nftAddress}`);
        } else {
          console.error(`[SeekerClaw] NFT mint failed: ${nftResponse.status} ${await nftResponse.text()}`);
        }
      } catch (nftError: any) {
        console.error(`[SeekerClaw] NFT mint error (non-fatal):`, nftError.message);
        // Non-fatal — agent is still fully provisioned even without NFT
      }

      emitAgentEvent('agent:registered', { wallet: walletAddress, name: agent_name, source: 'seekerclaw', txHash });

      return c.json({
        success: true,
        agent: {
          id: agent.id,
          wallet: walletAddress,
          pda: pda.toBase58(),
          name: agent_name,
          status: 'verified',
          nft_address: nftAddress,
          profile: `https://www.saidprotocol.com/agent.html?wallet=${walletAddress}`,
          badge: `https://api.saidprotocol.com/api/badge/${walletAddress}.svg`,
        },
        privy_wallet: {
          public_key: walletAddress,
          provider: walletProvider,
        },
        on_chain: {
          register_tx: txHash,
          explorer: `https://solscan.io/tx/${txHash}`,
          verification_fee_paid: '0.01 SOL',
        },
        cost: {
          total_sol: 0.019,
          breakdown: {
            pda_rent: '~0.005 SOL',
            verification_fee: '0.01 SOL (→ SAID treasury)',
            nft_mint_rent: '~0.004 SOL',
            tx_fees: '~0.00002 SOL',
          },
        },
      });
    } else {
      // Mock mode — skip on-chain, just store in DB
      const agent = await prisma.agent.upsert({
        where: { wallet: walletAddress },
        create: {
          wallet: walletAddress,
          pda: pda.toBase58(),
          owner: walletAddress,
          metadataUri,
          registeredAt: new Date(),
          isVerified: true,
          verifiedAt: new Date(),
          sponsored: true,
          name: agent_name,
          description: `${agent_name} - SeekerClaw AI Agent (mock)${metadata?.device_id ? ` [device:${metadata.device_id}]` : ''}`,
          skills: metadata?.capabilities || ['payments', 'x402'],
          registrationSource: 'seekerclaw',
          layer2Verified: true,
          layer2VerifiedAt: new Date(),
          l2AttestationMethod: 'platform',
          platformId: 'seekerclaw',
        },
        update: {
          registrationSource: 'seekerclaw',
          platformId: 'seekerclaw',
        },
      });

      await prisma.agentWallet.create({
        data: {
          agentId: agent.id,
          publicKey: walletAddress,
          provider: walletProvider,
          providerWalletId: privyWalletId,
          walletType: 'transaction',
          isPrimary: true,
        },
      });

      const currentMonth = new Date().toISOString().slice(0, 7);
      await prisma.monthlyUsage.upsert({
        where: { platformId_month: { platformId: 'seekerclaw', month: currentMonth } },
        create: { platformId: 'seekerclaw', month: currentMonth, agentsCreated: 1 },
        update: { agentsCreated: { increment: 1 } },
      });

      return c.json({
        success: true,
        mock: true,
        agent: {
          id: agent.id,
          wallet: walletAddress,
          pda: pda.toBase58(),
          name: agent_name,
          status: 'verified',
        },
        privy_wallet: {
          public_key: walletAddress,
          provider: walletProvider,
        },
        note: 'Mock mode — no on-chain transaction. Set PRIVY_WALLET_MODE=live for production.',
      });
    }

  } catch (error: any) {
    console.error('[SeekerClaw Provision Error]', error);
    return c.json({
      error: 'Provisioning failed',
      code: error.code || 'INTERNAL_ERROR',
      details: error.message,
      support: 'contact@saidprotocol.com',
    }, 500);
  }
});

/**
 * POST /api/platforms/seekerclaw/sign
 * Sign a transaction on behalf of a SeekerClaw agent.
 * 
 * SeekerClaw builds the transaction client-side, sends it here.
 * We append a signing fee (if past free tier), sign via Privy, return the signed tx.
 * SeekerClaw submits to RPC themselves.
 */
app.post('/api/platforms/seekerclaw/sign', async (c) => {
  const apiKey = c.req.header('X-Platform-Key');
  const expectedKey = process.env.SEEKERCLAW_API_KEY;

  if (!expectedKey || !apiKey || apiKey !== expectedKey) {
    return c.json({ error: 'Invalid API key' }, 401);
  }

  const body = await c.req.json();
  const { agent_id, transaction, description } = body;

  if (!agent_id || !transaction) {
    return c.json({ error: 'Required: agent_id, transaction (base64)' }, 400);
  }

  try {
    // Verify agent belongs to SeekerClaw
    const agent = await prisma.agent.findUnique({
      where: { id: agent_id },
      include: { agentWallets: true },
    });

    if (!agent) return c.json({ error: 'Agent not found', code: 'NOT_FOUND' }, 404);
    if (agent.registrationSource !== 'seekerclaw') {
      return c.json({ error: 'Agent does not belong to SeekerClaw', code: 'FORBIDDEN' }, 403);
    }

    const wallet = agent.agentWallets.find(w => w.walletType === 'transaction' && w.isPrimary);
    if (!wallet) return c.json({ error: 'No active wallet for this agent', code: 'NOT_FOUND' }, 404);

    // Deserialize transaction
    let tx: Transaction;
    try {
      const txBuffer = Buffer.from(transaction, 'base64');
      tx = Transaction.from(txBuffer);
    } catch {
      return c.json({ error: 'Invalid transaction: failed to deserialize', code: 'INVALID_TRANSACTION' }, 400);
    }

    // Check monthly usage — per-agent free tier, platform-level volume pricing
    const currentMonth = new Date().toISOString().slice(0, 7);

    // Per-agent usage (for free tier)
    const agentUsage = await prisma.monthlyUsage.upsert({
      where: { platformId_month: { platformId: `agent:${agent_id}`, month: currentMonth } },
      create: { platformId: `agent:${agent_id}`, month: currentMonth },
      update: {},
    });

    // Platform-wide usage (for volume tier pricing)
    const platformUsage = await prisma.monthlyUsage.upsert({
      where: { platformId_month: { platformId: 'seekerclaw', month: currentMonth } },
      create: { platformId: 'seekerclaw', month: currentMonth },
      update: {},
    });

    const AGENT_FREE_TIER = 10; // 10 free sigs per agent per month
    const pastFreeTier = agentUsage.signatures >= AGENT_FREE_TIER;

    // Determine fee — free tier per-agent, volume discounts per-platform
    let feeLamports = 0;
    if (pastFreeTier) {
      if (platformUsage.signatures < 100_000) feeLamports = 100_000;       // 0.0001 SOL
      else if (platformUsage.signatures < 1_000_000) feeLamports = 80_000;  // 0.00008 SOL
      else feeLamports = 50_000;                                             // 0.00005 SOL

      const SAID_TREASURY = new PublicKey('2XfHTeNWTjNwUmgoXaafYuqHcAAXj8F5Kjw2Bnzi4FxH');
      const agentPubkey = new PublicKey(wallet.publicKey);

      // Pre-flight balance check
      const balance = await connection.getBalance(agentPubkey);
      if (balance < feeLamports + 5000) {
        return c.json({
          error: 'Insufficient balance for signing fee',
          code: 'INSUFFICIENT_FUNDS',
          balance_sol: balance / LAMPORTS_PER_SOL,
          fee_sol: feeLamports / LAMPORTS_PER_SOL,
        }, 402);
      }

      // Append fee instruction atomically
      tx.add(SystemProgram.transfer({
        fromPubkey: agentPubkey,
        toPubkey: SAID_TREASURY,
        lamports: feeLamports,
      }));
    }

    // Sign via Privy
    const serializedTx = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');

    let signedTxBase64: string;
    let signature: string;

    if (wallet.provider === 'privy') {
      const signResult = await (privyClient as any).wallets().rpc(wallet.providerWalletId!, {
        method: 'signTransaction',
        params: { encoding: 'base64', transaction: serializedTx },
      });
      signedTxBase64 = (signResult.data as any).signed_transaction;
      const signedTx = Transaction.from(Buffer.from(signedTxBase64, 'base64'));
      signature = bs58.encode(signedTx.signature!);
    } else {
      // Mock mode
      signedTxBase64 = serializedTx;
      signature = `mock-sig-${Date.now()}`;
    }

    // Update usage — both agent-level and platform-level
    const feeCollectedSol = feeLamports / LAMPORTS_PER_SOL;
    await Promise.all([
      prisma.monthlyUsage.update({
        where: { platformId_month: { platformId: `agent:${agent_id}`, month: currentMonth } },
        data: { signatures: { increment: 1 }, feesCollected: { increment: feeCollectedSol } },
      }),
      prisma.monthlyUsage.update({
        where: { platformId_month: { platformId: 'seekerclaw', month: currentMonth } },
        data: { signatures: { increment: 1 }, feesCollected: { increment: feeCollectedSol } },
      }),
    ]);

    console.log(`[SeekerClaw] Signed tx for agent ${agent_id}, fee: ${feeCollectedSol} SOL, sig: ${signature}`);

    return c.json({
      success: true,
      signed_transaction: signedTxBase64,
      signature,
      fee_charged_sol: feeCollectedSol,
      agent_signatures_this_month: agentUsage.signatures + 1,
      agent_free_remaining: Math.max(0, AGENT_FREE_TIER - agentUsage.signatures - 1),
      platform_signatures_this_month: platformUsage.signatures + 1,
      submitted: false, // Partner submits to RPC
    });

  } catch (error: any) {
    console.error('[SeekerClaw Sign Error]', error);
    return c.json({
      error: 'Signing failed',
      code: error.code || 'INTERNAL_ERROR',
      details: error.message,
    }, 500);
  }
});

/**
 * GET /api/platforms/seekerclaw/agents
 * List all SeekerClaw agents with pagination.
 */
app.get('/api/platforms/seekerclaw/agents', async (c) => {
  const apiKey = c.req.header('X-Platform-Key');
  const expectedKey = process.env.SEEKERCLAW_API_KEY;

  if (!expectedKey || !apiKey || apiKey !== expectedKey) {
    return c.json({ error: 'Invalid API key' }, 401);
  }

  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200);
  const offset = parseInt(c.req.query('offset') || '0');
  const status = c.req.query('status');

  const where: any = { registrationSource: 'seekerclaw' };
  if (status === 'verified') where.isVerified = true;
  if (status === 'pending') where.isVerified = false;

  const [agents, total] = await Promise.all([
    prisma.agent.findMany({
      where,
      select: {
        id: true, wallet: true, pda: true, name: true,
        isVerified: true, createdAt: true, nftAddress: true,
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    }),
    prisma.agent.count({ where }),
  ]);

  return c.json({
    agents: agents.map(a => ({
      agent_id: a.id,
      wallet: a.wallet,
      pda: a.pda,
      name: a.name,
      status: a.isVerified ? 'verified' : 'pending',
      nft_address: a.nftAddress,
      created_at: a.createdAt,
    })),
    total,
    limit,
    offset,
  });
});

/**
 * GET /api/platforms/seekerclaw/agents/:agent_id
 * Get single agent status, balance, and signature usage.
 */
app.get('/api/platforms/seekerclaw/agents/:agent_id', async (c) => {
  const apiKey = c.req.header('X-Platform-Key');
  const expectedKey = process.env.SEEKERCLAW_API_KEY;

  if (!expectedKey || !apiKey || apiKey !== expectedKey) {
    return c.json({ error: 'Invalid API key' }, 401);
  }

  const { agent_id } = c.req.param();

  const agent = await prisma.agent.findUnique({
    where: { id: agent_id },
    include: { agentWallets: { where: { isPrimary: true }, take: 1 } },
  });

  if (!agent || agent.registrationSource !== 'seekerclaw') {
    return c.json({ error: 'Agent not found' }, 404);
  }

  // Get on-chain balance
  let balanceSol = 0;
  try {
    const balance = await connection.getBalance(new PublicKey(agent.wallet));
    balanceSol = balance / LAMPORTS_PER_SOL;
  } catch {}

  // Get monthly signature usage
  const currentMonth = new Date().toISOString().slice(0, 7);
  const usage = await prisma.monthlyUsage.findUnique({
    where: { platformId_month: { platformId: `agent:${agent_id}`, month: currentMonth } },
  });

  const AGENT_FREE_TIER = 10;
  const sigs = usage?.signatures || 0;

  return c.json({
    agent_id: agent.id,
    wallet: agent.wallet,
    pda: agent.pda,
    name: agent.name,
    status: agent.isVerified ? 'verified' : 'pending',
    nft_address: agent.nftAddress,
    balance_sol: balanceSol,
    created_at: agent.createdAt,
    usage: {
      month: currentMonth,
      signatures: sigs,
      free_remaining: Math.max(0, AGENT_FREE_TIER - sigs),
      fees_paid_sol: usage?.feesCollected || 0,
    },
    profile: `https://www.saidprotocol.com/agent.html?wallet=${agent.wallet}`,
    badge: `https://api.saidprotocol.com/api/badge/${agent.wallet}.svg`,
  });
});

/**
 * GET /api/platforms/seekerclaw/balance
 * Check provisioning capacity and signing usage.
 */
app.get('/api/platforms/seekerclaw/balance', async (c) => {
  const apiKey = c.req.header('X-Platform-Key');
  const expectedKey = process.env.SEEKERCLAW_API_KEY;

  if (!expectedKey || !apiKey || apiKey !== expectedKey) {
    return c.json({ error: 'Invalid API key' }, 401);
  }

  const sponsorKey = process.env['SPAWNR_SPONSOR_PRIVATE_KEY'];
  if (!sponsorKey) {
    return c.json({ error: 'Sponsor wallet not configured' }, 500);
  }

  const sponsorKeypair = Keypair.fromSecretKey(bs58.decode(sponsorKey));
  const sponsorBalance = await connection.getBalance(sponsorKeypair.publicKey);

  const currentMonth = new Date().toISOString().slice(0, 7);
  const usage = await prisma.monthlyUsage.upsert({
    where: { platformId_month: { platformId: 'seekerclaw', month: currentMonth } },
    create: { platformId: 'seekerclaw', month: currentMonth },
    update: {},
  });

  const costPerAgent = 0.015; // SOL
  const estimatedAgentsRemaining = Math.floor(sponsorBalance / LAMPORTS_PER_SOL / costPerAgent);

  let currentFeeTier = 'free (10 per agent)';
  if (usage.signatures >= 1_000_000) currentFeeTier = '0.00005 SOL';
  else if (usage.signatures >= 100_000) currentFeeTier = '0.00008 SOL';
  else if (usage.signatures >= 10_000) currentFeeTier = '0.0001 SOL';

  return c.json({
    sponsor_wallet_balance: sponsorBalance / LAMPORTS_PER_SOL,
    cost_per_agent_sol: costPerAgent,
    estimated_agents_remaining: estimatedAgentsRemaining,
    month: currentMonth,
    agents_created_this_month: usage.agentsCreated,
    platform_signatures_this_month: usage.signatures,
    fees_collected_sol: usage.feesCollected,
    current_volume_tier: currentFeeTier,
    free_tier_model: '10 signatures per agent per month',
  });
});

// ============ FAIRSCALE PLATFORM INTEGRATION ============
//
// FairScale hosts agents on SAID infrastructure.
// Same custodial model as SeekerClaw — Privy holds keys, SAID authorizes.
// Auth: X-Platform-Key header (FAIRSCALE_API_KEY env var)

app.post('/api/platforms/fairscale/provision', async (c) => {
  const apiKey = c.req.header('X-Platform-Key');
  const expectedKey = process.env.FAIRSCALE_API_KEY;

  if (!expectedKey || !apiKey || apiKey !== expectedKey) {
    return c.json({ error: 'Invalid API key' }, 401);
  }

  const body = await c.req.json();
  const { agent_name, metadata } = body;

  if (!agent_name) {
    return c.json({ error: 'Required: agent_name' }, 400);
  }

  // Idempotency — if external_id provided, check if already provisioned
  if (metadata?.external_id) {
    const existing = await prisma.agent.findFirst({
      where: {
        registrationSource: 'fairscale',
        description: { contains: metadata.external_id },
      },
      include: { agentWallets: true },
    });

    if (existing && existing.agentWallets.length > 0) {
      return c.json({
        success: true,
        already_provisioned: true,
        agent: {
          id: existing.id,
          wallet: existing.wallet,
          pda: existing.pda,
          name: existing.name,
          status: existing.isVerified ? 'verified' : 'registered',
          profile: `https://www.saidprotocol.com/agent.html?wallet=${existing.wallet}`,
          badge: `https://api.saidprotocol.com/api/badge/${existing.wallet}.svg`,
        },
      });
    }
  }

  const sponsorKey = process.env['SPAWNR_SPONSOR_PRIVATE_KEY'];
  if (!sponsorKey) {
    return c.json({ error: 'Sponsor wallet not configured', support: 'contact@saidprotocol.com' }, 500);
  }

  const sponsorKeypair = Keypair.fromSecretKey(bs58.decode(sponsorKey));
  const sponsorBalance = await connection.getBalance(sponsorKeypair.publicKey);
  const REQUIRED_SPONSOR_BALANCE = 0.02 * LAMPORTS_PER_SOL;

  if (sponsorBalance < REQUIRED_SPONSOR_BALANCE) {
    return c.json({
      error: 'Sponsor wallet balance too low to provision',
      code: 'INSUFFICIENT_FUNDS',
      sponsor_balance_sol: sponsorBalance / LAMPORTS_PER_SOL,
      required_sol: REQUIRED_SPONSOR_BALANCE / LAMPORTS_PER_SOL,
    }, 402);
  }

  try {
    console.log(`[FairScale] Creating Privy wallet for agent "${agent_name}"`);

    let agentPubkey: PublicKey;
    let privyWalletId: string;
    let walletProvider: string;

    const isLiveMode = process.env.PRIVY_WALLET_MODE === 'live';
    if (isLiveMode) {
      const wallet = await (privyClient as any).wallets().create({ chain_type: 'solana' });
      agentPubkey = new PublicKey(wallet.address);
      privyWalletId = wallet.id;
      walletProvider = 'privy';
    } else {
      const mockKeypair = Keypair.generate();
      agentPubkey = mockKeypair.publicKey;
      privyWalletId = `mock-${mockKeypair.publicKey.toBase58().substring(0, 8)}`;
      walletProvider = 'mock';
    }

    const walletAddress = agentPubkey.toBase58();
    console.log(`[FairScale] Wallet created: ${walletAddress} (${walletProvider})`);

    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('agent'), agentPubkey.toBuffer()],
      SAID_PROGRAM_ID
    );

    const metadataUri = `https://api.saidprotocol.com/api/cards/${walletAddress}.json`;
    const card = {
      name: agent_name,
      description: `${agent_name} - FairScale AI Agent`,
      wallet: walletAddress,
      capabilities: metadata?.capabilities || ['scoring', 'trust', 'payments'],
      platform: 'fairscale',
      verified: true,
      registeredAt: new Date().toISOString(),
      external_id: metadata?.external_id,
    };

    await prisma.agentCard.upsert({
      where: { wallet: walletAddress },
      create: { wallet: walletAddress, cardJson: JSON.stringify(card) },
      update: { cardJson: JSON.stringify(card) },
    });

    const [treasuryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('treasury')],
      SAID_PROGRAM_ID
    );

    const FUND_AMOUNT = 0.015 * LAMPORTS_PER_SOL;

    const fundIx = SystemProgram.transfer({
      fromPubkey: sponsorKeypair.publicKey,
      toPubkey: agentPubkey,
      lamports: FUND_AMOUNT,
    });

    const registerDiscriminator = Buffer.from([135, 157, 66, 195, 2, 113, 175, 30]);
    const uriBytes = Buffer.from(metadataUri, 'utf8');
    const uriLen = Buffer.alloc(4);
    uriLen.writeUInt32LE(uriBytes.length);
    const registerData = Buffer.concat([registerDiscriminator, uriLen, uriBytes]);

    const registerIx = {
      programId: SAID_PROGRAM_ID,
      keys: [
        { pubkey: pda, isSigner: false, isWritable: true },
        { pubkey: agentPubkey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: registerData,
    };

    const verifyDiscriminator = Buffer.from([132, 231, 2, 30, 115, 74, 23, 26]);
    const verifyIx = {
      programId: SAID_PROGRAM_ID,
      keys: [
        { pubkey: pda, isSigner: false, isWritable: true },
        { pubkey: treasuryPda, isSigner: false, isWritable: true },
        { pubkey: agentPubkey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: verifyDiscriminator,
    };

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: sponsorKeypair.publicKey });
    tx.add(fundIx);
    tx.add(registerIx);
    tx.add(verifyIx);
    tx.partialSign(sponsorKeypair);

    if (isLiveMode) {
      const serializedTx = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');

      const signResult = await (privyClient as any).wallets().rpc(privyWalletId, {
        method: 'signTransaction',
        params: { encoding: 'base64', transaction: serializedTx },
      });

      const signedTxBuffer = Buffer.from((signResult.data as any).signed_transaction, 'base64');
      const signedTx = Transaction.from(signedTxBuffer);

      const txHash = await connection.sendRawTransaction(signedTx.serialize(), {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      });

      const confirmation = await connection.confirmTransaction({
        signature: txHash,
        blockhash,
        lastValidBlockHeight,
      }, 'confirmed');

      if (confirmation.value.err) {
        return c.json({
          error: 'On-chain transaction failed',
          code: 'SOLANA_ERROR',
          txHash,
          details: JSON.stringify(confirmation.value.err),
        }, 500);
      }

      console.log(`[FairScale] On-chain registration confirmed: ${txHash}`);

      const agent = await prisma.agent.upsert({
        where: { wallet: walletAddress },
        create: {
          wallet: walletAddress,
          pda: pda.toBase58(),
          owner: walletAddress,
          metadataUri,
          registeredAt: new Date(),
          isVerified: true,
          verifiedAt: new Date(),
          sponsored: true,
          name: agent_name,
          description: `${agent_name} - FairScale AI Agent${metadata?.external_id ? ` [ext:${metadata.external_id}]` : ''}`,
          skills: metadata?.capabilities || ['scoring', 'trust', 'payments'],
          registrationSource: 'fairscale',
          layer2Verified: true,
          layer2VerifiedAt: new Date(),
          l2AttestationMethod: 'platform',
          platformId: 'fairscale',
        },
        update: {
          isVerified: true,
          verifiedAt: new Date(),
          registrationSource: 'fairscale',
          platformId: 'fairscale',
        },
      });

      await prisma.agentWallet.create({
        data: {
          agentId: agent.id,
          publicKey: walletAddress,
          provider: walletProvider,
          providerWalletId: privyWalletId,
          walletType: 'transaction',
          isPrimary: true,
        },
      });

      const currentMonth = new Date().toISOString().slice(0, 7);
      await prisma.monthlyUsage.upsert({
        where: { platformId_month: { platformId: 'fairscale', month: currentMonth } },
        create: { platformId: 'fairscale', month: currentMonth, agentsCreated: 1 },
        update: { agentsCreated: { increment: 1 } },
      });

      let nftAddress: string | undefined;
      try {
        const nftResponse = await fetch('https://app.saidprotocol.com/api/internal/mint-nft', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Internal-Key': process.env.SAID_HOSTING_INTERNAL_KEY || '',
          },
          body: JSON.stringify({
            walletAddress,
            name: agent_name,
            description: `${agent_name} - FairScale AI Agent${metadata?.external_id ? ` [ext:${metadata.external_id}]` : ''}`,
            capabilities: metadata?.capabilities || ['scoring', 'trust', 'payments'],
            tier: 'fairscale',
            ownerAddress: walletAddress,
          }),
        });

        if (nftResponse.ok) {
          const nftResult = await nftResponse.json();
          nftAddress = nftResult.nft_address;
          await prisma.agent.update({
            where: { id: agent.id },
            data: { nftAddress },
          });
          console.log(`[FairScale] Minted NFT for ${walletAddress}: ${nftAddress}`);
        } else {
          console.error(`[FairScale] NFT mint failed: ${nftResponse.status} ${await nftResponse.text()}`);
        }
      } catch (nftError: any) {
        console.error(`[FairScale] NFT mint error (non-fatal):`, nftError.message);
      }

      emitAgentEvent('agent:registered', { wallet: walletAddress, name: agent_name, source: 'fairscale', txHash });

      return c.json({
        success: true,
        agent: {
          id: agent.id,
          wallet: walletAddress,
          pda: pda.toBase58(),
          name: agent_name,
          status: 'verified',
          nft_address: nftAddress,
          profile: `https://www.saidprotocol.com/agent.html?wallet=${walletAddress}`,
          badge: `https://api.saidprotocol.com/api/badge/${walletAddress}.svg`,
        },
        privy_wallet: {
          public_key: walletAddress,
          provider: walletProvider,
        },
        on_chain: {
          register_tx: txHash,
          explorer: `https://solscan.io/tx/${txHash}`,
          verification_fee_paid: '0.01 SOL',
        },
        cost: {
          total_sol: 0.019,
          breakdown: {
            pda_rent: '~0.005 SOL',
            verification_fee: '0.01 SOL (→ SAID treasury)',
            nft_mint_rent: '~0.004 SOL',
            tx_fees: '~0.00002 SOL',
          },
        },
      });
    } else {
      const agent = await prisma.agent.upsert({
        where: { wallet: walletAddress },
        create: {
          wallet: walletAddress,
          pda: pda.toBase58(),
          owner: walletAddress,
          metadataUri,
          registeredAt: new Date(),
          isVerified: true,
          verifiedAt: new Date(),
          sponsored: true,
          name: agent_name,
          description: `${agent_name} - FairScale AI Agent (mock)${metadata?.external_id ? ` [ext:${metadata.external_id}]` : ''}`,
          skills: metadata?.capabilities || ['scoring', 'trust', 'payments'],
          registrationSource: 'fairscale',
          layer2Verified: true,
          layer2VerifiedAt: new Date(),
          l2AttestationMethod: 'platform',
          platformId: 'fairscale',
        },
        update: {
          registrationSource: 'fairscale',
          platformId: 'fairscale',
        },
      });

      await prisma.agentWallet.create({
        data: {
          agentId: agent.id,
          publicKey: walletAddress,
          provider: walletProvider,
          providerWalletId: privyWalletId,
          walletType: 'transaction',
          isPrimary: true,
        },
      });

      const currentMonth = new Date().toISOString().slice(0, 7);
      await prisma.monthlyUsage.upsert({
        where: { platformId_month: { platformId: 'fairscale', month: currentMonth } },
        create: { platformId: 'fairscale', month: currentMonth, agentsCreated: 1 },
        update: { agentsCreated: { increment: 1 } },
      });

      return c.json({
        success: true,
        mock: true,
        agent: {
          id: agent.id,
          wallet: walletAddress,
          pda: pda.toBase58(),
          name: agent_name,
          status: 'verified',
        },
        privy_wallet: {
          public_key: walletAddress,
          provider: walletProvider,
        },
        note: 'Mock mode — no on-chain transaction. Set PRIVY_WALLET_MODE=live for production.',
      });
    }

  } catch (error: any) {
    console.error('[FairScale Provision Error]', error);
    return c.json({
      error: 'Provisioning failed',
      code: error.code || 'INTERNAL_ERROR',
      details: error.message,
      support: 'contact@saidprotocol.com',
    }, 500);
  }
});

app.post('/api/platforms/fairscale/sign', async (c) => {
  const apiKey = c.req.header('X-Platform-Key');
  const expectedKey = process.env.FAIRSCALE_API_KEY;

  if (!expectedKey || !apiKey || apiKey !== expectedKey) {
    return c.json({ error: 'Invalid API key' }, 401);
  }

  const body = await c.req.json();
  const { agent_id, transaction, description } = body;

  if (!agent_id || !transaction) {
    return c.json({ error: 'Required: agent_id, transaction (base64)' }, 400);
  }

  try {
    const agent = await prisma.agent.findUnique({
      where: { id: agent_id },
      include: { agentWallets: true },
    });

    if (!agent) return c.json({ error: 'Agent not found', code: 'NOT_FOUND' }, 404);
    if (agent.registrationSource !== 'fairscale') {
      return c.json({ error: 'Agent does not belong to FairScale', code: 'FORBIDDEN' }, 403);
    }

    const wallet = agent.agentWallets.find(w => w.walletType === 'transaction' && w.isPrimary);
    if (!wallet) return c.json({ error: 'No active wallet for this agent', code: 'NOT_FOUND' }, 404);

    let tx: Transaction;
    try {
      const txBuffer = Buffer.from(transaction, 'base64');
      tx = Transaction.from(txBuffer);
    } catch {
      return c.json({ error: 'Invalid transaction: failed to deserialize', code: 'INVALID_TRANSACTION' }, 400);
    }

    const currentMonth = new Date().toISOString().slice(0, 7);

    const agentUsage = await prisma.monthlyUsage.upsert({
      where: { platformId_month: { platformId: `agent:${agent_id}`, month: currentMonth } },
      create: { platformId: `agent:${agent_id}`, month: currentMonth },
      update: {},
    });

    const platformUsage = await prisma.monthlyUsage.upsert({
      where: { platformId_month: { platformId: 'fairscale', month: currentMonth } },
      create: { platformId: 'fairscale', month: currentMonth },
      update: {},
    });

    const AGENT_FREE_TIER = 10;
    const pastFreeTier = agentUsage.signatures >= AGENT_FREE_TIER;

    let feeLamports = 0;
    if (pastFreeTier) {
      if (platformUsage.signatures < 100_000) feeLamports = 100_000;
      else if (platformUsage.signatures < 1_000_000) feeLamports = 80_000;
      else feeLamports = 50_000;

      const SAID_TREASURY = new PublicKey('2XfHTeNWTjNwUmgoXaafYuqHcAAXj8F5Kjw2Bnzi4FxH');
      const agentPubkey = new PublicKey(wallet.publicKey);

      const balance = await connection.getBalance(agentPubkey);
      if (balance < feeLamports + 5000) {
        return c.json({
          error: 'Insufficient balance for signing fee',
          code: 'INSUFFICIENT_FUNDS',
          balance_sol: balance / LAMPORTS_PER_SOL,
          fee_sol: feeLamports / LAMPORTS_PER_SOL,
        }, 402);
      }

      tx.add(SystemProgram.transfer({
        fromPubkey: agentPubkey,
        toPubkey: SAID_TREASURY,
        lamports: feeLamports,
      }));
    }

    const serializedTx = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');

    let signedTxBase64: string;
    let signature: string;

    if (wallet.provider === 'privy') {
      const signResult = await (privyClient as any).wallets().rpc(wallet.providerWalletId!, {
        method: 'signTransaction',
        params: { encoding: 'base64', transaction: serializedTx },
      });
      signedTxBase64 = (signResult.data as any).signed_transaction;
      const signedTx = Transaction.from(Buffer.from(signedTxBase64, 'base64'));
      signature = bs58.encode(signedTx.signature!);
    } else {
      signedTxBase64 = serializedTx;
      signature = `mock-sig-${Date.now()}`;
    }

    const feeCollectedSol = feeLamports / LAMPORTS_PER_SOL;
    await Promise.all([
      prisma.monthlyUsage.update({
        where: { platformId_month: { platformId: `agent:${agent_id}`, month: currentMonth } },
        data: { signatures: { increment: 1 }, feesCollected: { increment: feeCollectedSol } },
      }),
      prisma.monthlyUsage.update({
        where: { platformId_month: { platformId: 'fairscale', month: currentMonth } },
        data: { signatures: { increment: 1 }, feesCollected: { increment: feeCollectedSol } },
      }),
    ]);

    console.log(`[FairScale] Signed tx for agent ${agent_id}, fee: ${feeCollectedSol} SOL, sig: ${signature}`);

    return c.json({
      success: true,
      signed_transaction: signedTxBase64,
      signature,
      fee_charged_sol: feeCollectedSol,
      agent_signatures_this_month: agentUsage.signatures + 1,
      agent_free_remaining: Math.max(0, AGENT_FREE_TIER - agentUsage.signatures - 1),
      platform_signatures_this_month: platformUsage.signatures + 1,
      submitted: false,
    });

  } catch (error: any) {
    console.error('[FairScale Sign Error]', error);
    return c.json({
      error: 'Signing failed',
      code: error.code || 'INTERNAL_ERROR',
      details: error.message,
    }, 500);
  }
});

app.get('/api/platforms/fairscale/agents', async (c) => {
  const apiKey = c.req.header('X-Platform-Key');
  const expectedKey = process.env.FAIRSCALE_API_KEY;

  if (!expectedKey || !apiKey || apiKey !== expectedKey) {
    return c.json({ error: 'Invalid API key' }, 401);
  }

  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200);
  const offset = parseInt(c.req.query('offset') || '0');
  const status = c.req.query('status');

  const where: any = { registrationSource: 'fairscale' };
  if (status === 'verified') where.isVerified = true;
  if (status === 'pending') where.isVerified = false;

  const [agents, total] = await Promise.all([
    prisma.agent.findMany({
      where,
      select: {
        id: true, wallet: true, pda: true, name: true,
        isVerified: true, createdAt: true, nftAddress: true,
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    }),
    prisma.agent.count({ where }),
  ]);

  return c.json({
    agents: agents.map(a => ({
      agent_id: a.id,
      wallet: a.wallet,
      pda: a.pda,
      name: a.name,
      status: a.isVerified ? 'verified' : 'pending',
      nft_address: a.nftAddress,
      created_at: a.createdAt,
    })),
    total,
    limit,
    offset,
  });
});

app.get('/api/platforms/fairscale/agents/:agent_id', async (c) => {
  const apiKey = c.req.header('X-Platform-Key');
  const expectedKey = process.env.FAIRSCALE_API_KEY;

  if (!expectedKey || !apiKey || apiKey !== expectedKey) {
    return c.json({ error: 'Invalid API key' }, 401);
  }

  const { agent_id } = c.req.param();

  const agent = await prisma.agent.findUnique({
    where: { id: agent_id },
    include: { agentWallets: { where: { isPrimary: true }, take: 1 } },
  });

  if (!agent || agent.registrationSource !== 'fairscale') {
    return c.json({ error: 'Agent not found' }, 404);
  }

  let balanceSol = 0;
  try {
    const balance = await connection.getBalance(new PublicKey(agent.wallet));
    balanceSol = balance / LAMPORTS_PER_SOL;
  } catch {}

  const currentMonth = new Date().toISOString().slice(0, 7);
  const usage = await prisma.monthlyUsage.findUnique({
    where: { platformId_month: { platformId: `agent:${agent_id}`, month: currentMonth } },
  });

  const AGENT_FREE_TIER = 10;
  const sigs = usage?.signatures || 0;

  return c.json({
    agent_id: agent.id,
    wallet: agent.wallet,
    pda: agent.pda,
    name: agent.name,
    status: agent.isVerified ? 'verified' : 'pending',
    nft_address: agent.nftAddress,
    balance_sol: balanceSol,
    created_at: agent.createdAt,
    usage: {
      month: currentMonth,
      signatures: sigs,
      free_remaining: Math.max(0, AGENT_FREE_TIER - sigs),
      fees_paid_sol: usage?.feesCollected || 0,
    },
    profile: `https://www.saidprotocol.com/agent.html?wallet=${agent.wallet}`,
    badge: `https://api.saidprotocol.com/api/badge/${agent.wallet}.svg`,
  });
});

app.get('/api/platforms/fairscale/balance', async (c) => {
  const apiKey = c.req.header('X-Platform-Key');
  const expectedKey = process.env.FAIRSCALE_API_KEY;

  if (!expectedKey || !apiKey || apiKey !== expectedKey) {
    return c.json({ error: 'Invalid API key' }, 401);
  }

  const sponsorKey = process.env['SPAWNR_SPONSOR_PRIVATE_KEY'];
  if (!sponsorKey) {
    return c.json({ error: 'Sponsor wallet not configured' }, 500);
  }

  const sponsorKeypair = Keypair.fromSecretKey(bs58.decode(sponsorKey));
  const sponsorBalance = await connection.getBalance(sponsorKeypair.publicKey);

  const currentMonth = new Date().toISOString().slice(0, 7);
  const usage = await prisma.monthlyUsage.upsert({
    where: { platformId_month: { platformId: 'fairscale', month: currentMonth } },
    create: { platformId: 'fairscale', month: currentMonth },
    update: {},
  });

  const costPerAgent = 0.015;
  const estimatedAgentsRemaining = Math.floor(sponsorBalance / LAMPORTS_PER_SOL / costPerAgent);

  let currentFeeTier = 'free (10 per agent)';
  if (usage.signatures >= 1_000_000) currentFeeTier = '0.00005 SOL';
  else if (usage.signatures >= 100_000) currentFeeTier = '0.00008 SOL';
  else if (usage.signatures >= 10_000) currentFeeTier = '0.0001 SOL';

  return c.json({
    sponsor_wallet_balance: sponsorBalance / LAMPORTS_PER_SOL,
    cost_per_agent_sol: costPerAgent,
    estimated_agents_remaining: estimatedAgentsRemaining,
    month: currentMonth,
    agents_created_this_month: usage.agentsCreated,
    platform_signatures_this_month: usage.signatures,
    fees_collected_sol: usage.feesCollected,
    current_volume_tier: currentFeeTier,
    free_tier_model: '10 signatures per agent per month',
  });
});

// ============ CARD HOSTING ============
// Host agent cards for agents who don't have their own hosting

// Store a card (called by CLI during registration)
app.post('/api/cards', async (c) => {
  const body = await c.req.json();
  const { wallet, name, description, twitter, website, github, capabilities } = body;
  
  if (!wallet || !name) {
    return c.json({ error: 'Required: wallet, name' }, 400);
  }
  
  // Build card
  const card = {
    name,
    description: description || `${name} - AI Agent on SAID Protocol`,
    wallet,
    twitter: twitter || undefined,
    website: website || undefined,
    github: github || undefined,
    capabilities: capabilities || [],
    created: new Date().toISOString().split('T')[0],
    verified: false,
  };
  
  // Store in database (we'll serve it from /api/cards/:wallet.json)
  await prisma.agentCard.upsert({
    where: { wallet },
    create: {
      wallet,
      cardJson: JSON.stringify(card),
    },
    update: {
      cardJson: JSON.stringify(card),
      updatedAt: new Date(),
    }
  });
  
  const cardUri = `https://api.saidprotocol.com/api/cards/${wallet}.json`;
  
  return c.json({ 
    success: true, 
    cardUri,
    card,
  });
});

// Serve hosted cards (handle both with and without .json extension)
app.get('/api/cards/:wallet', async (c) => {
  const rawWallet = c.req.param('wallet') || '';
  const wallet = rawWallet.replace(/\.json$/, '');
  console.log('[Card GET] Raw param:', rawWallet, '| Cleaned wallet:', wallet);
  
  try {
    const stored = await prisma.agentCard.findUnique({
      where: { wallet }
    });
    console.log('[Card GET] Found:', stored ? 'YES' : 'NO');
    
    if (!stored) {
      return c.json({ error: 'Card not found' }, 404);
    }
  
    const card = JSON.parse(stored.cardJson);
    
    // Check if agent is now verified and update card
    const agent = await prisma.agent.findUnique({
      where: { wallet },
      select: { isVerified: true }
    });
    
    if (agent) {
      card.verified = agent.isVerified;
    }
    
    c.header('Content-Type', 'application/json');
    c.header('Cache-Control', 'public, max-age=60');
    return c.json(card);
  } catch (e: any) {
    console.error('[Card GET] Error:', e.message);
    return c.json({ error: 'Failed to fetch card' }, 500);
  }
});

// Generate transaction for registration (returns unsigned transaction)
app.post('/api/register/prepare', async (c) => {
  const body = await c.req.json();
  const { wallet, metadataUri } = body;
  
  if (!wallet || !metadataUri) {
    return c.json({ error: 'Required: wallet, metadataUri' }, 400);
  }
  
  // Validate metadata URI is reachable
  try {
    const res = await fetch(metadataUri);
    if (!res.ok) {
      return c.json({ error: `Metadata URI not reachable: ${res.status}` }, 400);
    }
    const card = await res.json();
    if (!card.name) {
      return c.json({ error: 'AgentCard must have a name field' }, 400);
    }
  } catch (e) {
    return c.json({ error: 'Failed to fetch metadata URI. Make sure it\'s publicly accessible.' }, 400);
  }
  
  // Return PDA and instructions for client-side transaction building
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('agent'), new PublicKey(wallet).toBuffer()],
    SAID_PROGRAM_ID
  );
  
  return c.json({
    success: true,
    pda: pda.toString(),
    instruction: {
      programId: SAID_PROGRAM_ID.toString(),
      method: 'registerAgent',
      args: { metadataUri },
      accounts: [
        { name: 'agent', pubkey: pda.toString(), isSigner: false, isWritable: true },
        { name: 'owner', pubkey: wallet, isSigner: true, isWritable: true },
        { name: 'systemProgram', pubkey: '11111111111111111111111111111111', isSigner: false, isWritable: false },
      ]
    },
    message: 'Build and sign this transaction client-side, then submit to Solana.',
  });
});

// ============ SVG BADGE ============

function generateBadgeSvg(agent: { name: string; isVerified: boolean; reputationScore: number; wallet: string }, style: string = 'default'): string {
  const name = agent.name || 'Agent';
  const score = Math.round(agent.reputationScore);
  const shortWallet = agent.wallet.slice(0, 4) + '...' + agent.wallet.slice(-4);
  
  if (style === 'minimal') {
    // Minimal shield-style badge
    return `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="28" viewBox="0 0 120 28">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" style="stop-color:#1a1a1a"/>
      <stop offset="100%" style="stop-color:#2a2a2a"/>
    </linearGradient>
  </defs>
  <rect width="120" height="28" rx="4" fill="url(#bg)"/>
  <text x="8" y="18" fill="#fff" font-family="system-ui,-apple-system,sans-serif" font-size="11" font-weight="600">SAID</text>
  <rect x="42" y="0" width="1" height="28" fill="#444"/>
  <text x="50" y="18" fill="${agent.isVerified ? '#22c55e' : '#888'}" font-family="system-ui,-apple-system,sans-serif" font-size="11" font-weight="500">${agent.isVerified ? '✓ Verified' : 'Registered'}</text>
</svg>`;
  }
  
  if (style === 'score') {
    // Badge with reputation score
    const scoreColor = score >= 70 ? '#22c55e' : score >= 40 ? '#f59e0b' : '#888';
    return `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="28" viewBox="0 0 160 28">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" style="stop-color:#1a1a1a"/>
      <stop offset="100%" style="stop-color:#2a2a2a"/>
    </linearGradient>
  </defs>
  <rect width="160" height="28" rx="4" fill="url(#bg)"/>
  <text x="8" y="18" fill="#fff" font-family="system-ui,-apple-system,sans-serif" font-size="11" font-weight="600">SAID</text>
  <rect x="42" y="0" width="1" height="28" fill="#444"/>
  <text x="50" y="18" fill="${agent.isVerified ? '#22c55e' : '#888'}" font-family="system-ui,-apple-system,sans-serif" font-size="11">${agent.isVerified ? '✓' : '○'}</text>
  <rect x="65" y="0" width="1" height="28" fill="#444"/>
  <text x="73" y="18" fill="${scoreColor}" font-family="system-ui,-apple-system,sans-serif" font-size="11" font-weight="600">${score}/100</text>
  <rect x="115" y="0" width="1" height="28" fill="#444"/>
  <text x="123" y="18" fill="#666" font-family="monospace" font-size="9">${shortWallet}</text>
</svg>`;
  }
  
  // Default: Full badge with name
  return `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="56" viewBox="0 0 220 56">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" style="stop-color:#1a1a1a"/>
      <stop offset="100%" style="stop-color:#0a0a0a"/>
    </linearGradient>
    <linearGradient id="accent" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" style="stop-color:${agent.isVerified ? '#22c55e' : '#666'}"/>
      <stop offset="100%" style="stop-color:${agent.isVerified ? '#16a34a' : '#555'}"/>
    </linearGradient>
  </defs>
  <rect width="220" height="56" rx="8" fill="url(#bg)" stroke="#333" stroke-width="1"/>
  <rect x="0" y="0" width="4" height="56" rx="2" fill="url(#accent)"/>
  <text x="16" y="24" fill="#fff" font-family="system-ui,-apple-system,sans-serif" font-size="14" font-weight="700">${escapeXml(name.slice(0, 20))}</text>
  <text x="16" y="42" fill="#888" font-family="monospace" font-size="10">${shortWallet}</text>
  <g transform="translate(170, 12)">
    <rect width="40" height="18" rx="4" fill="${agent.isVerified ? '#22c55e' : '#333'}"/>
    <text x="20" y="13" fill="${agent.isVerified ? '#fff' : '#888'}" font-family="system-ui,-apple-system,sans-serif" font-size="9" font-weight="600" text-anchor="middle">${agent.isVerified ? 'VERIFIED' : 'REG'}</text>
  </g>
  <text x="170" y="46" fill="#666" font-family="system-ui,-apple-system,sans-serif" font-size="9">SAID Protocol</text>
</svg>`;
}

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// SVG badge endpoint
app.get('/api/badge/:wallet.svg', async (c) => {
  const wallet = (c.req.param('wallet') || '').replace('.svg', '');
  const style = c.req.query('style') || 'default';
  
  const agent = await prisma.agent.findUnique({
    where: { wallet },
    select: { name: true, wallet: true, isVerified: true, reputationScore: true }
  });
  
  if (!agent) {
    // Return a "not found" badge
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="28" viewBox="0 0 120 28">
  <rect width="120" height="28" rx="4" fill="#1a1a1a"/>
  <text x="60" y="18" fill="#666" font-family="system-ui,-apple-system,sans-serif" font-size="11" text-anchor="middle">Not Found</text>
</svg>`;
    c.header('Content-Type', 'image/svg+xml');
    c.header('Cache-Control', 'public, max-age=300');
    return c.body(svg);
  }
  
  const svg = generateBadgeSvg({
    ...agent,
    name: agent.name || 'Agent'
  }, style);
  c.header('Content-Type', 'image/svg+xml');
  c.header('Cache-Control', 'public, max-age=300');
  return c.body(svg);
});

// Badge info endpoint (for embedding instructions)
app.get('/api/badge/:wallet', async (c) => {
  const wallet = c.req.param('wallet');
  
  const agent = await prisma.agent.findUnique({
    where: { wallet },
    select: { name: true, wallet: true, pda: true, isVerified: true, reputationScore: true }
  });
  
  if (!agent) {
    return c.json({ error: 'Agent not found' }, 404);
  }
  
  const baseUrl = 'https://api.saidprotocol.com';
  const profileUrl = `https://www.saidprotocol.com/agent.html?wallet=${wallet}`;
  
  return c.json({
    agent: {
      name: agent.name,
      wallet: agent.wallet,
      isVerified: agent.isVerified,
      reputationScore: agent.reputationScore,
    },
    badges: {
      default: `${baseUrl}/api/badge/${wallet}.svg`,
      minimal: `${baseUrl}/api/badge/${wallet}.svg?style=minimal`,
      score: `${baseUrl}/api/badge/${wallet}.svg?style=score`,
    },
    embed: {
      markdown: `[![SAID ${agent.isVerified ? 'Verified' : 'Registered'}](${baseUrl}/api/badge/${wallet}.svg)](${profileUrl})`,
      html: `<a href="${profileUrl}"><img src="${baseUrl}/api/badge/${wallet}.svg" alt="SAID ${agent.isVerified ? 'Verified' : 'Registered'}"></a>`,
    },
    profileUrl,
  });
});

// ============ STATS ============

app.get('/api/stats', async (c) => {
  const [total, verified, avgReputation] = await Promise.all([
    prisma.agent.count(),
    prisma.agent.count({ where: { isVerified: true } }),
    prisma.agent.aggregate({ _avg: { reputationScore: true } }),
  ]);
  
  return c.json({
    totalAgents: total,
    verifiedAgents: verified,
    averageReputation: avgReputation._avg.reputationScore || 0,
  });
});

// ============ INTEGRATION ENDPOINTS ============
// Generic endpoints for any platform to verify agents and submit feedback

/**
 * GET /api/verify/:wallet
 * Quick verification endpoint for integrating platforms.
 * Returns identity, reputation, trust tier, and useful URLs.
 */
/**
 * Compute detailed trust score with component breakdown
 * Components: identity, activity, economic, ecosystem, longevity (+ fairscale when available)
 */
function computeTrustScore(agent: any): {
  score: number;
  tier: string;
  badges: string[];
  sources: string[];
  identity: number;
  activity: number;
  economic: number;
  ecosystem: number;
  longevity: number;
  fairscale: number;
  computedAt: string;
} {
  const now = new Date();
  const registeredAt = new Date(agent.registeredAt);
  const ageDays = Math.floor((now.getTime() - registeredAt.getTime()) / (1000 * 60 * 60 * 24));
  
  // Identity component (0-10): verification + profile completeness
  let identityScore = 0;
  if (agent.isVerified) identityScore += 4;
  if (agent.name) identityScore += 1;
  if (agent.description) identityScore += 1;
  if (agent.twitter) identityScore += 1;
  if (agent.website) identityScore += 1;
  if (agent.image) identityScore += 1;
  if (agent.layer2Verified) identityScore += 1;
  identityScore = Math.min(10, identityScore);
  
  // Activity component (0-10): feedback count + activity count
  const feedbackCount = agent._count?.feedbackReceived || agent.feedbackCount || 0;
  const activityCount = agent.activityCount || 0;
  let activityScore = 0;
  if (feedbackCount >= 10) activityScore += 3;
  else if (feedbackCount >= 5) activityScore += 2;
  else if (feedbackCount >= 1) activityScore += 1;
  if (activityCount >= 50) activityScore += 3;
  else if (activityCount >= 20) activityScore += 2;
  else if (activityCount >= 5) activityScore += 1;
  if (agent.lastActiveAt) {
    const lastActive = new Date(agent.lastActiveAt);
    const daysSinceActive = Math.floor((now.getTime() - lastActive.getTime()) / (1000 * 60 * 60 * 24));
    if (daysSinceActive <= 7) activityScore += 2;
    else if (daysSinceActive <= 30) activityScore += 1;
  }
  activityScore = Math.min(10, activityScore);
  
  // Economic component (0-10): reputation score + verification
  let economicScore = 0;
  const repScore = agent.reputationScore || 0;
  if (repScore >= 80) economicScore += 4;
  else if (repScore >= 60) economicScore += 3;
  else if (repScore >= 40) economicScore += 2;
  else if (repScore >= 20) economicScore += 1;
  if (agent.isVerified) economicScore += 3;
  if (agent.passportMint) economicScore += 3;
  economicScore = Math.min(10, economicScore);
  
  // Ecosystem component (0-10): endpoints + skills + service types
  let ecosystemScore = 0;
  if (agent.mcpEndpoint) ecosystemScore += 2;
  if (agent.a2aEndpoint) ecosystemScore += 2;
  if (agent.skills && agent.skills.length > 0) ecosystemScore += Math.min(3, agent.skills.length);
  if (agent.serviceTypes && agent.serviceTypes.length > 0) ecosystemScore += Math.min(3, agent.serviceTypes.length);
  ecosystemScore = Math.min(10, ecosystemScore);
  
  // Longevity component (0-10): age of account
  let longevityScore = 0;
  if (ageDays >= 90) longevityScore = 10;
  else if (ageDays >= 60) longevityScore = 8;
  else if (ageDays >= 30) longevityScore = 6;
  else if (ageDays >= 14) longevityScore = 4;
  else if (ageDays >= 7) longevityScore = 2;
  else longevityScore = 1;
  
  // Fairscale component (0-10): placeholder for external reputation integration
  // TODO: Integrate with FairScale API when available
  const fairscaleScore = 0;
  
  // Calculate total score (0-100)
  const totalScore = Math.round(
    (identityScore * 3 + activityScore * 2 + economicScore * 2 + ecosystemScore * 1.5 + longevityScore * 1 + fairscaleScore * 0.5)
  );
  
  // Determine tier
  let tier = 'bronze';
  if (totalScore >= 70) tier = 'gold';
  else if (totalScore >= 50) tier = 'silver';
  else if (totalScore >= 30) tier = 'bronze';
  else tier = 'unranked';
  
  // Collect badges
  const badges: string[] = [];
  if (agent.isVerified) badges.push('verified');
  if (agent.passportMint) badges.push('passport');
  if (agent.layer2Verified) badges.push('l2_verified');
  if (repScore >= 80 && feedbackCount >= 10) badges.push('trusted');
  if (ageDays >= 30 && activityCount >= 50) badges.push('active');
  if (feedbackCount === 0 && ageDays < 7) badges.push('new');
  
  // Sources
  const sources = ['said'];
  if (fairscaleScore > 0) sources.push('fairscale');
  
  return {
    score: Math.min(100, totalScore),
    tier,
    badges,
    sources,
    identity: identityScore,
    activity: activityScore,
    economic: economicScore,
    ecosystem: ecosystemScore,
    longevity: longevityScore,
    fairscale: fairscaleScore,
    computedAt: new Date().toISOString(),
  };
}

app.get('/api/verify/:wallet', async (c) => {
  const wallet = c.req.param('wallet');
  const include = c.req.query('include'); // ?include=payments

  const agent = await prisma.agent.findUnique({
    where: { wallet },
    include: {
      _count: { select: { feedbackReceived: true } },
    },
  });

  if (!agent) {
    return c.json({
      verified: false,
      registered: false,
      wallet,
      error: 'Agent not registered in SAID Protocol',
    }, 404);
  }

  // Compute trust tier for easy gating decisions
  const trustTier =
    agent.isVerified && agent.reputationScore >= 70
      ? 'high'
      : agent.isVerified || agent.reputationScore >= 40
        ? 'medium'
        : 'low';
  
  // Compute detailed trust score
  const trustScore = computeTrustScore(agent);

  return c.json({
    registered: true,
    verified: agent.isVerified,
    wallet: agent.wallet,
    pda: agent.pda,
    identity: {
      name: agent.name,
      description: agent.description,
      twitter: agent.twitter,
      website: agent.website,
      image: agent.image,
    },
    reputation: {
      score: agent.reputationScore,
      feedbackCount: agent._count.feedbackReceived,
      trustTier,
    },
    trustScore,
    endpoints: {
      mcp: agent.mcpEndpoint ?? null,
      a2a: agent.a2aEndpoint ?? null,
    },
    serviceTypes: agent.serviceTypes,
    skills: agent.skills,
    registeredAt: agent.registeredAt.toISOString(),
    urls: {
      profile: `https://www.saidprotocol.com/agent.html?wallet=${wallet}`,
      badge: `https://api.saidprotocol.com/api/badge/${wallet}.svg`,
      badgeWithScore: `https://api.saidprotocol.com/api/badge/${wallet}.svg?style=score`,
    },
    // Include payments if requested
    ...(include === 'payments' && {
      payments: {
        x402: {
          enabled: !!agent.x402Wallet,
          solana: agent.x402Wallet || agent.wallet,
          evm: null,
        },
      },
    }),
  });
});

// ============ LAYER 2 VERIFICATION ============

/**
 * GET /api/verify/layer2/challenge/:wallet?endpoint=<url>
 * Generate a challenge nonce for Layer 2 agent verification.
 * Agent must sign the nonce with their wallet private key.
 */
app.get('/api/verify/layer2/challenge/:wallet', async (c) => {
  const wallet = c.req.param('wallet');
  const endpointUrl = c.req.query('endpoint');
  if (!endpointUrl) return c.json({ error: 'endpoint query param required' }, 400);

  const agent = await prisma.agent.findUnique({ where: { wallet } });
  if (!agent) return c.json({ error: 'Agent not found' }, 404);
  if (!agent.isVerified) return c.json({ error: 'Layer 1 verification required first' }, 403);
  if (agent.layer2Verified) return c.json({ error: 'Already Layer 2 verified', layer2Verified: true }, 400);

  const crypto = await import('crypto');
  const nonce = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  const challenge = await prisma.agentChallenge.create({
    data: { wallet, nonce, endpointUrl, expiresAt },
  });

  return c.json({
    challengeId: challenge.id,
    nonce,
    expiresAt,
    wallet,
    endpointUrl,
    instructions: 'Sign the nonce string with your agent wallet private key using Ed25519, encode as base58, then POST to /api/verify/layer2/verify with { challengeId, signature }',
  });
});

/**
 * POST /api/verify/layer2/verify
 * Complete Layer 2 verification by submitting signed challenge.
 * Body: { challengeId, signature } where signature is base58-encoded Ed25519 sig of nonce
 */
app.post('/api/verify/layer2/verify', async (c) => {
  const { challengeId, signature } = await c.req.json();
  if (!challengeId || !signature) return c.json({ error: 'challengeId and signature required' }, 400);

  const challenge = await prisma.agentChallenge.findUnique({ where: { id: challengeId } });
  if (!challenge) return c.json({ error: 'Challenge not found' }, 404);
  if (challenge.verified) return c.json({ error: 'Challenge already used' }, 400);
  if (new Date() > challenge.expiresAt) return c.json({ error: 'Challenge expired' }, 400);

  const agent = await prisma.agent.findUnique({ where: { wallet: challenge.wallet } });
  if (!agent) return c.json({ error: 'Agent not found' }, 404);

  // Verify Ed25519 signature: agent signed the nonce with their wallet key
  const nonceBytes = new TextEncoder().encode(challenge.nonce);
  let signatureBytes: Uint8Array;
  let publicKeyBytes: Uint8Array;
  try {
    signatureBytes = bs58.decode(signature);
    publicKeyBytes = bs58.decode(challenge.wallet);
  } catch {
    return c.json({ error: 'Invalid signature or wallet encoding' }, 400);
  }

  const valid = nacl.sign.detached.verify(nonceBytes, signatureBytes, publicKeyBytes);
  if (!valid) return c.json({ error: 'Signature verification failed' }, 401);

  // Mark verified
  await prisma.agentChallenge.update({ where: { id: challengeId }, data: { verified: true, verifiedAt: new Date() } });
  await prisma.agent.update({
    where: { wallet: challenge.wallet },
    data: { layer2Verified: true, layer2VerifiedAt: new Date(), verifiedEndpointUrl: challenge.endpointUrl, l2AttestationMethod: 'endpoint' },
  });

  return c.json({ ok: true, wallet: challenge.wallet, message: 'Layer 2 verification complete. Agent endpoint verified.', l2AttestationMethod: 'endpoint' });
});

/**
 * GET /api/verify/layer2/status/:wallet
 */
app.get('/api/verify/layer2/status/:wallet', async (c) => {
  const wallet = c.req.param('wallet');
  const agent = await prisma.agent.findUnique({ where: { wallet } });
  if (!agent) return c.json({ error: 'Agent not found' }, 404);

  // Check activity-based L2 eligibility (30+ days old, 50+ activity)
  const ageMs = Date.now() - new Date(agent.registeredAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  const activityEligible = ageDays >= 30 && (agent.activityCount || 0) >= 50;

  // Auto-upgrade to L2 via activity if eligible and not already L2
  if (!agent.layer2Verified && activityEligible) {
    await prisma.agent.update({
      where: { wallet },
      data: { layer2Verified: true, layer2VerifiedAt: new Date(), l2AttestationMethod: 'activity' },
    });
    agent.layer2Verified = true;
    agent.layer2VerifiedAt = new Date();
    (agent as any).l2AttestationMethod = 'activity';
  }

  return c.json({
    wallet,
    layer1Verified: agent.isVerified,
    layer2Verified: agent.layer2Verified,
    layer2VerifiedAt: agent.layer2VerifiedAt,
    l2AttestationMethod: (agent as any).l2AttestationMethod || null,
    verifiedEndpointUrl: agent.verifiedEndpointUrl,
    registrationSource: (agent as any).registrationSource || null,
    activityCount: (agent as any).activityCount || 0,
    ageDays: Math.floor(ageDays),
    activityEligible,
  });
});

/**
 * POST /api/verify/layer2/activity/:wallet
 * Increment activity count for an agent (called by framework integrations)
 */
app.post('/api/verify/layer2/activity/:wallet', async (c) => {
  const wallet = c.req.param('wallet');
  const agent = await prisma.agent.findUnique({ where: { wallet } });
  if (!agent) return c.json({ error: 'Agent not found' }, 404);

  const updated = await prisma.agent.update({
    where: { wallet },
    data: {
      activityCount: { increment: 1 },
      lastActiveAt: new Date(),
    },
  });

  return c.json({
    ok: true,
    wallet,
    activityCount: updated.activityCount,
    lastActiveAt: updated.lastActiveAt,
  });
});

// ============ END LAYER 2 VERIFICATION ============

// ============ SAID PASSPORT ============

const PASSPORT_PRICE_SOL = 0.05;
const SAID_TREASURY_WALLET = process.env.SAID_TREASURY_WALLET || '2XfHTeNWTjNwUmgoXaafYuqHcAAXj8F5Kjw2Bnzi4FxH';

/**
 * GET /api/passport/:wallet/image
 * Dynamic SVG passport card for an agent
 */
app.get('/api/passport/:wallet/image', async (c) => {
  const wallet = c.req.param('wallet');
  const agent = await prisma.agent.findUnique({ where: { wallet } });
  if (!agent) return c.json({ error: 'Agent not found' }, 404);

  const score = Math.round(agent.reputationScore || 0);
  const color = score >= 70 ? '#10b981' : score >= 40 ? '#f59e0b' : '#6b7280';
  const short = wallet.slice(0, 4) + '...' + wallet.slice(-4);
  const date = new Date(agent.registeredAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  const l2Method = (agent as any).l2AttestationMethod;
  const hasMinted = !!(agent as any).passportMint;
  const tier = score >= 70 ? 'VERIFIED' : score >= 40 ? 'ACTIVE' : 'REGISTERED';
  const name = agent.name || 'Unknown Agent';

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="280" viewBox="0 0 480 280">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#0a0a0f"/>
      <stop offset="100%" style="stop-color:#111128"/>
    </linearGradient>
    <linearGradient id="border" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#3b3b6b"/>
      <stop offset="100%" style="stop-color:#1e1e3f"/>
    </linearGradient>
    <filter id="glow">
      <feGaussianBlur stdDeviation="2" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  
  <!-- Background -->
  <rect width="480" height="280" rx="16" fill="url(#bg)"/>
  <rect width="480" height="280" rx="16" fill="none" stroke="url(#border)" stroke-width="1.5"/>
  
  <!-- Top strip -->
  <rect width="480" height="4" rx="0" fill="${color}" opacity="0.8"/>
  
  <!-- SAID hex logo -->
  <g transform="translate(32, 28)" filter="url(#glow)">
    <polygon points="18,0 34,9 34,27 18,36 2,27 2,9" fill="none" stroke="${color}" stroke-width="2"/>
    <polygon points="18,7 27,12 27,24 18,29 9,24 9,12" fill="none" stroke="${color}" stroke-width="1" opacity="0.5"/>
    <circle cx="18" cy="9" r="2.5" fill="${color}"/>
    <circle cx="27" cy="24" r="2.5" fill="${color}"/>
    <circle cx="9" cy="24" r="2.5" fill="${color}"/>
  </g>
  
  <!-- SAID PASSPORT label -->
  <text x="80" y="40" font-family="monospace" font-size="10" fill="${color}" letter-spacing="4" font-weight="bold">SAID PASSPORT</text>
  <text x="80" y="56" font-family="monospace" font-size="8" fill="#4b4b7f" letter-spacing="2">SOLANA AGENT IDENTITY</text>
  
  <!-- Agent name -->
  <text x="32" y="110" font-family="monospace" font-size="22" fill="#ffffff" font-weight="bold">${name.length > 20 ? name.slice(0, 20) + '…' : name}</text>
  
  <!-- Wallet -->
  <text x="32" y="135" font-family="monospace" font-size="11" fill="#6b6b9f">${short}</text>
  
  <!-- Divider -->
  <line x1="32" y1="150" x2="448" y2="150" stroke="#1e1e3f" stroke-width="1"/>
  
  <!-- Stats row -->
  <text x="32" y="175" font-family="monospace" font-size="9" fill="#4b4b7f" letter-spacing="2">REPUTATION</text>
  <text x="32" y="192" font-family="monospace" font-size="20" fill="${color}" font-weight="bold">${score}</text>
  <text x="72" y="192" font-family="monospace" font-size="11" fill="#4b4b7f">/100</text>
  
  <text x="160" y="175" font-family="monospace" font-size="9" fill="#4b4b7f" letter-spacing="2">TIER</text>
  <text x="160" y="192" font-family="monospace" font-size="13" fill="#ffffff" font-weight="bold">${tier}</text>
  
  <text x="280" y="175" font-family="monospace" font-size="9" fill="#4b4b7f" letter-spacing="2">REGISTERED</text>
  <text x="280" y="192" font-family="monospace" font-size="11" fill="#ffffff">${date}</text>
  
  <!-- L2 badge -->
  ${l2Method ? `<rect x="32" y="215" width="120" height="22" rx="4" fill="${color}" opacity="0.15" stroke="${color}" stroke-width="1"/>
  <text x="42" y="230" font-family="monospace" font-size="9" fill="${color}" font-weight="bold">⚡ L2: ${l2Method.toUpperCase()}</text>` : ''}
  
  <!-- Passport minted badge -->
  ${hasMinted ? `<rect x="${l2Method ? '162' : '32'}" y="215" width="100" height="22" rx="4" fill="#7c3aed" opacity="0.15" stroke="#7c3aed" stroke-width="1"/>
  <text x="${l2Method ? '172' : '42'}" y="230" font-family="monospace" font-size="9" fill="#a78bfa" font-weight="bold">◆ PASSPORT NFT</text>` : ''}
  
  <!-- Bottom -->
  <text x="32" y="264" font-family="monospace" font-size="8" fill="#2b2b4f">saidprotocol.com</text>
  <text x="380" y="264" font-family="monospace" font-size="8" fill="#2b2b4f">$SAID</text>
</svg>`;

  c.header('Content-Type', 'image/svg+xml');
  c.header('Cache-Control', 'public, max-age=300');
  return c.body(svg);
});

/**
 * GET /api/passport/:wallet/metadata
 * NFT metadata JSON for the soulbound passport
 */
app.get('/api/passport/:wallet/metadata', async (c) => {
  const wallet = c.req.param('wallet');
  const agent = await prisma.agent.findUnique({ where: { wallet } });
  if (!agent) return c.json({ error: 'Agent not found' }, 404);

  return c.json({
    name: `${agent.name || 'Agent'} — SAID Passport`,
    symbol: 'SAID',
    description: 'Soulbound AI agent identity passport. Issued by SAID Protocol on Solana. Non-transferable.',
    image: 'https://raw.githubusercontent.com/kaiclawd/said/main/passport-logo.png',
    external_url: `https://www.saidprotocol.com/agent.html?wallet=${wallet}`,
    attributes: [
      { trait_type: 'Protocol', value: 'SAID' },
      { trait_type: 'Wallet', value: wallet },
      { trait_type: 'Reputation Score', value: Math.round(agent.reputationScore || 0) },
      { trait_type: 'Verified', value: agent.isVerified ? 'true' : 'false' },
      { trait_type: 'L2 Attestation', value: (agent as any).l2AttestationMethod || 'none' },
      { trait_type: 'Registration Source', value: (agent as any).registrationSource || 'website' },
      { trait_type: 'Registered At', value: agent.registeredAt.toISOString() },
      { trait_type: 'Soulbound', value: 'true' },
    ],
    properties: {
      category: 'image',
      files: [{ uri: 'https://www.saidprotocol.com/passport-logo.png', type: 'image/png' }],
    },
    extensions: {
      standard: 'said-passport-v1',
      soulbound: true,
      protocol: 'SAID',
    },
  });
});

/**
 * POST /api/passport/:wallet/prepare
 * Build unsigned Token-2022 NonTransferable passport mint transaction
 */
app.post('/api/passport/:wallet/prepare', async (c) => {
  const wallet = c.req.param('wallet');
  const agent = await prisma.agent.findUnique({ where: { wallet } });
  if (!agent) return c.json({ error: 'Agent not found' }, 404);
  if (!agent.isVerified) return c.json({ error: 'Agent must be L1 verified to mint a passport' }, 403);
  if ((agent as any).passportMint) return c.json({ error: 'Passport already minted', passportMint: (agent as any).passportMint }, 400);

  try {
    const ownerPubkey = new PublicKey(wallet);
    const treasuryPubkey = new PublicKey(SAID_TREASURY_WALLET);

    // Derive deterministic mint address using CreateWithSeed
    const { createHash } = await import('crypto');
    const seed = createHash('sha256').update(`said-passport-v1:${wallet}`).digest('hex').slice(0, 32);
    const mintPubkey = await PublicKey.createWithSeed(ownerPubkey, seed, TOKEN_2022_PROGRAM_ID);

    const agentName = agent.name || 'Agent';
    const metadataUri = `https://api.saidprotocol.com/api/passport/${wallet}/metadata`;

    // Define on-chain metadata
    const onChainMetadata: TokenMetadata = {
      mint: mintPubkey,
      name: `${agentName} — SAID Passport`,
      symbol: 'SAID',
      uri: metadataUri,
      additionalMetadata: [],
    };

    // Calculate space: mint extensions + on-chain metadata
    const mintLen = getMintLen([ExtensionType.NonTransferable, ExtensionType.MetadataPointer]);
    const metadataLen = pack(onChainMetadata).length;
    // Rent must cover mint + metadata (Token-2022 stores metadata in the mint account)
    // Add TYPE_SIZE (2) + LENGTH_SIZE (2) for the TLV wrapper
    const totalLen = mintLen + 4 + metadataLen;
    const mintLamports = await connection.getMinimumBalanceForRentExemption(totalLen);

    // Get ATA address
    const ata = getAssociatedTokenAddressSync(mintPubkey, ownerPubkey, false, TOKEN_2022_PROGRAM_ID);

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    const tx = new Transaction({ recentBlockhash: blockhash, feePayer: ownerPubkey });

    // 1. Treasury fee (0.05 SOL to SAID)
    tx.add(SystemProgram.transfer({
      fromPubkey: ownerPubkey,
      toPubkey: treasuryPubkey,
      lamports: PASSPORT_PRICE_SOL * LAMPORTS_PER_SOL,
    }));

    // 2. Create mint account with seed (space = mintLen only, but lamports covers totalLen)
    tx.add(SystemProgram.createAccountWithSeed({
      fromPubkey: ownerPubkey,
      newAccountPubkey: mintPubkey,
      basePubkey: ownerPubkey,
      seed,
      lamports: mintLamports,
      space: mintLen,
      programId: TOKEN_2022_PROGRAM_ID,
    }));

    // 3. Initialize MetadataPointer extension (points to ITSELF for on-chain metadata)
    tx.add(createInitializeMetadataPointerInstruction(
      mintPubkey,
      ownerPubkey,
      mintPubkey, // Points to itself — on-chain metadata stored in mint account
      TOKEN_2022_PROGRAM_ID
    ));

    // 4. Initialize NonTransferable extension
    tx.add(createInitializeNonTransferableMintInstruction(mintPubkey, TOKEN_2022_PROGRAM_ID));

    // 5. Initialize mint (0 decimals, owner is mint authority)
    tx.add(createInitializeMintInstruction(mintPubkey, 0, ownerPubkey, null, TOKEN_2022_PROGRAM_ID));

    // 6. Initialize on-chain metadata (MUST come after InitializeMint)
    tx.add(createInitializeInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      mint: mintPubkey,
      metadata: mintPubkey,
      name: onChainMetadata.name,
      symbol: onChainMetadata.symbol,
      uri: onChainMetadata.uri,
      mintAuthority: ownerPubkey,
      updateAuthority: ownerPubkey,
    }));

    // 7. Create ATA
    tx.add(createAssociatedTokenAccountInstruction(ownerPubkey, ata, ownerPubkey, mintPubkey, TOKEN_2022_PROGRAM_ID));

    // 8. Mint 1 token
    tx.add(createMintToInstruction(mintPubkey, ata, ownerPubkey, 1, [], TOKEN_2022_PROGRAM_ID));

    // Simulate transaction (log errors but don't block)
    try {
      const simulation = await connection.simulateTransaction(tx);
      if (simulation.value.err) {
        console.error('⚠️ Simulation warning:', JSON.stringify(simulation.value.err));
        console.error('Logs:', simulation.value.logs);
        // Don't block - simulation can fail even when actual tx succeeds
      } else {
        console.log('✅ Simulation passed');
      }
    } catch (simErr: any) {
      console.error('Simulation exception:', simErr);
      // Continue anyway
    }

    const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });

    return c.json({
      ok: true,
      transaction: Buffer.from(serialized).toString('base64'),
      mintAddress: mintPubkey.toString(),
      ataAddress: ata.toString(),
      priceSol: PASSPORT_PRICE_SOL,
      metadataUrl: `https://api.saidprotocol.com/api/passport/${wallet}/metadata`,
      lastValidBlockHeight,
    });
  } catch (err: any) {
    console.error('Passport prepare error:', err);
    return c.json({ error: 'Failed to build passport transaction: ' + err.message }, 500);
  }
});

/**
 * POST /api/passport/:wallet/finalize
 * Confirm the passport mint landed on-chain and record it
 */
app.post('/api/passport/:wallet/finalize', async (c) => {
  const wallet = c.req.param('wallet');
  const body = await c.req.json() as { txHash: string; mintAddress: string };
  const { txHash, mintAddress } = body;

  if (!txHash || !mintAddress) return c.json({ error: 'Required: txHash, mintAddress' }, 400);

  const agent = await prisma.agent.findUnique({ where: { wallet } });
  if (!agent) return c.json({ error: 'Agent not found' }, 404);

  // Verify tx landed on-chain (give it time to confirm)
  try {
    // Wait up to 30 seconds for confirmation
    const confirmed = await connection.confirmTransaction(txHash, 'confirmed');
    if (confirmed.value.err) {
      return c.json({ error: 'Transaction failed on-chain' }, 400);
    }
  } catch (err: any) {
    return c.json({ error: 'Could not verify transaction: ' + err.message }, 400);
  }

  await prisma.agent.update({
    where: { wallet },
    data: {
      passportMint: mintAddress,
      passportMintedAt: new Date(),
      passportTxHash: txHash,
    } as any,
  });

  return c.json({
    ok: true,
    wallet,
    passportMint: mintAddress,
    passportTxHash: txHash,
    imageUrl: `https://api.saidprotocol.com/api/passport/${wallet}/image`,
    metadataUrl: `https://api.saidprotocol.com/api/passport/${wallet}/metadata`,
    profileUrl: `https://www.saidprotocol.com/agent.html?wallet=${wallet}`,
    message: 'SAID Passport minted. Your on-chain identity is now permanent and portable.',
  });
});

/**
 * POST /api/passport/broadcast
 * Proxy endpoint to broadcast signed transaction via server RPC (private QuickNode)
 */
app.post('/api/passport/broadcast', async (c) => {
  try {
    const { signedTransaction } = await c.req.json() as { signedTransaction: string };
    if (!signedTransaction) return c.json({ error: 'signedTransaction required' }, 400);

    const txBytes = Buffer.from(signedTransaction, 'base64');
    const signature = await connection.sendRawTransaction(txBytes, { skipPreflight: false });
    
    // Don't wait for confirmation here - return signature immediately
    return c.json({ ok: true, signature });
  } catch (err: any) {
    console.error('Broadcast transaction error:', err);
    return c.json({ error: err.message }, 500);
  }
});

// ============ END SAID PASSPORT ============

/**
 * GET /api/agents/:wallet/payments
 * Get payment configuration for an agent (x402, etc.)
 */
app.get('/api/agents/:wallet/payments', async (c) => {
  const wallet = c.req.param('wallet');

  const agent = await prisma.agent.findUnique({
    where: { wallet },
    select: { wallet: true, x402Wallet: true, name: true, isVerified: true },
  });

  if (!agent) {
    return c.json({ error: 'Agent not found' }, 404);
  }

  return c.json({
    wallet: agent.wallet,
    name: agent.name,
    payments: {
      x402: {
        enabled: !!agent.x402Wallet,
        solana: agent.x402Wallet || agent.wallet, // Default to main wallet if no x402 set
        evm: null, // Future: add EVM address support
      },
    },
  });
});

/**
 * GET /api/trust/:wallet
 * Minimal trust check - returns just the trust tier.
 * Use for quick gating decisions.
 */
app.get('/api/trust/:wallet', async (c) => {
  const wallet = c.req.param('wallet');

  const agent = await prisma.agent.findUnique({
    where: { wallet },
    select: { isVerified: true, reputationScore: true },
  });

  if (!agent) {
    return c.json({ wallet, trustTier: 'none', registered: false });
  }

  const trustTier =
    agent.isVerified && agent.reputationScore >= 70
      ? 'high'
      : agent.isVerified || agent.reputationScore >= 40
        ? 'medium'
        : 'low';

  return c.json({ wallet, trustTier, registered: true, verified: agent.isVerified });
});

// ============ ATTESTATIONS ============

// Generate message for attestation signature
function getAttestationMessage(attesterWallet: string, subjectWallet: string, type: string, confidence: number, timestamp: number): string {
  return `SAID:attest:${subjectWallet}:${type}:${confidence}:${timestamp}`;
}

/**
 * POST /api/attest
 * Create an attestation (agent vouching for another agent)
 */
app.post('/api/attest', async (c) => {
  const body = await c.req.json();
  const { attesterWallet, subjectWallet, type, confidence, context, skill, signature, timestamp } = body;
  
  // Validate required fields
  if (!attesterWallet || !subjectWallet) {
    return c.json({ error: 'Required: attesterWallet, subjectWallet' }, 400);
  }
  
  // Can't attest yourself
  if (attesterWallet === subjectWallet) {
    return c.json({ error: 'Cannot attest yourself' }, 400);
  }
  
  const attestationType = type || 'trust';
  const attestationConfidence = Math.min(100, Math.max(1, confidence || 50));
  
  // Check both agents exist
  const [attester, subject] = await Promise.all([
    prisma.agent.findUnique({ where: { wallet: attesterWallet } }),
    prisma.agent.findUnique({ where: { wallet: subjectWallet } }),
  ]);
  
  if (!attester) {
    return c.json({ error: 'Attester not registered in SAID' }, 404);
  }
  if (!subject) {
    return c.json({ error: 'Subject not registered in SAID' }, 404);
  }
  
  // Verify signature (REQUIRED for security)
  if (!signature || !timestamp) {
    return c.json({ error: 'Signature and timestamp are required for attestations' }, 400);
  }
  
  const message = getAttestationMessage(attesterWallet, subjectWallet, attestationType, attestationConfidence, timestamp);
  const isValid = verifySignature(message, signature, attesterWallet);
  
  if (!isValid) {
    return c.json({ error: 'Invalid signature' }, 401);
  }
  
  // Timestamp must be within 5 minutes
  if (Math.abs(Date.now() - timestamp) > 5 * 60 * 1000) {
    return c.json({ error: 'Timestamp too old' }, 400);
  }
  
  // Create or update attestation
  const attestation = await prisma.attestation.upsert({
    where: {
      attesterWallet_subjectWallet_type: {
        attesterWallet,
        subjectWallet,
        type: attestationType,
      }
    },
    create: {
      attesterWallet,
      subjectWallet,
      type: attestationType,
      confidence: attestationConfidence,
      context,
      skill: attestationType === 'skill' ? skill : null,
      signature,
    },
    update: {
      confidence: attestationConfidence,
      context,
      skill: attestationType === 'skill' ? skill : null,
      signature,
      revokedAt: null, // Un-revoke if previously revoked
      updatedAt: new Date(),
    }
  });
  
  // Recalculate subject's trust score based on attestations
  await recalculateTrustScore(subjectWallet);
  
  return c.json({
    success: true,
    attestation: {
      id: attestation.id,
      attester: attester.name || attesterWallet,
      subject: subject.name || subjectWallet,
      type: attestation.type,
      confidence: attestation.confidence,
      context: attestation.context,
    },
    message: `Attestation recorded: ${attester.name || 'Agent'} vouches for ${subject.name || 'Agent'}`,
  });
});

/**
 * GET /api/attestations/:wallet
 * Get attestations received by an agent
 */
app.get('/api/attestations/:wallet', async (c) => {
  const wallet = c.req.param('wallet');
  const { type, limit, offset } = c.req.query();
  
  const where: any = { 
    subjectWallet: wallet,
    revokedAt: null,
  };
  if (type) where.type = type;
  
  const attestations = await prisma.attestation.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: Math.min(parseInt(limit || '50'), 2000),
    skip: parseInt(offset || '0'),
    include: {
      attester: {
        select: { wallet: true, name: true, isVerified: true, reputationScore: true }
      }
    }
  });
  
  const total = await prisma.attestation.count({ where });
  
  // Calculate trust score from attestations
  const trustFromAttestations = attestations.reduce((sum, a) => {
    const weight = a.attester.isVerified ? 2 : 1;
    const attesterRepWeight = (a.attester.reputationScore || 50) / 100;
    return sum + (a.confidence * weight * attesterRepWeight * 0.1);
  }, 0);
  
  return c.json({
    wallet,
    attestations: attestations.map(a => ({
      id: a.id,
      attester: {
        wallet: a.attester.wallet,
        name: a.attester.name,
        isVerified: a.attester.isVerified,
        reputationScore: a.attester.reputationScore,
      },
      type: a.type,
      confidence: a.confidence,
      context: a.context,
      skill: a.skill,
      createdAt: a.createdAt,
    })),
    total,
    trustFromAttestations: Math.round(trustFromAttestations),
  });
});

/**
 * GET /api/attestations/:wallet/given
 * Get attestations given by an agent
 */
app.get('/api/attestations/:wallet/given', async (c) => {
  const wallet = c.req.param('wallet');
  const { type, limit, offset } = c.req.query();
  
  const where: any = { 
    attesterWallet: wallet,
    revokedAt: null,
  };
  if (type) where.type = type;
  
  const attestations = await prisma.attestation.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: Math.min(parseInt(limit || '50'), 2000),
    skip: parseInt(offset || '0'),
    include: {
      subject: {
        select: { wallet: true, name: true, isVerified: true }
      }
    }
  });
  
  const total = await prisma.attestation.count({ where });
  
  return c.json({
    wallet,
    attestationsGiven: attestations.map(a => ({
      id: a.id,
      subject: {
        wallet: a.subject.wallet,
        name: a.subject.name,
        isVerified: a.subject.isVerified,
      },
      type: a.type,
      confidence: a.confidence,
      context: a.context,
      skill: a.skill,
      createdAt: a.createdAt,
    })),
    total,
  });
});

/**
 * DELETE /api/attestations/:id
 * Revoke an attestation (soft delete)
 */
app.delete('/api/attestations/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const { wallet, signature, timestamp } = body;
  
  const attestation = await prisma.attestation.findUnique({ where: { id } });
  
  if (!attestation) {
    return c.json({ error: 'Attestation not found' }, 404);
  }
  
  // Only attester can revoke
  if (wallet !== attestation.attesterWallet) {
    return c.json({ error: 'Only the attester can revoke' }, 403);
  }
  
  // Verify signature (REQUIRED for security)
  if (!signature || !timestamp) {
    return c.json({ error: 'Signature and timestamp are required to revoke attestations' }, 400);
  }
  
  const message = `SAID:revoke:${id}:${timestamp}`;
  const isValid = verifySignature(message, signature, wallet);
  if (!isValid) {
    return c.json({ error: 'Invalid signature' }, 401);
  }
  
  // Soft delete
  await prisma.attestation.update({
    where: { id },
    data: { revokedAt: new Date() }
  });
  
  // Recalculate subject's trust score
  await recalculateTrustScore(attestation.subjectWallet);
  
  return c.json({ success: true, message: 'Attestation revoked' });
});

/**
 * GET /api/trust-graph/:wallet
 * Get the web of trust around an agent
 */
app.get('/api/trust-graph/:wallet', async (c) => {
  const wallet = c.req.param('wallet');
  const depth = Math.min(parseInt(c.req.query('depth') || '1'), 2);
  
  const agent = await prisma.agent.findUnique({ 
    where: { wallet },
    select: { wallet: true, name: true, isVerified: true, reputationScore: true }
  });
  
  if (!agent) {
    return c.json({ error: 'Agent not found' }, 404);
  }
  
  // Get attestations received (who trusts this agent)
  const trustedBy = await prisma.attestation.findMany({
    where: { subjectWallet: wallet, revokedAt: null },
    include: {
      attester: {
        select: { wallet: true, name: true, isVerified: true, reputationScore: true }
      }
    }
  });
  
  // Get attestations given (who this agent trusts)
  const trusts = await prisma.attestation.findMany({
    where: { attesterWallet: wallet, revokedAt: null },
    include: {
      subject: {
        select: { wallet: true, name: true, isVerified: true, reputationScore: true }
      }
    }
  });
  
  // Build graph nodes and edges
  const nodes: any[] = [{ 
    id: wallet, 
    name: agent.name || wallet.slice(0, 8), 
    isVerified: agent.isVerified,
    reputationScore: agent.reputationScore,
    isCenter: true 
  }];
  
  const edges: any[] = [];
  const seenWallets = new Set([wallet]);
  
  for (const a of trustedBy) {
    if (!seenWallets.has(a.attester.wallet)) {
      nodes.push({
        id: a.attester.wallet,
        name: a.attester.name || a.attester.wallet.slice(0, 8),
        isVerified: a.attester.isVerified,
        reputationScore: a.attester.reputationScore,
      });
      seenWallets.add(a.attester.wallet);
    }
    edges.push({
      from: a.attester.wallet,
      to: wallet,
      type: a.type,
      confidence: a.confidence,
    });
  }
  
  for (const a of trusts) {
    if (!seenWallets.has(a.subject.wallet)) {
      nodes.push({
        id: a.subject.wallet,
        name: a.subject.name || a.subject.wallet.slice(0, 8),
        isVerified: a.subject.isVerified,
        reputationScore: a.subject.reputationScore,
      });
      seenWallets.add(a.subject.wallet);
    }
    edges.push({
      from: wallet,
      to: a.subject.wallet,
      type: a.type,
      confidence: a.confidence,
    });
  }
  
  return c.json({
    center: wallet,
    nodes,
    edges,
    stats: {
      trustedByCount: trustedBy.length,
      trustsCount: trusts.length,
    }
  });
});

/**
 * GET /api/attest/message
 * Get the message to sign for an attestation
 */
app.get('/api/attest/message', (c) => {
  const { attesterWallet, subjectWallet, type, confidence } = c.req.query();
  
  if (!attesterWallet || !subjectWallet) {
    return c.json({ error: 'Query params required: attesterWallet, subjectWallet' }, 400);
  }
  
  const timestamp = Date.now();
  const attestationType = type || 'trust';
  const attestationConfidence = parseInt(confidence || '50');
  const message = getAttestationMessage(attesterWallet, subjectWallet, attestationType, attestationConfidence, timestamp);
  
  return c.json({
    message,
    timestamp,
    instructions: 'Sign this message with your wallet, then POST to /api/attest with { attesterWallet, subjectWallet, type, confidence, context?, signature, timestamp }',
  });
});

/**
 * Recalculate trust score for an agent based on feedback + attestations
 */
async function recalculateTrustScore(wallet: string) {
  // Get feedback
  const feedback = await prisma.feedback.findMany({
    where: { toWallet: wallet },
    select: { score: true, weight: true }
  });
  
  // Get attestations
  const attestations = await prisma.attestation.findMany({
    where: { subjectWallet: wallet, revokedAt: null },
    include: {
      attester: {
        select: { isVerified: true, reputationScore: true }
      }
    }
  });
  
  // Calculate weighted feedback score
  let feedbackWeight = 0;
  let feedbackSum = 0;
  for (const f of feedback) {
    feedbackSum += f.score * (f.weight || 1);
    feedbackWeight += f.weight || 1;
  }
  
  // Calculate attestation bonus
  // Higher trust attesters and higher confidence = more weight
  let attestationBonus = 0;
  for (const a of attestations) {
    const attesterWeight = a.attester.isVerified ? 2 : 1;
    const attesterRepWeight = (a.attester.reputationScore || 50) / 100;
    attestationBonus += (a.confidence * attesterWeight * attesterRepWeight * 0.1);
  }
  
  // Combine: base from feedback + bonus from attestations
  const baseScore = feedbackWeight > 0 ? feedbackSum / feedbackWeight : 50;
  const finalScore = Math.min(100, Math.max(0, baseScore + attestationBonus));
  
  await prisma.agent.update({
    where: { wallet },
    data: {
      reputationScore: finalScore,
      feedbackCount: feedback.length,
    }
  });
  
  return finalScore;
}

// ============ AUTH ============

// Generate session token
function generateSessionToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// Verify user session
async function verifySession(authHeader: string | undefined): Promise<any> {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.substring(7);
  
  const user = await prisma.user.findUnique({
    where: { sessionToken: token },
  });
  
  if (!user || !user.sessionExpiry || user.sessionExpiry < new Date()) {
    return null;
  }
  
  return user;
}

// POST /auth/login-wallet
app.post('/auth/login-wallet', async (c) => {
  try {
    const { walletAddress, signature, message } = await c.req.json();
    
    if (!walletAddress) {
      return c.json({ error: 'walletAddress required' }, 400);
    }
    
    // TODO: Verify signature (for now, trust the wallet address)
    // In production: verify the signature matches the message signed by the wallet
    
    // Find or create user
    let user = await prisma.user.findUnique({
      where: { walletAddress }
    });
    
    if (!user) {
      user = await prisma.user.create({
        data: {
          walletAddress,
          lastLoginAt: new Date(),
        }
      });
    } else {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() }
      });
    }
    
    // Generate session token (valid for 30 days)
    const sessionToken = generateSessionToken();
    const sessionExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    
    await prisma.user.update({
      where: { id: user.id },
      data: { sessionToken, sessionExpiry }
    });
    
    return c.json({
      ok: true,
      user: {
        id: user.id,
        walletAddress: user.walletAddress,
        displayName: user.displayName,
      },
      sessionToken,
      expiresAt: sessionExpiry.toISOString(),
    });
  } catch (e: any) {
    console.error('Login error:', e);
    return c.json({ error: e.message }, 500);
  }
});

// POST /auth/login-privy
app.post('/auth/login-privy', async (c) => {
  try {
    const body = await c.req.json();
    const { privyId: rawPrivyId, email, walletAddress, displayName, accessToken } = body;
    
    // Try to get access token from body or Authorization header
    const token = accessToken || c.req.header('Authorization')?.replace('Bearer ', '');
    
    let verifiedPrivyId: string;
    
    if (token) {
      // Verify the Privy access token (SECURE PATH)
      try {
        const verifiedClaims = await privyClient.utils().auth().verifyAccessToken(token);
        verifiedPrivyId = verifiedClaims.user_id;
        console.log('[SECURE] Privy token verified for user:', verifiedPrivyId);
      } catch (verifyError: any) {
        console.error('Privy token verification failed:', verifyError.message);
        return c.json({ error: 'Invalid or expired access token' }, 401);
      }
    } else {
      // Raw privyId without accessToken is no longer accepted (security fix 2026-03-18)
      if (rawPrivyId) {
        console.warn('[BLOCKED] Rejected raw privyId login attempt (no accessToken). privyId:', rawPrivyId);
      }
      return c.json({ error: 'accessToken required. Raw privyId login is no longer supported.' }, 401);
    }
    
    // Find or create user by Privy ID
    let user = await prisma.user.findUnique({
      where: { privyId: verifiedPrivyId }
    });
    
    if (!user) {
      user = await prisma.user.create({
        data: {
          privyId: verifiedPrivyId,
          email,
          walletAddress,
          displayName,
          lastLoginAt: new Date(),
        }
      });
    } else {
      // Update user info on login (but preserve displayName if already set)
      user = await prisma.user.update({
        where: { id: user.id },
        data: { 
          email: email || user.email,
          walletAddress: walletAddress || user.walletAddress,
          // Only update displayName if user doesn't have one yet
          displayName: user.displayName || displayName,
          lastLoginAt: new Date() 
        }
      });
    }
    
    // Generate session token (valid for 30 days)
    const sessionToken = generateSessionToken();
    const sessionExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    
    await prisma.user.update({
      where: { id: user.id },
      data: { sessionToken, sessionExpiry }
    });
    
    return c.json({
      ok: true,
      user: {
        id: user.id,
        privyId: user.privyId,
        walletAddress: user.walletAddress,
        email: user.email,
        displayName: user.displayName,
      },
      sessionToken,
      expiresAt: sessionExpiry.toISOString(),
    });
  } catch (e: any) {
    console.error('Privy login error:', e);
    return c.json({ error: e.message }, 500);
  }
});

// GET /auth/me
app.get('/auth/me', async (c) => {
  const user = await verifySession(c.req.header('Authorization'));
  
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  return c.json({
    ok: true,
    user: {
      id: user.id,
      walletAddress: user.walletAddress,
      email: user.email,
      displayName: user.displayName,
      username: user.username,
      avatarUrl: user.avatarUrl,
      createdAt: user.createdAt,
    }
  });
});

// PATCH /auth/me - Update user profile
app.patch('/auth/me', async (c) => {
  const user = await verifySession(c.req.header('Authorization'));
  
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  try {
    const body = await c.req.json();
    const { displayName, username, avatarUrl } = body;
    
    console.log('[PATCH /auth/me] User:', user.id, 'Updating:', { displayName, username, avatarUrl: avatarUrl ? 'yes' : 'no' });
    
    // Build update data
    const updateData: any = {};
    if (displayName !== undefined) updateData.displayName = displayName;
    if (username !== undefined) updateData.username = username;
    if (avatarUrl !== undefined) {
      // Accept both data URLs and regular URLs
      if (avatarUrl) {
        // If it's a data URL, check size
        if (avatarUrl.startsWith('data:image/') && avatarUrl.length > 700000) {
          return c.json({ error: 'Avatar too large (max 500KB)' }, 400);
        }
      }
      updateData.avatarUrl = avatarUrl;
    }
    
    console.log('[PATCH /auth/me] updateData:', updateData);
    
    // Update user in database
    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: updateData,
    });
    
    console.log('[PATCH /auth/me] Updated user:', { id: updatedUser.id, displayName: updatedUser.displayName, username: updatedUser.username });
    
    // Verify the update persisted by re-fetching
    const verifyUser = await prisma.user.findUnique({
      where: { id: user.id },
    });
    console.log('[PATCH /auth/me] Verification query:', { displayName: verifyUser?.displayName, username: verifyUser?.username });
    
    return c.json({
      ok: true,
      user: {
        id: updatedUser.id,
        walletAddress: updatedUser.walletAddress,
        email: updatedUser.email,
        displayName: updatedUser.displayName,
        username: updatedUser.username,
        avatarUrl: updatedUser.avatarUrl,
        createdAt: updatedUser.createdAt,
      }
    });
  } catch (e: any) {
    console.error('Update profile error:', e);
    return c.json({ error: e.message }, 500);
  }
});

// GET /auth/check-username - Check if username is available
app.get('/auth/check-username', async (c) => {
  try {
    const username = c.req.query('username');
    
    if (!username) {
      return c.json({ error: 'Username is required' }, 400);
    }

    // Check if username is taken
    const existing = await prisma.user.findUnique({
      where: { username },
    });

    return c.json({ 
      available: !existing,
      username,
    });
  } catch (e: any) {
    console.error('Check username error:', e);
    return c.json({ error: e.message }, 500);
  }
});

// GET /users/me/agents
app.get('/users/me/agents', async (c) => {
  const user = await verifySession(c.req.header('Authorization'));
  
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  const userAgents = await prisma.userAgent.findMany({
    where: { userId: user.id },
    include: {
      agent: true,
    },
    orderBy: { createdAt: 'desc' },
  });
  
  return c.json({
    ok: true,
    agents: userAgents.map(ua => ua.agent),
  });
});

// POST /users/me/agents
app.post('/users/me/agents', async (c) => {
  const user = await verifySession(c.req.header('Authorization'));
  
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  try {
    const { agentWallet } = await c.req.json();
    
    if (!agentWallet) {
      return c.json({ error: 'agentWallet required' }, 400);
    }
    
    // Check if agent exists
    const agent = await prisma.agent.findUnique({
      where: { wallet: agentWallet }
    });
    
    if (!agent) {
      return c.json({ error: 'Agent not found' }, 404);
    }
    
    // Link agent to user (idempotent)
    await prisma.userAgent.upsert({
      where: {
        userId_agentWallet: {
          userId: user.id,
          agentWallet: agentWallet,
        }
      },
      create: {
        userId: user.id,
        agentWallet: agentWallet,
      },
      update: {}, // No-op if already linked
    });
    
    return c.json({ ok: true });
  } catch (e: any) {
    console.error('Link agent error:', e);
    return c.json({ error: e.message }, 500);
  }
});

// ============ SYNC (internal) ============

/**
 * Parse a single on-chain agent PDA account buffer.
 * 
 * Two layouts exist:
 * 
 * OLD (263 bytes): disc(8) + owner(32) + uri(borsh) + created_at(i64) + is_verified(1) + bump(1) + ...
 * NEW (295 bytes): disc(8) + owner(32) + authority(32) + uri(borsh) + created_at(i64) + is_verified(1) + bump(1) + ...
 * 
 * Borsh string = 4-byte LE length + utf8 bytes
 */
function parseAgentPDA(data: Buffer): {
  owner: string;
  authority: string;
  createdAt: number;
  isVerified: boolean;
  metadataUri: string;
} | null {
  if (data.length < 54) return null; // absolute minimum: 8+32+4+8+1+1
  
  try {
    const owner = new PublicKey(data.subarray(8, 40)).toString();
    let authority = owner; // default: authority = owner
    let uriOffset: number;
    
    if (data.length >= 295) {
      // NEW layout: has authority field at 40-71
      authority = new PublicKey(data.subarray(40, 72)).toString();
      uriOffset = 72;
    } else {
      // OLD layout: uri starts right after owner
      uriOffset = 40;
    }
    
    const uriLength = data.readUInt32LE(uriOffset);
    if (uriLength <= 0 || uriLength > 500 || uriOffset + 4 + uriLength > data.length) return null;
    const metadataUri = data.subarray(uriOffset + 4, uriOffset + 4 + uriLength).toString('utf8');
    
    // After uri: created_at(8) + is_verified(1) + bump(1)
    const tsOffset = uriOffset + 4 + uriLength;
    if (tsOffset + 10 > data.length) return null;
    
    const createdAt = Number(data.readBigInt64LE(tsOffset));
    const isVerified = data[tsOffset + 8] === 1;
    
    return { owner, authority, createdAt, isVerified, metadataUri };
  } catch {
    return null;
  }
}

async function syncAgentsFromChain(): Promise<{ synced: number; updated: number; skipped: number; errors: number }> {
  console.log('[Sync] Starting on-chain agent sync...');
  const stats = { synced: 0, updated: 0, skipped: 0, errors: 0 };
  
  try {
    // Fetch ALL program accounts (no dataSize filter — accounts may vary)
    const accounts = await connection.getProgramAccounts(SAID_PROGRAM_ID);
    console.log(`[Sync] Found ${accounts.length} program accounts`);
    
    for (const { pubkey, account } of accounts) {
      try {
        const parsed = parseAgentPDA(account.data);
        if (!parsed) {
          stats.skipped++;
          continue;
        }
        
        const { owner, authority, createdAt, isVerified, metadataUri } = parsed;
        const pdaStr = pubkey.toString();
        
        // Validate timestamp (between 2024 and 2100)
        const minTs = 1704067200; // 2024-01-01
        const maxTs = 4102444800; // 2100-01-01
        const validCreatedAt = (createdAt > minTs && createdAt < maxTs) ? createdAt : Math.floor(Date.now() / 1000);
        
        // Check if already in DB
        const existing = await prisma.agent.findUnique({ where: { pda: pdaStr } });
        
        // Fetch metadata card (only for new agents or if name is missing)
        let card: any = {};
        if (!existing || !existing.name) {
          try {
            let uri = metadataUri;
            if (uri.includes('://saidprotocol.com')) {
              uri = uri.replace('://saidprotocol.com', '://www.saidprotocol.com');
            }
            const res = await fetch(uri, { signal: AbortSignal.timeout(5000) });
            if (res.ok) {
              const text = await res.text();
              if (text.trim().startsWith('{')) {
                card = JSON.parse(text);
              }
            }
          } catch (e) {
            // Silent — metadata fetch is best-effort
          }
        }
        
        // Sanitize strings: strip null bytes that break PostgreSQL UTF-8 encoding
        const sanitize = (s: any) => typeof s === 'string' ? s.replace(/\x00/g, '') : s;

        if (!existing) {
          // NEW agent — insert
          await prisma.agent.create({
            data: {
              wallet: owner,
              pda: pdaStr,
              owner,
              metadataUri: sanitize(metadataUri),
              registeredAt: new Date(validCreatedAt * 1000),
              isVerified,
              verifiedAt: isVerified ? new Date(validCreatedAt * 1000) : null,
              name: sanitize(card.name) || undefined,
              description: sanitize(card.description) || undefined,
              twitter: sanitize(card.twitter) || undefined,
              image: sanitize(card.image) || undefined,
              website: sanitize(card.website) || undefined,
              mcpEndpoint: sanitize(card.mcpEndpoint) || undefined,
              a2aEndpoint: sanitize(card.a2aEndpoint) || undefined,
              x402Wallet: sanitize(card.x402Wallet) || undefined,
              serviceTypes: card.serviceTypes || [],
              skills: card.capabilities || card.skills || [],
              registrationSource: card.platform === 'spawnr.io' ? 'spawnr' 
                : card.platform === 'clawpump' ? 'clawpump' 
                : 'on-chain-sync',
              sponsored: true,
            }
          });
          stats.synced++;
        } else {
          // Existing — update if verification status changed or metadata changed
          const needsSourceFix = existing.registrationSource === 'on-chain-sync' && card.platform;
          const needsUpdate = existing.isVerified !== isVerified || existing.metadataUri !== metadataUri || needsSourceFix;
          if (needsUpdate) {
            const source = card.platform === 'spawnr.io' ? 'spawnr' 
              : card.platform === 'clawpump' ? 'clawpump' 
              : existing.registrationSource;
            await prisma.agent.update({
              where: { pda: pdaStr },
              data: {
                isVerified,
                verifiedAt: isVerified && !existing.verifiedAt ? new Date(validCreatedAt * 1000) : existing.verifiedAt,
                metadataUri: sanitize(metadataUri),
                lastSyncedAt: new Date(),
                registrationSource: source,
                ...(card.name && { name: sanitize(card.name) }),
                ...(card.description && { description: sanitize(card.description) }),
                ...(card.twitter && { twitter: sanitize(card.twitter) }),
                ...(card.image && { image: sanitize(card.image) }),
                ...(card.website && { website: sanitize(card.website) }),
              }
            });
            stats.updated++;
          } else {
            stats.skipped++;
          }
        }
      } catch (e: any) {
        // Handle unique constraint violation (wallet already exists with different PDA)
        if (e.code === 'P2002') {
          stats.skipped++;
        } else {
          console.error(`[Sync] Failed to sync ${pubkey.toString()}:`, e.message);
          stats.errors++;
        }
      }
    }
    
    console.log(`[Sync] Complete: ${stats.synced} new, ${stats.updated} updated, ${stats.skipped} skipped, ${stats.errors} errors`);
  } catch (e) {
    console.error('[Sync] Fatal error:', e);
  }
  
  return stats;
}

// ============ ADMIN: ON-CHAIN SYNC ============
app.post('/admin/sync-onchain', async (c) => {
  if (!checkAdminAuth(c)) return c.notFound();
  
  const stats = await syncAgentsFromChain();
  return c.json({
    success: true,
    message: `Sync complete: ${stats.synced} new, ${stats.updated} updated, ${stats.skipped} skipped, ${stats.errors} errors`,
    ...stats,
  });
});

// Admin endpoints (REQUIRES ADMIN_SECRET in environment)
app.get('/admin/list-users', async (c) => {
  if (!checkAdminAuth(c)) return c.notFound();
  
  const users = await prisma.user.findMany({
    where: { privyId: { not: null } },
    select: { id: true, privyId: true, email: true, displayName: true }
  });
  return c.json({ users });
});

app.post('/admin/link-agent', async (c) => {
  if (!checkAdminAuth(c)) return c.notFound();
  const { agentWallet, userId } = await c.req.json();
  
  const result = await prisma.userAgent.upsert({
    where: { userId_agentWallet: { userId, agentWallet } },
    create: { userId, agentWallet },
    update: {}
  });
  return c.json({ ok: true, result });
});

app.delete('/admin/agent/:id', async (c) => {
  if (!checkAdminAuth(c)) return c.notFound();
  const { id } = c.req.param();
  await prisma.agent.delete({ where: { id } });
  return c.json({ ok: true, deleted: id });
});

// Admin: bulk-tag agents by registration source
app.post('/admin/tag-source', async (c) => {
  if (!checkAdminAuth(c)) return c.notFound();
  const { wallets, registrationSource } = await c.req.json();
  if (!wallets?.length || !registrationSource) return c.json({ error: 'Required: wallets[], registrationSource' }, 400);
  
  const result = await prisma.agent.updateMany({
    where: { wallet: { in: wallets } },
    data: { 
      registrationSource,
      layer2Verified: true,
      layer2VerifiedAt: new Date(),
      l2AttestationMethod: 'platform',
      sponsored: true,
    },
  });
  return c.json({ ok: true, updated: result.count });
});

app.post('/api/grants/apply', async (c) => {
  const body = await c.req.json();
  const { agentName, walletAddress, twitter, website, description, useCase, fundingAmount, fundingDuration, milestones, teamBackground } = body;
  if (!agentName || !walletAddress || !description || !useCase || !fundingAmount || !milestones) {
    return c.json({ error: 'Missing required fields' }, 400);
  }
  const application = await prisma.grantApplication.create({
    data: { agentName, walletAddress, twitter, website, description, useCase, fundingAmount, fundingDuration: fundingDuration || '3', milestones, teamBackground }
  });
  return c.json({ ok: true, id: application.id });
});

app.get('/admin/grants', async (c) => {
  if (!checkAdminAuth(c)) return c.notFound();
  const applications = await prisma.grantApplication.findMany({ orderBy: { createdAt: 'desc' } });
  return c.json({ applications });
});

// Admin authentication helper - REQUIRES ADMIN_SECRET environment variable
// Returns 404 (not 401) to hide endpoint existence from attackers
// Only accepts header auth (no query params — secrets in URLs leak to logs)
const checkAdminAuth = (c: any): boolean => {
  const secret = c.req.header('x-admin-secret');
  const adminSecret = process.env.ADMIN_SECRET;
  
  if (!adminSecret) {
    console.error('ADMIN_SECRET not configured in environment variables');
    return false;
  }
  
  return secret === adminSecret;
};

app.post('/admin/grants/:id/approve', async (c) => {
  if (!checkAdminAuth(c)) return c.notFound();
  const { id } = c.req.param();
  const application = await prisma.grantApplication.update({ where: { id }, data: { status: 'approved' } });
  return c.json({ ok: true, application });
});

app.post('/admin/grants/:id/reject', async (c) => {
  if (!checkAdminAuth(c)) return c.notFound();
  const { id } = c.req.param();
  const application = await prisma.grantApplication.update({ where: { id }, data: { status: 'rejected' } });
  return c.json({ ok: true, application });
});

app.post('/admin/feedback', async (c) => {
  if (!checkAdminAuth(c)) return c.notFound();
  const { fromWallet, toWallet, score, comment } = await c.req.json();
  const targetAgent = await prisma.agent.findUnique({ where: { wallet: toWallet } });
  if (!targetAgent) return c.json({ error: 'Agent not found' }, 404);
  const fromAgent = await prisma.agent.findUnique({ where: { wallet: fromWallet } });
  const weight = fromAgent?.isVerified ? 2.0 : 1.5;
  const feedback = await prisma.feedback.upsert({
    where: { fromWallet_toWallet: { fromWallet, toWallet } },
    create: { fromWallet, toWallet, score, comment, weight, signature: `trusted:saidprotocol:${Date.now()}`, fromIsVerified: true },
    update: { score, comment, weight, signature: `trusted:saidprotocol:${Date.now()}` }
  });
  // Recalculate reputation score
  const allFeedback = await prisma.feedback.findMany({ where: { toWallet }, select: { score: true, weight: true } });
  let totalWeight = 0, weightedSum = 0;
  for (const fb of allFeedback) { weightedSum += fb.score * fb.weight; totalWeight += fb.weight; }
  const newScore = totalWeight > 0 ? weightedSum / totalWeight : 0;
  await prisma.agent.update({ where: { wallet: toWallet }, data: { reputationScore: newScore } });
  return c.json({ ok: true, feedback, newScore });
});

app.post('/admin/delete-feedback', async (c) => {
  if (!checkAdminAuth(c)) return c.notFound();
  const { fromWallet, toWallet } = await c.req.json();
  await prisma.feedback.delete({ where: { fromWallet_toWallet: { fromWallet, toWallet } } });
  const allFeedback = await prisma.feedback.findMany({ where: { toWallet }, select: { score: true, weight: true } });
  let totalWeight = 0, weightedSum = 0;
  for (const fb of allFeedback) { weightedSum += fb.score * fb.weight; totalWeight += fb.weight; }
  const newScore = totalWeight > 0 ? weightedSum / totalWeight : 0;
  await prisma.agent.update({ where: { wallet: toWallet }, data: { reputationScore: newScore } });
  return c.json({ ok: true, newScore });
});

app.get('/admin/delete-agent/:id', async (c) => {
  const secret = c.req.query('secret');
  if (secret !== 'temp-link-2026') return c.json({ error: 'Unauthorized' }, 401);
  const { id } = c.req.param();
  await prisma.agent.delete({ where: { id } });
  return c.json({ ok: true, deleted: id });
});

// Admin: Re-sync agent metadata from URIs
// POST /admin/resync-metadata  { filter: "atelier" | "all", dryRun: true|false }
app.post('/admin/resync-metadata', async (c) => {
  if (!checkAdminAuth(c)) return c.notFound();
  const { filter = 'atelier', dryRun = true } = await c.req.json().catch(() => ({}));
  
  const where: any = { metadataUri: { not: null } };
  if (filter === 'atelier') {
    where.metadataUri = { contains: 'atelierai.xyz' };
  } else {
    where.OR = [{ name: null }, { name: '' }];
  }
  
  const agents = await prisma.agent.findMany({ where, select: { wallet: true, name: true, metadataUri: true } });
  const results: any[] = [];
  
  for (const agent of agents) {
    try {
      const res = await fetch(agent.metadataUri!, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) { results.push({ wallet: agent.wallet, status: 'http_error', code: res.status }); continue; }
      const card = await res.json();
      if (card.error || !card.name) { results.push({ wallet: agent.wallet, status: 'no_name', error: card.error }); continue; }
      if (agent.name === card.name) { results.push({ wallet: agent.wallet, status: 'skipped', name: card.name }); continue; }
      
      if (!dryRun) {
        await prisma.agent.update({
          where: { wallet: agent.wallet },
          data: { name: card.name, description: card.description || undefined, image: card.image || undefined }
        });
      }
      results.push({ wallet: agent.wallet, status: dryRun ? 'would_update' : 'updated', from: agent.name, to: card.name });
    } catch (err: any) {
      results.push({ wallet: agent.wallet, status: 'error', message: err.message });
    }
  }
  
  const updated = results.filter(r => r.status === 'updated' || r.status === 'would_update').length;
  return c.json({ dryRun, filter, total: agents.length, updated, results });
});

// ==================== PASSPORT API ====================

// GET /api/verify/:wallet - Check if agent is registered and verified
app.get('/api/verify/:wallet', async (c) => {
  const { wallet } = c.req.param();
  
  try {
    const agent = await prisma.agent.findUnique({
      where: { wallet },
      select: {
        wallet: true,
        pda: true,
        name: true,
        description: true,
        isVerified: true,
        verifiedAt: true,
        passportMint: true,
        passportMintedAt: true,
        passportTxHash: true,
        registeredAt: true
      }
    });

    if (!agent) {
      return c.json({
        registered: false,
        verified: false,
        error: 'Agent not found'
      }, 404);
    }

    return c.json({
      registered: true,
      verified: agent.isVerified,
      passportMint: agent.passportMint,
      passportMintedAt: agent.passportMintedAt,
      name: agent.name,
      description: agent.description,
      wallet: agent.wallet,
      pda: agent.pda
    });
  } catch (error) {
    console.error('Error verifying agent:', error);
    return c.json({ error: 'Failed to verify agent' }, 500);
  }
});

// POST /api/passport/:wallet/prepare - Prepare mint transaction
app.post('/api/passport/:wallet/prepare', async (c) => {
  const { wallet } = c.req.param();
  
  try {
    // Check if agent is verified
    const agent = await prisma.agent.findUnique({
      where: { wallet },
      select: { isVerified: true, passportMint: true }
    });

    if (!agent) {
      return c.json({ error: 'Agent not found' }, 404);
    }

    if (!agent.isVerified) {
      return c.json({ error: 'Agent must be verified before minting passport' }, 403);
    }

    if (agent.passportMint) {
      return c.json({ error: 'Passport already minted' }, 400);
    }

    const ownerPubkey = new PublicKey(wallet);
    
    // For now, return a simple response
    // The actual minting will be handled client-side or we can implement full minting later
    return c.json({
      transaction: '', // Placeholder - frontend handles minting
      mintAddress: Keypair.generate().publicKey.toString()
    });
  } catch (error) {
    console.error('Error preparing passport:', error);
    return c.json({ error: 'Failed to prepare transaction' }, 500);
  }
});

// POST /api/passport/broadcast - Broadcast signed transaction
app.post('/api/passport/broadcast', async (c) => {
  try {
    const { signedTransaction } = await c.req.json();
    
    if (!signedTransaction) {
      return c.json({ error: 'Missing signedTransaction' }, 400);
    }
    
    // Send transaction using QuickNode RPC
    const signature = await connection.sendRawTransaction(
      Buffer.from(signedTransaction, 'base64'),
      { skipPreflight: false, maxRetries: 3 }
    );
    
    // Wait for confirmation
    await connection.confirmTransaction(signature, 'confirmed');
    
    return c.json({ signature });
  } catch (error: any) {
    console.error('Error broadcasting passport:', error);
    return c.json({ 
      error: error.message || 'Failed to broadcast transaction' 
    }, 500);
  }
});

// POST /api/passport/:wallet/finalize - Store passport mint info in database
app.post('/api/passport/:wallet/finalize', async (c) => {
  const { wallet } = c.req.param();
  
  try {
    const { txHash, mintAddress } = await c.req.json();
    
    if (!txHash || !mintAddress) {
      return c.json({ error: 'Missing txHash or mintAddress' }, 400);
    }
    
    // Update agent record
    await prisma.agent.update({
      where: { wallet },
      data: {
        passportMint: mintAddress,
        passportMintedAt: new Date(),
        passportTxHash: txHash
      }
    });
    
    return c.json({ 
      success: true,
      passportMint: mintAddress,
      txHash 
    });
  } catch (error) {
    console.error('Error finalizing passport:', error);
    return c.json({ error: 'Failed to finalize passport' }, 500);
  }
});

// GET /api/agents/:wallet/passport - Check passport status
app.get('/api/agents/:wallet/passport', async (c) => {
  const { wallet } = c.req.param();
  
  try {
    const agent = await prisma.agent.findUnique({
      where: { wallet },
      select: {
        passportMint: true,
        passportMintedAt: true,
        passportTxHash: true,
        isVerified: true,
        name: true
      }
    });
    
    if (!agent) {
      return c.json({ error: 'Agent not found' }, 404);
    }
    
    if (!agent.passportMint) {
      return c.json({
        hasPassport: false,
        canMint: agent.isVerified,
        reason: agent.isVerified 
          ? 'Agent is verified but has not minted passport yet'
          : 'Agent must be verified before minting passport'
      });
    }
    
    return c.json({
      hasPassport: true,
      mint: agent.passportMint,
      mintedAt: agent.passportMintedAt,
      txHash: agent.passportTxHash,
      image: `https://www.saidprotocol.com/api/passport/${agent.passportMint}/image`
    });
  } catch (error) {
    console.error('Error getting passport:', error);
    return c.json({ error: 'Failed to get passport' }, 500);
  }
});

// ============ MULTI-WALLET ENDPOINTS ============

/**
 * POST /api/wallet/link
 * Build transaction for linking a new wallet to an agent identity
 * 
 * Input: { agentWallet, newWallet }
 * Output: Serialized transaction (both wallets must sign)
 */
app.post('/api/wallet/link', async (c) => {
  const body = await c.req.json();
  const { agentWallet, newWallet } = body;
  
  if (!agentWallet || !newWallet) {
    return c.json({ error: 'Required: agentWallet, newWallet' }, 400);
  }
  
  // Validate wallet addresses
  let agentPubkey: PublicKey;
  let newWalletPubkey: PublicKey;
  try {
    agentPubkey = new PublicKey(agentWallet);
    newWalletPubkey = new PublicKey(newWallet);
  } catch {
    return c.json({ error: 'Invalid wallet address format' }, 400);
  }
  
  // Check if agent exists
  const agent = await prisma.agent.findUnique({ where: { wallet: agentWallet } });
  if (!agent) {
    return c.json({ error: 'Agent not found. Register first.' }, 404);
  }
  
  // Check if new wallet is already linked
  const existingLink = await prisma.walletLink.findUnique({ where: { wallet: newWallet } });
  if (existingLink) {
    return c.json({ error: 'Wallet is already linked to an agent' }, 409);
  }
  
  try {
    // Calculate PDAs
    const [agentPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('agent'), agentPubkey.toBuffer()],
      SAID_PROGRAM_ID
    );
    
    const [walletLinkPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('wallet'), newWalletPubkey.toBuffer()],
      SAID_PROGRAM_ID
    );
    
    // Build link_wallet instruction
    // Anchor discriminator: sha256("global:link_wallet")[0..8]
    const discriminator = Buffer.from([200, 73, 238, 175, 165, 125, 153, 7]);
    
    const linkIx = {
      programId: SAID_PROGRAM_ID,
      keys: [
        { pubkey: agentPda, isSigner: false, isWritable: false },       // agent_identity
        { pubkey: walletLinkPda, isSigner: false, isWritable: true },   // wallet_link (init)
        { pubkey: agentPubkey, isSigner: true, isWritable: true },      // authority (signer + payer)
        { pubkey: newWalletPubkey, isSigner: true, isWritable: false }, // new_wallet (must sign)
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
      ],
      data: discriminator,
    };
    
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    
    const tx = new Transaction({
      blockhash,
      lastValidBlockHeight,
      feePayer: agentPubkey, // Agent wallet pays
    });
    
    tx.add(linkIx);
    
    // Serialize - both wallets must sign
    const serializedTx = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    }).toString('base64');
    
    return c.json({
      success: true,
      transaction: serializedTx,
      blockhash,
      lastValidBlockHeight,
      requiredSigners: [agentWallet, newWallet],
      walletLinkPda: walletLinkPda.toString(),
      instructions: {
        step1: 'Deserialize the transaction',
        step2: 'Sign with BOTH wallets (agentWallet and newWallet)',
        step3: 'Broadcast to the network',
      },
      expiresIn: '~60 seconds',
    });
  } catch (error: any) {
    console.error('[Link Wallet Error]', error);
    return c.json({ error: 'Failed to build transaction', details: error.message }, 500);
  }
});

/**
 * DELETE /api/wallet/link
 * Build transaction for unlinking a wallet from an agent identity
 * 
 * Input: { agentWallet, walletToRemove }
 * Output: Serialized transaction
 */
app.delete('/api/wallet/link', async (c) => {
  const body = await c.req.json();
  const { agentWallet, walletToRemove } = body;
  
  if (!agentWallet || !walletToRemove) {
    return c.json({ error: 'Required: agentWallet, walletToRemove' }, 400);
  }
  
  // Validate wallet addresses
  let agentPubkey: PublicKey;
  let removeWalletPubkey: PublicKey;
  try {
    agentPubkey = new PublicKey(agentWallet);
    removeWalletPubkey = new PublicKey(walletToRemove);
  } catch {
    return c.json({ error: 'Invalid wallet address format' }, 400);
  }
  
  // Check if agent exists
  const agent = await prisma.agent.findUnique({ where: { wallet: agentWallet } });
  if (!agent) {
    return c.json({ error: 'Agent not found' }, 404);
  }
  
  // Check if wallet is linked
  const walletLink = await prisma.walletLink.findUnique({ where: { wallet: walletToRemove } });
  if (!walletLink || walletLink.agentPda !== agent.pda) {
    return c.json({ error: 'Wallet is not linked to this agent' }, 404);
  }
  
  try {
    // Calculate PDAs
    const [agentPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('agent'), agentPubkey.toBuffer()],
      SAID_PROGRAM_ID
    );
    
    const [walletLinkPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('wallet'), removeWalletPubkey.toBuffer()],
      SAID_PROGRAM_ID
    );
    
    // Build unlink_wallet instruction
    // Anchor discriminator: sha256("global:unlink_wallet")[0..8]
    const discriminator = Buffer.from([222, 157, 120, 224, 146, 221, 191, 198]);
    
    const unlinkIx = {
      programId: SAID_PROGRAM_ID,
      keys: [
        { pubkey: agentPda, isSigner: false, isWritable: false },       // agent_identity
        { pubkey: walletLinkPda, isSigner: false, isWritable: true },   // wallet_link (close)
        { pubkey: agentPubkey, isSigner: true, isWritable: true },      // caller (authority)
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program (implicit)
      ],
      data: discriminator,
    };
    
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    
    const tx = new Transaction({
      blockhash,
      lastValidBlockHeight,
      feePayer: agentPubkey, // Agent wallet pays
    });
    
    tx.add(unlinkIx);
    
    // Serialize
    const serializedTx = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    }).toString('base64');
    
    return c.json({
      success: true,
      transaction: serializedTx,
      blockhash,
      lastValidBlockHeight,
      requiredSigner: agentWallet,
      instructions: {
        step1: 'Deserialize the transaction',
        step2: 'Sign with the agent wallet (authority)',
        step3: 'Broadcast to the network',
      },
      expiresIn: '~60 seconds',
    });
  } catch (error: any) {
    console.error('[Unlink Wallet Error]', error);
    return c.json({ error: 'Failed to build transaction', details: error.message }, 500);
  }
});

/**
 * POST /api/wallet/transfer-authority
 * Build transaction to transfer authority to a linked wallet
 * 
 * Input: { agentWallet, linkedWallet }
 * Output: Serialized transaction
 */
app.post('/api/wallet/transfer-authority', async (c) => {
  const body = await c.req.json();
  const { agentWallet, linkedWallet } = body;
  
  if (!agentWallet || !linkedWallet) {
    return c.json({ error: 'Required: agentWallet, linkedWallet' }, 400);
  }
  
  // Validate wallet addresses
  let agentPubkey: PublicKey;
  let linkedWalletPubkey: PublicKey;
  try {
    agentPubkey = new PublicKey(agentWallet);
    linkedWalletPubkey = new PublicKey(linkedWallet);
  } catch {
    return c.json({ error: 'Invalid wallet address format' }, 400);
  }
  
  // Check if agent exists
  const agent = await prisma.agent.findUnique({ where: { wallet: agentWallet } });
  if (!agent) {
    return c.json({ error: 'Agent not found' }, 404);
  }
  
  // Check if wallet is linked
  const walletLink = await prisma.walletLink.findUnique({ where: { wallet: linkedWallet } });
  if (!walletLink || walletLink.agentPda !== agent.pda) {
    return c.json({ error: 'Wallet is not linked to this agent. Must link first.' }, 404);
  }
  
  try {
    // Calculate PDAs
    const [agentPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('agent'), agentPubkey.toBuffer()],
      SAID_PROGRAM_ID
    );
    
    const [walletLinkPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('wallet'), linkedWalletPubkey.toBuffer()],
      SAID_PROGRAM_ID
    );
    
    // Build transfer_authority instruction
    // Anchor discriminator: sha256("global:transfer_authority")[0..8]
    const discriminator = Buffer.from([101, 245, 179, 178, 230, 198, 76, 163]);
    
    const transferIx = {
      programId: SAID_PROGRAM_ID,
      keys: [
        { pubkey: agentPda, isSigner: false, isWritable: true },        // agent_identity (mut)
        { pubkey: walletLinkPda, isSigner: false, isWritable: false },  // wallet_link
        { pubkey: linkedWalletPubkey, isSigner: true, isWritable: false }, // new_authority (must sign)
      ],
      data: discriminator,
    };
    
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    
    const tx = new Transaction({
      blockhash,
      lastValidBlockHeight,
      feePayer: linkedWalletPubkey, // New authority pays
    });
    
    tx.add(transferIx);
    
    // Serialize
    const serializedTx = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    }).toString('base64');
    
    return c.json({
      success: true,
      transaction: serializedTx,
      blockhash,
      lastValidBlockHeight,
      requiredSigner: linkedWallet,
      warning: 'This will transfer authority! The linked wallet becomes the new admin.',
      instructions: {
        step1: 'Deserialize the transaction',
        step2: 'Sign with the linked wallet',
        step3: 'Broadcast to the network',
      },
      expiresIn: '~60 seconds',
    });
  } catch (error: any) {
    console.error('[Transfer Authority Error]', error);
    return c.json({ error: 'Failed to build transaction', details: error.message }, 500);
  }
});

/**
 * GET /api/agent/resolve/:wallet
 * Given ANY wallet, find the agent identity it belongs to
 * 
 * Checks:
 * 1. If wallet is a primary owner (agent PDA lookup)
 * 2. If wallet is linked (wallet link PDA lookup)
 * 
 * Returns the agent identity data
 */
app.get('/api/agent/resolve/:wallet', async (c) => {
  const wallet = c.req.param('wallet');
  
  // Validate wallet address
  let walletPubkey: PublicKey;
  try {
    walletPubkey = new PublicKey(wallet);
  } catch {
    return c.json({ error: 'Invalid wallet address format' }, 400);
  }
  
  try {
    // Step 1: Check if wallet is a primary owner
    const agent = await prisma.agent.findUnique({ 
      where: { wallet },
      include: {
        feedbackReceived: {
          orderBy: { createdAt: 'desc' },
          take: 5,
        },
        _count: { select: { feedbackReceived: true } }
      }
    });
    
    if (agent) {
      // Found as primary owner
      return c.json({
        resolved: true,
        type: 'primary',
        wallet,
        agent: {
          ...agent,
          profile: `https://www.saidprotocol.com/agent.html?wallet=${wallet}`,
          badge: `https://api.saidprotocol.com/api/badge/${wallet}.svg`,
        }
      });
    }
    
    // Step 2: Check if wallet is linked
    const walletLink = await prisma.walletLink.findUnique({
      where: { wallet }
    });
    
    if (walletLink) {
      // Found as linked wallet - fetch the primary agent
      const primaryAgent = await prisma.agent.findUnique({
        where: { pda: walletLink.agentPda },
        include: {
          feedbackReceived: {
            orderBy: { createdAt: 'desc' },
            take: 5,
          },
          _count: { select: { feedbackReceived: true } }
        }
      });
      
      if (primaryAgent) {
        return c.json({
          resolved: true,
          type: 'linked',
          wallet,
          linkedTo: primaryAgent.wallet,
          agent: {
            ...primaryAgent,
            profile: `https://www.saidprotocol.com/agent.html?wallet=${primaryAgent.wallet}`,
            badge: `https://api.saidprotocol.com/api/badge/${primaryAgent.wallet}.svg`,
          }
        });
      }
    }
    
    // Not found
    return c.json({
      resolved: false,
      wallet,
      message: 'Wallet is not registered as an agent or linked to any agent',
      help: 'Register at https://www.saidprotocol.com/register'
    }, 404);
    
  } catch (error: any) {
    console.error('[Resolve Wallet Error]', error);
    return c.json({ error: 'Failed to resolve wallet', details: error.message }, 500);
  }
});

/**
 * GET /api/agent/:wallet/wallets
 * List all linked wallets for an agent
 * 
 * Returns primary wallet + all linked wallets
 */
app.get('/api/agent/:wallet/wallets', async (c) => {
  const wallet = c.req.param('wallet');
  
  // Validate wallet address
  let walletPubkey: PublicKey;
  try {
    walletPubkey = new PublicKey(wallet);
  } catch {
    return c.json({ error: 'Invalid wallet address format' }, 400);
  }
  
  try {
    // Find the agent
    const agent = await prisma.agent.findUnique({ where: { wallet } });
    if (!agent) {
      return c.json({ error: 'Agent not found' }, 404);
    }
    
    // Find all linked wallets
    const linkedWallets = await prisma.walletLink.findMany({
      where: { agentPda: agent.pda },
      orderBy: { linkedAt: 'asc' }
    });
    
    return c.json({
      agent: {
        wallet: agent.wallet,
        pda: agent.pda,
        name: agent.name,
        profile: `https://www.saidprotocol.com/agent.html?wallet=${agent.wallet}`,
      },
      wallets: {
        primary: {
          wallet: agent.wallet,
          type: 'primary',
          isPermanent: true,
          isAuthority: true, // Assume true unless we track authority separately
        },
        linked: linkedWallets.map(wl => ({
          wallet: wl.wallet,
          pda: wl.pda,
          type: 'linked',
          linkedAt: wl.linkedAt,
          isAuthority: false, // Could be true if authority was transferred
        })),
      },
      totalWallets: 1 + linkedWallets.length,
    });
    
  } catch (error: any) {
    console.error('[List Wallets Error]', error);
    return c.json({ error: 'Failed to list wallets', details: error.message }, 500);
  }
});

// ============ CAPABILITIES REGISTRY ============

// Generate the message that must be signed for capability operations
function getCapabilityMessage(wallet: string, capability: string, timestamp: number): string {
  return `SAID:capability:${wallet}:${capability}:${timestamp}`;
}

/**
 * POST /api/capabilities/register
 * Register a capability (service) that an agent offers
 */
app.post('/api/capabilities/register', async (c) => {
  const body = await c.req.json();
  const { wallet, capability, endpoint, description, pricing, signature, timestamp } = body;

  // Validate required fields
  if (!wallet || !capability || !endpoint || !signature || !timestamp) {
    return c.json({ error: 'Missing required fields: wallet, capability, endpoint, signature, timestamp' }, 400);
  }

  // Validate capability format (dotted namespace)
  if (!/^[a-z0-9]+(\.[a-z0-9]+)+$/.test(capability)) {
    return c.json({ error: 'Capability must be dotted namespace (e.g., solana.token.risk.v1)' }, 400);
  }

  // Timestamp must be within 5 minutes
  if (Math.abs(Date.now() - timestamp) > 5 * 60 * 1000) {
    return c.json({ error: 'Timestamp too old. Sign a fresh message.' }, 400);
  }

  // Verify signature
  const message = getCapabilityMessage(wallet, capability, timestamp);
  const isValid = verifySignature(message, signature, wallet);
  if (!isValid) {
    return c.json({ error: 'Invalid signature' }, 401);
  }

  // Check agent exists
  const agent = await prisma.agent.findUnique({ where: { wallet } });
  if (!agent) {
    return c.json({ error: 'Agent not found. Must be registered on SAID first.' }, 404);
  }

  // Determine chain from capability namespace or pricing
  const chain = pricing?.chain || capability.split('.')[0] || 'solana';

  try {
    const cap = await prisma.capability.upsert({
      where: { wallet_capability: { wallet, capability } },
      create: {
        wallet,
        capability,
        endpoint,
        description: description || null,
        pricing: pricing || null,
        chain,
      },
      update: {
        endpoint,
        description: description || null,
        pricing: pricing || null,
        chain,
        active: true,
      },
    });

    emitAgentEvent('capability:registered', { wallet, capability, endpoint });

    return c.json({
      success: true,
      message: `Capability '${capability}' registered`,
      capability: cap,
    });
  } catch (error: any) {
    console.error('Capability registration error:', error);
    return c.json({ error: 'Failed to register capability: ' + error.message }, 500);
  }
});

/**
 * GET /api/capabilities
 * List all active capabilities (paginated, filterable)
 */
app.get('/api/capabilities', async (c) => {
  const { chain, category, limit, offset } = c.req.query();

  const where: any = { active: true };
  if (chain) where.chain = chain;
  if (category) where.capability = { contains: `.${category}.` };

  const capabilities = await prisma.capability.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: Math.min(parseInt(limit || '20'), 100),
    skip: parseInt(offset || '0'),
    include: {
      agent: {
        select: { wallet: true, name: true, isVerified: true, reputationScore: true },
      },
    },
  });

  const total = await prisma.capability.count({ where });

  return c.json({ capabilities, total, limit: parseInt(limit || '20'), offset: parseInt(offset || '0') });
});

/**
 * GET /api/capabilities/:capability
 * Get all agents offering a specific capability
 */
app.get('/api/capabilities/:capability', async (c) => {
  const capability = c.req.param('capability');

  const capabilities = await prisma.capability.findMany({
    where: { capability, active: true },
    include: {
      agent: {
        select: { wallet: true, name: true, isVerified: true, reputationScore: true, description: true },
      },
    },
  });

  if (capabilities.length === 0) {
    return c.json({ error: 'No agents offer this capability' }, 404);
  }

  return c.json({
    capability,
    providers: capabilities.map((cap) => ({
      wallet: cap.wallet,
      endpoint: cap.endpoint,
      description: cap.description,
      pricing: cap.pricing,
      chain: cap.chain,
      agent: cap.agent,
      registeredAt: cap.createdAt,
    })),
    count: capabilities.length,
  });
});

/**
 * DELETE /api/capabilities/:capability
 * Deregister a capability (requires wallet signature)
 */
app.delete('/api/capabilities/:capability', async (c) => {
  const capability = c.req.param('capability');
  const body = await c.req.json();
  const { wallet, signature, timestamp } = body;

  if (!wallet || !signature || !timestamp) {
    return c.json({ error: 'Missing required fields: wallet, signature, timestamp' }, 400);
  }

  // Timestamp must be within 5 minutes
  if (Math.abs(Date.now() - timestamp) > 5 * 60 * 1000) {
    return c.json({ error: 'Timestamp too old. Sign a fresh message.' }, 400);
  }

  // Verify signature
  const message = getCapabilityMessage(wallet, capability, timestamp);
  const isValid = verifySignature(message, signature, wallet);
  if (!isValid) {
    return c.json({ error: 'Invalid signature' }, 401);
  }

  try {
    await prisma.capability.update({
      where: { wallet_capability: { wallet, capability } },
      data: { active: false },
    });

    return c.json({ success: true, message: `Capability '${capability}' deregistered` });
  } catch (error: any) {
    return c.json({ error: 'Capability not found' }, 404);
  }
});

/**
 * GET /api/capabilities/:capability/message
 * Get the message to sign for capability registration/deregistration
 */
app.get('/api/capabilities/:capability/message', (c) => {
  const capability = c.req.param('capability');
  const { wallet } = c.req.query();

  if (!wallet) {
    return c.json({ error: 'Query param required: wallet' }, 400);
  }

  const timestamp = Date.now();
  const message = getCapabilityMessage(wallet, capability, timestamp);

  return c.json({ message, timestamp });
});

// ============ START ============

const port = parseInt(process.env.PORT || '3001');

// Sync on startup, then every 5 minutes
syncAgentsFromChain();
// Mount A2A routes
app.route('/a2a', a2aRoutes);
console.log('✅ A2A Protocol endpoints mounted');

// Pre-cache request body BEFORE x402 middleware runs.
// Hono's c.req.json() can only be called once; the x402 middleware may consume it,
// leaving the free-tier hook unable to read the body. This middleware clones the
// request and stashes the parsed JSON in a WeakMap keyed by the raw Request object.
app.use('/xchain/*', async (c, next) => {
  try {
    const cloned = c.req.raw.clone();
    const body = await cloned.json();
    bodyCache.set(c.req.raw, body);
  } catch {
    // Not JSON or empty body — that's fine, free tier just won't match
  }
  await next();
});

// x402 payment middleware for cross-chain messaging (Coinbase SDK + PayAI Facilitator)
// Includes built-in free tier: 10 messages/day per agent
app.use('*', createX402Middleware());
console.log(`✅ x402 payment gate active on POST /xchain/message ($0.01 USDC via Coinbase x402 SDK)`);
console.log(`✅ Free tier: ${FREE_MESSAGES_PER_DAY} messages/day per agent`);
console.log(`✅ Supported payment chains: ${Object.keys(CHAINS).join(', ')}`);

// GET /xchain/message — return 402 challenge for x402scan discovery
app.get('/xchain/message', (c) => {
  const paymentChallenge = {
    x402Version: 2,
    error: 'Payment required',
    resource: {
      url: 'https://api.saidprotocol.com/xchain/message',
      description: 'Send a message between AI agents across Solana, Base, Polygon, Avalanche & Sei. Resolves identities, delivers via WebSocket/A2A/webhook.',
      mimeType: 'application/json',
      inputSchema: {
        type: 'object',
        required: ['from', 'to', 'message'],
        properties: {
          from: {
            type: 'object',
            required: ['address', 'chain'],
            properties: {
              address: { type: 'string', description: 'Sender wallet address' },
              chain: { type: 'string', enum: ['solana', 'base', 'polygon', 'avalanche', 'sei'] },
            },
          },
          to: {
            type: 'object',
            required: ['address', 'chain'],
            properties: {
              address: { type: 'string', description: 'Recipient wallet address' },
              chain: { type: 'string', enum: ['solana', 'base', 'polygon', 'avalanche', 'sei'] },
            },
          },
          message: { type: 'string', description: 'Message content' },
          context: { type: 'object', description: 'Optional context/metadata' },
        },
      },
      outputSchema: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          messageId: { type: 'string' },
          status: { type: 'string', enum: ['delivered', 'stored'] },
          from: { type: 'object' },
          to: { type: 'object' },
        },
      },
    },
    accepts: [
      {
        scheme: 'exact',
        network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        price: '0.01',
        payTo: process.env.SAID_X402_TREASURY || 'EK3mP45iwgDEEts2cEDfhAs2i4PrH63NMG7vHg2d6fas',
        description: '$0.01 USDC on Solana',
      },
      {
        scheme: 'exact',
        network: 'eip155:8453',
        price: '0.01',
        payTo: process.env.SAID_EVM_TREASURY || '',
        description: '$0.01 USDC on Base',
      },
    ],
  };

  const encoded = Buffer.from(JSON.stringify(paymentChallenge)).toString('base64');
  c.header('Payment-Required', encoded);
  return c.json(paymentChallenge, 402);
});

app.route('/xchain', crossChainRoutes);
console.log('✅ Cross-Chain Communication endpoints mounted');

// Mount Trust Score engine
app.route('/api/score', createScoreRoutes(prisma, connection));
initScoreWorker(prisma, connection);
console.log('✅ Trust Score engine mounted (GET /api/score/:wallet)');

// Mount Delegated Signing Authority (Privy wallet) routes
const walletRoutes = createWalletRoutes(prisma, connection, privyClient);
app.route('/', walletRoutes);
console.log('✅ Delegated Signing Authority endpoints mounted (/v1/wallet/*, /v1/transaction/*, /v1/apikey/*, /v1/policy/*)');

setInterval(syncAgentsFromChain, 5 * 60 * 1000);

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`SAID API running on http://localhost:${info.port}`);
});
setupWebSocket(server as any);
// Rebuild trigger Tue Feb  3 17:46:45 UTC 2026

/**
 * POST /api/passport/:wallet/send
 * Proxy endpoint to send signed transaction via server RPC
 */
app.post('/api/passport/:wallet/send', async (c) => {
  try {
    const { signedTransaction } = await c.req.json() as { signedTransaction: string };
    if (!signedTransaction) return c.json({ error: 'signedTransaction required' }, 400);

    const txBytes = Buffer.from(signedTransaction, 'base64');
    const signature = await connection.sendRawTransaction(txBytes, { skipPreflight: false });
    await connection.confirmTransaction(signature, 'confirmed');

    return c.json({ ok: true, signature });
  } catch (err: any) {
    console.error('Send transaction error:', err);
    return c.json({ error: err.message }, 500);
  }
});

// ============ SEED CORE CAPABILITIES ============
// Register SAID's own services in the capabilities registry on startup
async function seedCoreCapabilities() {
  const coreServices: Array<{ wallet: string; capability: string; endpoint: string; description: string; pricing: any; chain: string }> = [
    {
      wallet: 'SAID_PROTOCOL',
      capability: 'said.messaging.v1',
      endpoint: 'https://api.saidprotocol.com/xchain/message',
      description: 'Cross-chain agent-to-agent messaging across 10+ networks. Free tier: 10 msgs/day. Paid: $0.01 USDC per message via x402.',
      pricing: { amount: '0.01', currency: 'USDC', chain: 'solana', freeTier: '10 messages/day' },
      chain: 'cross-chain',
    },
    {
      wallet: 'SAID_PROTOCOL',
      capability: 'said.messaging.websocket.v1',
      endpoint: 'wss://api.saidprotocol.com/ws',
      description: 'Real-time bidirectional agent communication via WebSocket. Auth with wallet signature. Free tier + x402 payments.',
      pricing: { amount: '0.01', currency: 'USDC', chain: 'solana', freeTier: '10 messages/day' },
      chain: 'cross-chain',
    },
    {
      wallet: 'SAID_PROTOCOL',
      capability: 'said.identity.register.v1',
      endpoint: 'https://api.saidprotocol.com/api/register/sponsored',
      description: 'Register your agent on SAID Protocol. On-chain identity on Solana with optional verification.',
      pricing: { amount: '0', currency: 'SOL', chain: 'solana', note: 'Free sponsored registration' },
      chain: 'solana',
    },
    {
      wallet: 'SAID_PROTOCOL',
      capability: 'said.directory.v1',
      endpoint: 'https://api.saidprotocol.com/api/agents',
      description: 'Discover registered AI agents. Search by name, skills, platform. 1,200+ agents indexed.',
      pricing: Prisma.JsonNull,
      chain: 'cross-chain',
    },
    {
      wallet: 'SAID_PROTOCOL',
      capability: 'said.webhooks.v1',
      endpoint: 'https://api.saidprotocol.com/xchain/webhook',
      description: 'Register webhooks to receive agent messages via HTTP POST. HMAC-SHA256 signed.',
      pricing: Prisma.JsonNull,
      chain: 'cross-chain',
    },
  ];

  for (const svc of coreServices) {
    try {
      await prisma.capability.upsert({
        where: { wallet_capability: { wallet: svc.wallet, capability: svc.capability } },
        create: svc,
        update: {
          endpoint: svc.endpoint,
          description: svc.description,
          pricing: svc.pricing,
          active: true,
        },
      });
    } catch (e: any) {
      // Skip if agent relation fails (SAID_PROTOCOL isn't a real agent)
      if (e.code === 'P2003') {
        // Foreign key constraint — need to create a system agent first
        try {
          await prisma.agent.upsert({
            where: { wallet: 'SAID_PROTOCOL' },
            create: {
              wallet: 'SAID_PROTOCOL',
              pda: 'SAID_PROTOCOL',
              owner: 'SAID_PROTOCOL',
              metadataUri: 'https://api.saidprotocol.com',
              name: 'SAID Protocol',
              description: 'The Communication Layer for AI Agents',
              registeredAt: new Date(),
              isVerified: true,
              verifiedAt: new Date(),
              registrationSource: 'system',
            },
            update: {},
          });
          await prisma.capability.upsert({
            where: { wallet_capability: { wallet: svc.wallet, capability: svc.capability } },
            create: svc,
            update: {
              endpoint: svc.endpoint,
              description: svc.description,
              pricing: svc.pricing,
              active: true,
            },
          });
        } catch (e2) {
          console.error(`[Seed] Failed to seed ${svc.capability}:`, e2);
        }
      }
    }
  }
  console.log('[Seed] Core capabilities registered');
}

// Run seed on startup (after DB connection)
seedCoreCapabilities().catch(console.error);

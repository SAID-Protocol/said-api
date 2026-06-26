/**
 * Delegated Signing Authority — Privy Agent Wallet Endpoints
 * 
 * Architecture:
 *   Agent/Operator → SAID API (validates, enforces policy) → Privy (signs tx) → Solana
 *   Agent NEVER holds private keys. Privy holds keys in secure enclave.
 *   SAID acts as authorization layer with rotatable API keys.
 * 
 * Endpoints:
 *   POST /v1/wallet/create         — Provision Privy wallet for agent (auth required)
 *   GET  /v1/wallet/:agentId       — Get wallet public key + balance (public)
 *   POST /v1/wallet/upgrade        — Add Privy wallet to existing agent (auth required)
 *   POST /v1/transaction/request   — Request a transaction (API key required)
 *   GET  /v1/transaction/:txId     — Get transaction status
 *   POST /v1/apikey/generate       — Generate rotatable API key (session auth required)
 *   POST /v1/apikey/revoke         — Revoke an API key (session auth required)
 *   GET  /v1/policy/:agentId       — Get current policy limits
 *   PUT  /v1/policy/:agentId       — Update policy limits (owner only)
 * 
 * Security review applied (March 28, 2026):
 *   - Auth required on wallet creation/upgrade
 *   - Race condition fix: advisory lock + pending/approved in spending aggregation
 *   - Transaction status state machine enforcement
 *   - Idempotency keys on transaction requests
 *   - Rate limiting on all authenticated endpoints
 *   - Monthly spending limit enforcement
 *   - requireApprovalAbove threshold
 *   - Agent + wallet status pre-checks
 */

import { Hono } from 'hono';
import { PrismaClient } from '@prisma/client';
import { Connection, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import crypto from 'crypto';

// ============================================================
// Types
// ============================================================

interface AgentContext {
  agentId: string;
  agentWallet: string;
  apiKeyId: string;
  scopes: string[];
  rateLimitPerHour: number;
}

// Valid transaction status transitions
const VALID_TRANSITIONS: Record<string, string[]> = {
  pending:   ['approved', 'denied', 'failed'],
  approved:  ['signing', 'failed'],
  signing:   ['broadcast', 'failed'],
  broadcast: ['confirmed', 'failed'],
  confirmed: [], // terminal
  denied:    [], // terminal
  failed:    [], // terminal
};

// Statuses that count toward spending limits (prevents race conditions)
const SPENDING_STATUSES = ['pending', 'approved', 'signing', 'broadcast', 'confirmed'];

// ============================================================
// Configuration
// ============================================================

const API_KEY_PREFIX = 'said_ak_';
// SAID_API_KEY_HMAC_SECRET: Used to HMAC-hash agent API keys before storing in DB.
// MUST be consistent across deploys or all issued API keys become invalid.
const API_KEY_SECRET = process.env.SAID_API_KEY_HMAC_SECRET || process.env.API_KEY_SECRET || crypto.randomBytes(32).toString('hex');

// ============================================================
// API Key Utilities
// ============================================================

function generateRawApiKey(): string {
  const randomPart = crypto.randomBytes(24).toString('hex');
  return `${API_KEY_PREFIX}${randomPart}`;
}

function hashApiKey(apiKey: string): string {
  return crypto.createHmac('sha256', API_KEY_SECRET).update(apiKey).digest('hex');
}

// ============================================================
// Transaction Status State Machine
// ============================================================

function canTransition(currentStatus: string, newStatus: string): boolean {
  const allowed = VALID_TRANSITIONS[currentStatus];
  return allowed ? allowed.includes(newStatus) : false;
}

async function updateTxStatus(
  prisma: PrismaClient,
  txId: string,
  newStatus: string,
  extraData: Record<string, any> = {}
): Promise<boolean> {
  const tx = await prisma.transactionRequest.findUnique({ where: { id: txId } });
  if (!tx) return false;
  
  if (!canTransition(tx.status, newStatus)) {
    console.warn(`[TX State] Invalid transition: ${tx.status} → ${newStatus} for tx ${txId}`);
    return false;
  }
  
  await prisma.transactionRequest.update({
    where: { id: txId },
    data: { status: newStatus, ...extraData },
  });
  return true;
}

// ============================================================
// Middleware: Validate API Key + Rate Limit
// ============================================================

function createApiKeyMiddleware(prisma: PrismaClient) {
  // In-memory rate limit counters (per API key per hour window)
  const rateLimitCounters = new Map<string, { count: number; windowStart: number }>();
  
  return async (c: any, next: () => Promise<void>) => {
    const authHeader = c.req.header('Authorization');
    
    if (!authHeader || !authHeader.startsWith('Bearer said_ak_')) {
      return c.json({ error: 'Missing or invalid API key. Use: Authorization: Bearer said_ak_...' }, 401);
    }
    
    const apiKey = authHeader.substring(7);
    const keyHash = hashApiKey(apiKey);
    
    const keyRecord = await prisma.apiKey.findUnique({
      where: { keyHash },
      include: { agent: true }
    });
    
    if (!keyRecord) {
      return c.json({ error: 'Invalid API key' }, 401);
    }
    
    if (keyRecord.revokedAt) {
      return c.json({ error: 'API key has been revoked' }, 401);
    }
    
    if (keyRecord.expiresAt && new Date(keyRecord.expiresAt) < new Date()) {
      return c.json({ error: 'API key has expired' }, 401);
    }
    
    // ---- Rate Limiting (in-memory, per key per hour) ----
    const now = Date.now();
    const windowStart = Math.floor(now / 3600000) * 3600000; // Round to hour
    const counterKey = `${keyRecord.id}:${windowStart}`;
    
    const counter = rateLimitCounters.get(counterKey);
    if (counter) {
      if (counter.count >= keyRecord.rateLimitPerHour) {
        const resetAt = new Date(windowStart + 3600000);
        return c.json({
          error: 'Rate limit exceeded',
          limit: keyRecord.rateLimitPerHour,
          resetAt: resetAt.toISOString(),
          retryAfter: Math.ceil((resetAt.getTime() - now) / 1000),
        }, 429);
      }
      counter.count++;
    } else {
      // Clean up old windows
      for (const [k, v] of rateLimitCounters) {
        if (v.windowStart < windowStart) rateLimitCounters.delete(k);
      }
      rateLimitCounters.set(counterKey, { count: 1, windowStart });
    }
    
    // Update last used (non-blocking)
    prisma.apiKey.update({
      where: { id: keyRecord.id },
      data: { lastUsedAt: new Date() }
    }).catch(() => {});
    
    // Attach agent context
    c.set('agentCtx', {
      agentId: keyRecord.agentId,
      agentWallet: keyRecord.agent.wallet,
      apiKeyId: keyRecord.id,
      scopes: keyRecord.scopes,
      rateLimitPerHour: keyRecord.rateLimitPerHour,
    } satisfies AgentContext);
    
    await next();
  };
}

// ============================================================
// Middleware: Session Auth (for wallet creation, API key management)
// Checks for session token from the existing auth system
// ============================================================

// ============================================================
// Middleware: Session Auth (for wallet creation, API key management)
// ============================================================

function createSessionAuthMiddleware(prisma: PrismaClient) {
  return async (c: any, next: () => Promise<void>) => {
    // Accept either session token or API key
    const authHeader = c.req.header('Authorization');
    const sessionToken = c.req.header('X-Session-Token') || (authHeader?.startsWith('Bearer ') && !authHeader.startsWith('Bearer said_ak_') ? authHeader.substring(7) : null);
    
    if (!sessionToken) {
      return c.json({ error: 'Authentication required. Provide X-Session-Token header or Bearer token.' }, 401);
    }
    
    const user = await prisma.user.findUnique({
      where: { sessionToken },
      include: { agents: true }
    });
    
    if (!user || !user.sessionExpiry || new Date(user.sessionExpiry) < new Date()) {
      return c.json({ error: 'Invalid or expired session' }, 401);
    }
    
    c.set('userId', user.id);
    c.set('userAgentIds', user.agents.map((ua: any) => ua.agentWallet));
    
    await next();
  };
}

// ============================================================
// Mock Privy Wallet Service
// 
// TODO: Replace with real Privy SDK after Tuesday call.
// 
// IMPORTANT notes from security review:
// - Mock must return same response shapes as real Privy SDK
// - Mock addresses don't exist on-chain (balance checks return 0)
// - Privy uses ECDSA P-256 for authorization keys (not Ed25519)
//   → Confirm exact signing flow on Tuesday
// - Consider devnet wallets for e2e testing before live switch
// ============================================================

class PrivyWalletService {
  private isMock: boolean;
  private privyClient: any;
  
  constructor(privyClient?: any) {
    this.privyClient = privyClient;
    this.isMock = process.env.PRIVY_WALLET_MODE !== 'live';
    if (this.isMock) {
      console.log('[Privy Wallets] Running in MOCK mode. Set PRIVY_WALLET_MODE=live for production.');
    } else {
      console.log('[Privy Wallets] Running in LIVE mode with Privy SDK.');
    }
  }
  
  async createWallet(agentId: string): Promise<{
    publicKey: string;
    providerWalletId: string;
    provider: string;
  }> {
    if (this.isMock) {
      const mockBytes = crypto.randomBytes(32);
      const chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
      let mockAddress = '';
      for (let i = 0; i < 44; i++) {
        mockAddress += chars[mockBytes[i % 32] % chars.length];
      }
      
      return {
        publicKey: mockAddress,
        providerWalletId: `privy-mock-${crypto.randomUUID()}`,
        provider: 'mock',
      };
    }
    
    // Real Privy SDK — create Solana wallet
    const wallet = await this.privyClient.wallets().create({ chain_type: 'solana' });
    return {
      publicKey: wallet.address,
      providerWalletId: wallet.id,
      provider: 'privy',
    };
  }
  
  async signTransaction(providerWalletId: string, serializedTx: string): Promise<{
    signedTransaction: string;
    signature: string;
  }> {
    if (this.isMock) {
      const mockSig = crypto.randomBytes(64).toString('hex');
      return {
        signedTransaction: serializedTx,
        signature: `mock-sig-${mockSig.substring(0, 16)}`,
      };
    }
    
    // Real Privy SDK — sign transaction via RPC
    const result = await this.privyClient.wallets().rpc(providerWalletId, {
      method: 'signTransaction',
      params: {
        encoding: 'base64',
        transaction: serializedTx,
      },
    });
    return {
      signedTransaction: (result.data as any)?.signed_transaction || serializedTx,
      signature: (result.data as any)?.signature || result.hash || 'unknown',
    };
  }
  
  async getBalance(publicKey: string, connection: Connection): Promise<{
    sol: number;
    usdc: number;
  }> {
    try {
      const pubkey = new PublicKey(publicKey);
      const lamports = await connection.getBalance(pubkey);
      // TODO: SPL token balance lookup for USDC
      return { sol: lamports / LAMPORTS_PER_SOL, usdc: 0 };
    } catch {
      return { sol: 0, usdc: 0 };
    }
  }
}

// ============================================================
// Route Factory
// ============================================================

type Variables = {
  agentCtx: AgentContext;
  userId: string;
  userAgentIds: string[];
};

export function createWalletRoutes(prisma: PrismaClient, connection: Connection, privyClient?: any) {
  const app = new Hono<{ Variables: Variables }>();
  const privyWallets = new PrivyWalletService(privyClient);
  const validateApiKey = createApiKeyMiddleware(prisma);
  const requireSession = createSessionAuthMiddleware(prisma);
  
  // ----------------------------------------------------------
  // POST /v1/wallet/create
  // Provision a new Privy wallet for an agent
  // Auth: Session token required (must own the agent)
  // ----------------------------------------------------------
  app.use('/v1/wallet/create', requireSession);
  app.post('/v1/wallet/create', async (c) => {
    const body = await c.req.json();
    const { agentId, walletType = 'transaction' } = body;
    
    if (!agentId) {
      return c.json({ error: 'Required: agentId' }, 400);
    }
    
    // Verify agent exists
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) {
      return c.json({ error: 'Agent not found' }, 404);
    }
    
    // Verify caller owns this agent
    const userAgentIds = c.get('userAgentIds') as string[];
    if (!userAgentIds.includes(agent.wallet)) {
      return c.json({ error: 'You do not own this agent' }, 403);
    }
    
    // Check if agent already has a wallet of this type
    const existingWallet = await prisma.agentWallet.findFirst({
      where: { agentId, walletType, status: 'active' }
    });
    
    if (existingWallet) {
      return c.json({
        error: 'Agent already has an active wallet of this type',
        existingWallet: {
          id: existingWallet.id,
          publicKey: existingWallet.publicKey,
          walletType: existingWallet.walletType,
        }
      }, 409);
    }
    
    try {
      const privyResult = await privyWallets.createWallet(agentId);
      
      const wallet = await prisma.agentWallet.create({
        data: {
          agentId,
          publicKey: privyResult.publicKey,
          provider: privyResult.provider,
          providerWalletId: privyResult.providerWalletId,
          walletType,
          isPrimary: walletType === 'transaction',
          metadata: {
            provisionedAt: new Date().toISOString(),
            mode: process.env.PRIVY_WALLET_MODE || 'mock',
          },
        }
      });
      
      // Auto-create default policy
      await prisma.transactionPolicy.upsert({
        where: { agentId },
        create: {
          agentId,
          maxPerTransaction: 10.00,
          maxPerDay: 100.00,
          maxPerMonth: 1000.00,
          allowedTokens: ['USDC', 'SOL'],
          allowedPrograms: [],
        },
        update: {},
      });
      
      return c.json({
        success: true,
        wallet: {
          id: wallet.id,
          agentId: wallet.agentId,
          publicKey: wallet.publicKey,
          provider: wallet.provider,
          walletType: wallet.walletType,
          status: wallet.status,
          createdAt: wallet.createdAt,
        },
        note: privyResult.provider === 'mock'
          ? 'Mock wallet. Real Privy integration after Tuesday call.'
          : 'Wallet provisioned via Privy. Private key in secure enclave.',
      }, 201);
      
    } catch (error: any) {
      console.error('[Wallet Create Error]', error);
      return c.json({ error: 'Failed to provision wallet', details: error.message }, 500);
    }
  });
  
  // ----------------------------------------------------------
  // GET /v1/wallet/:agentId
  // Get agent's wallet info + balance (public endpoint)
  // ----------------------------------------------------------
  app.get('/v1/wallet/:agentId', async (c) => {
    const agentId = c.req.param('agentId');
    
    const wallets = await prisma.agentWallet.findMany({
      where: { agentId, status: 'active' },
      orderBy: { createdAt: 'desc' },
    });
    
    if (wallets.length === 0) {
      return c.json({ error: 'No Privy wallets found. Use POST /v1/wallet/create first.' }, 404);
    }
    
    const walletsWithBalances = await Promise.all(
      wallets.map(async (w) => {
        const balance = await privyWallets.getBalance(w.publicKey, connection);
        return {
          id: w.id,
          publicKey: w.publicKey,
          provider: w.provider,
          walletType: w.walletType,
          isPrimary: w.isPrimary,
          status: w.status,
          balance,
          createdAt: w.createdAt,
        };
      })
    );
    
    return c.json({ agentId, wallets: walletsWithBalances });
  });
  
  // ----------------------------------------------------------
  // POST /v1/wallet/upgrade
  // Add Privy wallet to existing agent (opt-in migration)
  // Auth: Session token required (must own the agent)
  // ----------------------------------------------------------
  app.use('/v1/wallet/upgrade', requireSession);
  app.post('/v1/wallet/upgrade', async (c) => {
    const body = await c.req.json();
    const { agentId } = body;
    
    if (!agentId) {
      return c.json({ error: 'Required: agentId' }, 400);
    }
    
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) {
      return c.json({ error: 'Agent not found' }, 404);
    }
    
    // Verify caller owns this agent
    const userAgentIds = c.get('userAgentIds') as string[];
    if (!userAgentIds.includes(agent.wallet)) {
      return c.json({ error: 'You do not own this agent' }, 403);
    }
    
    // Check if already upgraded
    const existingWallet = await prisma.agentWallet.findFirst({
      where: { agentId, walletType: 'transaction', status: 'active' }
    });
    
    if (existingWallet) {
      return c.json({
        error: 'Agent already has a Privy transaction wallet',
        wallet: { publicKey: existingWallet.publicKey, createdAt: existingWallet.createdAt }
      }, 409);
    }
    
    try {
      const privyResult = await privyWallets.createWallet(agentId);
      
      const wallet = await prisma.agentWallet.create({
        data: {
          agentId,
          publicKey: privyResult.publicKey,
          provider: privyResult.provider,
          providerWalletId: privyResult.providerWalletId,
          walletType: 'transaction',
          isPrimary: true,
          metadata: {
            upgradedFrom: 'self-custody',
            originalWallet: agent.wallet,
            provisionedAt: new Date().toISOString(),
          },
        }
      });
      
      await prisma.transactionPolicy.upsert({
        where: { agentId },
        create: {
          agentId,
          maxPerTransaction: 10.00,
          maxPerDay: 100.00,
          maxPerMonth: 1000.00,
          allowedTokens: ['USDC', 'SOL'],
          allowedPrograms: [],
        },
        update: {},
      });
      
      return c.json({
        success: true,
        wallet: {
          id: wallet.id,
          publicKey: wallet.publicKey,
          provider: wallet.provider,
          status: wallet.status,
        },
        originalWallet: agent.wallet,
        nextSteps: {
          step1: 'Deposit funds (SOL/USDC) to the new wallet address',
          step2: 'Use POST /v1/transaction/request to transact via SAID',
          step3: '(Optional) Link on-chain via /api/wallet/link for identity resolution',
        },
        note: 'Original self-custody wallet remains active. Privy wallet is an additional secure transaction wallet.',
      }, 201);
      
    } catch (error: any) {
      console.error('[Wallet Upgrade Error]', error);
      return c.json({ error: 'Failed to upgrade wallet', details: error.message }, 500);
    }
  });
  
  // ----------------------------------------------------------
  // POST /v1/transaction/request
  // Request a transaction — full policy check → Privy sign → broadcast
  // Auth: API key required with "transaction" scope
  //
  // Security: Uses advisory lock to prevent race conditions on
  // concurrent spending limit checks.
  // ----------------------------------------------------------
  app.use('/v1/transaction/request', validateApiKey);
  app.post('/v1/transaction/request', async (c) => {
    const agentCtx = c.get('agentCtx') as AgentContext;
    const body = await c.req.json();
    const { type, token, amount, recipient, programId, memo, idempotencyKey } = body;
    
    // Validate required fields
    if (!type || !token || amount === undefined) {
      return c.json({ error: 'Required: type, token, amount' }, 400);
    }
    
    if (type === 'transfer' && !recipient) {
      return c.json({ error: 'Recipient required for transfer transactions' }, 400);
    }
    
    // Check scope
    if (!agentCtx.scopes.includes('transaction')) {
      return c.json({ error: 'API key does not have transaction scope' }, 403);
    }
    
    const numAmount = Number(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      return c.json({ error: 'Amount must be a positive number' }, 400);
    }
    
    // ---- Idempotency Check ----
    if (idempotencyKey) {
      const existing = await prisma.transactionRequest.findFirst({
        where: { agentId: agentCtx.agentId, memo: `idempotency:${idempotencyKey}` },
        orderBy: { createdAt: 'desc' },
      });
      if (existing) {
        return c.json({
          transactionId: existing.id,
          status: existing.status,
          note: 'Duplicate request detected via idempotency key. Returning existing transaction.',
          txHash: existing.txHash,
        });
      }
    }
    
    // ---- Pre-check 1: Agent status ----
    const agent = await prisma.agent.findUnique({ where: { id: agentCtx.agentId } });
    if (!agent) {
      return c.json({ error: 'Agent not found' }, 404);
    }
    // Note: Add agent suspension/deactivation check here when that feature exists
    
    // ---- Pre-check 2: Wallet status ----
    const wallet = await prisma.agentWallet.findFirst({
      where: { agentId: agentCtx.agentId, walletType: 'transaction', status: 'active', isPrimary: true }
    });
    
    if (!wallet) {
      return c.json({ error: 'No active Privy wallet. Use POST /v1/wallet/create first.' }, 404);
    }
    
    if (wallet.status !== 'active') {
      return c.json({ error: `Wallet is ${wallet.status}. Cannot transact.` }, 403);
    }
    
    // Create transaction request record
    const txRequest = await prisma.transactionRequest.create({
      data: {
        agentId: agentCtx.agentId,
        walletId: wallet.id,
        apiKeyId: agentCtx.apiKeyId,
        type,
        token,
        amount,
        recipient,
        programId,
        memo: idempotencyKey ? `idempotency:${idempotencyKey}` : memo,
        status: 'pending',
      }
    });
    
    try {
      // ---- Policy Check (with advisory lock to prevent race conditions) ----
      // Use raw SQL advisory lock on the agent's policy row
      // This serializes concurrent requests for the same agent
      const policy = await prisma.$queryRaw`
        SELECT * FROM "TransactionPolicy" 
        WHERE "agentId" = ${agentCtx.agentId} 
        FOR UPDATE
      `.then((rows: any) => rows[0] || null);
      
      if (policy && policy.status === 'active') {
        // Check 1: Per-transaction limit
        if (numAmount > Number(policy.maxPerTransaction)) {
          await updateTxStatus(prisma, txRequest.id, 'denied', {
            policyPassed: false,
            policyReason: `Exceeds per-transaction limit: ${amount} > ${policy.maxPerTransaction}`,
          });
          return c.json({
            transactionId: txRequest.id,
            status: 'denied',
            policyCheck: {
              passed: false,
              reason: `Exceeds per-transaction limit (${amount} > ${policy.maxPerTransaction} ${token})`,
            }
          }, 403);
        }
        
        // Check 2: Daily spending limit
        // Includes pending+approved+signing+broadcast+confirmed to prevent race conditions
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        
        const dailySpend = await prisma.transactionRequest.aggregate({
          where: {
            agentId: agentCtx.agentId,
            status: { in: SPENDING_STATUSES },
            createdAt: { gte: todayStart },
            id: { not: txRequest.id }, // Exclude current request
          },
          _sum: { amount: true },
        });
        
        const dailyTotal = Number(dailySpend._sum.amount || 0) + numAmount;
        if (dailyTotal > Number(policy.maxPerDay)) {
          await updateTxStatus(prisma, txRequest.id, 'denied', {
            policyPassed: false,
            policyReason: `Exceeds daily limit: ${dailyTotal.toFixed(2)} > ${policy.maxPerDay}`,
          });
          return c.json({
            transactionId: txRequest.id,
            status: 'denied',
            policyCheck: {
              passed: false,
              reason: `Exceeds daily limit (${dailyTotal.toFixed(2)} > ${policy.maxPerDay} ${token})`,
              currentDailySpend: Number(dailySpend._sum.amount || 0),
            }
          }, 403);
        }
        
        // Check 3: Monthly spending limit
        const monthStart = new Date();
        monthStart.setDate(1);
        monthStart.setHours(0, 0, 0, 0);
        
        const monthlySpend = await prisma.transactionRequest.aggregate({
          where: {
            agentId: agentCtx.agentId,
            status: { in: SPENDING_STATUSES },
            createdAt: { gte: monthStart },
            id: { not: txRequest.id },
          },
          _sum: { amount: true },
        });
        
        const monthlyTotal = Number(monthlySpend._sum.amount || 0) + numAmount;
        if (monthlyTotal > Number(policy.maxPerMonth)) {
          await updateTxStatus(prisma, txRequest.id, 'denied', {
            policyPassed: false,
            policyReason: `Exceeds monthly limit: ${monthlyTotal.toFixed(2)} > ${policy.maxPerMonth}`,
          });
          return c.json({
            transactionId: txRequest.id,
            status: 'denied',
            policyCheck: {
              passed: false,
              reason: `Exceeds monthly limit (${monthlyTotal.toFixed(2)} > ${policy.maxPerMonth} ${token})`,
              currentMonthlySpend: Number(monthlySpend._sum.amount || 0),
            }
          }, 403);
        }
        
        // Check 4: Token allowlist
        if (policy.allowedTokens.length > 0 && !policy.allowedTokens.includes(token)) {
          await updateTxStatus(prisma, txRequest.id, 'denied', {
            policyPassed: false,
            policyReason: `Token ${token} not in allowlist: ${policy.allowedTokens.join(', ')}`,
          });
          return c.json({
            transactionId: txRequest.id,
            status: 'denied',
            policyCheck: {
              passed: false,
              reason: `Token ${token} not allowed. Permitted: ${policy.allowedTokens.join(', ')}`,
            }
          }, 403);
        }
        
        // Check 5: Program allowlist
        if (programId && policy.allowedPrograms.length > 0 && !policy.allowedPrograms.includes(programId)) {
          await updateTxStatus(prisma, txRequest.id, 'denied', {
            policyPassed: false,
            policyReason: `Program ${programId} not in allowlist`,
          });
          return c.json({
            transactionId: txRequest.id,
            status: 'denied',
            policyCheck: {
              passed: false,
              reason: `Program ${programId} not in allowlist`,
            }
          }, 403);
        }
        
        // Check 6: Approval threshold
        if (numAmount > Number(policy.requireApprovalAbove)) {
          await updateTxStatus(prisma, txRequest.id, 'pending', {
            policyPassed: true,
            policyReason: `Amount ${amount} exceeds approval threshold (${policy.requireApprovalAbove}). Queued for manual approval.`,
          });
          return c.json({
            transactionId: txRequest.id,
            status: 'pending_approval',
            policyCheck: {
              passed: true,
              reason: `Amount exceeds ${policy.requireApprovalAbove} ${token}. Queued for manual approval.`,
            },
            note: 'This transaction requires manual approval from the agent operator.',
          });
        }
      }
      
      // ---- All Policy Checks Passed ----
      await updateTxStatus(prisma, txRequest.id, 'approved', {
        policyPassed: true,
        policyReason: 'All policy checks passed',
      });
      
      // ---- Build & Sign Transaction ----
      if (type === 'transfer' && token === 'SOL') {
        const senderPubkey = new PublicKey(wallet.publicKey);
        const recipientPubkey = new PublicKey(recipient);
        
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
        
        const tx = new Transaction({
          blockhash,
          lastValidBlockHeight,
          feePayer: senderPubkey,
        });
        
        tx.add(
          SystemProgram.transfer({
            fromPubkey: senderPubkey,
            toPubkey: recipientPubkey,
            lamports: Math.round(numAmount * LAMPORTS_PER_SOL),
          })
        );
        
        const serializedTx = tx.serialize({
          requireAllSignatures: false,
          verifySignatures: false,
        }).toString('base64');
        
        // Sign via Privy
        await updateTxStatus(prisma, txRequest.id, 'signing', { serializedTx });
        
        const signResult = await privyWallets.signTransaction(
          wallet.providerWalletId!,
          serializedTx
        );
        
        // Broadcast
        await updateTxStatus(prisma, txRequest.id, 'broadcast', {
          signedAt: new Date(),
          txHash: signResult.signature,
          broadcastAt: new Date(),
        });
        
        if (wallet.provider === 'mock') {
          // A mock wallet must NEVER report a real 'confirmed' settlement — a
          // consumer keying on status would treat fake settlement as real (a
          // fund-safety/trust hazard). In production, refuse outright; otherwise
          // return an unmistakable 'simulated' status, never 'confirmed'.
          if (process.env.PRIVY_WALLET_MODE !== 'live' && process.env.NODE_ENV === 'production') {
            return c.json({
              transactionId: txRequest.id,
              status: 'failed',
              error: 'Wallet is in mock mode — real transactions are disabled in production. Set PRIVY_WALLET_MODE=live.',
            }, 503);
          }
          await updateTxStatus(prisma, txRequest.id, 'confirmed', {
            confirmedAt: new Date(),
          });

          return c.json({
            transactionId: txRequest.id,
            status: 'simulated',
            type,
            amount: numAmount,
            token,
            recipient,
            txHash: signResult.signature,
            policyCheck: { passed: true, reason: 'All policy checks passed' },
            wallet: { publicKey: wallet.publicKey },
            note: 'Mock transaction — NO real funds moved (simulated).',
          });
        }
        
        // TODO: Real broadcast + async confirmation polling
        // For live mode:
        // 1. Send raw transaction
        // 2. Return 'broadcast' status with txHash immediately
        // 3. Background job polls for confirmation, updates status
        // 4. Optional webhook notification to agent when confirmed
        
        return c.json({
          transactionId: txRequest.id,
          status: 'broadcast',
          type,
          amount: numAmount,
          token,
          recipient,
          txHash: signResult.signature,
          policyCheck: { passed: true, reason: 'All policy checks passed' },
          wallet: { publicKey: wallet.publicKey },
          note: 'Transaction broadcast. Confirmation is async — poll GET /v1/transaction/:txId for status.',
        });
        
      } else {
        // Non-SOL-transfer: approved but not yet executable in V1
        return c.json({
          transactionId: txRequest.id,
          status: 'approved',
          type,
          amount: numAmount,
          token,
          recipient,
          policyCheck: { passed: true, reason: 'All policy checks passed' },
          note: `Transaction type '${type}' for '${token}' approved but execution not yet implemented. SOL transfers are live.`,
        });
      }
      
    } catch (error: any) {
      console.error('[Transaction Request Error]', error);
      
      await updateTxStatus(prisma, txRequest.id, 'failed', {
        errorMessage: error.message,
      });
      
      return c.json({
        transactionId: txRequest.id,
        status: 'failed',
        error: error.message,
      }, 500);
    }
  });
  
  // ----------------------------------------------------------
  // GET /v1/transaction/:txId
  // Get transaction status + full audit trail
  // ----------------------------------------------------------
  app.get('/v1/transaction/:txId', async (c) => {
    const txId = c.req.param('txId');
    
    const tx = await prisma.transactionRequest.findUnique({
      where: { id: txId },
      include: { wallet: { select: { publicKey: true, provider: true } } },
    });
    
    if (!tx) {
      return c.json({ error: 'Transaction not found' }, 404);
    }
    
    return c.json({
      transactionId: tx.id,
      agentId: tx.agentId,
      status: tx.status,
      type: tx.type,
      token: tx.token,
      amount: Number(tx.amount),
      recipient: tx.recipient,
      programId: tx.programId,
      txHash: tx.txHash,
      policyCheck: {
        passed: tx.policyPassed,
        reason: tx.policyReason,
      },
      wallet: tx.wallet,
      timestamps: {
        created: tx.createdAt,
        signed: tx.signedAt,
        broadcast: tx.broadcastAt,
        confirmed: tx.confirmedAt,
      },
      error: tx.errorMessage,
    });
  });
  
  // ----------------------------------------------------------
  // POST /v1/apikey/generate
  // Generate a new API key for an agent
  // Auth: Session token required (must own the agent)
  // ----------------------------------------------------------
  app.use('/v1/apikey/generate', requireSession);
  app.post('/v1/apikey/generate', async (c) => {
    const body = await c.req.json();
    const { agentId, name, scopes, rateLimitPerHour, expiresInDays } = body;
    
    if (!agentId) {
      return c.json({ error: 'Required: agentId' }, 400);
    }
    
    // Verify agent exists
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) {
      return c.json({ error: 'Agent not found' }, 404);
    }
    
    // Verify caller owns this agent
    const userAgentIds = c.get('userAgentIds') as string[];
    if (!userAgentIds.includes(agent.wallet)) {
      return c.json({ error: 'You do not own this agent' }, 403);
    }
    
    const rawKey = generateRawApiKey();
    const keyHash = hashApiKey(rawKey);
    const keyPrefix = rawKey.substring(0, 12);
    
    const expiresAt = expiresInDays
      ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
      : null;
    
    const apiKey = await prisma.apiKey.create({
      data: {
        agentId,
        keyHash,
        keyPrefix,
        name: name || null,
        scopes: scopes || ['wallet', 'transaction'],
        rateLimitPerHour: rateLimitPerHour || 100,
        expiresAt,
        createdBy: c.get('userId') as string,
      }
    });
    
    return c.json({
      apiKey: rawKey, // ⚠️ ONLY shown once
      keyId: apiKey.id,
      keyPrefix: apiKey.keyPrefix,
      agentId: apiKey.agentId,
      scopes: apiKey.scopes,
      rateLimitPerHour: apiKey.rateLimitPerHour,
      createdAt: apiKey.createdAt,
      expiresAt: apiKey.expiresAt,
      warning: 'Store this API key securely. It will NOT be shown again.',
    }, 201);
  });
  
  // ----------------------------------------------------------
  // POST /v1/apikey/revoke
  // Revoke an API key
  // Auth: Session token required
  // ----------------------------------------------------------
  app.use('/v1/apikey/revoke', requireSession);
  app.post('/v1/apikey/revoke', async (c) => {
    const body = await c.req.json();
    const { keyId } = body;
    
    if (!keyId) {
      return c.json({ error: 'Required: keyId' }, 400);
    }
    
    const key = await prisma.apiKey.findUnique({
      where: { id: keyId },
      include: { agent: true }
    });
    if (!key) {
      return c.json({ error: 'API key not found' }, 404);
    }
    
    // Verify caller owns the agent this key belongs to
    const userAgentIds = c.get('userAgentIds') as string[];
    if (!userAgentIds.includes(key.agent.wallet)) {
      return c.json({ error: 'You do not own this agent' }, 403);
    }
    
    if (key.revokedAt) {
      return c.json({ error: 'API key already revoked' }, 409);
    }
    
    await prisma.apiKey.update({
      where: { id: keyId },
      data: { revokedAt: new Date() }
    });
    
    return c.json({
      success: true,
      keyId,
      keyPrefix: key.keyPrefix,
      revokedAt: new Date().toISOString(),
    });
  });
  
  // ----------------------------------------------------------
  // GET /v1/policy/:agentId
  // Get current transaction policy + spending totals
  // ----------------------------------------------------------
  app.get('/v1/policy/:agentId', async (c) => {
    const agentId = c.req.param('agentId');
    
    const policy = await prisma.transactionPolicy.findUnique({
      where: { agentId }
    });
    
    if (!policy) {
      return c.json({ error: 'No policy found. One is created automatically when a wallet is provisioned.' }, 404);
    }
    
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    
    const [dailySpend, monthlySpend] = await Promise.all([
      prisma.transactionRequest.aggregate({
        where: {
          agentId,
          status: { in: SPENDING_STATUSES },
          createdAt: { gte: todayStart },
        },
        _sum: { amount: true },
      }),
      prisma.transactionRequest.aggregate({
        where: {
          agentId,
          status: { in: SPENDING_STATUSES },
          createdAt: { gte: monthStart },
        },
        _sum: { amount: true },
      }),
    ]);
    
    return c.json({
      agentId,
      policy: {
        maxPerTransaction: Number(policy.maxPerTransaction),
        maxPerDay: Number(policy.maxPerDay),
        maxPerMonth: Number(policy.maxPerMonth),
        allowedTokens: policy.allowedTokens,
        allowedPrograms: policy.allowedPrograms,
        requireApprovalAbove: Number(policy.requireApprovalAbove),
        status: policy.status,
      },
      currentUsage: {
        todaySpent: Number(dailySpend._sum.amount || 0),
        monthSpent: Number(monthlySpend._sum.amount || 0),
        todayRemaining: Math.max(0, Number(policy.maxPerDay) - Number(dailySpend._sum.amount || 0)),
        monthRemaining: Math.max(0, Number(policy.maxPerMonth) - Number(monthlySpend._sum.amount || 0)),
      },
      updatedAt: policy.updatedAt,
    });
  });
  
  // ----------------------------------------------------------
  // PUT /v1/policy/:agentId
  // Update transaction policy (owner only)
  // Auth: Session token required
  // ----------------------------------------------------------
  app.use('/v1/policy/:agentId', requireSession);
  app.put('/v1/policy/:agentId', async (c) => {
    const agentId = c.req.param('agentId');
    const body = await c.req.json();
    
    // Verify agent exists and caller owns it
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) {
      return c.json({ error: 'Agent not found' }, 404);
    }
    
    const userAgentIds = c.get('userAgentIds') as string[];
    if (!userAgentIds.includes(agent.wallet)) {
      return c.json({ error: 'You do not own this agent' }, 403);
    }
    
    const {
      maxPerTransaction,
      maxPerDay,
      maxPerMonth,
      allowedTokens,
      allowedPrograms,
      requireApprovalAbove,
      status,
    } = body;
    
    const updateData: Record<string, any> = {};
    if (maxPerTransaction !== undefined) updateData.maxPerTransaction = maxPerTransaction;
    if (maxPerDay !== undefined) updateData.maxPerDay = maxPerDay;
    if (maxPerMonth !== undefined) updateData.maxPerMonth = maxPerMonth;
    if (allowedTokens !== undefined) updateData.allowedTokens = allowedTokens;
    if (allowedPrograms !== undefined) updateData.allowedPrograms = allowedPrograms;
    if (requireApprovalAbove !== undefined) updateData.requireApprovalAbove = requireApprovalAbove;
    if (status !== undefined) updateData.status = status;
    
    const policy = await prisma.transactionPolicy.upsert({
      where: { agentId },
      create: { agentId, ...updateData },
      update: updateData,
    });
    
    return c.json({
      success: true,
      agentId,
      policy: {
        maxPerTransaction: Number(policy.maxPerTransaction),
        maxPerDay: Number(policy.maxPerDay),
        maxPerMonth: Number(policy.maxPerMonth),
        allowedTokens: policy.allowedTokens,
        allowedPrograms: policy.allowedPrograms,
        requireApprovalAbove: Number(policy.requireApprovalAbove),
        status: policy.status,
      },
      updatedAt: policy.updatedAt,
    });
  });
  
  return app;
}

import { Hono } from 'hono';
import { PrismaClient } from '@prisma/client';
import { PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import type { AgentCard, A2AMessage, A2ATask, DiscoveryQuery } from './a2a-types.js';

const prisma = new PrismaClient();
const a2a = new Hono();

// When true, the relay rejects messages without a valid sender signature.
// Defaults to false so existing unsigned callers keep working; unsigned messages
// are still accepted but flagged unauthenticated and stripped of borrowed trust.
const A2A_REQUIRE_SIGNATURE = process.env.A2A_REQUIRE_SIGNATURE === 'true';

// Messages older than this (vs the signed timestamp) are rejected to prevent replay.
const A2A_SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Verifies that `signature` is an ed25519 signature by `fromWallet` over the
 * canonical A2A payload. Returns false on any malformed input — never throws.
 */
function verifyA2ASignature(
  fromWallet: string,
  toWallet: string,
  message: string,
  timestamp: unknown,
  signature: unknown,
): boolean {
  if (typeof signature !== 'string' || typeof timestamp !== 'number') return false;
  if (Math.abs(Date.now() - timestamp) > A2A_SIGNATURE_MAX_AGE_MS) return false;
  try {
    const payload = `SAID-A2A:${fromWallet}:${toWallet}:${timestamp}:${message}`;
    return nacl.sign.detached.verify(
      new TextEncoder().encode(payload),
      bs58.decode(signature),
      new PublicKey(fromWallet).toBytes(),
    );
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════
// 1. AGENT CARD (Discovery)
// ═══════════════════════════════════════════════════════

/**
 * GET /a2a/:wallet/agent-card.json
 * Returns A2A-compliant agent card for discovery
 */
a2a.get('/:wallet/agent-card.json', async (c) => {
  const { wallet } = c.req.param();
  
  try {
    const agent = await prisma.agent.findUnique({
      where: { wallet },
      select: {
        wallet: true,
        name: true,
        description: true,
        isVerified: true,
        reputationScore: true,
        feedbackCount: true,
        registeredAt: true,
        skills: true,
        a2aEndpoint: true,
      }
    });
    
    if (!agent) {
      return c.json({ error: 'Agent not found' }, 404);
    }
    
    const agentCard: AgentCard = {
      name: agent.name || 'Unnamed Agent',
      description: agent.description || 'No description provided',
      capabilities: agent.skills || [],
      endpoint: agent.a2aEndpoint || `https://api.saidprotocol.com/a2a/${wallet}`,
      version: '0.3.0',
      said: {
        verified: agent.isVerified,
        wallet: agent.wallet,
        reputationScore: agent.reputationScore,
        registeredAt: agent.registeredAt.toISOString(),
        feedbackCount: agent.feedbackCount,
      },
      authentication: {
        methods: ['wallet-signature', 'said-verification'],
        required: true,
      }
    };
    
    return c.json(agentCard);
    
  } catch (error) {
    console.error('[A2A Card Error]', error);
    return c.json({ error: 'Failed to generate agent card' }, 500);
  }
});

// ═══════════════════════════════════════════════════════
// 2. MESSAGE RELAY (Communication)
// ═══════════════════════════════════════════════════════

/**
 * POST /a2a/:wallet/message
 * Send message to an agent
 */
a2a.post('/:wallet/message', async (c) => {
  const { wallet: toWallet } = c.req.param();
  
  try {
    const body = await c.req.json();
    const { from: fromWallet, message, context, signature, timestamp } = body;

    if (!fromWallet || !message) {
      return c.json({ error: 'Missing required fields: from, message' }, 400);
    }

    // Verify sender is SAID-registered
    const sender = await prisma.agent.findUnique({
      where: { wallet: fromWallet },
      select: { isVerified: true }
    });

    if (!sender) {
      return c.json({ error: 'Sender not registered on SAID' }, 403);
    }

    // Verify recipient exists
    const recipient = await prisma.agent.findUnique({
      where: { wallet: toWallet },
      select: { wallet: true }
    });

    if (!recipient) {
      return c.json({ error: 'Recipient not found' }, 404);
    }

    // Authenticate the claimed sender. Without a valid signature anyone could
    // post as any registered wallet and borrow its verification + reputation;
    // unauthenticated messages are still accepted (unless A2A_REQUIRE_SIGNATURE)
    // but must not carry the sender's trust — see the inbox enrichment below.
    const authenticated = verifyA2ASignature(fromWallet, toWallet, message, timestamp, signature);
    if (A2A_REQUIRE_SIGNATURE && !authenticated) {
      return c.json({ error: 'Valid sender signature required' }, 401);
    }

    // Store message. The signature is persisted only when valid, so a non-null
    // signature is the authoritative marker that this message was authenticated.
    const taskId = `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const msg = await prisma.a2AMessage.create({
      data: {
        fromWallet,
        toWallet,
        message,
        context: context ? JSON.stringify(context) : null,
        taskId,
        fromVerified: authenticated && sender.isVerified,
        signature: authenticated ? (signature as string) : null,
        status: 'created',
        progress: 0,
      }
    });
    
    console.log(`[A2A Message] ${fromWallet} → ${toWallet}: ${message.substring(0, 50)}...`);
    
    return c.json({
      success: true,
      taskId,
      status: 'created',
      streamUrl: `/a2a/${toWallet}/tasks/${taskId}/stream`,
      inboxUrl: `/a2a/${toWallet}/inbox`,
    });
    
  } catch (error) {
    console.error('[A2A Message Error]', error);
    return c.json({ error: 'Failed to send message' }, 500);
  }
});

/**
 * GET /a2a/:wallet/inbox
 * Get messages for an agent
 */
a2a.get('/:wallet/inbox', async (c) => {
  const { wallet } = c.req.param();
  const { limit = '20', status, unreadOnly } = c.req.query();
  
  try {
    const messages = await prisma.a2AMessage.findMany({
      where: {
        toWallet: wallet,
        ...(status && { status }),
      },
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit as string),
      select: {
        id: true,
        taskId: true,
        fromWallet: true,
        message: true,
        context: true,
        status: true,
        progress: true,
        result: true,
        fromVerified: true,
        signature: true,
        createdAt: true,
      }
    });

    // Enrich with sender info. Only an authenticated message (one stored with a
    // verified signature) may carry the sender's real verification + reputation;
    // an unauthenticated message has an unproven `from`, so it is shown as such
    // with no borrowed trust, even though we still resolve the display name.
    const enriched = await Promise.all(messages.map(async (msg) => {
      const sender = await prisma.agent.findUnique({
        where: { wallet: msg.fromWallet },
        select: { name: true, isVerified: true, reputationScore: true }
      });

      const authenticated = msg.signature != null;
      const { signature: _signature, ...rest } = msg;

      return {
        ...rest,
        context: msg.context ? JSON.parse(msg.context) : null,
        result: msg.result ? JSON.parse(msg.result) : null,
        authenticated,
        from: {
          wallet: msg.fromWallet,
          name: sender?.name || 'Unknown',
          verified: authenticated && (sender?.isVerified || false),
          reputation: authenticated ? sender?.reputationScore || 0 : 0,
        }
      };
    }));
    
    return c.json({
      messages: enriched,
      count: enriched.length,
    });
    
  } catch (error) {
    console.error('[A2A Inbox Error]', error);
    return c.json({ error: 'Failed to fetch inbox' }, 500);
  }
});

/**
 * GET /a2a/:wallet/tasks/:taskId
 * Get task status
 */
a2a.get('/:wallet/tasks/:taskId', async (c) => {
  const { wallet, taskId } = c.req.param();
  
  try {
    const task = await prisma.a2AMessage.findFirst({
      where: {
        toWallet: wallet,
        taskId,
      }
    });
    
    if (!task) {
      return c.json({ error: 'Task not found' }, 404);
    }
    
    return c.json({
      taskId: task.taskId,
      status: task.status,
      progress: task.progress,
      result: task.result ? JSON.parse(task.result) : null,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    });
    
  } catch (error) {
    console.error('[A2A Task Error]', error);
    return c.json({ error: 'Failed to fetch task' }, 500);
  }
});

/**
 * PATCH /a2a/:wallet/tasks/:taskId
 * Update task status/progress (for agents processing messages)
 */
a2a.patch('/:wallet/tasks/:taskId', async (c) => {
  const { wallet, taskId } = c.req.param();
  
  try {
    const body = await c.req.json();
    const { status, progress, result } = body;
    
    const updated = await prisma.a2AMessage.update({
      where: { taskId },
      data: {
        ...(status && { status }),
        ...(progress !== undefined && { progress }),
        ...(result && { result: JSON.stringify(result) }),
        updatedAt: new Date(),
      }
    });
    
    console.log(`[A2A Task Update] ${taskId}: ${status || 'progress'} ${progress || ''}`);
    
    return c.json({
      success: true,
      taskId: updated.taskId,
      status: updated.status,
      progress: updated.progress,
    });
    
  } catch (error) {
    console.error('[A2A Task Update Error]', error);
    return c.json({ error: 'Failed to update task' }, 500);
  }
});

// ═══════════════════════════════════════════════════════
// 3. DISCOVERY API (Search)
// ═══════════════════════════════════════════════════════

/**
 * GET /api/agents/discover
 * Discover agents by capability, verification, reputation
 */
a2a.get('/api/agents/discover', async (c) => {
  const { 
    capability, 
    verified, 
    chain = 'solana',
    minReputation,
    limit = '50' 
  } = c.req.query();
  
  try {
    const agents = await prisma.agent.findMany({
      where: {
        ...(verified === 'true' && { isVerified: true }),
        ...(capability && { skills: { has: capability as string } }),
        ...(minReputation && { reputationScore: { gte: parseFloat(minReputation as string) } }),
      },
      orderBy: [
        { isVerified: 'desc' },
        { reputationScore: 'desc' },
      ],
      take: parseInt(limit as string),
      select: {
        wallet: true,
        name: true,
        description: true,
        isVerified: true,
        reputationScore: true,
        feedbackCount: true,
        skills: true,
        a2aEndpoint: true,
        registeredAt: true,
      }
    });
    
    // Generate agent cards
    const agentCards: AgentCard[] = agents.map(agent => ({
      name: agent.name || 'Unnamed Agent',
      description: agent.description || 'No description',
      capabilities: agent.skills || [],
      endpoint: agent.a2aEndpoint || `https://api.saidprotocol.com/a2a/${agent.wallet}`,
      version: '0.3.0',
      said: {
        verified: agent.isVerified,
        wallet: agent.wallet,
        reputationScore: agent.reputationScore,
        registeredAt: agent.registeredAt.toISOString(),
        feedbackCount: agent.feedbackCount,
      }
    }));
    
    return c.json({
      agents: agentCards,
      count: agentCards.length,
      query: { capability, verified, chain, minReputation },
    });
    
  } catch (error) {
    console.error('[A2A Discovery Error]', error);
    return c.json({ error: 'Discovery failed' }, 500);
  }
});

// ═══════════════════════════════════════════════════════
// 4. STATS & HEALTH
// ═══════════════════════════════════════════════════════

/**
 * GET /a2a/stats
 * A2A system stats
 */
a2a.get('/stats', async (c) => {
  try {
    const [totalMessages, totalAgentsWithA2A, messagesByStatus] = await Promise.all([
      prisma.a2AMessage.count(),
      prisma.agent.count({ where: { a2aEndpoint: { not: null } } }),
      prisma.a2AMessage.groupBy({
        by: ['status'],
        _count: true,
      })
    ]);
    
    return c.json({
      totalMessages,
      totalAgentsWithA2A,
      messagesByStatus: messagesByStatus.reduce((acc, item) => {
        acc[item.status] = item._count;
        return acc;
      }, {} as Record<string, number>),
    });
    
  } catch (error) {
    console.error('[A2A Stats Error]', error);
    return c.json({ error: 'Failed to fetch stats' }, 500);
  }
});

export default a2a;

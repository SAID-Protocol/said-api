/**
 * SAID Trust Score Engine — cache + background refresh layer.
 *
 * Score computation lives in `./scoring/trust-score.ts` (the canonical
 * implementation, also used by the `/api/agents/:wallet` live overlay).
 * This file handles caching (Redis + Postgres) and the background
 * BullMQ refresh queue.
 *
 * Historical note: prior to consolidation this file contained its OWN
 * scoring implementation (`computeSAIDScore`) that diverged from the
 * live overlay's `computeTrustScore`. Cached scores ended up ~9 points
 * below live scores for the same agent, which produced the prod bug
 * where most agents showed Unranked in the directory while their
 * profile pages showed Bronze. Single source of truth now.
 */

import { Hono } from 'hono';
import { PrismaClient } from '@prisma/client';
import { Connection } from '@solana/web3.js';
import Redis from 'ioredis';
import { Queue, Worker } from 'bullmq';

import {
  computeTrustScore,
  type ActivityStatsInput,
  type LaunchedTokenStatsInput,
  type AnchorStatsInput,
} from './scoring/trust-score.js';
import {
  getActivityStatsForWallet,
  getLaunchedTokenStatsForWallet,
} from './services/wallet-activity.js';

// ─── Types ────────────────────────────────────────────────────────

export interface ScoreBreakdown {
  identity: number;
  activity: number;
  economic: number;
  ecosystem: number;
  longevity: number;
  fairscale_enrichment: number;
}

export interface ScoreResult {
  wallet: string;
  score: number;
  tier: 'unranked' | 'bronze' | 'silver' | 'gold' | 'platinum';
  breakdown: ScoreBreakdown;
  badges: string[];
  flags: string[];
  sources: string[];
  cached: boolean;
  updated: string;
}

const CACHE_TTL = 6 * 60 * 60; // 6 hours in seconds
const CACHE_PREFIX = 'said:score:';
const FAIRSCALE_TIMEOUT = 3_000; // 3 seconds

// ─── Redis & Queue Setup ──────────────────────────────────────────

let redis: Redis | null = null;
let scoreQueue: Queue | null = null;
let scoreWorker: Worker | null = null;

function getRedis(): Redis | null {
  if (redis) return redis;
  const url = process.env.REDIS_URL;
  if (!url) {
    console.warn('[Score] REDIS_URL not set — caching disabled');
    return null;
  }
  try {
    redis = new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: true });
    redis.on('error', (err) => console.error('[Score Redis]', err.message));
    redis.connect().catch(() => {});
    return redis;
  } catch {
    return null;
  }
}

function getQueue(): Queue | null {
  if (scoreQueue) return scoreQueue;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  try {
    scoreQueue = new Queue('score-refresh', {
      connection: { url },
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: 50,
        attempts: 2,
        backoff: { type: 'exponential', delay: 5_000 },
      },
    });
    return scoreQueue;
  } catch {
    return null;
  }
}

// ─── Tier & Badge Logic ───────────────────────────────────────────

function getTier(score: number): ScoreResult['tier'] {
  // Matches computeTrustScore in src/index.ts so the cached AgentScore
  // emits the same tier names + thresholds as the live overlay.
  if (score >= 80) return 'platinum';
  if (score >= 65) return 'gold';
  if (score >= 45) return 'silver';
  if (score >= 25) return 'bronze';
  return 'unranked';
}

// ─── FairScale Enrichment (30 pts) ────────────────────────────────

export async function fetchFairScaleScore(wallet: string): Promise<{ score: number; max: number } | null> {
  const apiUrl = process.env.FAIRSCALE_API_URL;
  const apiKey = process.env.FAIRSCALE_API_KEY;

  if (!apiUrl) return null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FAIRSCALE_TIMEOUT);

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['fairkey'] = apiKey;

    const res = await fetch(`${apiUrl}/score?wallet=${wallet}`, {
      signal: controller.signal,
      headers,
    });
    clearTimeout(timeout);

    if (!res.ok) return null;

    const data = await res.json() as { fairscore?: number; fairscore_base?: number; score?: number; max?: number };
    const score = data.fairscore ?? data.score;
    if (typeof score !== 'number') return null;

    return {
      score,
      max: data.max || 100,
    };
  } catch {
    // Timeout or network error — degrade gracefully
    return null;
  }
}

// ─── Full Score Computation ───────────────────────────────────────

/**
 * Compute a full ScoreResult for a wallet using the canonical
 * `computeTrustScore` (the same function the live `/api/agents/:wallet`
 * overlay uses). Guarantees cached score === live overlay for any given
 * input vector.
 *
 * The `_connection` parameter is retained for signature compatibility
 * with prior callers but is unused — the canonical scorer reads
 * pre-computed activity/anchor/launch stats from the DB instead of
 * re-fetching on-chain data inline.
 */
async function computeFullScore(
  wallet: string,
  prisma: PrismaClient,
  _connection?: Connection,
): Promise<ScoreResult> {
  const agent = await prisma.agent.findUnique({
    where: { wallet },
    include: { _count: { select: { feedbackReceived: true } } },
  });

  if (!agent) {
    return {
      wallet,
      score: 0,
      tier: 'unranked',
      breakdown: { identity: 0, activity: 0, economic: 0, ecosystem: 0, longevity: 0, fairscale_enrichment: 0 },
      badges: [],
      flags: ['not_registered'],
      sources: [],
      cached: false,
      updated: new Date().toISOString(),
    };
  }

  const [anchorStats, activityStatsResult, launchedTokens, fairscaleRaw] = await Promise.all([
    agent.pda
      ? prisma.receiptAnchor
          .aggregate({
            where: { agentPda: agent.pda },
            _count: { _all: true },
            _max: { endSeq: true },
          })
          .then((agg): AnchorStatsInput => ({
            anchorCount: agg._count._all ?? 0,
            totalReceipts: Number(agg._max.endSeq ?? 0n),
          }))
          .catch((): AnchorStatsInput => ({ anchorCount: 0, totalReceipts: 0 }))
      : Promise.resolve<AnchorStatsInput>({ anchorCount: 0, totalReceipts: 0 }),
    getActivityStatsForWallet(prisma, agent.wallet) as Promise<ActivityStatsInput | null>,
    getLaunchedTokenStatsForWallet(prisma, agent.wallet) as Promise<LaunchedTokenStatsInput>,
    fetchFairScaleScore(agent.wallet),
  ]);

  const activityStats = activityStatsResult ?? undefined;
  const fairscaleSubscore =
    fairscaleRaw && fairscaleRaw.max > 0
      ? Math.max(0, Math.min(10, (fairscaleRaw.score / fairscaleRaw.max) * 10))
      : 0;

  const result = computeTrustScore(
    agent,
    anchorStats,
    activityStats,
    launchedTokens,
    fairscaleSubscore,
  );

  return {
    wallet,
    score: result.score,
    tier: result.tier,
    breakdown: {
      identity: result.identity,
      activity: result.activity,
      economic: result.economic,
      ecosystem: result.ecosystem,
      longevity: result.longevity,
      fairscale_enrichment: result.fairscale,
    },
    badges: result.badges,
    flags: [],
    sources: result.sources,
    cached: false,
    updated: result.computedAt,
  };
}

// ─── Redis Cache Layer ────────────────────────────────────────────

async function getCachedScore(wallet: string): Promise<ScoreResult | null> {
  const r = getRedis();
  if (!r) return null;

  try {
    const cached = await r.get(`${CACHE_PREFIX}${wallet}`);
    if (!cached) return null;
    const result = JSON.parse(cached) as ScoreResult;
    result.cached = true;
    return result;
  } catch {
    return null;
  }
}

async function setCachedScore(wallet: string, result: ScoreResult): Promise<void> {
  const r = getRedis();
  if (!r) return;

  try {
    await r.set(`${CACHE_PREFIX}${wallet}`, JSON.stringify(result), 'EX', CACHE_TTL);
  } catch {
    // Non-critical — log and continue
  }
}

// ─── Postgres Persistence Layer ───────────────────────────────────

const SAID_STALE_HOURS = 6;
const FAIRSCALE_STALE_DAYS = 7;

async function getStoredScore(wallet: string, prisma: PrismaClient): Promise<ScoreResult | null> {
  try {
    const row = await prisma.agentScore.findUnique({ where: { wallet } });
    if (!row) return null;

    return {
      wallet: row.wallet,
      score: row.score,
      tier: row.tier as ScoreResult['tier'],
      breakdown: {
        identity: row.identity,
        activity: row.activity,
        economic: row.economic,
        ecosystem: row.ecosystem,
        longevity: row.longevity,
        fairscale_enrichment: row.fairscale,
      },
      badges: row.badges,
      flags: row.flags,
      sources: row.sources,
      cached: true,
      updated: row.computedAt.toISOString(),
    };
  } catch {
    return null;
  }
}

function isSaidStale(computedAt: Date): boolean {
  return Date.now() - computedAt.getTime() > SAID_STALE_HOURS * 60 * 60 * 1000;
}

function isFairscaleStale(fairscaleAt: Date | null): boolean {
  if (!fairscaleAt) return true;
  return Date.now() - fairscaleAt.getTime() > FAIRSCALE_STALE_DAYS * 24 * 60 * 60 * 1000;
}

async function persistScore(
  wallet: string,
  result: ScoreResult,
  fairscaleRaw: any | null,
  prisma: PrismaClient,
): Promise<void> {
  try {
    const data = {
      score: result.score,
      tier: result.tier,
      identity: result.breakdown.identity,
      activity: result.breakdown.activity,
      economic: result.breakdown.economic,
      ecosystem: result.breakdown.ecosystem,
      longevity: result.breakdown.longevity,
      fairscale: result.breakdown.fairscale_enrichment,
      fairscaleRaw: fairscaleRaw ?? undefined,
      fairscaleAt: fairscaleRaw ? new Date() : undefined,
      badges: result.badges,
      flags: result.flags,
      sources: result.sources,
      computedAt: new Date(),
      lastQueriedAt: new Date(),
    };

    await prisma.agentScore.upsert({
      where: { wallet },
      create: { wallet, ...data },
      update: data,
    });
  } catch (err: any) {
    console.error(`[Score] DB persist failed for ${wallet}:`, err.message);
  }
}

async function touchLastQueried(wallet: string, prisma: PrismaClient): Promise<void> {
  try {
    await prisma.agentScore.update({
      where: { wallet },
      data: { lastQueriedAt: new Date() },
    });
  } catch {
    // Non-critical — score may not exist yet
  }
}

// ─── Queue: Background Refresh ────────────────────────────────────

export function initScoreWorker(prisma: PrismaClient, connection: Connection): void {
  const url = process.env.REDIS_URL;
  if (!url) return;

  try {
    // Single canonical refresh path. Previously this had a "SAID-only"
    // branch that reused cached FairScale data — that branch called the
    // now-deleted `computeSAIDScore`. Post-consolidation, every refresh
    // recomputes the full score (which includes a 3s-timeout FairScale
    // fetch, degrading gracefully to fairscale=0 if the API is down).
    scoreWorker = new Worker(
      'score-refresh',
      async (job) => {
        const { wallet } = job.data as { wallet: string; includeFairscale?: boolean };
        console.log(`[Score Worker] Refreshing ${wallet}`);
        const result = await computeFullScore(wallet, prisma, connection);
        const fairscaleRaw = result.sources.includes('fairscale')
          ? await fetchFairScaleScore(wallet)
          : null;
        await persistScore(wallet, result, fairscaleRaw, prisma);
        await setCachedScore(wallet, result);
        console.log(`[Score Worker] Done — ${wallet} score=${result.score}`);
      },
      { connection: { url }, concurrency: 3 },
    );
    scoreWorker.on('failed', (job, err) => {
      console.error(`[Score Worker] Job ${job?.id} failed:`, err.message);
    });

    // Schedule recurring refresh jobs
    scheduleBatchRefresh(prisma);

    console.log('[Score] Background worker started');
  } catch (err) {
    console.error('[Score] Worker init failed:', err);
  }
}

async function scheduleBatchRefresh(prisma: PrismaClient): Promise<void> {
  const q = getQueue();
  if (!q) return;

  // SAID refresh: every 6 hours — rescore agents queried in last 7 days
  setInterval(async () => {
    try {
      const staleAgents = await prisma.agentScore.findMany({
        where: {
          lastQueriedAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
          computedAt: { lt: new Date(Date.now() - SAID_STALE_HOURS * 60 * 60 * 1000) },
        },
        select: { wallet: true },
      });
      console.log(`[Score] Queuing ${staleAgents.length} SAID-only refreshes`);
      for (const agent of staleAgents) {
        await q.add('refresh', { wallet: agent.wallet, includeFairscale: false }, {
          jobId: `said-${agent.wallet}-${Date.now()}`,
        });
      }
    } catch (err: any) {
      console.error('[Score] SAID batch refresh failed:', err.message);
    }
  }, SAID_STALE_HOURS * 60 * 60 * 1000);

  // FairScale refresh: daily — only agents queried in last 7 days with stale FairScale
  setInterval(async () => {
    try {
      const needsFairscale = await prisma.agentScore.findMany({
        where: {
          lastQueriedAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
          OR: [
            { fairscaleAt: null },
            { fairscaleAt: { lt: new Date(Date.now() - FAIRSCALE_STALE_DAYS * 24 * 60 * 60 * 1000) } },
          ],
        },
        select: { wallet: true },
      });
      console.log(`[Score] Queuing ${needsFairscale.length} FairScale refreshes`);
      for (const agent of needsFairscale) {
        await q.add('refresh', { wallet: agent.wallet, includeFairscale: true }, {
          jobId: `fs-${agent.wallet}-${Date.now()}`,
        });
      }
    } catch (err: any) {
      console.error('[Score] FairScale batch refresh failed:', err.message);
    }
  }, 24 * 60 * 60 * 1000); // Daily
}

async function enqueueRefresh(wallet: string, includeFairscale = false): Promise<void> {
  const q = getQueue();
  if (!q) return;
  try {
    await q.add('refresh', { wallet, includeFairscale }, {
      jobId: `score-${wallet}-${Date.now()}`,
      delay: 0,
    });
  } catch {
    // Non-critical
  }
}

// ─── Route: GET /api/score/:wallet ────────────────────────────────

export function createScoreRoutes(prisma: PrismaClient, connection: Connection): Hono {
  const routes = new Hono();

  routes.get('/:wallet', async (c) => {
    const wallet = c.req.param('wallet');

    // Validate wallet format (base58, 32-44 chars)
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) {
      return c.json({ error: 'Invalid wallet address' }, 400);
    }

    // Tier 1: Redis cache
    const cached = await getCachedScore(wallet);
    if (cached) {
      // Update lastQueriedAt in DB (non-blocking)
      touchLastQueried(wallet, prisma);

      // Queue SAID refresh if approaching TTL
      const updatedAt = new Date(cached.updated).getTime();
      if (Date.now() - updatedAt > 5 * 60 * 60 * 1000) {
        enqueueRefresh(wallet);
      }
      return c.json(cached);
    }

    // Tier 2: Postgres
    const stored = await getStoredScore(wallet, prisma);
    if (stored) {
      // Re-populate Redis cache
      setCachedScore(wallet, stored);

      // Update lastQueriedAt
      touchLastQueried(wallet, prisma);

      // Check if SAID data is stale — queue refresh
      const row = await prisma.agentScore.findUnique({ where: { wallet } });
      if (row && isSaidStale(row.computedAt)) {
        enqueueRefresh(wallet, isFairscaleStale(row.fairscaleAt));
      }

      return c.json(stored);
    }

    // Tier 3: Compute fresh
    try {
      const result = await computeFullScore(wallet, prisma, connection);

      // Persist to DB + Redis (non-blocking)
      const fairscaleRaw = result.sources.includes('fairscale')
        ? await fetchFairScaleScore(wallet) : null;
      persistScore(wallet, result, fairscaleRaw, prisma);
      setCachedScore(wallet, result);

      return c.json(result);
    } catch (err: any) {
      console.error(`[Score] Error computing score for ${wallet}:`, err.message);
      return c.json({ error: 'Failed to compute trust score', details: err.message }, 500);
    }
  });

  // Batch seed: score all agents that don't have a score yet
  routes.post('/seed', async (c) => {
    const agents = await prisma.agent.findMany({
      where: {
        trustScore: null,
      },
      select: { wallet: true },
    });

    if (agents.length === 0) {
      return c.json({ message: 'All agents already scored', queued: 0 });
    }

    // Queue them all for scoring
    let queued = 0;
    for (const agent of agents) {
      await enqueueRefresh(agent.wallet, true); // true = include FairScale
      queued++;
    }

    return c.json({ message: `Queued ${queued} agents for scoring`, queued, total: agents.length });
  });

  return routes;
}

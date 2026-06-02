/**
 * One-shot backfill: recompute the cached AgentScore for every verified
 * agent against the consolidated trust-score engine.
 *
 * Why this exists:
 *   Pre-consolidation, the cached `AgentScore` table was populated by a
 *   *different* scoring implementation (`computeSAIDScore` in
 *   `score-engine.ts`) than the live `/api/agents/:wallet` overlay
 *   (`computeTrustScore` in `src/index.ts`). The two diverged by ~9
 *   points on average, which caused most agents to render as Unranked
 *   in the directory while their profile pages showed Bronze.
 *
 *   After the engines are consolidated (single `computeTrustScore`
 *   imported by both code paths), this script re-runs the canonical
 *   scorer against every verified agent and upserts the result into
 *   `AgentScore`. After it completes:
 *     - Every verified agent has a non-null cached score row
 *     - Cached score == live overlay (by construction)
 *
 *   Run once after deploying the consolidation. The rolling 6h refresh
 *   worker maintains freshness from there.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/refresh-all-cached-scores.ts
 *
 * Optional env:
 *   CONCURRENCY=4          # default 4 — agents processed in parallel
 *   ONLY_MISSING=true      # only score agents with no existing AgentScore row
 *   LIMIT=100              # cap the number of agents processed (for dry runs)
 *
 * Expected runtime: ~3-4 hours for ~4,300 verified agents at concurrency 4.
 * The bottleneck is the FairScale 3s timeout, not the DB.
 */
import { PrismaClient } from '@prisma/client';
import { Connection } from '@solana/web3.js';
import {
  computeTrustScore,
  type AnchorStatsInput,
  type ActivityStatsInput,
  type LaunchedTokenStatsInput,
} from '../src/scoring/trust-score.js';
import { fetchFairScaleScore } from '../src/score-engine.js';
import {
  getActivityStatsForWallet,
  getLaunchedTokenStatsForWallet,
} from '../src/services/wallet-activity.js';

const CONCURRENCY = Number(process.env.CONCURRENCY ?? 4);
const ONLY_MISSING = process.env.ONLY_MISSING === 'true';
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : null;
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

const prisma = new PrismaClient();
const _connection = new Connection(SOLANA_RPC_URL, 'confirmed'); // signature compat only

interface BatchStats {
  processed: number;
  errors: number;
  startedAt: number;
}

function elapsedSeconds(stats: BatchStats): number {
  return Math.round((Date.now() - stats.startedAt) / 1000);
}

async function loadAnchorStats(agentPda: string | null): Promise<AnchorStatsInput> {
  if (!agentPda) return { anchorCount: 0, totalReceipts: 0 };
  try {
    const agg = await prisma.receiptAnchor.aggregate({
      where: { agentPda },
      _count: { _all: true },
      _max: { endSeq: true },
    });
    return {
      anchorCount: agg._count._all ?? 0,
      totalReceipts: Number(agg._max.endSeq ?? 0n),
    };
  } catch {
    return { anchorCount: 0, totalReceipts: 0 };
  }
}

async function scoreOne(wallet: string): Promise<{ score: number; tier: string } | null> {
  const agent = await prisma.agent.findUnique({
    where: { wallet },
    include: { _count: { select: { feedbackReceived: true } } },
  });
  if (!agent) return null;

  const [anchorStats, activityStatsResult, launchedTokens, fairscaleRaw] = await Promise.all([
    loadAnchorStats(agent.pda),
    getActivityStatsForWallet(prisma, agent.wallet) as Promise<ActivityStatsInput | null>,
    getLaunchedTokenStatsForWallet(prisma, agent.wallet) as Promise<LaunchedTokenStatsInput>,
    fetchFairScaleScore(agent.wallet),
  ]);

  const fairscaleSubscore =
    fairscaleRaw && fairscaleRaw.max > 0
      ? Math.max(0, Math.min(10, (fairscaleRaw.score / fairscaleRaw.max) * 10))
      : 0;

  const result = computeTrustScore(
    agent,
    anchorStats,
    activityStatsResult ?? undefined,
    launchedTokens,
    fairscaleSubscore,
  );

  await prisma.agentScore.upsert({
    where: { wallet },
    update: {
      score: result.score,
      tier: result.tier,
      identity: result.identity,
      activity: result.activity,
      economic: result.economic,
      ecosystem: result.ecosystem,
      longevity: result.longevity,
      fairscale: result.fairscale,
      badges: result.badges,
      flags: [],
      sources: result.sources,
      computedAt: new Date(result.computedAt),
      fairscaleAt: fairscaleRaw ? new Date() : null,
    },
    create: {
      wallet,
      score: result.score,
      tier: result.tier,
      identity: result.identity,
      activity: result.activity,
      economic: result.economic,
      ecosystem: result.ecosystem,
      longevity: result.longevity,
      fairscale: result.fairscale,
      badges: result.badges,
      flags: [],
      sources: result.sources,
      computedAt: new Date(result.computedAt),
      fairscaleAt: fairscaleRaw ? new Date() : null,
      lastQueriedAt: new Date(),
    },
  });

  return { score: result.score, tier: result.tier };
}

async function run() {
  console.log('Loading agent list...');
  const where = ONLY_MISSING
    ? { isVerified: true, trustScore: null }
    : { isVerified: true };
  const agents = await prisma.agent.findMany({
    where,
    select: { wallet: true },
    ...(LIMIT ? { take: LIMIT } : {}),
  });
  console.log(`Refreshing ${agents.length} agents at concurrency=${CONCURRENCY}\n`);

  const stats: BatchStats = { processed: 0, errors: 0, startedAt: Date.now() };
  const tierCounts: Record<string, number> = {
    platinum: 0, gold: 0, silver: 0, bronze: 0, unranked: 0,
  };

  // Simple inline concurrency loop
  let idx = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (true) {
        const myIdx = idx++;
        if (myIdx >= agents.length) return;
        const wallet = agents[myIdx].wallet;
        try {
          const result = await scoreOne(wallet);
          stats.processed++;
          if (result) tierCounts[result.tier]++;
        } catch (err: any) {
          stats.errors++;
          console.error(`[refresh] ${wallet}: ${err?.message ?? err}`);
        }
        if (stats.processed % 50 === 0) {
          const elapsed = elapsedSeconds(stats);
          const rate = (stats.processed / Math.max(elapsed, 1)).toFixed(1);
          const eta = Math.round((agents.length - stats.processed) / Math.max(parseFloat(rate), 0.01));
          console.log(
            `  ${stats.processed}/${agents.length} (${elapsed}s elapsed, ${rate}/s, ~${eta}s left, ${stats.errors} errors)`,
          );
        }
      }
    }),
  );

  console.log(`\nDone in ${elapsedSeconds(stats)}s. Processed=${stats.processed}, errors=${stats.errors}`);
  console.log('\nFinal tier distribution:');
  for (const tier of ['platinum', 'gold', 'silver', 'bronze', 'unranked']) {
    const n = tierCounts[tier];
    const pct = ((n / stats.processed) * 100).toFixed(1);
    console.log(`  ${tier.padEnd(10)} ${String(n).padStart(5)} (${pct}%)`);
  }

  await prisma.$disconnect();
}

run().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});

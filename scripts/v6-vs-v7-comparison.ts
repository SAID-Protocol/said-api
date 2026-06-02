/**
 * Side-by-side: v0.6 trust score vs v0.7 trust score for every
 * verified SAID agent. Read-only — no DB writes, safe to run during
 * production traffic.
 *
 * Inputs are loaded once per agent and passed to both engines so we
 * can isolate the *engine* difference (not input drift).
 *
 * Prereqs:
 *   - Run scripts/sync-x402-activity.ts FIRST so AgentX402Activity
 *     is populated. Otherwise paid_service delivery will fire for 0
 *     agents and v0.7 will under-perform.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/v6-vs-v7-comparison.ts
 *
 * Optional env:
 *   LIMIT=200             # cap agents processed (default: all verified)
 *   USE_LIVE_FAIRSCALE=1  # hit FairScale per agent (slow, ~3s timeout each)
 */
import { PrismaClient } from '@prisma/client';
import {
  computeTrustScore,
  type ActivityStatsInput,
  type LaunchedTokenStatsInput,
  type AnchorStatsInput,
} from '../src/scoring/trust-score.js';
import {
  computeTrustScoreV7,
  type V7AnchorStats,
  type V7ActivityStats,
  type V7LaunchedTokenStats,
  type V7X402ActivityStats,
} from '../src/reputation-engine-v7.js';
import {
  getActivityStatsForWallet,
  getLaunchedTokenStatsForWallet,
} from '../src/services/wallet-activity.js';

const prisma = new PrismaClient();
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : null;
const USE_LIVE_FAIRSCALE = process.env.USE_LIVE_FAIRSCALE === '1';

interface Row {
  name: string;
  wallet: string;
  v6Score: number;
  v6Tier: string;
  v7Score: number;
  v7Tier: string;
  delta: number;
  v7Delivery: string;
  v7Type: string;
}

async function loadAnchorStats(agentPda: string | null): Promise<AnchorStatsInput & V7AnchorStats> {
  if (!agentPda) return { anchorCount: 0, totalReceipts: 0 };
  const agg = await prisma.receiptAnchor.aggregate({
    where: { agentPda },
    _count: { _all: true },
    _max: { endSeq: true },
  });
  return {
    anchorCount: agg._count._all ?? 0,
    totalReceipts: Number(agg._max.endSeq ?? 0n),
  };
}

async function scoreAgent(wallet: string): Promise<Row | null> {
  const agent = await prisma.agent.findUnique({
    where: { wallet },
    include: { _count: { select: { feedbackReceived: true } } },
  });
  if (!agent) return null;

  const [anchorStats, activity, launched, cachedScore, x402] = await Promise.all([
    loadAnchorStats(agent.pda),
    getActivityStatsForWallet(prisma, agent.wallet) as Promise<
      (ActivityStatsInput & V7ActivityStats) | null
    >,
    getLaunchedTokenStatsForWallet(prisma, agent.wallet) as Promise<
      LaunchedTokenStatsInput & V7LaunchedTokenStats
    >,
    prisma.agentScore.findUnique({ where: { wallet }, select: { fairscale: true } }),
    prisma.agentX402Activity.findUnique({ where: { wallet } }),
  ]);

  const fairscale = cachedScore?.fairscale ?? 0;
  const x402Stats: V7X402ActivityStats | undefined = x402
    ? {
        providerUniqueBuyers: x402.providerUniqueBuyers,
        providerTxCount: x402.providerTxCount,
        buyerUniqueSellers: x402.buyerUniqueSellers,
        buyerTxCount: x402.buyerTxCount,
      }
    : undefined;

  const v6 = computeTrustScore(agent, anchorStats, activity ?? undefined, launched, fairscale);
  const v7 = computeTrustScoreV7(
    agent,
    anchorStats,
    activity ?? undefined,
    launched,
    fairscale,
    x402Stats,
  );

  return {
    name: agent.name ?? '(unnamed)',
    wallet,
    v6Score: v6.score,
    v6Tier: v6.tier,
    v7Score: v7.score,
    v7Tier: v7.tier,
    delta: v7.score - v6.score,
    v7Delivery: v7.demonstratedDelivery?.path ?? 'none',
    v7Type: v7.dominantType ?? '?',
  };
}

async function run() {
  console.log('Loading verified SAID agents...');
  const agents = await prisma.agent.findMany({
    where: { isVerified: true },
    select: { wallet: true },
    ...(LIMIT ? { take: LIMIT } : {}),
  });
  console.log(`Scoring ${agents.length} agents (v6 + v7 in parallel per agent)\n`);

  const x402Count = await prisma.agentX402Activity.count();
  if (x402Count === 0) {
    console.log(
      '⚠️  AgentX402Activity table is EMPTY. paid_service delivery will not activate for any agent.',
    );
    console.log('   Run scripts/sync-x402-activity.ts first to populate it.\n');
  } else {
    console.log(`AgentX402Activity has ${x402Count} rows.\n`);
  }

  const startedAt = Date.now();
  const rows: Row[] = [];
  let processed = 0;
  let errors = 0;
  const CONCURRENCY = 8;
  let idx = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (true) {
        const myIdx = idx++;
        if (myIdx >= agents.length) return;
        const wallet = agents[myIdx].wallet;
        try {
          const r = await scoreAgent(wallet);
          if (r) rows.push(r);
          processed++;
          if (processed % 500 === 0) {
            const el = Math.round((Date.now() - startedAt) / 1000);
            console.log(`  ${processed}/${agents.length} (${el}s elapsed)`);
          }
        } catch (err: any) {
          errors++;
          console.error(`  ${wallet}: ${err?.message ?? err}`);
        }
      }
    }),
  );
  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  console.log(`\nScored ${rows.length} in ${elapsed}s. Errors: ${errors}\n`);

  // ─── Aggregates ───────────────────────────────────────────────────
  const tierCount = (tier: 'tier' | 'v7Tier') => {
    const c: Record<string, number> = { platinum: 0, gold: 0, silver: 0, bronze: 0, unranked: 0 };
    for (const r of rows) c[(r as any)[tier === 'tier' ? 'v6Tier' : 'v7Tier']]++;
    return c;
  };

  const v6c = tierCount('tier');
  const v7c = tierCount('v7Tier');

  console.log('Tier distribution:');
  console.log(`  ${'tier'.padEnd(10)} ${'v0.6'.padStart(8)} ${'v0.7'.padStart(8)}`);
  for (const t of ['platinum', 'gold', 'silver', 'bronze', 'unranked']) {
    const v6p = ((v6c[t] / rows.length) * 100).toFixed(1);
    const v7p = ((v7c[t] / rows.length) * 100).toFixed(1);
    console.log(`  ${t.padEnd(10)} ${String(v6c[t]).padStart(5)} (${v6p}%) ${String(v7c[t]).padStart(5)} (${v7p}%)`);
  }
  console.log();

  // Score histogram (5-point buckets)
  console.log('v0.7 score histogram (5-point buckets):');
  const buckets: Record<string, number> = {};
  for (const r of rows) {
    const b = Math.floor(r.v7Score / 5) * 5;
    const k = `${b}-${b + 4}`;
    buckets[k] = (buckets[k] ?? 0) + 1;
  }
  for (const [k, v] of Object.entries(buckets).sort((a, b) => parseInt(a[0]) - parseInt(b[0]))) {
    const bar = '#'.repeat(Math.min(60, Math.round((v / rows.length) * 200)));
    console.log(`  ${k.padEnd(8)} ${String(v).padStart(5)}  ${bar}`);
  }
  console.log();

  // Top 20 by v0.7 score
  console.log('Top 20 by v0.7 score:');
  console.log(`  ${'name'.padEnd(25)} ${'v6'.padStart(4)} ${'v6_tier'.padEnd(10)} ${'v7'.padStart(4)} ${'v7_tier'.padEnd(10)} ${'Δ'.padStart(5)}  v7_delivery       type`);
  const topV7 = [...rows].sort((a, b) => b.v7Score - a.v7Score).slice(0, 20);
  for (const r of topV7) {
    console.log(
      `  ${r.name.slice(0, 25).padEnd(25)} ${String(r.v6Score).padStart(4)} ${r.v6Tier.padEnd(10)} ${String(r.v7Score).padStart(4)} ${r.v7Tier.padEnd(10)} ${(r.delta > 0 ? '+' : '') + r.delta} ${r.v7Delivery.padEnd(17)} ${r.v7Type}`,
    );
  }
  console.log();

  // Biggest movers (v7 above v6)
  console.log('Biggest UPWARD movers (v7 - v6 ≥ 10):');
  const upMovers = [...rows].filter((r) => r.delta >= 10).sort((a, b) => b.delta - a.delta).slice(0, 15);
  if (upMovers.length === 0) {
    console.log('  (none)');
  } else {
    for (const r of upMovers) {
      console.log(
        `  ${r.name.slice(0, 25).padEnd(25)} v6=${r.v6Score} → v7=${r.v7Score} (+${r.delta})  delivery=${r.v7Delivery}  type=${r.v7Type}`,
      );
    }
  }
  console.log();

  // Biggest movers (v7 below v6) — ceiling activations etc.
  console.log('Biggest DOWNWARD movers (v6 - v7 ≥ 10):');
  const dnMovers = [...rows].filter((r) => r.delta <= -10).sort((a, b) => a.delta - b.delta).slice(0, 15);
  if (dnMovers.length === 0) {
    console.log('  (none)');
  } else {
    for (const r of dnMovers) {
      console.log(`  ${r.name.slice(0, 25).padEnd(25)} v6=${r.v6Score} → v7=${r.v7Score} (${r.delta})  type=${r.v7Type}`);
    }
  }

  await prisma.$disconnect();
}

run().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});

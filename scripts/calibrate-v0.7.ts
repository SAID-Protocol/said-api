/**
 * Principled calibration harness for the v0.7 reputation engine.
 *
 * Goal:
 *   Find the engine configuration that best satisfies a set of *logical
 *   invariants* about what each tier means — without fitting to specific
 *   wallets. The output is a recommended config + a report of how many
 *   agents end up in each tier under that config, as a byproduct.
 *
 * What this is NOT:
 *   This is NOT "force wallet X into tier Y." That would be circular —
 *   tuning the model to match priors. Instead, we define what *properties*
 *   warrant each tier and check whether the model honors those properties.
 *
 * Tier meanings (logical predicates over agent properties):
 *   - PLATINUM : demonstrated_delivery AND exceptional scale
 *                  (paid_service ≥ 100 buyers OR launcher mc ≥ $5M)
 *   - GOLD     : demonstrated_delivery active (any path)
 *   - SILVER   : meaningful protocol engagement OR active x402 use
 *                  (said_engagement ≥ 1.0 OR any x402 provider/buyer activity)
 *   - BRONZE   : verified + completed profile + on-chain footprint
 *                  (isVerified AND name AND description)
 *   - UNRANKED : otherwise
 *
 * Invariants we score against:
 *   1. UPPER BOUND: If an agent does NOT meet tier T's predicate, the model
 *      should not place them in T or higher. (No grade inflation.)
 *   2. LOWER BOUND: If an agent strongly meets tier T's predicate (with
 *      headroom — see "strong" thresholds below), the model should place
 *      them in T or higher. (No suppression of clear cases.)
 *
 * Search:
 *   Coordinate-descent over the meaningful tuning space. For each parameter
 *   axis, find the value that minimizes total invariant violations, holding
 *   others fixed. Repeat for ~3 passes. Faster than full grid (~minutes
 *   instead of hours) and finds local optima which is fine for our purpose.
 *
 * Usage:
 *   DATABASE_URL=...  npx tsx scripts/calibrate-v0.7.ts
 *
 * Optional env:
 *   LIMIT=500           # cap agents for faster iteration
 *   PASSES=3            # coordinate-descent passes
 */
import { PrismaClient } from '@prisma/client';
import {
  computeTrustScoreV7,
  type V7AnchorStats,
  type V7ActivityStats,
  type V7LaunchedTokenStats,
  type V7X402ActivityStats,
  type V7SaidEngagementStats,
  type V7EngineConfig,
  type V7Tier,
} from '../src/reputation-engine-v7.js';
import {
  getActivityStatsForWallet,
  getLaunchedTokenStatsForWallet,
} from '../src/services/wallet-activity.js';

const prisma = new PrismaClient();
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : null;
const PASSES = Number(process.env.PASSES ?? 3);

// ─── Tier predicates ────────────────────────────────────────────────
// What each tier MEANS. These are the only "ground truth" we encode.

interface AgentInputs {
  wallet: string;
  name: string;
  agent: any; // ScorableAgent / AgentLike
  anchor: V7AnchorStats;
  activity: V7ActivityStats | null;
  launched: V7LaunchedTokenStats;
  fairscale: number;
  x402: V7X402ActivityStats | null;
  saidEng: V7SaidEngagementStats | null;
}

/** Strongest tier T such that the agent's properties qualify them for T. */
function maxEarnedTier(inp: AgentInputs): V7Tier {
  const launchedMc = inp.launched?.topMarketCapUsd ?? 0;
  const x402Buyers = inp.x402?.providerUniqueBuyers ?? 0;
  const x402Sellers = inp.x402?.buyerUniqueSellers ?? 0;
  const x402Active = x402Buyers > 0 || x402Sellers > 0;
  const hasDelivery = launchedMc >= 250_000 || x402Buyers >= 5;
  const hasExceptionalScale = launchedMc >= 5_000_000 || x402Buyers >= 100;

  // Compute said_engagement-equivalent on raw stats (mirrors engine logic,
  // simplified — we just want to know "did this agent invoke meaningful
  // protocol instructions").
  const s = inp.saidEng;
  const log2 = (n: number) => (n <= 0 ? 0 : Math.log2(n + 1));
  let saidProxy = 0;
  if (s) {
    saidProxy += Math.min(4, log2(s.submitAnchorCount) * 1.0);
    saidProxy += Math.min(3, log2(s.validateWorkCount) * 0.9);
    saidProxy += Math.min(2, log2(s.submitFeedbackCount) * 0.8);
    saidProxy += Math.min(1.5, log2(s.stakeCount + s.addStakeCount + s.registerAndStakeCount) * 0.6);
  }
  const hasEngagement = saidProxy >= 1.0 || x402Active;

  if (hasDelivery && hasExceptionalScale) return 'platinum';
  if (hasDelivery) return 'gold';
  if (hasEngagement) return 'silver';
  if (inp.agent.isVerified && inp.agent.name && inp.agent.description) return 'bronze';
  return 'unranked';
}

/**
 * Lowest tier the agent *clearly* earns — used to detect suppression. Only
 * fires when the agent's signals are *unambiguously strong*; weak cases are
 * allowed to land in lower tiers without being counted as violations.
 */
function minDeservedTier(inp: AgentInputs): V7Tier {
  const launchedMc = inp.launched?.topMarketCapUsd ?? 0;
  const x402Buyers = inp.x402?.providerUniqueBuyers ?? 0;
  const x402Sellers = inp.x402?.buyerUniqueSellers ?? 0;
  const submitAnchors = inp.saidEng?.submitAnchorCount ?? 0;

  if (x402Buyers >= 100 || launchedMc >= 5_000_000) return 'gold'; // exceptional → at least gold
  if (x402Buyers >= 50 || launchedMc >= 1_000_000) return 'gold'; // full delivery → at least gold
  if (x402Buyers >= 5 || x402Sellers >= 5 || launchedMc >= 250_000) return 'silver'; // partial → at least silver
  if (submitAnchors >= 3) return 'silver'; // 3+ on-chain anchors → at least silver
  return 'unranked'; // most agents can land anywhere; no lower bound
}

// ─── Tier ordering helpers ──────────────────────────────────────────

const TIER_ORDER: V7Tier[] = ['unranked', 'bronze', 'silver', 'gold', 'platinum'];
function tierIdx(t: V7Tier): number {
  return TIER_ORDER.indexOf(t);
}

// ─── Search space ───────────────────────────────────────────────────

interface ParamAxis {
  name: keyof V7EngineConfig;
  values: number[];
}

const SEARCH_SPACE: ParamAxis[] = [
  { name: 'capNoDelivery', values: [60, 65, 70, 75, 79] },
  { name: 'capNoDeliveryNoEngagement', values: [34, 38, 42, 44, 48] },
  { name: 'noEngagementThreshold', values: [0.5, 1.0, 1.5, 2.0] },
  { name: 'paidServiceFullUniqueBuyers', values: [25, 50, 100] },
  { name: 'paidServicePartialUniqueBuyers', values: [3, 5, 10] },
  { name: 'serviceSaidWeight', values: [0.25, 0.35, 0.45, 0.55] },
];

// Starting point for coordinate descent (current defaults)
const SEED_CONFIG: Required<Pick<V7EngineConfig,
  | 'capNoDelivery'
  | 'capNoDeliveryNoEngagement'
  | 'noEngagementThreshold'
  | 'paidServiceFullUniqueBuyers'
  | 'paidServicePartialUniqueBuyers'
  | 'serviceSaidWeight'>> = {
  capNoDelivery: 79,
  capNoDeliveryNoEngagement: 44,
  noEngagementThreshold: 1.0,
  paidServiceFullUniqueBuyers: 50,
  paidServicePartialUniqueBuyers: 5,
  serviceSaidWeight: 0.25,
};

// ─── Scoring a config ───────────────────────────────────────────────

interface ConfigReport {
  config: V7EngineConfig;
  upperViolations: number; // model placed agent ABOVE their earned tier
  lowerViolations: number; // model placed agent BELOW the tier their signals demand
  totalViolations: number;
  tierCounts: Record<V7Tier, number>;
  // For diagnostics
  worstUpper: Array<{ name: string; modelTier: V7Tier; maxEarned: V7Tier }>;
  worstLower: Array<{ name: string; modelTier: V7Tier; minDeserved: V7Tier }>;
}

function scoreConfig(inputs: AgentInputs[], cfg: V7EngineConfig): ConfigReport {
  const tierCounts: Record<V7Tier, number> = {
    unranked: 0,
    bronze: 0,
    silver: 0,
    gold: 0,
    platinum: 0,
  };
  let upperViolations = 0;
  let lowerViolations = 0;
  const worstUpper: ConfigReport['worstUpper'] = [];
  const worstLower: ConfigReport['worstLower'] = [];

  for (const inp of inputs) {
    const result = computeTrustScoreV7(
      inp.agent,
      inp.anchor,
      inp.activity ?? undefined,
      inp.launched,
      inp.fairscale,
      inp.x402 ?? undefined,
      inp.saidEng ?? undefined,
      cfg,
    );
    const modelTier = result.tier;
    tierCounts[modelTier]++;

    const maxEarned = maxEarnedTier(inp);
    if (tierIdx(modelTier) > tierIdx(maxEarned)) {
      upperViolations++;
      if (worstUpper.length < 10) {
        worstUpper.push({ name: inp.name, modelTier, maxEarned });
      }
    }
    const minDeserved = minDeservedTier(inp);
    if (tierIdx(modelTier) < tierIdx(minDeserved)) {
      lowerViolations++;
      if (worstLower.length < 10) {
        worstLower.push({ name: inp.name, modelTier, minDeserved });
      }
    }
  }

  return {
    config: cfg,
    upperViolations,
    lowerViolations,
    totalViolations: upperViolations + lowerViolations,
    tierCounts,
    worstUpper,
    worstLower,
  };
}

// ─── Coordinate descent ─────────────────────────────────────────────

async function coordinateDescent(inputs: AgentInputs[]): Promise<ConfigReport> {
  let bestConfig: V7EngineConfig = { ...SEED_CONFIG };
  let best = scoreConfig(inputs, bestConfig);
  console.log(
    `Seed config: upper=${best.upperViolations} lower=${best.lowerViolations} total=${best.totalViolations}`,
  );

  for (let pass = 0; pass < PASSES; pass++) {
    console.log(`\n── Pass ${pass + 1}/${PASSES} ──`);
    let improvedThisPass = false;
    for (const axis of SEARCH_SPACE) {
      let axisBest = best;
      let axisBestValue = (bestConfig[axis.name] as number) ?? 0;
      for (const v of axis.values) {
        const candidate = { ...bestConfig, [axis.name]: v };
        const report = scoreConfig(inputs, candidate);
        if (report.totalViolations < axisBest.totalViolations) {
          axisBest = report;
          axisBestValue = v;
        }
      }
      if (axisBest.totalViolations < best.totalViolations) {
        improvedThisPass = true;
        bestConfig = { ...bestConfig, [axis.name]: axisBestValue };
        best = axisBest;
        console.log(
          `  ${axis.name.padEnd(36)} → ${String(axisBestValue).padStart(5)}  (total violations: ${best.totalViolations})`,
        );
      } else {
        console.log(
          `  ${axis.name.padEnd(36)}   ${String(axisBestValue).padStart(5)}  (no improvement)`,
        );
      }
    }
    if (!improvedThisPass) {
      console.log('  (no axis improved → stopping early)');
      break;
    }
  }
  return best;
}

// ─── Load inputs ────────────────────────────────────────────────────

async function loadAnchorStats(agentPda: string | null): Promise<V7AnchorStats> {
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

async function loadInputs(): Promise<AgentInputs[]> {
  console.log(`Loading verified agents (LIMIT=${LIMIT ?? 'none'})...`);
  const agents = await prisma.agent.findMany({
    where: { isVerified: true },
    include: { _count: { select: { feedbackReceived: true } } },
    ...(LIMIT ? { take: LIMIT } : {}),
  });
  console.log(`Loading inputs for ${agents.length} agents...`);

  const inputs: AgentInputs[] = [];
  let processed = 0;
  const CONC = 8;
  let idx = 0;
  await Promise.all(
    Array.from({ length: CONC }, async () => {
      while (true) {
        const i = idx++;
        if (i >= agents.length) return;
        const a = agents[i];
        try {
          const [anchor, activity, launched, cached, x402, saidEng] = await Promise.all([
            loadAnchorStats(a.pda),
            getActivityStatsForWallet(prisma, a.wallet) as Promise<V7ActivityStats | null>,
            getLaunchedTokenStatsForWallet(prisma, a.wallet) as Promise<V7LaunchedTokenStats>,
            prisma.agentScore.findUnique({ where: { wallet: a.wallet }, select: { fairscale: true } }),
            prisma.agentX402Activity.findUnique({ where: { wallet: a.wallet } }),
            prisma.agentSaidEngagement.findUnique({ where: { wallet: a.wallet } }),
          ]);
          inputs.push({
            wallet: a.wallet,
            name: a.name ?? '(unnamed)',
            agent: a,
            anchor,
            activity,
            launched,
            fairscale: cached?.fairscale ?? 0,
            x402: x402
              ? {
                  providerUniqueBuyers: x402.providerUniqueBuyers,
                  providerTxCount: x402.providerTxCount,
                  buyerUniqueSellers: x402.buyerUniqueSellers,
                  buyerTxCount: x402.buyerTxCount,
                }
              : null,
            saidEng: saidEng
              ? {
                  registerCount: saidEng.registerCount,
                  getVerifiedCount: saidEng.getVerifiedCount,
                  registerAndStakeCount: saidEng.registerAndStakeCount,
                  sponsorRegisterCount: saidEng.sponsorRegisterCount,
                  sponsorVerifyCount: saidEng.sponsorVerifyCount,
                  updateAgentCount: saidEng.updateAgentCount,
                  submitAnchorCount: saidEng.submitAnchorCount,
                  validateWorkCount: saidEng.validateWorkCount,
                  submitFeedbackCount: saidEng.submitFeedbackCount,
                  stakeCount: saidEng.stakeCount,
                  addStakeCount: saidEng.addStakeCount,
                  unstakeLifecycleCount: saidEng.unstakeLifecycleCount,
                  linkWalletCount: saidEng.linkWalletCount,
                  unlinkWalletCount: saidEng.unlinkWalletCount,
                  transferAuthorityCount: saidEng.transferAuthorityCount,
                  slashAgentCount: saidEng.slashAgentCount,
                  otherSaidCount: saidEng.otherSaidCount,
                  totalSaidInstructions: saidEng.totalSaidInstructions,
                }
              : null,
          });
        } catch (err: any) {
          // Skip failed agents silently — calibration is robust to a few missing
        }
        processed++;
      }
    }),
  );
  return inputs;
}

// ─── Main ────────────────────────────────────────────────────────────

async function run() {
  const inputs = await loadInputs();
  console.log(`Loaded ${inputs.length} agent inputs.\n`);

  // Predicate distribution — what tier each agent EARNS based on their properties.
  // This is the "honest" distribution; the model should approximate it.
  const earnedCounts: Record<V7Tier, number> = {
    unranked: 0, bronze: 0, silver: 0, gold: 0, platinum: 0,
  };
  for (const inp of inputs) earnedCounts[maxEarnedTier(inp)]++;
  console.log('Distribution implied by tier-meaning predicates (the principled target):');
  for (const t of TIER_ORDER.slice().reverse()) {
    const n = earnedCounts[t];
    const pct = ((n / inputs.length) * 100).toFixed(1);
    console.log(`  ${t.padEnd(10)} ${String(n).padStart(5)} (${pct}%)`);
  }
  console.log();

  // Run coordinate descent
  const best = await coordinateDescent(inputs);

  console.log('\n────────────────────────────────────────');
  console.log('BEST CONFIG FOUND');
  console.log('────────────────────────────────────────');
  for (const [k, v] of Object.entries(best.config)) {
    console.log(`  ${k.padEnd(36)} ${v}`);
  }
  console.log();
  console.log(`Total invariant violations: ${best.totalViolations}`);
  console.log(`  upper-bound (grade inflation):    ${best.upperViolations}`);
  console.log(`  lower-bound (signal suppression): ${best.lowerViolations}`);
  console.log();

  console.log('Resulting tier distribution:');
  for (const t of TIER_ORDER.slice().reverse()) {
    const n = best.tierCounts[t];
    const pct = ((n / inputs.length) * 100).toFixed(1);
    const earned = ((earnedCounts[t] / inputs.length) * 100).toFixed(1);
    console.log(`  ${t.padEnd(10)} ${String(n).padStart(5)} (${pct}%)   [meaning predicate: ${earned}%]`);
  }
  console.log();

  if (best.worstUpper.length > 0) {
    console.log('Sample upper-bound violations (model placed too high):');
    for (const v of best.worstUpper) {
      console.log(`  ${v.name.padEnd(28)} model=${v.modelTier.padEnd(10)} max-earned=${v.maxEarned}`);
    }
    console.log();
  }
  if (best.worstLower.length > 0) {
    console.log('Sample lower-bound violations (model placed too low):');
    for (const v of best.worstLower) {
      console.log(`  ${v.name.padEnd(28)} model=${v.modelTier.padEnd(10)} min-deserved=${v.minDeserved}`);
    }
    console.log();
  }

  await prisma.$disconnect();
}

run().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});

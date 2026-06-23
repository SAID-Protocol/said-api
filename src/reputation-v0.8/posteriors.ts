/**
 * Posterior aggregation for reputation v0.8.
 *
 * Inputs: ReputationSignal rows per (subject × axis × kind).
 * Outputs: per-axis Beta posteriors, composite score, tier.
 *
 * Math (see docs/reputation-v0.8.md §5.2 + §5.5):
 *
 *   For each axis:
 *     α_axis = 2 (prior) + Σ positive event weight contributions
 *     β_axis = 2 (prior) + Σ negative event weight contributions
 *     posterior_mean     = α / (α + β)
 *     posterior_variance = αβ / ((α+β)²(α+β+1))
 *     lower_bound_95     = max(0, posterior_mean - 1.96·√variance)
 *
 *   Composite (weighted blend of axis posterior means):
 *     composite = Σ_axis (w_axis · posterior_mean_axis)
 *
 *   Tier (composite + minimum sample size):
 *     platinum : composite ≥ 0.85 AND identity ≥ 0.70 AND samples ≥ 100
 *     gold     : composite ≥ 0.70 AND samples ≥ 30
 *     silver   : composite ≥ 0.50 AND samples ≥ 10
 *     bronze   : composite ≥ 0.30
 *     unranked : otherwise
 *
 *   Sample size for tier gating uses *effective evidence*:
 *     samples = (α + β) − (prior_α + prior_β) per axis, summed across axes
 *
 * This module is pure. No DB access; takes signal rows in, returns
 * posteriors out.
 */
import type { Axis } from './axes.js';
import { AXES } from './axes.js';
import { EVENT_KINDS, type EventKind } from './kinds.js';

// Cold-start prior matches the schema default on ReputationSignal.alpha/beta.
const PRIOR_ALPHA = 2.0;
const PRIOR_BETA = 2.0;
const PRIOR_TOTAL = PRIOR_ALPHA + PRIOR_BETA;

/** Composite axis weights. Documented defaults — overridable per consumer. */
export const AXIS_WEIGHTS_DEFAULT: Record<Axis, number> = {
  identity: 0.10,   // floor — every verified agent gets some baseline
  delivery: 0.30,   // strongest — "did they deliver real work"
  payments: 0.20,   // commercial activity
  validation: 0.15, // peer-validation accuracy (Phase 3 fills this)
  community: 0.10,  // ecosystem participation
  economic: 0.15,   // real on-chain economic footprint (activity, counterparties, volume, launches)
};

/** Tier definitions — kept in sync with the design doc. */
export const TIER_THRESHOLDS = {
  platinum: { composite: 0.85, samples: 100, identity: 0.70 },
  gold:     { composite: 0.70, samples: 30  },
  silver:   { composite: 0.50, samples: 10  },
  bronze:   { composite: 0.30, samples: 0   },
} as const;

export type Tier = 'platinum' | 'gold' | 'silver' | 'bronze' | 'unranked';

/** Subset of ReputationSignal we need — keeps this module unaware of Prisma. */
export interface SignalInput {
  subjectWallet: string;
  axis: string;
  kind: string;
  decayedValue: number;
  alpha: number;
  beta: number;
  uniqueActors: number;
  shannonEntropyEst: number;
  lastEventAt: Date | null;
}

export interface EvidenceItem {
  kind: string;
  decayedValue: number;
  uniqueActors: number;
  polarity: number;
}

export interface AxisPosterior {
  axis: Axis;
  alpha: number;
  beta: number;
  posteriorMean: number;
  posteriorVariance: number;
  lowerBound95: number;
  effectiveSamples: number;          // (α + β) − prior_total
  topEvidence: EvidenceItem[];       // top contributing kinds for the explainability response
}

export interface AgentPosteriors {
  subjectWallet: string;
  axes: Record<Axis, AxisPosterior>;
  compositeScore: number;
  totalSamples: number;
  tier: Tier;
}

// ─── Helpers ────────────────────────────────────────────────────────

function betaVariance(alpha: number, beta: number): number {
  const total = alpha + beta;
  if (total <= 0) return 0;
  return (alpha * beta) / (total * total * (total + 1));
}

function wilsonLowerBound95(alpha: number, beta: number): number {
  const mean = alpha / (alpha + beta);
  const variance = betaVariance(alpha, beta);
  const lb = mean - 1.96 * Math.sqrt(variance);
  return Math.max(0, Math.min(1, lb));
}

function emptyAxisPosterior(axis: Axis): AxisPosterior {
  const mean = PRIOR_ALPHA / PRIOR_TOTAL;
  return {
    axis,
    alpha: PRIOR_ALPHA,
    beta: PRIOR_BETA,
    posteriorMean: mean,
    posteriorVariance: betaVariance(PRIOR_ALPHA, PRIOR_BETA),
    lowerBound95: wilsonLowerBound95(PRIOR_ALPHA, PRIOR_BETA),
    effectiveSamples: 0,
    topEvidence: [],
  };
}

/**
 * Compute per-axis Beta posterior for a single subject from all of their
 * ReputationSignal rows. Aggregates evidence across signal kinds within
 * each axis, with a single shared prior per axis (not per-kind).
 */
export function computeAxisPosteriors(
  signals: SignalInput[],
): Record<Axis, AxisPosterior> {
  // Initialize all axes with their priors so absent axes still get a row
  const out: Record<Axis, AxisPosterior> = Object.fromEntries(
    AXES.map((a) => [a, emptyAxisPosterior(a)]),
  ) as Record<Axis, AxisPosterior>;

  // Group signals by axis
  const byAxis = new Map<Axis, SignalInput[]>();
  for (const s of signals) {
    if (!(AXES as readonly string[]).includes(s.axis)) continue;
    const arr = byAxis.get(s.axis as Axis) ?? [];
    arr.push(s);
    byAxis.set(s.axis as Axis, arr);
  }

  for (const [axis, axisSignals] of byAxis) {
    // Re-aggregate α/β at the axis level from scratch. Each ReputationSignal
    // row carries its own (α, β) — sum α contributions, sum β contributions,
    // then add the prior once.
    //
    // The per-row α and β each include a copy of the prior (α=2, β=2 baked
    // in). To avoid multiplying the prior by the number of kinds, we subtract
    // PRIOR_ALPHA / PRIOR_BETA from each row's posterior contribution before
    // summing, then add one prior at the end.
    let positiveSum = 0;
    let negativeSum = 0;
    const evidenceItems: EvidenceItem[] = [];

    for (const s of axisSignals) {
      const spec = EVENT_KINDS[s.kind as EventKind];
      const polarity = spec?.polarity ?? 1;

      const rowPositive = Math.max(0, s.alpha - PRIOR_ALPHA);
      const rowNegative = Math.max(0, s.beta - PRIOR_BETA);
      positiveSum += rowPositive;
      negativeSum += rowNegative;

      // Only include in evidence if meaningfully contributing
      if (s.decayedValue > 0.01) {
        evidenceItems.push({
          kind: s.kind,
          decayedValue: s.decayedValue,
          uniqueActors: s.uniqueActors,
          polarity,
        });
      }
    }

    const alpha = PRIOR_ALPHA + positiveSum;
    const beta = PRIOR_BETA + negativeSum;
    const mean = alpha / (alpha + beta);
    const variance = betaVariance(alpha, beta);
    const lb = wilsonLowerBound95(alpha, beta);
    const effectiveSamples = positiveSum + negativeSum;

    // Top 5 evidence items by decayedValue
    evidenceItems.sort((a, b) => b.decayedValue - a.decayedValue);
    const topEvidence = evidenceItems.slice(0, 5);

    out[axis] = {
      axis,
      alpha,
      beta,
      posteriorMean: mean,
      posteriorVariance: variance,
      lowerBound95: lb,
      effectiveSamples,
      topEvidence,
    };
  }

  return out;
}

export function computeComposite(
  axisPosteriors: Record<Axis, AxisPosterior>,
  weights: Record<Axis, number> = AXIS_WEIGHTS_DEFAULT,
): number {
  let composite = 0;
  let totalWeight = 0;
  for (const axis of AXES) {
    const w = weights[axis] ?? 0;
    composite += w * axisPosteriors[axis].posteriorMean;
    totalWeight += w;
  }
  // Normalize in case weights don't sum to 1
  if (totalWeight > 0 && Math.abs(totalWeight - 1) > 0.001) {
    composite /= totalWeight;
  }
  return Math.max(0, Math.min(1, composite));
}

/**
 * Composite from bare per-axis means — same blend as computeComposite, but
 * takes a plain `{axis: mean}` map. Used by the EigenTrust step (Phase 3c)
 * to RE-derive the graph-free base composite from the stored posterior
 * means, so applying the graph bonus stays idempotent across re-runs (the
 * means never change; the stored compositeScore would compound).
 */
export function compositeFromMeans(
  means: Partial<Record<Axis, number>>,
  weights: Record<Axis, number> = AXIS_WEIGHTS_DEFAULT,
): number {
  const neutral = PRIOR_ALPHA / PRIOR_TOTAL;
  let composite = 0;
  let totalWeight = 0;
  for (const axis of AXES) {
    const w = weights[axis] ?? 0;
    composite += w * (means[axis] ?? neutral);
    totalWeight += w;
  }
  if (totalWeight > 0 && Math.abs(totalWeight - 1) > 0.001) composite /= totalWeight;
  return Math.max(0, Math.min(1, composite));
}

/** Phase 3c default — graph bonus weight (additive, never a penalty). */
export const GRAPH_BONUS_WEIGHT = 0.15;

/**
 * Fold EigenTrust into the composite as a BONUS that never penalizes.
 *
 *   composite' = clamp(base + bonusWeight · max(0, eigentrust))
 *
 * Because eigentrust ≥ 0, the bonus is always ≥ 0 — an agent with no graph
 * footprint (eigentrust 0: SlimeBot, every new legit agent) is unchanged,
 * while the network's most-trusted agent (Xona, normalized eigentrust 1.0)
 * gets the full bonus. Graph presence only ever helps.
 */
export function applyGraphBonus(
  baseComposite: number,
  eigentrust: number,
  bonusWeight: number = GRAPH_BONUS_WEIGHT,
): number {
  return Math.max(0, Math.min(1, baseComposite + bonusWeight * Math.max(0, eigentrust)));
}

export function assignTier(
  composite: number,
  totalSamples: number,
  identityPosteriorMean: number,
): Tier {
  if (
    composite >= TIER_THRESHOLDS.platinum.composite &&
    totalSamples >= TIER_THRESHOLDS.platinum.samples &&
    identityPosteriorMean >= TIER_THRESHOLDS.platinum.identity
  ) {
    return 'platinum';
  }
  if (
    composite >= TIER_THRESHOLDS.gold.composite &&
    totalSamples >= TIER_THRESHOLDS.gold.samples
  ) {
    return 'gold';
  }
  if (
    composite >= TIER_THRESHOLDS.silver.composite &&
    totalSamples >= TIER_THRESHOLDS.silver.samples
  ) {
    return 'silver';
  }
  if (composite >= TIER_THRESHOLDS.bronze.composite) {
    return 'bronze';
  }
  return 'unranked';
}

/**
 * Full pipeline: signals → per-axis posteriors → composite → tier.
 */
export function computeAgentPosteriors(
  subjectWallet: string,
  signals: SignalInput[],
  weights: Record<Axis, number> = AXIS_WEIGHTS_DEFAULT,
): AgentPosteriors {
  const axes = computeAxisPosteriors(signals);
  const composite = computeComposite(axes, weights);
  const totalSamples = AXES.reduce((sum, a) => sum + axes[a].effectiveSamples, 0);
  const tier = assignTier(composite, totalSamples, axes.identity.posteriorMean);
  return {
    subjectWallet,
    axes,
    compositeScore: composite,
    totalSamples,
    tier,
  };
}

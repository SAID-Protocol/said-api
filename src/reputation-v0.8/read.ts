/**
 * Read layer for reputation v0.8 — how the API reads scores back.
 *
 * The compute pipeline (run on the score-backfill service) writes
 * ReputationPosterior. This is the single read path the public endpoints
 * (/api/trust, /api/verify) share, so there's one source of truth for an
 * agent's v8 tier + score.
 *
 * Miss handling: an agent with no ReputationPosterior rows (e.g. registered
 * after the last batch run) returns `found: false` + an `unranked` tier
 * rather than throwing. Callers decide how to present an unscored agent.
 *
 * This module is pure-read and side-effect-free; the v0.6 engine is
 * untouched and remains the fallback at the call site.
 */
import type { PrismaClient } from '@prisma/client';
import { AXES, type Axis } from './axes.js';
import { assignTier, type Tier } from './posteriors.js';

export interface V8AxisView {
  posteriorMean: number;
  lowerBound95: number;
  sampleSize: number;
}

export interface V8Reputation {
  wallet: string;
  found: boolean; // false → no posterior rows yet (unscored / too new)
  compositeScore: number; // 0–1, includes the Phase 3c graph bonus
  tier: Tier; // unranked | bronze | silver | gold | platinum
  totalSamples: number;
  eigentrustScore: number;
  axes: Partial<Record<Axis, V8AxisView>>;
  computedAt: Date | null;
}

const UNRANKED = (wallet: string): V8Reputation => ({
  wallet,
  found: false,
  compositeScore: 0,
  tier: 'unranked',
  totalSamples: 0,
  eigentrustScore: 0,
  axes: {},
  computedAt: null,
});

/**
 * Read an agent's v0.8 reputation from ReputationPosterior. compositeScore
 * and eigentrustScore are stored per-axis but identical across a subject's
 * rows, so we take them off any row; tier is re-derived from
 * (composite, total samples, identity mean) since tier isn't a stored column.
 */
export async function getV8Reputation(prisma: PrismaClient, wallet: string): Promise<V8Reputation> {
  const rows = await prisma.reputationPosterior.findMany({
    where: { subjectWallet: wallet },
    select: {
      axis: true,
      posteriorMean: true,
      lowerBound95: true,
      sampleSize: true,
      compositeScore: true,
      eigentrustScore: true,
      computedAt: true,
    },
  });
  if (rows.length === 0) return UNRANKED(wallet);

  const compositeScore = rows[0].compositeScore;
  const eigentrustScore = rows[0].eigentrustScore;
  const computedAt = rows[0].computedAt ?? null;

  let totalSamples = 0;
  let identityMean = 0.5;
  const axes: Partial<Record<Axis, V8AxisView>> = {};
  for (const r of rows) {
    totalSamples += r.sampleSize;
    if (r.axis === 'identity') identityMean = r.posteriorMean;
    if ((AXES as readonly string[]).includes(r.axis)) {
      axes[r.axis as Axis] = {
        posteriorMean: r.posteriorMean,
        lowerBound95: r.lowerBound95,
        sampleSize: r.sampleSize,
      };
    }
  }

  const tier = assignTier(compositeScore, totalSamples, identityMean);

  return { wallet, found: true, compositeScore, tier, totalSamples, eigentrustScore, axes, computedAt };
}

/**
 * Map the v0.8 five-tier to the legacy three-tier the public endpoints have
 * always returned (`high`/`medium`/`low`), so existing fast-gate consumers
 * that read `trustTier` keep working after the swap.
 */
export function legacyTrustTier(tier: Tier): 'high' | 'medium' | 'low' {
  if (tier === 'platinum' || tier === 'gold') return 'high';
  if (tier === 'silver') return 'medium';
  return 'low';
}

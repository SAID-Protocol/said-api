/**
 * Trust-screen logic for GET /api/screen — "should my agent pay this counterparty?"
 *
 * Kept separate from the route handler in index.ts so it's unit-testable without
 * booting the whole server. Reads SAID's computed v0.8 reputation and maps it to
 * an allow/review/caution verdict for an agent about to pay this wallet.
 *
 * Verdicts use *positive-evidence* reputation only — we assert "allow" on an
 * established track record and never fabricate a "block" we have no fraud data
 * for, so "no reputation" maps to "review", not "block".
 */
import type { PrismaClient } from '@prisma/client';
import { getV8Reputation } from './reputation-v0.8/read.js';

export interface ScreenResult {
  wallet: string;
  verdict: 'allow' | 'review' | 'caution';
  score: number | null; // 0–100 composite, null if unscored
  tier: string;
  registered: boolean;
  verified: boolean;
  scored: boolean;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  axes: Record<string, { score: number; confidenceFloor: number; signals: number }>;
  eigentrust: number | null;
  computedAt: Date | null;
  source: string;
}

const SOURCE_SCORED =
  'SAID Protocol reputation v0.8 — computed Bayesian per-axis posteriors + EigenTrust over 5,600+ Solana agents';

export async function buildScreenResult(prisma: PrismaClient, wallet: string): Promise<ScreenResult> {
  const agent = await prisma.agent.findUnique({
    where: { wallet },
    select: { isVerified: true },
  });

  // Unknown wallet: not a registered SAID agent → no identity to vouch for.
  if (!agent) {
    return {
      wallet,
      verdict: 'review',
      score: null,
      tier: 'unranked',
      registered: false,
      verified: false,
      scored: false,
      confidence: 'low',
      reason:
        'Not a registered SAID agent — no verifiable identity or reputation on record. Verify out-of-band before paying.',
      axes: {},
      eigentrust: null,
      computedAt: null,
      source: 'SAID Protocol reputation v0.8',
    };
  }

  let rep: Awaited<ReturnType<typeof getV8Reputation>> | null = null;
  try {
    rep = await getV8Reputation(prisma, wallet);
  } catch (err) {
    console.error('[/api/screen] v8 reputation read failed', wallet, err);
  }

  const scored = !!rep?.found;
  const tier = scored ? rep!.tier : 'unranked';
  const composite = scored ? rep!.compositeScore : 0;
  const samples = rep?.totalSamples ?? 0;
  const score = scored ? Math.round(composite * 100) : null;
  const confidence = samples >= 30 ? 'high' : samples >= 10 ? 'medium' : 'low';

  let verdict: 'allow' | 'review' | 'caution';
  let reason: string;
  if (!scored) {
    verdict = 'review';
    reason = agent.isVerified
      ? 'Verified SAID identity but no reputation evidence yet (no track record to score). Proceed with caution on a first interaction.'
      : 'Registered but unverified, with no reputation evidence yet. Verify out-of-band before paying.';
  } else if (tier === 'platinum' || tier === 'gold') {
    verdict = 'allow';
    reason = `Established ${tier} reputation (composite ${score}/100) across ${samples} signals. Safe to transact.`;
  } else if (tier === 'silver') {
    verdict = 'review';
    reason = `Moderate reputation (silver, ${score}/100, ${samples} signals). Reasonable, but review for high-value transactions.`;
  } else {
    verdict = 'caution';
    reason = `Low reputation (${tier}, ${score}/100, ${samples} signals). Limited or weak track record — caution advised.`;
  }

  // Per-axis breakdown — SAID's differentiator vs a flat feedback average.
  const axes = scored
    ? Object.fromEntries(
        Object.entries(rep!.axes).map(([axis, v]) => [
          axis,
          {
            score: Math.round(v!.posteriorMean * 100),
            confidenceFloor: Math.round(v!.lowerBound95 * 100),
            signals: v!.sampleSize,
          },
        ]),
      )
    : {};

  return {
    wallet,
    verdict,
    score,
    tier,
    registered: true,
    verified: agent.isVerified,
    scored,
    confidence,
    reason,
    axes,
    eigentrust: scored ? Number(rep!.eigentrustScore.toFixed(4)) : null,
    computedAt: rep?.computedAt ?? null,
    source: SOURCE_SCORED,
  };
}

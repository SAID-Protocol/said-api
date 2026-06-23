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

// A single ReputationPosterior row, narrowed to what the read path needs.
interface PostRow {
  axis: string;
  posteriorMean: number;
  lowerBound95: number;
  sampleSize: number;
  compositeScore: number;
  eigentrustScore: number;
  computedAt: Date | null;
}

const POST_SELECT = {
  axis: true,
  posteriorMean: true,
  lowerBound95: true,
  sampleSize: true,
  compositeScore: true,
  eigentrustScore: true,
  computedAt: true,
} as const;

// ── Sustained-launch tier-floor ─────────────────────────────────────
// A launched token still alive at high market cap ≥21 days later is strong,
// hard-to-fake evidence of value. We floor the agent's tier accordingly,
// because the composite (baseline-axis drag) caps even a real launcher at
// silver. Mirrors the floor applied in the compute pipeline's report.
const SUSTAIN_DAYS = 21;
const TIER_RANK: Record<Tier, number> = {
  unranked: 0,
  bronze: 1,
  silver: 2,
  gold: 3,
  platinum: 4,
};

async function getLaunchFloors(
  prisma: PrismaClient,
  wallets: string[],
): Promise<Map<string, Tier>> {
  const floors = new Map<string, Tier>();
  if (wallets.length === 0) return floors;
  const launches = await prisma.launchedToken.findMany({
    where: { agentWallet: { in: wallets }, marketCapUsd: { gte: 1_000_000 } },
    select: { agentWallet: true, marketCapUsd: true, launchedAt: true, detectedAt: true },
  });
  const cutoff = Date.now() - SUSTAIN_DAYS * 24 * 60 * 60 * 1000;
  for (const l of launches) {
    const launchedMs = (l.launchedAt ?? l.detectedAt).getTime();
    if (launchedMs > cutoff) continue; // not sustained long enough yet
    const t: Tier = (l.marketCapUsd ?? 0) >= 10_000_000 ? 'platinum' : 'gold';
    const cur = floors.get(l.agentWallet);
    if (!cur || TIER_RANK[t] > TIER_RANK[cur]) floors.set(l.agentWallet, t);
  }
  return floors;
}

/**
 * Build a V8Reputation from a subject's posterior rows. compositeScore and
 * eigentrustScore are stored per-axis but identical across rows, so we take
 * them off any row; tier is re-derived from (composite, total samples,
 * identity mean) since tier isn't a stored column.
 */
function buildFromRows(wallet: string, rows: PostRow[], floor: Tier | null = null): V8Reputation {
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

  let tier = assignTier(compositeScore, totalSamples, identityMean);
  // Sustained-launch tier-floor: bump up if the agent has a qualifying launch.
  if (floor && TIER_RANK[floor] > TIER_RANK[tier]) tier = floor;
  return { wallet, found: true, compositeScore, tier, totalSamples, eigentrustScore, axes, computedAt };
}

/** Read one agent's v0.8 reputation from ReputationPosterior. */
export async function getV8Reputation(prisma: PrismaClient, wallet: string): Promise<V8Reputation> {
  const [rows, floors] = await Promise.all([
    prisma.reputationPosterior.findMany({ where: { subjectWallet: wallet }, select: POST_SELECT }),
    getLaunchFloors(prisma, [wallet]),
  ]);
  return buildFromRows(wallet, rows, floors.get(wallet) ?? null);
}

/**
 * Batch version for list/leaderboard endpoints — one query for all wallets,
 * grouped in memory. Wallets with no rows map to the unranked default.
 */
export async function getV8ReputationBatch(
  prisma: PrismaClient,
  wallets: string[],
): Promise<Map<string, V8Reputation>> {
  const out = new Map<string, V8Reputation>();
  if (wallets.length === 0) return out;

  const rows = await prisma.reputationPosterior.findMany({
    where: { subjectWallet: { in: wallets } },
    select: { ...POST_SELECT, subjectWallet: true },
  });

  const byWallet = new Map<string, PostRow[]>();
  for (const r of rows) {
    const arr = byWallet.get(r.subjectWallet) ?? [];
    arr.push(r);
    byWallet.set(r.subjectWallet, arr);
  }
  const floors = await getLaunchFloors(prisma, wallets);
  for (const w of wallets) {
    out.set(w, buildFromRows(w, byWallet.get(w) ?? [], floors.get(w) ?? null));
  }
  return out;
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

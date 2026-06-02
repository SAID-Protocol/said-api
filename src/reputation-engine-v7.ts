/**
 * SAID Reputation Engine v0.7
 *
 * Materially different from v0.6.x in five ways:
 *
 *   1. Two-axis Trust + Traction split (was: single weighted sum)
 *   2. Square-gated composite — SAID = wT·Trust + wX·Traction·(Trust/100)²
 *      so a high-traction agent with no trust cannot rank above a
 *      genuinely trustworthy one purely on market activity
 *   3. Demonstrated-delivery sub-signal — adds up to +0.20 to Identity
 *      when an agent has a launched token sustaining $1M+ cap (proxy
 *      for graduation + retention until we wire dexId/ATH)
 *   4. Structural ceilings via verification status:
 *        - Unverified → composite capped at Silver (44)
 *        - Verified but no demonstrated delivery → capped at Gold (79)
 *        - Verified + demonstrated delivery → eligible for Platinum
 *   5. Continuous-membership type model (μ_new / μ_launcher / μ_service)
 *      with conditional weights blended at the basket level so there
 *      are no overnight cliffs at day-14 or first-mint
 *
 * Composition with v0.6.x:
 *   - Component sub-scores (identity/activity/economic/ecosystem/longevity/
 *     fairscale) are computed identically — same 0-10 bands, same inputs.
 *     v0.7 changes how they're aggregated, not how they're measured.
 *   - The cached AgentScore table and the directory still use the old
 *     computeTrustScore. v0.7 powers the reputation API surface
 *     (/api/reputation/*) only, so the model can be iterated without
 *     touching the directory's rendering.
 *
 * Honest limitations of this iteration:
 *   - Stake-based Platinum gating (verified + sustained stake → Platinum
 *     eligible) is deferred because stake state isn't mirrored in the
 *     DB and adding an RPC call to the hot path is a separate change.
 *     Until then, demonstrated-delivery is the Platinum eligibility gate.
 *   - Retention guard (sustainedCap/ATH > 0.5) on the demonstrated-
 *     delivery bonus is approximated by "current marketCap >= $1M"
 *     because we don't track ATH yet.
 *   - Liveness sub-signal is plumbed at zero pending the ping infra.
 *   - Funding-cluster collapse and v0.7's full sybil defenses are
 *     pending; this iteration is honest about that in reason codes
 *     and the methodology doc.
 */

export interface AgentLike {
  wallet: string;
  isVerified?: boolean;
  layer2Verified?: boolean;
  name?: string | null;
  description?: string | null;
  twitter?: string | null;
  website?: string | null;
  image?: string | null;
  mcpEndpoint?: string | null;
  a2aEndpoint?: string | null;
  skills?: string[] | null;
  serviceTypes?: string[] | null;
  reputationScore?: number;
  feedbackCount?: number;
  activityCount?: number | null;
  lastActiveAt?: Date | string | null;
  registeredAt: Date | string;
  _count?: { feedbackReceived?: number };
}

export interface V7AnchorStats {
  anchorCount: number;
  totalReceipts: number;
}
export interface V7ActivityStats {
  txCount: number;
  volumeSol: number;
  uniqueCounterparties: number;
  activeDays: number;
}
export interface V7LaunchedTokenStats {
  tokenCount: number;
  totalMarketCapUsd: number;
  totalVolume24hUsd: number;
  topMarketCapUsd: number;
}

/**
 * x402 micropayment activity (both sides) for this wallet, as indexed
 * by x402scan. Powers the paid_service path of demonstrated-delivery.
 *
 * - Provider side: this wallet sells endpoints; unique_buyers counts
 *   distinct payers across the full lookback.
 * - Buyer side: this wallet pays other endpoints; unique_sellers counts
 *   distinct services consumed.
 *
 * Both sides being non-empty is the strongest "full agent-economy
 * participant" signal.
 */
export interface V7X402ActivityStats {
  providerUniqueBuyers: number;
  providerTxCount: number;
  buyerUniqueSellers: number;
  buyerTxCount: number;
}

export type V7Tier = 'unranked' | 'bronze' | 'silver' | 'gold' | 'platinum';
export type V7AgentType = 'launcher' | 'service' | 'new' | 'mixed';

export interface V7DemonstratedDelivery {
  active: boolean;
  path: 'launcher_token' | 'paid_service' | null;
  /** Raw contribution added to Identity sub-signal (0-2, before identity clamp). */
  contribution: number;
}

export interface V7CeilingDecision {
  /** Name of the ceiling rule that fired, or null if no ceiling applied. */
  name: 'unverified_silver' | 'no_delivery_gold' | null;
  /** The cap value the composite was clamped to. 100 means no cap. */
  cap: number;
}

export interface V7TypeMembership {
  new: number;
  launcher: number;
  service: number;
}

export interface V7ScoreResult {
  // headline
  score: number;
  tier: V7Tier;

  // two-axis decomposition
  trust: number; // 0-100
  traction: number; // 0-100
  trust_gate: number; // (Trust/100)^2, 0-1

  // component breakdown (kept for v0.6 compatibility / partner familiarity)
  identity: number; // 0-10
  activity: number; // 0-10
  economic: number; // 0-10
  ecosystem: number; // 0-10
  longevity: number; // 0-10
  fairscale: number; // 0-10

  // v0.7-specific signals
  type: V7AgentType;
  type_membership: V7TypeMembership;
  demonstrated_delivery: V7DemonstratedDelivery;
  ceiling_applied: V7CeilingDecision;

  // metadata
  badges: string[];
  sources: string[];
  computedAt: string;
  methodology_version: string;
}

// ─── Constants ────────────────────────────────────────────────────

export const METHODOLOGY_VERSION_V7 = 'v0.7.0';

// Tier cuts — match v0.6.x and the methodology doc.
const TIER_PLATINUM = 80;
const TIER_GOLD = 65;
const TIER_SILVER = 45;
const TIER_BRONZE = 25;

// Structural ceiling caps (applied AFTER composite computation, before tier).
// Cap = top of the tier the ceiling allows. Silver tier is 45-64, so the
// top of Silver is 64. Gold tier is 65-79, so the top of Gold is 79.
const CAP_UNVERIFIED = 64; // Cap at top of Silver tier
const CAP_NO_DELIVERY = 79; // Cap at top of Gold tier

// Demonstrated-delivery thresholds (path a — launched token sustained cap).
// $1M is the "sustained real cap" proxy; tier is fully partial below it.
const DELIVERY_CAP_FULL_USD = 1_000_000;
const DELIVERY_CAP_PARTIAL_USD = 250_000;
const DELIVERY_BONUS_FULL = 2.0; // points added to identity (0-10 scale)
const DELIVERY_BONUS_PARTIAL = 1.0;

// paid_service path thresholds (x402scan-indexed)
// Calibrated against the actual SAID corpus distribution: ~0.05% of
// verified agents have any x402 provider activity today. Xona is the
// only agent in the corpus that clears the FULL threshold (580 unique
// buyers). PARTIAL is set low enough to catch emerging real providers
// (≥5 distinct payers) without rewarding sybil setups.
const PAID_SERVICE_FULL_UNIQUE_BUYERS = 50;
const PAID_SERVICE_PARTIAL_UNIQUE_BUYERS = 5;
const PAID_SERVICE_PARTIAL_BUYER_UNIQUE_SELLERS = 5;

// Type model
const NEW_AGENT_DAYS = 14;

// ─── Sub-signal computation (component scores, 0-10) ──────────────
// These mirror the v0.6.x logic so the component breakdown stays
// recognizable to partners. v0.7 changes happen at the aggregation
// layer, not the per-component layer.

function computeIdentitySubscore(
  agent: AgentLike,
  delivery: V7DemonstratedDelivery,
): number {
  let score = 0;
  if (agent.isVerified) score += 4;
  if (agent.name) score += 1;
  if (agent.description) score += 1;
  if (agent.twitter) score += 1;
  if (agent.website) score += 1;
  if (agent.image) score += 1;
  if (agent.layer2Verified) score += 1;
  // Demonstrated-delivery bonus — the v0.7 addition.
  score += delivery.contribution;
  return Math.min(10, score);
}

function computeActivitySubscore(
  agent: AgentLike,
  anchorStats: V7AnchorStats | undefined,
  activityStats: V7ActivityStats | undefined,
): number {
  let score = 0;
  const feedbackCount = agent._count?.feedbackReceived ?? agent.feedbackCount ?? 0;
  const activityCount = agent.activityCount ?? 0;
  const txCount30d = activityStats?.txCount ?? 0;
  const activeDays30d = activityStats?.activeDays ?? 0;
  const counterparties30d = activityStats?.uniqueCounterparties ?? 0;

  if (feedbackCount >= 10) score += 2;
  else if (feedbackCount >= 5) score += 1;
  if (activityCount >= 50) score += 1;
  else if (activityCount >= 5) score += 0.5;
  if (agent.lastActiveAt) {
    const days =
      (Date.now() - new Date(agent.lastActiveAt).getTime()) / (1000 * 60 * 60 * 24);
    if (days <= 7) score += 1;
    else if (days <= 30) score += 0.5;
  }
  if (txCount30d >= 1000) score += 3;
  else if (txCount30d >= 200) score += 2.5;
  else if (txCount30d >= 50) score += 2;
  else if (txCount30d >= 10) score += 1;
  if (activeDays30d >= 20) score += 2;
  else if (activeDays30d >= 7) score += 1;
  else if (activeDays30d >= 3) score += 0.5;
  if (counterparties30d >= 100) score += 1;
  else if (counterparties30d >= 20) score += 0.5;

  const totalReceipts = anchorStats?.totalReceipts ?? 0;
  const anchorCount = anchorStats?.anchorCount ?? 0;
  if (totalReceipts >= 1000) score += 2;
  else if (totalReceipts >= 100) score += 1.5;
  else if (totalReceipts >= 25) score += 1;
  else if (totalReceipts >= 5) score += 0.5;
  if (anchorCount >= 5) score += 0.5;

  return Math.min(10, score);
}

function computeEconomicSubscore(
  agent: AgentLike,
  activityStats: V7ActivityStats | undefined,
  launched: V7LaunchedTokenStats | undefined,
): number {
  let score = 0;
  const rep = agent.reputationScore ?? 0;
  if (rep >= 80) score += 2;
  else if (rep >= 60) score += 1.5;
  else if (rep >= 40) score += 1;
  else if (rep >= 20) score += 0.5;
  if (agent.isVerified) score += 1;

  const volumeSol = activityStats?.volumeSol ?? 0;
  if (volumeSol >= 100_000) score += 4;
  else if (volumeSol >= 10_000) score += 3;
  else if (volumeSol >= 1_000) score += 2;
  else if (volumeSol >= 100) score += 1;
  else if (volumeSol >= 10) score += 0.5;

  const launchedMcUsd = launched?.totalMarketCapUsd ?? 0;
  const launched24hVolUsd = launched?.totalVolume24hUsd ?? 0;
  if (launchedMcUsd >= 10_000_000) score += 3;
  else if (launchedMcUsd >= 1_000_000) score += 2;
  else if (launchedMcUsd >= 100_000) score += 1;
  else if (launchedMcUsd >= 10_000) score += 0.5;
  if (launched24hVolUsd >= 1_000_000) score += 1;
  else if (launched24hVolUsd >= 100_000) score += 0.5;

  return Math.min(10, score);
}

function computeEcosystemSubscore(agent: AgentLike): number {
  let score = 0;
  if (agent.mcpEndpoint) score += 2;
  if (agent.a2aEndpoint) score += 2;
  if (agent.skills && agent.skills.length > 0)
    score += Math.min(3, agent.skills.length);
  if (agent.serviceTypes && agent.serviceTypes.length > 0)
    score += Math.min(3, agent.serviceTypes.length);
  return Math.min(10, score);
}

function computeLongevitySubscore(ageDays: number): number {
  if (ageDays >= 90) return 10;
  if (ageDays >= 60) return 8;
  if (ageDays >= 30) return 6;
  if (ageDays >= 14) return 4;
  if (ageDays >= 7) return 2;
  return 1;
}

// ─── Demonstrated-delivery sub-signal (the constrained Option D) ──

/**
 * Detect whether the agent has demonstrated real-world delivery.
 *
 * Path (a) — Launched token sustaining real cap. Until we wire dexId
 * (graduation) and ATH (retention guard) we use current top marketCap
 * as a proxy: $1M+ is rarely sustainable without real market activity
 * behind it, and falsifying it is meaningfully expensive.
 *
 * Path (b) — External paid service: TBD pending x402 ingestion. Not
 * computed here; returns negative for service-only agents until the
 * paid-demand index is in place.
 */
function detectDemonstratedDelivery(
  launched: V7LaunchedTokenStats | undefined,
  x402?: V7X402ActivityStats,
): V7DemonstratedDelivery {
  // Path (a): launcher_token — agent's token reached real market cap
  const topCap = launched?.topMarketCapUsd ?? 0;
  if (topCap >= DELIVERY_CAP_FULL_USD) {
    return { active: true, path: 'launcher_token', contribution: DELIVERY_BONUS_FULL };
  }

  // Path (b): paid_service — agent is an active x402 provider with
  // independently-verified buyer activity (per x402scan).
  const providerBuyers = x402?.providerUniqueBuyers ?? 0;
  if (providerBuyers >= PAID_SERVICE_FULL_UNIQUE_BUYERS) {
    return { active: true, path: 'paid_service', contribution: DELIVERY_BONUS_FULL };
  }

  // Partial delivery falls through both paths
  if (topCap >= DELIVERY_CAP_PARTIAL_USD) {
    return { active: true, path: 'launcher_token', contribution: DELIVERY_BONUS_PARTIAL };
  }
  if (providerBuyers >= PAID_SERVICE_PARTIAL_UNIQUE_BUYERS) {
    return { active: true, path: 'paid_service', contribution: DELIVERY_BONUS_PARTIAL };
  }
  // Buyer-side fallback: an autonomous agent that consumes services across
  // multiple distinct sellers is a credible economy participant even if it
  // hasn't (yet) attracted enough buyers as a provider.
  const buyerSellers = x402?.buyerUniqueSellers ?? 0;
  if (buyerSellers >= PAID_SERVICE_PARTIAL_BUYER_UNIQUE_SELLERS) {
    return { active: true, path: 'paid_service', contribution: DELIVERY_BONUS_PARTIAL };
  }

  return { active: false, path: null, contribution: 0 };
}

// ─── Continuous type membership ───────────────────────────────────

function computeTypeMembership(
  ageDays: number,
  hasLaunchedToken: boolean,
): V7TypeMembership {
  const mNew = Math.max(0, Math.min(1, (NEW_AGENT_DAYS - ageDays) / NEW_AGENT_DAYS));
  const mLauncher = (hasLaunchedToken ? 1 : 0) * (1 - mNew);
  const mService = Math.max(0, 1 - mNew - mLauncher);
  return { new: mNew, launcher: mLauncher, service: mService };
}

function dominantType(m: V7TypeMembership): V7AgentType {
  if (m.new >= 0.5) return 'new';
  if (m.launcher >= 0.5) return 'launcher';
  if (m.service >= 0.5) return 'service';
  return 'mixed';
}

// ─── Conditional weights per agent type ───────────────────────────
//
// Each basket sums to 1.0. Components are 0-10 raw, so basket × component_value
// produces a 0-10 contribution per component, summed across the basket to
// produce a 0-10 axis subtotal, then ×10 to produce the 0-100 axis score.

interface TypeWeights {
  // Trust basket (sums to ~1.0)
  identity: number;
  longevity: number;
  // Traction basket (sums to ~1.0)
  activity: number;
  economic: number;
  ecosystem: number;
  // External enrichment — applied to whichever axis is most appropriate
  fairscale_to_trust: number; // fraction routed to Trust
  // Composite mix
  wTrust: number;
  wTraction: number;
}

const WEIGHTS_LAUNCHER: TypeWeights = {
  identity: 0.65,
  longevity: 0.35,
  activity: 0.30,
  economic: 0.55,
  ecosystem: 0.15,
  fairscale_to_trust: 0.5,
  wTrust: 0.55,
  wTraction: 0.45,
};

const WEIGHTS_SERVICE: TypeWeights = {
  identity: 0.55,
  longevity: 0.45,
  activity: 0.60,
  economic: 0.20,
  ecosystem: 0.20,
  fairscale_to_trust: 0.5,
  wTrust: 0.60,
  wTraction: 0.40,
};

const WEIGHTS_NEW: TypeWeights = {
  identity: 0.75,
  longevity: 0.25,
  activity: 0.55,
  economic: 0.25,
  ecosystem: 0.20,
  fairscale_to_trust: 0.7, // new agents lean on identity-style enrichment
  wTrust: 0.80,
  wTraction: 0.20,
};

function blendWeights(
  m: V7TypeMembership,
): TypeWeights {
  const out: TypeWeights = {
    identity: 0,
    longevity: 0,
    activity: 0,
    economic: 0,
    ecosystem: 0,
    fairscale_to_trust: 0,
    wTrust: 0,
    wTraction: 0,
  };
  const sets: Array<[number, TypeWeights]> = [
    [m.new, WEIGHTS_NEW],
    [m.launcher, WEIGHTS_LAUNCHER],
    [m.service, WEIGHTS_SERVICE],
  ];
  for (const [weight, set] of sets) {
    out.identity += weight * set.identity;
    out.longevity += weight * set.longevity;
    out.activity += weight * set.activity;
    out.economic += weight * set.economic;
    out.ecosystem += weight * set.ecosystem;
    out.fairscale_to_trust += weight * set.fairscale_to_trust;
    out.wTrust += weight * set.wTrust;
    out.wTraction += weight * set.wTraction;
  }
  return out;
}

// ─── Structural ceiling decision ──────────────────────────────────

function decideCeiling(
  agent: AgentLike,
  delivery: V7DemonstratedDelivery,
): V7CeilingDecision {
  if (!agent.isVerified) {
    return { name: 'unverified_silver', cap: CAP_UNVERIFIED };
  }
  if (!delivery.active) {
    return { name: 'no_delivery_gold', cap: CAP_NO_DELIVERY };
  }
  return { name: null, cap: 100 };
}

// ─── Tier from composite ──────────────────────────────────────────

function tierFromScore(score: number): V7Tier {
  if (score >= TIER_PLATINUM) return 'platinum';
  if (score >= TIER_GOLD) return 'gold';
  if (score >= TIER_SILVER) return 'silver';
  if (score >= TIER_BRONZE) return 'bronze';
  return 'unranked';
}

// ─── Badges & sources ─────────────────────────────────────────────

function buildBadges(
  agent: AgentLike,
  type: V7AgentType,
  delivery: V7DemonstratedDelivery,
  activityStats: V7ActivityStats | undefined,
  launched: V7LaunchedTokenStats | undefined,
): string[] {
  const out: string[] = [];
  if (agent.isVerified) out.push('verified');
  if (agent.layer2Verified) out.push('l2_verified');
  if (type === 'new') out.push('new');
  if ((launched?.tokenCount ?? 0) > 0) out.push('token_launcher');
  if (delivery.active && delivery.path === 'launcher_token')
    out.push('demonstrated_delivery_launcher');
  if ((activityStats?.txCount ?? 0) >= 100) out.push('active');
  if ((activityStats?.volumeSol ?? 0) >= 10_000) out.push('high_volume');
  if ((launched?.topMarketCapUsd ?? 0) >= 1_000_000) out.push('cap_over_1m');
  return out;
}

function buildSources(
  trustScore: { fairscale: number },
  anchorStats: V7AnchorStats | undefined,
  activityStats: V7ActivityStats | undefined,
  launched: V7LaunchedTokenStats | undefined,
  x402?: V7X402ActivityStats,
): string[] {
  const sources = ['said'];
  if (trustScore.fairscale > 0) sources.push('fairscale');
  if ((anchorStats?.anchorCount ?? 0) > 0) sources.push('receipts');
  if ((activityStats?.txCount ?? 0) > 0) sources.push('onchain_activity');
  if ((launched?.tokenCount ?? 0) > 0) sources.push('launched_tokens');
  if ((x402?.providerUniqueBuyers ?? 0) > 0 || (x402?.buyerUniqueSellers ?? 0) > 0) {
    sources.push('x402scan');
  }
  return sources;
}

// ─── Main entry ───────────────────────────────────────────────────

/**
 * Compute the v0.7 trust score for an agent.
 *
 * Returns the full V7ScoreResult — composite + axes + components +
 * v0.7-specific signals (type, demonstrated delivery, ceiling decision).
 * Reason codes are derived downstream in reputation-shaping.ts.
 */
export function computeTrustScoreV7(
  agent: AgentLike,
  anchorStats?: V7AnchorStats,
  activityStats?: V7ActivityStats,
  launchedTokenStats?: V7LaunchedTokenStats,
  fairscaleSubscore?: number,
  x402ActivityStats?: V7X402ActivityStats,
): V7ScoreResult {
  const now = Date.now();
  const ageDays = Math.floor(
    (now - new Date(agent.registeredAt).getTime()) / (1000 * 60 * 60 * 24),
  );
  const fairscale = Math.max(0, Math.min(10, fairscaleSubscore ?? 0));

  // Step 1: Demonstrated delivery (feeds Identity)
  const delivery = detectDemonstratedDelivery(launchedTokenStats, x402ActivityStats);

  // Step 2: Sub-signals (each 0-10)
  const identity = computeIdentitySubscore(agent, delivery);
  const activity = computeActivitySubscore(agent, anchorStats, activityStats);
  const economic = computeEconomicSubscore(agent, activityStats, launchedTokenStats);
  const ecosystem = computeEcosystemSubscore(agent);
  const longevity = computeLongevitySubscore(ageDays);

  // Step 3: Type membership + blended weights
  const hasLaunchedToken = (launchedTokenStats?.tokenCount ?? 0) > 0;
  const typeMembership = computeTypeMembership(ageDays, hasLaunchedToken);
  const W = blendWeights(typeMembership);

  // Step 4: Compute Trust and Traction axes (each 0-100)
  // Trust axis: identity + longevity, plus a fraction of fairscale routed in
  const fairscaleToTrust = fairscale * W.fairscale_to_trust;
  const fairscaleToTraction = fairscale * (1 - W.fairscale_to_trust);
  const trustRaw =
    W.identity * identity + W.longevity * longevity + 0.1 * fairscaleToTrust;
  // Normalize: identity+longevity weights sum to 1, raw values 0-10 →
  // multiply by 10 to land 0-100. fairscale contribution is small,
  // bounded so it can't push past 100.
  const trust = Math.max(0, Math.min(100, trustRaw * 10));

  const tractionRaw =
    W.activity * activity +
    W.economic * economic +
    W.ecosystem * ecosystem +
    0.1 * fairscaleToTraction;
  const traction = Math.max(0, Math.min(100, tractionRaw * 10));

  // Step 5: Square-gated composite — this is THE v0.7 change.
  // A zero-trust agent gets zero traction credit. A half-trust agent
  // gets a quarter. Only an agent with substantial trust extracts most
  // of its traction.
  const trustGate = Math.pow(trust / 100, 2);
  let composite = W.wTrust * trust + W.wTraction * traction * trustGate;
  composite = Math.max(0, Math.min(100, composite));

  // Step 6: Apply structural ceiling.
  const ceiling = decideCeiling(agent, delivery);
  composite = Math.min(composite, ceiling.cap);
  const finalScore = Math.round(composite);

  const tier = tierFromScore(finalScore);

  return {
    score: finalScore,
    tier,
    trust: Math.round(trust * 10) / 10,
    traction: Math.round(traction * 10) / 10,
    trust_gate: Math.round(trustGate * 1000) / 1000,
    identity,
    activity,
    economic,
    ecosystem,
    longevity,
    fairscale,
    type: dominantType(typeMembership),
    type_membership: {
      new: Math.round(typeMembership.new * 1000) / 1000,
      launcher: Math.round(typeMembership.launcher * 1000) / 1000,
      service: Math.round(typeMembership.service * 1000) / 1000,
    },
    demonstrated_delivery: delivery,
    ceiling_applied: ceiling,
    badges: buildBadges(agent, dominantType(typeMembership), delivery, activityStats, launchedTokenStats),
    sources: buildSources({ fairscale }, anchorStats, activityStats, launchedTokenStats, x402ActivityStats),
    computedAt: new Date().toISOString(),
    methodology_version: METHODOLOGY_VERSION_V7,
  };
}

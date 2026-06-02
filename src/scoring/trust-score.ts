/**
 * Canonical SAID Trust Score implementation.
 *
 * This is the single source of truth for trust-score computation across
 * the codebase. It's used by:
 *   - `/api/agents/:wallet` live overlay in `src/index.ts`
 *   - The background score worker in `src/score-engine.ts`
 *   - The v0.7 reputation API surface (`src/reputation-engine-v7.ts` extends
 *     these same sub-signal computations)
 *
 * Historical note: prior to this consolidation there were two
 * implementations of "the trust score" — `computeTrustScore` (here) used
 * by the live overlay, and `computeSAIDScore` in score-engine.ts used by
 * the cached worker. The two diverged in inputs (live used cached
 * AgentActivityStats + LaunchedToken; cached re-fetched on-chain data
 * inline) and in formulas (live: uniform 0-10 per pillar, weighted
 * composite; cached: non-uniform pillar caps, straight sum capped at 70).
 * Net effect was the same agent producing different scores in the
 * directory vs the profile page. This module exists so that can't
 * happen again.
 */

export interface ActivityStatsInput {
  txCount: number;
  volumeSol: number;
  uniqueCounterparties: number;
  activeDays: number;
}

export interface LaunchedTokenStatsInput {
  tokenCount: number;
  totalMarketCapUsd: number;
  totalVolume24hUsd: number;
  topMarketCapUsd: number;
}

export interface AnchorStatsInput {
  anchorCount: number;
  totalReceipts: number;
}

export interface TrustScoreResult {
  score: number;
  tier: 'unranked' | 'bronze' | 'silver' | 'gold' | 'platinum';
  badges: string[];
  sources: string[];
  identity: number;
  activity: number;
  economic: number;
  ecosystem: number;
  longevity: number;
  fairscale: number;
  computedAt: string;
}

/**
 * Minimal agent shape the score function reads. Permissive on purpose —
 * we cast Prisma's full `Agent` model through this without complaint.
 */
export interface ScorableAgent {
  registeredAt: Date | string;
  isVerified?: boolean | null;
  layer2Verified?: boolean | null;
  name?: string | null;
  description?: string | null;
  twitter?: string | null;
  website?: string | null;
  image?: string | null;
  mcpEndpoint?: string | null;
  a2aEndpoint?: string | null;
  skills?: string[] | null;
  serviceTypes?: string[] | null;
  reputationScore?: number | null;
  feedbackCount?: number | null;
  activityCount?: number | null;
  lastActiveAt?: Date | string | null;
  _count?: { feedbackReceived?: number };
}

/**
 * Compute the SAID trust score.
 *
 * Pillar contracts:
 *   - identity (0-10): verification + L2 + profile completeness
 *   - activity (0-10): peer feedback + activityCount + recency
 *                    + 30-day on-chain activity + anchored receipts
 *   - economic (0-10): reputationScore + 30-day SOL volume
 *                    + launched-token performance
 *   - ecosystem (0-10): MCP/A2A endpoints + declared skills/serviceTypes
 *   - longevity (0-10): age bands (7d/14d/30d/60d/90d+)
 *   - fairscale (0-10): external API, fetched upstream and passed in
 *
 * Composite formula (max 100):
 *   economic*3 + activity*2 + identity + ecosystem + longevity + fairscale*2
 *
 * Tier cuts: platinum >=80, gold >=65, silver >=45, bronze >=25, else unranked.
 */
export function computeTrustScore(
  agent: ScorableAgent,
  anchorStats?: AnchorStatsInput,
  activityStats?: ActivityStatsInput,
  launchedTokenStats?: LaunchedTokenStatsInput,
  fairscaleSubscore?: number, // 0-10, externally fetched
): TrustScoreResult {
  const now = new Date();
  const registeredAt = new Date(agent.registeredAt);
  const ageDays = Math.floor((now.getTime() - registeredAt.getTime()) / (1000 * 60 * 60 * 24));

  // ── Identity (0-10): verification + profile completeness ──
  let identityScore = 0;
  if (agent.isVerified) identityScore += 4;
  if (agent.name) identityScore += 1;
  if (agent.description) identityScore += 1;
  if (agent.twitter) identityScore += 1;
  if (agent.website) identityScore += 1;
  if (agent.image) identityScore += 1;
  if (agent.layer2Verified) identityScore += 1;
  identityScore = Math.min(10, identityScore);

  // ── Activity (0-10): feedback + activity counters + 30d on-chain ──
  // tx count / active-day spread + anchored receipts. Logarithmic-ish
  // bands so a wallet that's been busy on-chain meaningfully outscores
  // a dormant one.
  const feedbackCount = agent._count?.feedbackReceived || agent.feedbackCount || 0;
  const activityCount = agent.activityCount || 0;
  const txCount30d = activityStats?.txCount ?? 0;
  const activeDays30d = activityStats?.activeDays ?? 0;
  const counterparties30d = activityStats?.uniqueCounterparties ?? 0;

  let activityScore = 0;
  if (feedbackCount >= 10) activityScore += 2;
  else if (feedbackCount >= 5) activityScore += 1;
  if (activityCount >= 50) activityScore += 1;
  else if (activityCount >= 5) activityScore += 0.5;
  if (agent.lastActiveAt) {
    const lastActive = new Date(agent.lastActiveAt);
    const daysSinceActive = Math.floor((now.getTime() - lastActive.getTime()) / (1000 * 60 * 60 * 24));
    if (daysSinceActive <= 7) activityScore += 1;
    else if (daysSinceActive <= 30) activityScore += 0.5;
  }
  // 30-day on-chain activity from wallet history (Alchemy ingest)
  if (txCount30d >= 1000) activityScore += 3;
  else if (txCount30d >= 200) activityScore += 2.5;
  else if (txCount30d >= 50) activityScore += 2;
  else if (txCount30d >= 10) activityScore += 1;
  if (activeDays30d >= 20) activityScore += 2;
  else if (activeDays30d >= 7) activityScore += 1;
  else if (activeDays30d >= 3) activityScore += 0.5;
  if (counterparties30d >= 100) activityScore += 1;
  else if (counterparties30d >= 20) activityScore += 0.5;
  // Receipts: cryptographically anchored activity counts
  const anchorCount = anchorStats?.anchorCount ?? 0;
  const totalReceipts = anchorStats?.totalReceipts ?? 0;
  if (totalReceipts >= 1000) activityScore += 2;
  else if (totalReceipts >= 100) activityScore += 1.5;
  else if (totalReceipts >= 25) activityScore += 1;
  else if (totalReceipts >= 5) activityScore += 0.5;
  if (anchorCount >= 5) activityScore += 0.5;
  activityScore = Math.min(10, activityScore);

  // ── Economic (0-10): reputation + on-chain volume + launched-token ──
  // performance. This is the heaviest weighted signal (×3) — actual money
  // moving via the agent matters more than any profile field.
  let economicScore = 0;
  const repScore = agent.reputationScore || 0;
  if (repScore >= 80) economicScore += 2;
  else if (repScore >= 60) economicScore += 1.5;
  else if (repScore >= 40) economicScore += 1;
  else if (repScore >= 20) economicScore += 0.5;
  if (agent.isVerified) economicScore += 1;

  // 30-day SOL volume through the wallet. Bands are roughly logarithmic
  // so an order-of-magnitude bigger wallet gets ~+1.
  const volumeSol30d = activityStats?.volumeSol ?? 0;
  if (volumeSol30d >= 100_000) economicScore += 4;
  else if (volumeSol30d >= 10_000) economicScore += 3;
  else if (volumeSol30d >= 1_000) economicScore += 2;
  else if (volumeSol30d >= 100) economicScore += 1;
  else if (volumeSol30d >= 10) economicScore += 0.5;

  // Tokens this agent launched. Sum of market caps (USD) across all their
  // launched tokens, plus a kicker for any single token doing real volume.
  const launchedMcUsd = launchedTokenStats?.totalMarketCapUsd ?? 0;
  const launched24hVolUsd = launchedTokenStats?.totalVolume24hUsd ?? 0;
  if (launchedMcUsd >= 10_000_000) economicScore += 3;
  else if (launchedMcUsd >= 1_000_000) economicScore += 2;
  else if (launchedMcUsd >= 100_000) economicScore += 1;
  else if (launchedMcUsd >= 10_000) economicScore += 0.5;
  if (launched24hVolUsd >= 1_000_000) economicScore += 1;
  else if (launched24hVolUsd >= 100_000) economicScore += 0.5;

  economicScore = Math.min(10, economicScore);

  // ── Ecosystem (0-10): endpoints + skills + service types ──
  let ecosystemScore = 0;
  if (agent.mcpEndpoint) ecosystemScore += 2;
  if (agent.a2aEndpoint) ecosystemScore += 2;
  if (agent.skills && agent.skills.length > 0) ecosystemScore += Math.min(3, agent.skills.length);
  if (agent.serviceTypes && agent.serviceTypes.length > 0)
    ecosystemScore += Math.min(3, agent.serviceTypes.length);
  ecosystemScore = Math.min(10, ecosystemScore);

  // ── Longevity (0-10): age of account ──
  let longevityScore = 0;
  if (ageDays >= 90) longevityScore = 10;
  else if (ageDays >= 60) longevityScore = 8;
  else if (ageDays >= 30) longevityScore = 6;
  else if (ageDays >= 14) longevityScore = 4;
  else if (ageDays >= 7) longevityScore = 2;
  else longevityScore = 1;

  // ── FairScale (0-10): external reputation source ──
  // Fetched upstream of computeTrustScore and passed in. Returns 0 if the
  // API isn't reachable or the wallet is unknown to FairScale.
  const fairscaleScore = Math.max(0, Math.min(10, fairscaleSubscore ?? 0));

  // ── Weighted aggregate ──
  // Split is 80% SAID-native components / 20% FairScale. Within SAID,
  // economic carries the most weight — what an agent actually did
  // on-chain matters more than its bio.
  const totalScore = Math.round(
    economicScore * 3 +
      activityScore * 2 +
      identityScore * 1 +
      ecosystemScore * 1 +
      longevityScore * 1 +
      fairscaleScore * 2,
  );

  let tier: TrustScoreResult['tier'] = 'unranked';
  if (totalScore >= 80) tier = 'platinum';
  else if (totalScore >= 65) tier = 'gold';
  else if (totalScore >= 45) tier = 'silver';
  else if (totalScore >= 25) tier = 'bronze';

  const badges: string[] = [];
  if (agent.isVerified) badges.push('verified');
  if (agent.layer2Verified) badges.push('l2_verified');
  if (repScore >= 80 && feedbackCount >= 10) badges.push('trusted');
  if (txCount30d >= 100 || activeDays30d >= 14) badges.push('active');
  if (feedbackCount === 0 && ageDays < 7) badges.push('new');
  if (launchedTokenStats && launchedTokenStats.tokenCount > 0) badges.push('token_launcher');
  if (volumeSol30d >= 10_000 || launchedMcUsd >= 1_000_000) badges.push('high_volume');

  const sources = ['said'];
  if (fairscaleScore > 0) sources.push('fairscale');
  if (anchorCount > 0) sources.push('receipts');
  if (txCount30d > 0) sources.push('onchain_activity');
  if (launchedTokenStats && launchedTokenStats.tokenCount > 0) sources.push('launched_tokens');

  return {
    score: Math.min(100, totalScore),
    tier,
    badges,
    sources,
    identity: identityScore,
    activity: activityScore,
    economic: economicScore,
    ecosystem: ecosystemScore,
    longevity: longevityScore,
    fairscale: fairscaleScore,
    computedAt: new Date().toISOString(),
  };
}

/**
 * Reputation API response shaping for external consumers (IDLE Protocol, etc.).
 *
 * The /api/agents/:wallet endpoint returns ~30 fields tailored to the SAID
 * profile UI. External consumers integrating SAID's reputation as a routing
 * signal only need a focused subset: tier + score + components + reason codes.
 *
 * This module:
 *   1. Projects the full agent record + computed trust score down to the
 *      IDLE-shaped response.
 *   2. Derives human-readable reason codes from the underlying signal state,
 *      so partners can explain ranking decisions to their own users.
 *
 * Supports v0.6.x (single-weighted-sum) and v0.7 (two-axis + square gate +
 * demonstrated delivery + structural ceilings) trust scores via a discriminator
 * on the methodology_version field of the input.
 *
 * Keep this file pure: no I/O, no DB calls. Inputs come from the existing
 * computeTrustScore() or computeTrustScoreV7() pipeline.
 */
import { METHODOLOGY_VERSION } from './reputation-methodology.js';
import type {
  V7ScoreResult,
  V7AgentType,
  V7DemonstratedDelivery,
  V7CeilingDecision,
} from './reputation-engine-v7.js';

// ─── Types ────────────────────────────────────────────────────────

/** Subset of the agent profile the shaping function reads. */
export interface AgentInput {
  wallet: string;
  name?: string | null;
  isVerified?: boolean;
  layer2Verified?: boolean;
  reputationScore?: number;
  feedbackCount?: number;
  activityCount?: number | null;
  lastActiveAt?: Date | string | null;
  registeredAt: Date | string;
  description?: string | null;
  twitter?: string | null;
  website?: string | null;
  image?: string | null;
  mcpEndpoint?: string | null;
  a2aEndpoint?: string | null;
  skills?: string[] | null;
  serviceTypes?: string[] | null;
  _count?: { feedbackReceived?: number };
}

export interface AnchorStatsInput {
  anchorCount: number;
  totalReceipts: number;
}

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

/** Output of the existing computeTrustScore function. */
export interface TrustScoreInput {
  score: number;
  tier: string;
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

/** External-consumer-shaped reputation response. */
export interface ReputationResponse {
  wallet: string;
  tier: 'unranked' | 'bronze' | 'silver' | 'gold' | 'platinum';
  score: number;
  /**
   * Two-axis decomposition — present when methodology_version >= v0.7.0.
   * Omitted on v0.6.x responses for backward compatibility.
   */
  axes?: {
    trust: number; // 0-100
    traction: number; // 0-100
    trust_gate: number; // (Trust/100)^2 — the gate value
  };
  components: {
    identity: number;
    activity: number;
    economic: number;
    ecosystem: number;
    longevity: number;
    fairscale_enrichment: number;
  };
  reason_codes: string[];
  badges: string[];
  /**
   * v0.7+ extra fields. Optional so v0.6 callers don't need to populate them.
   */
  type?: V7AgentType;
  type_membership?: { new: number; launcher: number; service: number };
  demonstrated_delivery?: V7DemonstratedDelivery;
  ceiling_applied?: V7CeilingDecision;
  data_completeness: 'full' | 'partial' | 'minimal';
  last_updated: string;
  methodology_version: string;
}

// ─── Reason Code Derivation ───────────────────────────────────────

/**
 * Derive human-readable reason codes that explain what drove the score.
 *
 * The order matters: codes are returned highest-impact-first so consumers
 * displaying only the top N codes still surface the most important reasons.
 *
 * All codes are documented in reputation-methodology.ts under
 * `reason_code_glossary`. Adding a new code here requires a glossary entry.
 */
export function deriveReasonCodes(
  agent: AgentInput,
  trustScore: TrustScoreInput,
  anchorStats?: AnchorStatsInput,
  activityStats?: ActivityStatsInput,
  launchedTokenStats?: LaunchedTokenStatsInput,
): string[] {
  const codes: string[] = [];
  const now = Date.now();
  const ageDays = Math.floor(
    (now - new Date(agent.registeredAt).getTime()) / (1000 * 60 * 60 * 24),
  );

  // ── Verification & identity ──
  if (agent.isVerified) codes.push('verified');
  else codes.push('unverified');
  if (agent.layer2Verified) codes.push('l2_verified');

  // ── Launched token signal (the highest-impact positive signal for launchers) ──
  if (launchedTokenStats && launchedTokenStats.tokenCount > 0) {
    if (launchedTokenStats.topMarketCapUsd >= 1_000_000) {
      codes.push('token_high_market_cap');
    } else if (launchedTokenStats.topMarketCapUsd >= 100_000) {
      codes.push('token_moderate_market_cap');
    } else {
      codes.push('token_launched');
    }
    if (launchedTokenStats.totalVolume24hUsd >= 100_000) {
      codes.push('token_sustained_volume');
    }
  } else if (ageDays >= 7) {
    // Old enough that absence of launches is itself a signal — for a service
    // agent this is neutral; for a Claw Pump-style agent this is notable.
    codes.push('no_launched_tokens');
  }

  // ── Peer feedback ──
  const feedbackCount = agent._count?.feedbackReceived ?? agent.feedbackCount ?? 0;
  if (feedbackCount >= 10) codes.push('peer_feedback_strong');
  else if (feedbackCount >= 3) codes.push('peer_feedback_some');
  else if (feedbackCount === 0) codes.push('no_peer_feedback');

  // ── On-chain activity ──
  const txCount30d = activityStats?.txCount ?? 0;
  if (txCount30d >= 200) codes.push('high_onchain_activity');
  else if (txCount30d >= 50) codes.push('moderate_onchain_activity');
  else if (txCount30d > 0) codes.push('low_onchain_activity');
  else codes.push('no_recent_onchain_activity');

  // ── Receipts (anchored interaction proofs) ──
  const totalReceipts = anchorStats?.totalReceipts ?? 0;
  if (totalReceipts >= 100) codes.push('receipts_anchored_strong');
  else if (totalReceipts >= 5) codes.push('receipts_anchored_some');
  else codes.push('no_receipts_anchored');

  // ── Wallet age ──
  if (ageDays >= 90) codes.push('established_90d_plus');
  else if (ageDays >= 30) codes.push('established_30d_plus');
  else if (ageDays >= 7) codes.push('wallet_age_under_30d');
  else codes.push('new_agent_under_7d');

  // ── Endpoints declared (signal of operational maturity) ──
  if (agent.mcpEndpoint || agent.a2aEndpoint) codes.push('endpoints_declared');

  return codes;
}

// ─── Data Completeness ────────────────────────────────────────────

/**
 * Tells the consumer how reliable the score is. Anchored on which optional
 * external signals (FairScale, anchor stats, activity stats) successfully
 * resolved. A "minimal" score should be treated with caution — it's mostly
 * identity + longevity.
 */
export function deriveDataCompleteness(
  trustScore: TrustScoreInput,
  anchorStats?: AnchorStatsInput,
  activityStats?: ActivityStatsInput,
  launchedTokenStats?: LaunchedTokenStatsInput,
): ReputationResponse['data_completeness'] {
  const externalSignals = [
    trustScore.fairscale > 0,
    !!anchorStats,
    !!activityStats,
    !!launchedTokenStats,
  ];
  const present = externalSignals.filter(Boolean).length;
  if (present >= 3) return 'full';
  if (present >= 1) return 'partial';
  return 'minimal';
}

// ─── Response Shaping ─────────────────────────────────────────────

/**
 * Project the full agent record + computed trust score down to the
 * IDLE-shaped response. Single entry point for external consumers.
 */
export function shapeReputationResponse(
  agent: AgentInput,
  trustScore: TrustScoreInput,
  anchorStats?: AnchorStatsInput,
  activityStats?: ActivityStatsInput,
  launchedTokenStats?: LaunchedTokenStatsInput,
): ReputationResponse {
  const tier = normalizeTier(trustScore.tier);
  const reasonCodes = deriveReasonCodes(
    agent,
    trustScore,
    anchorStats,
    activityStats,
    launchedTokenStats,
  );
  const completeness = deriveDataCompleteness(
    trustScore,
    anchorStats,
    activityStats,
    launchedTokenStats,
  );
  return {
    wallet: agent.wallet,
    tier,
    score: trustScore.score,
    components: {
      identity: trustScore.identity,
      activity: trustScore.activity,
      economic: trustScore.economic,
      ecosystem: trustScore.ecosystem,
      longevity: trustScore.longevity,
      fairscale_enrichment: trustScore.fairscale,
    },
    reason_codes: reasonCodes,
    badges: trustScore.badges,
    data_completeness: completeness,
    last_updated: trustScore.computedAt,
    methodology_version: METHODOLOGY_VERSION,
  };
}

function normalizeTier(t: string): ReputationResponse['tier'] {
  const allowed = ['unranked', 'bronze', 'silver', 'gold', 'platinum'] as const;
  return (allowed as readonly string[]).includes(t)
    ? (t as ReputationResponse['tier'])
    : 'unranked';
}

// ─── v0.7 Reason Code Derivation ──────────────────────────────────

/**
 * Derive reason codes from a v0.7 trust score result. Supersets the v0.6
 * codes with new entries for: type classification, demonstrated delivery,
 * structural ceilings, square-gate attenuation.
 *
 * Codes are returned highest-impact-first so consumers displaying only the
 * top N still surface the most important drivers.
 */
export function deriveReasonCodesV7(
  agent: AgentInput,
  trustScore: V7ScoreResult,
  anchorStats?: AnchorStatsInput,
  activityStats?: ActivityStatsInput,
  launchedTokenStats?: LaunchedTokenStatsInput,
): string[] {
  const codes: string[] = [];
  const now = Date.now();
  const ageDays = Math.floor(
    (now - new Date(agent.registeredAt).getTime()) / (1000 * 60 * 60 * 24),
  );

  // ── Structural ceiling (highest impact — this CAPS the score) ──
  if (trustScore.ceiling_applied.name === 'unverified_silver') {
    codes.push('ceiling_unverified_silver');
  } else if (trustScore.ceiling_applied.name === 'no_delivery_gold') {
    codes.push('ceiling_no_delivery_gold');
  }

  // ── Demonstrated delivery (highest positive single signal) ──
  if (trustScore.demonstrated_delivery.active) {
    if (trustScore.demonstrated_delivery.path === 'launcher_token') {
      if (trustScore.demonstrated_delivery.contribution >= 2) {
        codes.push('demonstrated_delivery_launcher_full');
      } else {
        codes.push('demonstrated_delivery_launcher_partial');
      }
    } else if (trustScore.demonstrated_delivery.path === 'paid_service') {
      codes.push('demonstrated_delivery_paid_service');
    }
  } else if (agent.isVerified && ageDays >= 14) {
    codes.push('no_demonstrated_delivery');
  }

  // ── Verification & identity ──
  if (agent.isVerified) codes.push('verified');
  else codes.push('unverified');
  if (agent.layer2Verified) codes.push('l2_verified');

  // ── Type classification ──
  codes.push(`type_${trustScore.type}`);

  // ── Square-gate attenuation (important for partner debugging) ──
  if (trustScore.trust < 30 && trustScore.traction > 50) {
    codes.push('traction_gated_by_low_trust');
  } else if (trustScore.trust < 50) {
    codes.push('trust_below_midpoint');
  }

  // ── Token signals (legacy compatible) ──
  if (launchedTokenStats && launchedTokenStats.tokenCount > 0) {
    if (launchedTokenStats.topMarketCapUsd >= 1_000_000) {
      codes.push('token_high_market_cap');
    } else if (launchedTokenStats.topMarketCapUsd >= 100_000) {
      codes.push('token_moderate_market_cap');
    } else {
      codes.push('token_launched');
    }
    if (launchedTokenStats.totalVolume24hUsd >= 100_000) {
      codes.push('token_sustained_volume');
    }
  } else if (ageDays >= 7) {
    codes.push('no_launched_tokens');
  }

  // ── Peer feedback ──
  const feedbackCount = agent._count?.feedbackReceived ?? agent.feedbackCount ?? 0;
  if (feedbackCount >= 10) codes.push('peer_feedback_strong');
  else if (feedbackCount >= 3) codes.push('peer_feedback_some');
  else if (feedbackCount === 0) codes.push('no_peer_feedback');

  // ── On-chain activity ──
  const txCount30d = activityStats?.txCount ?? 0;
  if (txCount30d >= 200) codes.push('high_onchain_activity');
  else if (txCount30d >= 50) codes.push('moderate_onchain_activity');
  else if (txCount30d > 0) codes.push('low_onchain_activity');
  else codes.push('no_recent_onchain_activity');

  // ── Receipts ──
  const totalReceipts = anchorStats?.totalReceipts ?? 0;
  if (totalReceipts >= 100) codes.push('receipts_anchored_strong');
  else if (totalReceipts >= 5) codes.push('receipts_anchored_some');
  else codes.push('no_receipts_anchored');

  // ── Wallet age ──
  if (ageDays >= 90) codes.push('established_90d_plus');
  else if (ageDays >= 30) codes.push('established_30d_plus');
  else if (ageDays >= 7) codes.push('wallet_age_under_30d');
  else codes.push('new_agent_under_7d');

  // ── Endpoints ──
  if (agent.mcpEndpoint || agent.a2aEndpoint) codes.push('endpoints_declared');

  return codes;
}

/**
 * v0.7 response shaping. Adds two-axis decomposition, type signals,
 * demonstrated-delivery, and ceiling state on top of the v0.6 shape.
 */
export function shapeReputationResponseV7(
  agent: AgentInput,
  trustScore: V7ScoreResult,
  anchorStats?: AnchorStatsInput,
  activityStats?: ActivityStatsInput,
  launchedTokenStats?: LaunchedTokenStatsInput,
): ReputationResponse {
  const tier = normalizeTier(trustScore.tier);
  const reason_codes = deriveReasonCodesV7(
    agent,
    trustScore,
    anchorStats,
    activityStats,
    launchedTokenStats,
  );
  const completeness = deriveDataCompleteness(
    { fairscale: trustScore.fairscale } as TrustScoreInput,
    anchorStats,
    activityStats,
    launchedTokenStats,
  );
  return {
    wallet: agent.wallet,
    tier,
    score: trustScore.score,
    axes: {
      trust: trustScore.trust,
      traction: trustScore.traction,
      trust_gate: trustScore.trust_gate,
    },
    components: {
      identity: trustScore.identity,
      activity: trustScore.activity,
      economic: trustScore.economic,
      ecosystem: trustScore.ecosystem,
      longevity: trustScore.longevity,
      fairscale_enrichment: trustScore.fairscale,
    },
    reason_codes,
    badges: trustScore.badges,
    type: trustScore.type,
    type_membership: trustScore.type_membership,
    demonstrated_delivery: trustScore.demonstrated_delivery,
    ceiling_applied: trustScore.ceiling_applied,
    data_completeness: completeness,
    last_updated: trustScore.computedAt,
    methodology_version: trustScore.methodology_version,
  };
}

/**
 * Minimal-information response for agents we don't have on file. Returned
 * with HTTP 200 so partners get a stable shape — they shouldn't have to
 * special-case 404s in their routing logic. Treats unknown agents as
 * unranked with zero score and an explicit reason code.
 */
export function shapeNotFoundReputationResponse(wallet: string): ReputationResponse {
  return {
    wallet,
    tier: 'unranked',
    score: 0,
    components: {
      identity: 0,
      activity: 0,
      economic: 0,
      ecosystem: 0,
      longevity: 0,
      fairscale_enrichment: 0,
    },
    reason_codes: ['agent_not_registered'],
    badges: [],
    data_completeness: 'minimal',
    last_updated: new Date().toISOString(),
    methodology_version: METHODOLOGY_VERSION,
  };
}

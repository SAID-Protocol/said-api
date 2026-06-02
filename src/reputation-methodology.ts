/**
 * SAID Reputation Methodology — published configuration.
 *
 * This is the source of truth for what /api/reputation/methodology returns.
 * Update the version field when meaningful changes ship (anything that would
 * cause a consumer's routing logic to behave differently against the same
 * underlying agent state).
 *
 * Honest framing in the description fields matters. External integrators
 * read this to defend their routing decisions to their own users.
 */

export const METHODOLOGY_VERSION = 'v0.7.0';

export interface TierDefinition {
  cut: number;
  meaning: string;
  suggested_routing: string;
}

export interface ComponentDefinition {
  weight: string;
  max_raw: number;
  measures: string;
  inputs: string[];
}

export interface AxisDefinition {
  range: string;
  measures: string;
  components: string[];
}

export interface ReputationMethodology {
  version: string;
  scale: string;
  scale_min: number;
  scale_max: number;
  composite_formula: string;
  axes: Record<string, AxisDefinition>;
  tiers: Record<string, TierDefinition>;
  structural_ceilings: Record<string, { cap: number; meaning: string }>;
  type_model: {
    overview: string;
    types: Record<string, { description: string; weight_bias: string }>;
  };
  demonstrated_delivery: {
    overview: string;
    paths: Record<string, { description: string; status: string }>;
  };
  components: Record<string, ComponentDefinition>;
  reason_code_glossary: Record<string, string>;
  data_completeness_levels: Record<string, string>;
  refresh: {
    cache_ttl_seconds: number;
    live_overlay: string;
  };
  honest_disclosures: string[];
  roadmap: string[];
}

export const REPUTATION_METHODOLOGY: ReputationMethodology = {
  version: METHODOLOGY_VERSION,
  scale: '0-100 composite score, sorted into five tiers. Decomposes into a Trust axis and a Traction axis with a square gate.',
  scale_min: 0,
  scale_max: 100,
  composite_formula:
    'SAID = wT·Trust + wX·Traction·(Trust/100)². The square gate means a zero-trust agent gets zero traction credit; a half-trust agent gets a quarter; an agent earns most of its traction only with substantial trust.',
  axes: {
    trust: {
      range: '0-100',
      measures:
        'How likely is this agent to harm a counterparty — rug, abandon, sybil, defraud. Built from identity, longevity, and a demonstrated-delivery bonus when the agent has launched a token sustaining real cap.',
      components: ['identity', 'longevity', 'fairscale_enrichment (partial)'],
    },
    traction: {
      range: '0-100',
      measures:
        "How much real market validation has this agent earned — adoption, paid usage, market cap, distribution. Built from on-chain activity, launched-token performance, and declared service infrastructure. Gated by Trust: an untrusted agent can't convert traction into composite score.",
      components: ['activity', 'economic', 'ecosystem', 'fairscale_enrichment (partial)'],
    },
  },
  tiers: {
    platinum: {
      cut: 80,
      meaning:
        'Highest-trust counterparty. Verified, demonstrating real on-chain economic activity (e.g., a launched token sustaining $1M+ cap), strong in both Trust and Traction.',
      suggested_routing:
        'Premium routes / fastest dispatch / highest payout tiers. Safe default counterparty for high-value or irreversible-action work.',
    },
    gold: {
      cut: 65,
      meaning:
        'High-trust agent. Verified with strong activity or token traction. Minor gaps in one axis. Unverified or agents without demonstrated delivery cannot reach Gold (see structural ceilings).',
      suggested_routing:
        'Priority queue, preferential routing. Suitable for moderate-to-high-value work.',
    },
    silver: {
      cut: 45,
      meaning:
        'Established agent with moderate signal. May be a verified service agent without a token launch, or a launcher with limited traction. Unverified agents cap here.',
      suggested_routing:
        'Standard routing. Suitable for routine work; check data_completeness and ceiling_applied before high-value routing.',
    },
    bronze: {
      cut: 25,
      meaning:
        'Minimal validation, or capped due to specific signal (recent slash, very new account, no demonstrated activity).',
      suggested_routing:
        'Standard routing with caution. Avoid for irreversible-action work; suitable for low-stakes tasks.',
    },
    unranked: {
      cut: 0,
      meaning:
        'Insufficient evidence — typically unverified, registered <14 days ago, or unknown to SAID.',
      suggested_routing:
        'No preferential treatment. Treat as unknown counterparty; require additional out-of-band verification for sensitive work.',
    },
  },
  structural_ceilings: {
    unverified_silver: {
      cap: 64,
      meaning:
        'Unverified agents (have not paid the 0.01 SOL on-chain verification fee) are capped at the top of the Silver tier (composite ≤ 64) regardless of other signals. The 0.01 SOL fee is the smallest scarce-resource commitment required to demonstrate skin in the game.',
    },
    no_delivery_gold: {
      cap: 79,
      meaning:
        'Verified agents that have not demonstrated real delivery (no graduated/sustained launched token, no equivalent service-side proof) are capped at the Gold tier. Demonstrated delivery is the Platinum eligibility gate in v0.7. Future iterations will add stake-based Platinum gating.',
    },
  },
  type_model: {
    overview:
      'Agents are classified continuously into three types — new, launcher, service — based on registration age and whether they have launched any token. Membership is a soft probability so there are no overnight cliffs at day 14 or first-mint. Weights for each axis are a blended average across type memberships.',
    types: {
      new: {
        description: 'Registered <14 days ago. μ_new = clamp((14 - ageDays)/14, 0, 1).',
        weight_bias: 'Trust-heavy (0.80 / 0.20), identity-led. Limited traction signal available.',
      },
      launcher: {
        description: 'Has launched at least one token. μ_launcher = hasToken · (1 - μ_new).',
        weight_bias: 'Trust 0.55 / Traction 0.45. Token performance dominates Traction.',
      },
      service: {
        description: 'No launched token, established (>14 days). μ_service = 1 - μ_new - μ_launcher.',
        weight_bias: 'Trust 0.60 / Traction 0.40. Activity-heavy on the Traction side.',
      },
    },
  },
  demonstrated_delivery: {
    overview:
      'A Trust-axis sub-signal that adds up to +2.0 to the Identity component when an agent has produced a hard-to-forge proof of real delivery. Multi-path so launcher and service agents are both first-class.',
    paths: {
      launcher_token: {
        description:
          'Launched a token currently sustaining $1M+ market cap (+2.0 Identity) or $250K-$1M ($1.0 Identity). Proxy for graduation + retention guard until dexId and ATH ingestion are wired up.',
        status: 'live in v0.7',
      },
      paid_service: {
        description:
          'External x402 USDC revenue from ≥50 distinct payers over ≥30d, payer set passing funding-cluster check. Service-agent equivalent of token graduation.',
        status: 'planned for v0.7.x — requires x402 payment indexing',
      },
      free_service: {
        description:
          'Anchored interaction receipts from ≥50 distinct external counterparties over ≥30d. Free-service-agent equivalent of paid demand.',
        status: 'planned for v0.7.x — requires receipt index build-out',
      },
      validated_work: {
        description:
          'ValidationRecord PDA entries with passed=true from external validators (ERC-8004 Validation Registry pattern).',
        status: 'infrastructure exists on-chain; awaiting external validator integration',
      },
    },
  },
  components: {
    identity: {
      weight: 'Trust basket — 0.65 launcher / 0.55 service / 0.75 new',
      max_raw: 10,
      measures:
        'Verification status, profile completeness, L2 attestation, demonstrated-delivery bonus. The most-load-bearing single component for Trust.',
      inputs: [
        'isVerified (paid 0.01 SOL verification fee)',
        'layer2Verified (L2 endpoint attestation)',
        'name, description, twitter, website, image (profile completeness)',
        'demonstrated_delivery contribution (+0 to +2)',
      ],
    },
    activity: {
      weight: 'Traction basket — 0.30 launcher / 0.60 service / 0.55 new',
      max_raw: 10,
      measures:
        '30-day on-chain activity from wallet history, anchored receipt counts, peer feedback volume, and recency. Heaviest component for service agents.',
      inputs: [
        'feedbackReceived (peer feedback count)',
        'activityCount (lifetime activity counter)',
        'txCount30d (30-day transaction count via Alchemy ingest)',
        'activeDays30d (unique active days in last 30)',
        'uniqueCounterparties30d (distinct interaction partners)',
        'anchorCount + totalReceipts (cryptographically anchored receipts)',
      ],
    },
    economic: {
      weight: 'Traction basket — 0.55 launcher / 0.20 service / 0.25 new',
      max_raw: 10,
      measures:
        'Reputation score (Bayesian-shrunk from peer feedback), 30-day SOL volume, and performance of any tokens the agent launched. Dominant component for launchers.',
      inputs: [
        'reputationScore (Bayesian-prior peer-feedback aggregate)',
        'isVerified (small additive)',
        'volumeSol30d (30-day SOL volume through wallet)',
        'launchedTokenMarketCapUsd (sum across launched tokens)',
        'launched24hVolumeUsd (sustained trading volume)',
      ],
    },
    ecosystem: {
      weight: 'Traction basket — 0.15 launcher / 0.20 service / 0.20 new',
      max_raw: 10,
      measures:
        'Declared service endpoints (MCP, A2A) and declared skills/service types. Reflects integration maturity.',
      inputs: [
        'mcpEndpoint',
        'a2aEndpoint',
        'skills',
        'serviceTypes',
      ],
    },
    longevity: {
      weight: 'Trust basket — 0.35 launcher / 0.45 service / 0.25 new',
      max_raw: 10,
      measures:
        'Time since registration. Discrete bands at 7d, 14d, 30d, 60d, 90d+. No decay — provenance is a fact, not a behavior.',
      inputs: ['registeredAt (wallet registration timestamp)'],
    },
    fairscale_enrichment: {
      weight: 'Split across Trust and Traction',
      max_raw: 10,
      measures:
        'External reputation signal from FairScale, normalized into the 0-10 band. Returns 0 if FairScale is unreachable. Provides a second independent attestation source.',
      inputs: ['fairscale.score / fairscale.max (external API)'],
    },
  },
  reason_code_glossary: {
    // Structural ceilings (highest impact)
    ceiling_unverified_silver:
      'Agent has not paid the 0.01 SOL verification fee. Composite capped at Silver (44) regardless of other signals.',
    ceiling_no_delivery_gold:
      'Agent is verified but has no demonstrated delivery (no graduated/sustained launched token, no equivalent service-side proof). Composite capped at Gold (79). Will lift when demonstrated_delivery activates.',

    // Demonstrated delivery
    demonstrated_delivery_launcher_full:
      'Agent has launched a token currently sustaining $1M+ market cap. Adds +2.0 to Identity. Strongest single positive signal in v0.7.',
    demonstrated_delivery_launcher_partial:
      'Agent has launched a token currently in the $250K-$1M range. Adds +1.0 to Identity (partial credit).',
    demonstrated_delivery_paid_service:
      'Agent has demonstrable external paid demand (≥50 distinct x402 payers over 30d). Adds +2.0 to Identity. (v0.7.x — not active yet.)',
    no_demonstrated_delivery:
      'Verified agent ≥14 days old with no demonstrated delivery yet. Caps composite at Gold.',

    // Square-gate attenuation
    traction_gated_by_low_trust:
      'Agent has meaningful traction (>50) but low trust (<30). The square gate is suppressing most of the traction contribution to the composite. Common for unverified launchers with no track record.',
    trust_below_midpoint:
      'Trust axis is below 50, meaning the square gate is attenuating Traction by more than 75%. Composite is dominated by Trust.',

    // Type classification
    type_launcher: 'Classified as a token-launching agent (μ_launcher ≥ 0.5).',
    type_service: 'Classified as a service-provider agent (μ_service ≥ 0.5).',
    type_new: 'Classified as a new agent (registered <14 days ago, μ_new ≥ 0.5).',
    type_mixed: 'Mixed type membership — no single classification dominates.',

    // Verification
    verified: 'Agent has paid the 0.01 SOL verification fee on-chain.',
    unverified: 'Agent has not paid the 0.01 SOL verification fee.',
    l2_verified: 'Agent has a successful L2 endpoint attestation.',
    agent_not_registered:
      'Wallet is not registered as a SAID agent — treat as unknown counterparty.',

    // Launched-token signals
    token_high_market_cap: 'At least one launched token sustains $1M+ market cap.',
    token_moderate_market_cap: 'At least one launched token in $100K-$1M range.',
    token_launched: 'Agent launched a token; current market cap below $100K.',
    token_sustained_volume: 'Aggregate 24h volume across launched tokens exceeds $100K.',
    no_launched_tokens: 'Agent ≥7 days old and has not launched any detectable tokens.',

    // Peer feedback
    peer_feedback_strong: 'Agent has received 10+ peer feedback attestations.',
    peer_feedback_some: 'Agent has received 3-9 peer feedback attestations.',
    no_peer_feedback: 'Agent has received no peer feedback yet.',

    // On-chain activity
    high_onchain_activity: '200+ transactions in the last 30 days.',
    moderate_onchain_activity: '50-199 transactions in the last 30 days.',
    low_onchain_activity: '1-49 transactions in the last 30 days.',
    no_recent_onchain_activity: 'No on-chain transactions in the last 30 days.',

    // Receipts
    receipts_anchored_strong: '100+ anchored interaction receipts on-chain.',
    receipts_anchored_some: '5-99 anchored interaction receipts.',
    no_receipts_anchored:
      'No anchored receipts. Anchoring is opt-in with low current adoption.',

    // Wallet age
    established_90d_plus: 'Agent registered 90+ days ago.',
    established_30d_plus: 'Agent registered 30-89 days ago.',
    wallet_age_under_30d: 'Agent registered 7-29 days ago.',
    new_agent_under_7d: 'Agent registered <7 days ago.',

    // Endpoints
    endpoints_declared: 'Agent declares at least one operational endpoint (MCP or A2A).',
  },
  data_completeness_levels: {
    full: 'All external signals (FairScale + anchor stats + activity stats + launched-token data) resolved successfully.',
    partial:
      'Some external signals available but not all. Score is reliable but may underweight signals that failed to resolve.',
    minimal:
      'Score is built from on-chain registry data only (identity + longevity). External enrichment unavailable. Treat with caution for high-value routing.',
  },
  refresh: {
    cache_ttl_seconds: 60,
    live_overlay:
      'Single-agent reputation queries compute a live overlay using fresh anchored receipts, 30-day wallet activity, launched-token performance, and a live FairScale fetch (3s timeout). Responses are then cached for 60s. The directory and leaderboard use a separate background-refreshed score with 6h TTL.',
  },
  honest_disclosures: [
    'v0.7 implements the two-axis Trust+Traction split with the square gate, structural ceilings (unverified→Silver, no-delivery→Gold), continuous-membership type model, and a constrained demonstrated-delivery sub-signal. The model is intentionally more discriminating than v0.6.x.',
    'The current corpus has very sparse adoption of the protocol\'s reputation primitives — most agents have 0 peer feedback records and 0 anchored receipts. The score therefore discriminates primarily on identity, registration age, demonstrated-delivery, and (for launchers) launched-token performance via Dexscreener.',
    'Demonstrated-delivery in v0.7.0 uses current marketCap ≥ $1M as a proxy for the full graduation+retention guard. Token retention (sustained_cap / ATH) and graduation status (dexId) will be wired up in v0.7.x, at which point the proxy is replaced with the real signal.',
    'Stake-based Platinum gating (verified + sustained stake → Platinum eligible) is on the roadmap but not in v0.7.0 because stake state isn\'t mirrored in the database and RPC-fetching it in the hot path is a separate change. Until then, demonstrated-delivery is the Platinum eligibility gate.',
    'Liveness sub-signal (proof-of-life ping response rate) is planned for v0.7.x and not contributing to scores yet.',
    'Funding-cluster collapse with sponsor allowlist is v0.7.x — current feedback weighting does not have sybil-ring detection beyond what\'s built into the Bayesian shrinkage. Risk is low today because feedback volume is sparse; will become load-bearing when the reputation graph densifies.',
    'FairScale enrichment is fetched live per-query with a 3s timeout. If FairScale is unreachable, the score still resolves but with 20% of the maximum weight unavailable — reflected in data_completeness=partial.',
    'SAID does not currently originate reputation attestations on behalf of agents; the validate_work on-chain instruction exists but is unused. This will change in future versions and will be disclosed here when it does.',
    'Reason codes are designed to be human-readable explanations of what drove a score, not exhaustive lists of every input. A consumer displaying the top 3-4 codes will surface the highest-impact drivers.',
  ],
  roadmap: [
    'v0.7.x: Wire dexId (graduation) and ATH (retention) into demonstrated-delivery path (a), replacing the current "$1M cap" proxy.',
    'v0.7.x: Path (b) — paid_service delivery via x402 USDC payer indexing. Service agents become first-class for Platinum eligibility.',
    'v0.7.x: Stake state mirroring (DB-side or live RPC overlay) so Platinum gating can split verified-only from verified+staked.',
    'v0.7.x: Liveness sub-signal — proof-of-life pings populated by the butler-container Stage-1 pinger pool.',
    'v0.7.x: Funding-cluster collapse with sponsor allowlist (SAID treasury and Claw Pump sponsor exempt) — sybil-resistance for feedback aggregation.',
    'v0.8: Validation Registry consumption — when agents start using the validate_work on-chain instruction, those records feed the score directly.',
  ],
};

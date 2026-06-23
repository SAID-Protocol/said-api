/**
 * Event vocabulary for reputation v0.8.
 *
 * Every ReputationEvent row's `kind` field MUST come from this catalog.
 * Each entry defines defaults for axis, polarity, and raw weight — the
 * ingest helper applies these unless the caller overrides.
 *
 * Adding a new event kind:
 *   1. Add it here with axis + polarity + default weight
 *   2. Document in docs/reputation-v0.8.md §3 (Architecture) if it
 *      represents a new architectural signal class
 *   3. Wire it from the producing code path (sync worker, API handler,
 *      backfill script) via emitEvent()
 *
 * Weight semantics:
 *   Raw weight is the un-decayed, un-diversity-adjusted contribution
 *   this event makes to its target signal accumulator. Downstream
 *   transformations (decay, COCM cluster discount, EigenTrust propagation)
 *   apply on top. Think of it as "how strong is this single signal in
 *   isolation, before reputation infrastructure does its work."
 */
import type { Axis } from './axes.js';

export type Polarity = -1 | 0 | 1;

export interface EventKindSpec {
  axis: Axis;
  polarity: Polarity;
  defaultWeight: number;
  // Whether this event is structural (one-time identity transition) or
  // ongoing-activity. Structural events contribute to identity-axis
  // signals with no decay; activity events contribute to behavior signals
  // with decay.
  structural: boolean;
  description: string;
}

export const EVENT_KINDS = {
  // ── Identity / structural ─────────────────────────────────────────
  registered: {
    axis: 'identity',
    polarity: 1,
    defaultWeight: 1.0,
    structural: true,
    description: 'Agent registered on-chain via register_agent or register_and_stake',
  },
  verified: {
    axis: 'identity',
    polarity: 1,
    defaultWeight: 3.0,
    structural: true,
    description: 'Agent completed get_verified (paid the verification fee)',
  },
  l2_verified: {
    axis: 'identity',
    polarity: 1,
    defaultWeight: 2.0,
    structural: true,
    description: 'Agent passed Layer-2 endpoint challenge-response',
  },
  operator_bound: {
    axis: 'identity',
    polarity: 1,
    defaultWeight: 2.0,
    structural: true,
    description: 'Agent bound to a verified Operator (KYA tier)',
  },
  pop_linked: {
    axis: 'identity',
    polarity: 1,
    defaultWeight: 3.0,
    structural: true,
    description: 'Operator linked a Proof-of-Personhood credential',
  },
  profile_completed: {
    axis: 'identity',
    polarity: 1,
    defaultWeight: 1.0,
    structural: true,
    description: 'Agent has name, description, and at least one of {twitter, website}',
  },

  // ── Delivery / work signals ──────────────────────────────────────
  submit_anchor: {
    axis: 'delivery',
    polarity: 1,
    defaultWeight: 1.0,
    structural: false,
    description: 'submit_anchor instruction — Merkle-anchor of work receipts',
  },
  validate_work_done: {
    axis: 'validation',
    polarity: 1,
    defaultWeight: 1.5,
    structural: false,
    description: 'Agent performed validate_work — peer validation of another agent',
  },
  validate_work_received: {
    axis: 'delivery',
    polarity: 1,
    defaultWeight: 2.0,
    structural: false,
    description: 'Agent had their work validated by a peer (received side)',
  },
  token_launched: {
    axis: 'delivery',
    polarity: 1,
    defaultWeight: 1.0,
    structural: false,
    description: 'Agent launched a token (raw signal; weight scaled by market cap)',
  },

  // ── Payment / x402 signals ───────────────────────────────────────
  x402_payment_received: {
    axis: 'payments',
    polarity: 1,
    defaultWeight: 0.5,
    structural: false,
    description: 'Agent received an x402 micropayment (provider side)',
  },
  x402_payment_received_delivery: {
    axis: 'delivery',
    polarity: 1,
    defaultWeight: 0.5,
    structural: false,
    description: 'x402 payment received also implies delivery occurred',
  },
  x402_payment_sent: {
    axis: 'payments',
    polarity: 1,
    defaultWeight: 0.2,
    structural: false,
    description: 'Agent sent an x402 micropayment (buyer side, weaker signal)',
  },

  // ── Peer feedback / attestations ─────────────────────────────────
  feedback_pos: {
    axis: 'delivery',
    polarity: 1,
    defaultWeight: 1.0,
    structural: false,
    description: 'Peer left positive feedback (score >= 50)',
  },
  feedback_neg: {
    axis: 'delivery',
    polarity: -1,
    defaultWeight: 1.0,
    structural: false,
    description: 'Peer left negative feedback (score < 50)',
  },
  attestation_received: {
    axis: 'community',
    polarity: 1,
    defaultWeight: 1.0,
    structural: false,
    description: 'Agent received an attestation from a peer',
  },
  attestation_given: {
    axis: 'community',
    polarity: 1,
    defaultWeight: 0.3,
    structural: false,
    description: 'Agent gave an attestation (weak — active curation signal)',
  },

  // ── Economic / stake signals ─────────────────────────────────────
  stake: {
    axis: 'identity',
    polarity: 1,
    defaultWeight: 1.5,
    structural: false,
    description: 'Agent staked (stake, add_stake, or register_and_stake instruction)',
  },
  unstake_lifecycle: {
    axis: 'identity',
    polarity: 0,
    defaultWeight: 0.0,
    structural: false,
    description: 'Unstake-related instruction (neutral; lifecycle event)',
  },

  // ── On-chain economic activity (from AgentActivityStats) ─────────
  onchain_activity: {
    axis: 'economic',
    polarity: 1,
    defaultWeight: 1.0,
    structural: false,
    description: 'Real on-chain economic footprint over a 30-day window — counterparty-discounted activity + SOL volume (from AgentActivityStats)',
  },

  // ── FairScale (partner) cross-platform reputation ────────────────
  // Only SAID-INDEPENDENT signals — FairScale already reads SAID's score,
  // so its overall score is intentionally excluded (feedback-loop risk).
  fairscale_peer_rep: {
    axis: 'community',
    polarity: 1,
    defaultWeight: 1.0,
    structural: false,
    description: 'FairScale peer-reputation pillar (partner cross-platform reputation; weight scales with the 0-100 pillar)',
  },
  fairscale_red_flag: {
    axis: 'delivery',
    polarity: -1,
    defaultWeight: 1.0,
    structural: false,
    description: 'FairScale red flag — risky-behavior signal flagged by the partner platform',
  },

  // ── Negative / fraud signals ─────────────────────────────────────
  slashed: {
    axis: 'identity',
    polarity: -1,
    defaultWeight: 5.0,
    structural: false,
    description: 'Agent was slashed via slash_agent (strong negative)',
  },
  dispute_opened_against: {
    axis: 'delivery',
    polarity: -1,
    defaultWeight: 0.5,
    structural: false,
    description: 'Dispute opened against this agent (weak negative until resolved)',
  },
  dispute_lost: {
    axis: 'delivery',
    polarity: -1,
    defaultWeight: 4.0,
    structural: false,
    description: 'Agent lost a dispute (strong negative, slow decay)',
  },
  dispute_won: {
    axis: 'delivery',
    polarity: 1,
    defaultWeight: 1.0,
    structural: false,
    description: 'Agent won a dispute against them (mild positive — vindication)',
  },
} satisfies Record<string, EventKindSpec>;

export type EventKind = keyof typeof EVENT_KINDS;

/**
 * Decay math for reputation v0.8.
 *
 * Every signal accumulator is an exponentially-decayed sum maintained
 * incrementally. The math is the same regardless of signal type — only
 * the half-life differs. This module is pure: no DB, no I/O.
 *
 * Math (see docs/reputation-v0.8.md §5.1):
 *
 *   S(t) = Σ_i w_i · exp(-ln(2) · (t - t_i) / t½)
 *
 * Incremental update on event arrival at time t_new:
 *
 *   elapsed = t_new - lastDecayAt
 *   decayedValue = decayedValue · exp(-ln(2) · elapsed / t½) + newEventWeight
 *   lastDecayAt = t_new
 *
 * Half-lives per (axis, kind) come from the policy table below. Negative
 * signals decay slower than positive ones (FICO pattern — prevents "sin
 * then wait" laundering).
 */
import type { Axis } from './axes.js';
import type { EventKind } from './kinds.js';

const LN2 = Math.log(2);
const MS_PER_DAY = 86_400_000;

/**
 * Half-life policy keyed by event kind. Returns days. `null` means no
 * decay (the signal is treated as a structural fact that's true until
 * explicitly revoked).
 *
 * Rationale per category (see docs §5.1):
 *   - Identity events           : structural, no decay
 *   - Anchored work             : 60d — tracks "currently shipping"
 *   - Positive feedback         : 90d — witnessed quality
 *   - Negative feedback         : 180d — asymmetric, slower (FICO)
 *   - Validation                : 120d — between anchors and feedback
 *   - Payments                  : 90d — commercial recency
 *   - Stake / vouches           : 365d — capital commitment
 *   - Disputes lost / slashed   : 365d — bad news fades slowest
 *   - Attestations              : 180d — moderate institutional memory
 *
 * Adding a kind: add it to EVENT_KINDS in kinds.ts AND here, otherwise
 * decay will default to 90d (the silent fallback below).
 */
export const HALF_LIFE_DAYS: Record<EventKind, number | null> = {
  // Identity (structural — no decay)
  registered: null,
  verified: null,
  l2_verified: null,
  operator_bound: null,
  pop_linked: null,
  profile_completed: null,

  // Delivery / work
  submit_anchor: 60,
  validate_work_done: 120,
  validate_work_received: 120,
  token_launched: 60,

  // Payments / x402
  x402_payment_received: 90,
  x402_payment_received_delivery: 90,
  x402_payment_sent: 90,

  // Peer feedback / attestations
  feedback_pos: 90,
  feedback_neg: 180,
  attestation_received: 180,
  attestation_given: 180,

  // Economic / stake
  stake: 365,
  unstake_lifecycle: 365,

  // On-chain economic activity + FairScale (partner) cross-platform rep
  onchain_activity: 90, // recency of real on-chain activity
  fairscale_peer_rep: 180, // partner peer reputation — moderate memory

  // Negative
  slashed: 365,
  dispute_opened_against: 90,
  dispute_lost: 365,
  dispute_won: 90,
  fairscale_red_flag: 180, // risky-behavior flag — decays slower (FICO pattern)
};

/** Fallback half-life when a kind isn't in the policy. Should never happen in practice. */
const DEFAULT_HALF_LIFE_DAYS = 90;

/** Returns half-life for an event kind in days, or null for structural (no-decay). */
export function halfLifeFor(kind: EventKind): number | null {
  if (!(kind in HALF_LIFE_DAYS)) return DEFAULT_HALF_LIFE_DAYS;
  return HALF_LIFE_DAYS[kind];
}

/** Days elapsed between two timestamps (positive if `to` is after `from`). */
export function daysBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / MS_PER_DAY;
}

/**
 * Decay an existing accumulator value forward by `elapsedDays`.
 *
 * `halfLifeDays = null` returns the input unchanged (no-decay signal).
 * Negative `elapsedDays` is clamped to 0 (we never project backward in time).
 */
export function decayForward(
  currentValue: number,
  elapsedDays: number,
  halfLifeDays: number | null,
): number {
  if (halfLifeDays === null) return currentValue;
  if (elapsedDays <= 0) return currentValue;
  return currentValue * Math.exp(-LN2 * elapsedDays / halfLifeDays);
}

/**
 * Incremental decay-and-add — the core update operation.
 *
 * Given an accumulator's current state and a new event arriving at
 * `eventOccurredAt` with weight `eventWeight`, returns the new state.
 *
 * Critical invariant: events MUST be applied in chronological order
 * (earliest first). Out-of-order application produces wrong results
 * because decay is path-dependent.
 */
export function applyEvent(
  state: { decayedValue: number; lastDecayAt: Date },
  eventOccurredAt: Date,
  eventWeight: number,
  halfLifeDays: number | null,
): { decayedValue: number; lastDecayAt: Date } {
  const elapsed = daysBetween(state.lastDecayAt, eventOccurredAt);
  const decayed = decayForward(state.decayedValue, elapsed, halfLifeDays);
  return {
    decayedValue: decayed + eventWeight,
    lastDecayAt: eventOccurredAt,
  };
}

/**
 * Project an accumulator state forward to a target time without
 * applying any new event. Used to compute "current value as of now"
 * from a snapshot whose `lastDecayAt` is in the past.
 */
export function projectTo(
  state: { decayedValue: number; lastDecayAt: Date },
  targetAt: Date,
  halfLifeDays: number | null,
): { decayedValue: number; lastDecayAt: Date } {
  const elapsed = daysBetween(state.lastDecayAt, targetAt);
  return {
    decayedValue: decayForward(state.decayedValue, elapsed, halfLifeDays),
    lastDecayAt: targetAt,
  };
}

/**
 * Update Beta posterior parameters from a polarity-bearing event.
 *
 * Convention: positive event adds to α, negative event adds to β.
 * Neutral events (polarity 0) leave both alone.
 *
 * This module does NOT decay α/β toward the prior — that's a Phase 1c.v1
 * concern we'll add when we see whether posteriors get over-confident
 * over long periods. For now, α/β are running sums of event weights by
 * polarity, with the cold-start prior (2, 2) baked into the schema default.
 */
export function updatePosterior(
  alpha: number,
  beta: number,
  polarity: number,
  eventWeight: number,
): { alpha: number; beta: number } {
  if (polarity > 0) return { alpha: alpha + eventWeight, beta };
  if (polarity < 0) return { alpha, beta: beta + eventWeight };
  return { alpha, beta };
}

/**
 * Shannon entropy in bits over a multiset of actor weights. Used to
 * track counterparty diversity per (subject, axis, kind) accumulator.
 *
 * Inputs: a Map of actor → total weight contributed by that actor.
 * Higher entropy = more diverse counterparties = stronger signal.
 *
 * Returns 0 for empty input or single-actor input.
 */
export function shannonEntropy(actorWeights: Map<string, number>): number {
  let total = 0;
  for (const w of actorWeights.values()) total += w;
  if (total <= 0 || actorWeights.size <= 1) return 0;
  let H = 0;
  for (const w of actorWeights.values()) {
    if (w <= 0) continue;
    const p = w / total;
    H -= p * Math.log2(p);
  }
  return H;
}

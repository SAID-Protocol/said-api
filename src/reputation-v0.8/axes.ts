/**
 * Reputation axes for v0.8.
 *
 * Reputation is vectored, not scalar. Every event contributes to exactly
 * one axis (an event with multi-axis effects produces multiple
 * ReputationEvent rows). Downstream consumers query specific axes;
 * the composite combines them with consumer-supplied weights.
 *
 * Adding an axis:
 *   - Bump this enum
 *   - Add a default composite weight in src/reputation-v0.8/composite.ts
 *     (when that file is created in Phase 2)
 *   - Document the axis's meaning in docs/reputation-v0.8.md §3
 */

export const AXES = [
  'identity',    // who they are: verification, profile, KYA, age
  'delivery',    // did they deliver work: anchors, paid_service, peer feedback
  'payments',    // payment reliability: x402 sent + received, settlement track record
  'validation',  // quality of their work-validation of others: validate_work accuracy
  'community',   // ecosystem participation: attestations given/received, vouches
] as const;

export type Axis = (typeof AXES)[number];

export function isAxis(s: string): s is Axis {
  return (AXES as readonly string[]).includes(s);
}

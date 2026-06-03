/**
 * Reputation v0.8 event ingest.
 *
 * Every reputation-relevant action — on-chain instructions, peer feedback,
 * x402 payments, dispute resolutions — funnels through emitEvent(), which
 * writes a row into ReputationEvent.
 *
 * Design constraints:
 *   - Idempotent: caller supplies a sourceKey; duplicates are silently
 *     skipped (no exception). Re-running backfill is safe.
 *   - Typed: kind must be in EVENT_KINDS; axis must be in AXES.
 *   - Atomic: a single emitEvent call writes one row. Multi-axis events
 *     (e.g., an x402 payment that affects both 'payments' and 'delivery')
 *     are emitted as two separate calls with distinct sourceKeys.
 *
 * What this does NOT do (yet):
 *   - Update ReputationSignal accumulators (Phase 1c)
 *   - Update TrustEdge weights (Phase 3a)
 *   - Update ReputationPosterior (Phase 2a)
 *
 * Those layers will be wired downstream and will read from
 * ReputationEvent as the authoritative event source.
 */
import type { PrismaClient } from '@prisma/client';
import { EVENT_KINDS, type EventKind, type Polarity } from './kinds.js';
import type { Axis } from './axes.js';

export interface EmitEventInput {
  /** Stable identifier of the source — e.g. "fb:<feedback_id>", "x402:provider:<wallet>". */
  sourceKey: string;
  subjectWallet: string;
  actorWallet?: string | null;
  kind: EventKind;
  /** Optional override of the kind's default axis (rare — usually leave undefined). */
  axis?: Axis;
  /** Optional override of polarity. */
  polarity?: Polarity;
  /** Optional override of raw weight (e.g., scale by token market cap or x402 tx count). */
  weight?: number;
  occurredAt: Date;
  txHash?: string | null;
  attestationId?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface EmitResult {
  emitted: boolean;        // true if we wrote a new row, false if sourceKey was already present
  eventId: string | null;  // id of the new (or existing) row, null on dry-run
}

/**
 * Write a single reputation event. Idempotent on `sourceKey`.
 *
 * If a row with the same sourceKey already exists, this is a no-op and
 * returns { emitted: false, eventId: <existing> }.
 */
export async function emitEvent(
  prisma: PrismaClient,
  input: EmitEventInput,
): Promise<EmitResult> {
  const spec = EVENT_KINDS[input.kind];
  if (!spec) {
    throw new Error(`Unknown reputation event kind: ${input.kind}`);
  }

  const axis: Axis = input.axis ?? spec.axis;
  const polarity: Polarity = input.polarity ?? spec.polarity;
  const weight: number = input.weight ?? spec.defaultWeight;

  // Fast path: if a row with this sourceKey already exists, do nothing.
  const existing = await prisma.reputationEvent.findUnique({
    where: { sourceKey: input.sourceKey },
    select: { id: true },
  });
  if (existing) {
    return { emitted: false, eventId: existing.id };
  }

  const row = await prisma.reputationEvent.create({
    data: {
      sourceKey: input.sourceKey,
      subjectWallet: input.subjectWallet,
      actorWallet: input.actorWallet ?? null,
      kind: input.kind,
      axis,
      polarity,
      weight,
      txHash: input.txHash ?? null,
      attestationId: input.attestationId ?? null,
      metadata: input.metadata as never,
      occurredAt: input.occurredAt,
    },
    select: { id: true },
  });

  return { emitted: true, eventId: row.id };
}

/**
 * Emit multiple events in one batch. Returns counts.
 *
 * Note: this currently calls emitEvent in sequence for clarity. Phase 1c
 * will replace this with a single createMany + skipDuplicates pass when
 * we're confident the sourceKey discipline is correct.
 */
export async function emitEventsBatch(
  prisma: PrismaClient,
  inputs: EmitEventInput[],
): Promise<{ emitted: number; skipped: number }> {
  let emitted = 0;
  let skipped = 0;
  for (const input of inputs) {
    const r = await emitEvent(prisma, input);
    if (r.emitted) emitted++;
    else skipped++;
  }
  return { emitted, skipped };
}

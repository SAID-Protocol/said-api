/**
 * v0.8 signal computation — walks the ReputationEvent log, applies decay
 * incrementally in chronological order, and writes the resulting decayed
 * accumulators to ReputationSignal.
 *
 * Per (subjectWallet, axis, kind) it computes:
 *   - decayedValue at the time of the most recent event
 *   - lastDecayAt = most recent event's occurredAt
 *   - α, β posterior parameters (running sums of positive/negative weight)
 *   - uniqueActors + shannonEntropyEst over the contributing actors
 *
 * It does NOT project forward to "now" — that's the API layer's job at
 * read time, because the projection depends on the query timestamp and
 * isn't a stored property of the accumulator.
 *
 * Idempotent: each run deletes existing ReputationSignal rows and
 * recomputes from scratch. Source-of-truth is ReputationEvent.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/v8-compute-signals.ts
 *
 * Optional env:
 *   LIMIT=10000          # cap events processed (dry run / smoke test)
 *   WALLET=<wallet>      # only this subject (for debugging)
 *   SKIP_CLEAR=1         # don't truncate existing rows (incremental, advanced)
 *   COCM=true            # Phase 3b: collapse collusive (reciprocal-cluster)
 *                        # feedback toward a single signal before it inflates
 *                        # the Beta posterior
 *   COCM_MIN_CLUSTER=3   # min feedback-cluster size to collapse
 */
import { PrismaClient } from '@prisma/client';
import { applyEvent, halfLifeFor, shannonEntropy, updatePosterior } from '../src/reputation-v0.8/decay.js';
import type { EventKind } from '../src/reputation-v0.8/kinds.js';
import {
  detectClusters,
  collapseCollusiveFeedback,
  type RawEdge,
  type ClusterDetection,
} from '../src/reputation-v0.8/cocm.js';

const prisma = new PrismaClient();
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : undefined;
const WALLET = process.env.WALLET ?? null;
const SKIP_CLEAR = process.env.SKIP_CLEAR === '1';
// Phase 3b (posterior path): collapse collusive feedback toward a single
// signal before it inflates a Beta posterior. Off by default.
const COCM = process.env.COCM === 'true';
const COCM_MIN_CLUSTER = Number(process.env.COCM_MIN_CLUSTER ?? 3);
const COCM_MIN_RECIPROCITY = Number(process.env.COCM_MIN_RECIPROCITY ?? 0.3);
// Endorsement kinds eligible for collapse. Positive-only — collapsing
// negative feedback would help sybils, not hurt them.
const COLLAPSE_KINDS = new Set<string>(['feedback_pos']);

interface SignalKey {
  subjectWallet: string;
  axis: string;
  kind: string;
}

interface Accumulator {
  decayedValue: number;
  lastDecayAt: Date;
  lastEventAt: Date | null;
  alpha: number;
  beta: number;
  actorWeights: Map<string, number>;
  eventCount: number;
}

function keyOf(k: SignalKey): string {
  return `${k.subjectWallet}|${k.axis}|${k.kind}`;
}

async function run() {
  console.log(`v0.8 signal computation starting (wallet=${WALLET ?? 'all'}, limit=${LIMIT ?? 'none'})`);
  const startedAt = Date.now();

  // Optionally clear existing signals to recompute from scratch.
  if (!SKIP_CLEAR) {
    const cleared = WALLET
      ? await prisma.reputationSignal.deleteMany({ where: { subjectWallet: WALLET } })
      : await prisma.reputationSignal.deleteMany();
    console.log(`Cleared ${cleared.count} existing ReputationSignal rows.`);
  }

  // Stream events in chronological order. Order is mandatory: decay-and-add
  // is path-dependent; out-of-order processing yields wrong results.
  console.log('Loading events in chronological order...');
  const events = await prisma.reputationEvent.findMany({
    where: WALLET ? { subjectWallet: WALLET } : {},
    orderBy: { occurredAt: 'asc' },
    select: {
      subjectWallet: true,
      actorWallet: true,
      kind: true,
      axis: true,
      polarity: true,
      weight: true,
      occurredAt: true,
    },
    ...(LIMIT ? { take: LIMIT } : {}),
  });
  console.log(`Loaded ${events.length} events. Building accumulators in memory...`);

  // Detect collusive feedback clusters from the feedback graph (rater →
  // subject). Reciprocity within these clusters drives how hard we collapse
  // their feedback in the finalize pass below.
  let detection: ClusterDetection | null = null;
  if (COCM) {
    const fbEdges: RawEdge[] = [];
    for (const ev of events) {
      if (COLLAPSE_KINDS.has(ev.kind) && ev.actorWallet && ev.actorWallet !== ev.subjectWallet) {
        fbEdges.push({ fromWallet: ev.actorWallet, toWallet: ev.subjectWallet, edgeType: 'feedback', weight: ev.weight });
      }
    }
    detection = detectClusters(fbEdges, { minClusterSize: COCM_MIN_CLUSTER });
    const flaggedSizes = [...detection.flagged]
      .map((c) => detection!.sizeOf.get(c) ?? 0)
      .sort((a, b) => b - a);
    console.log(
      `COCM on: feedback graph ${fbEdges.length} edges, ${detection.numCommunities} communities, ` +
        `${detection.flagged.size} flagged (sizes: ${flaggedSizes.slice(0, 5).join(', ')}…)`,
    );
  }

  // Accumulators keyed by (subjectWallet, axis, kind). Cold-start prior (α=2, β=2)
  // matches the schema default; ensures new accumulators see the same prior
  // as ones that were inserted fresh by the schema.
  const COLD_START_ALPHA = 2.0;
  const COLD_START_BETA = 2.0;

  const accs = new Map<string, Accumulator>();
  let processed = 0;
  let invalidKinds = 0;

  for (const ev of events) {
    processed++;
    const key: SignalKey = {
      subjectWallet: ev.subjectWallet,
      axis: ev.axis,
      kind: ev.kind,
    };
    const k = keyOf(key);
    let acc = accs.get(k);
    if (!acc) {
      acc = {
        decayedValue: 0,
        lastDecayAt: ev.occurredAt, // initialize at first event time — no decay before then
        lastEventAt: null,
        alpha: COLD_START_ALPHA,
        beta: COLD_START_BETA,
        actorWeights: new Map(),
        eventCount: 0,
      };
      accs.set(k, acc);
    }

    const halfLife = halfLifeFor(ev.kind as EventKind);
    if (halfLife === undefined as unknown as number | null) {
      // halfLifeFor falls back to default; this branch shouldn't fire in practice
      invalidKinds++;
    }

    // Decay-and-add. Pure function — accumulator state updated explicitly.
    const next = applyEvent(
      { decayedValue: acc.decayedValue, lastDecayAt: acc.lastDecayAt },
      ev.occurredAt,
      ev.weight,
      halfLife,
    );
    acc.decayedValue = next.decayedValue;
    acc.lastDecayAt = next.lastDecayAt;
    acc.lastEventAt = ev.occurredAt;
    acc.eventCount++;

    // Posterior update on polarity-bearing events.
    if (ev.polarity !== 0) {
      const post = updatePosterior(acc.alpha, acc.beta, ev.polarity, ev.weight);
      acc.alpha = post.alpha;
      acc.beta = post.beta;
    }

    // Track per-actor contribution for diversity entropy.
    if (ev.actorWallet) {
      const cur = acc.actorWeights.get(ev.actorWallet) ?? 0;
      acc.actorWeights.set(ev.actorWallet, cur + ev.weight);
    }

    if (processed % 5000 === 0) {
      console.log(`  ${processed}/${events.length} processed, ${accs.size} accumulators so far`);
    }
  }

  // ── COCM finalize: collapse collusive feedback ───────────────────
  // A ring member's silver tier rides mutual feedback inflating their
  // delivery posterior. Collapse same-cluster feedback toward a single
  // signal: α drops, and effectiveSamples (the tier sample-gate) craters.
  if (COCM && detection) {
    let collapsedAccs = 0;
    let weightRemovedTotal = 0;
    for (const [k, acc] of accs) {
      const [subjectWallet, , kind] = k.split('|');
      if (!COLLAPSE_KINDS.has(kind)) continue;
      const res = collapseCollusiveFeedback(subjectWallet, acc.actorWeights, detection, COCM_MIN_RECIPROCITY);
      if (!res) continue;

      // feedback_pos is positive-only, so α − prior == Σ raw feedback weight.
      const fullSum = Math.max(0, acc.alpha - COLD_START_ALPHA);
      const removed = Math.min(res.weightRemoved, fullSum);
      acc.alpha -= removed;
      if (fullSum > 0) acc.decayedValue *= (fullSum - removed) / fullSum; // cosmetic; composite uses α/β

      // Fold the collusive raters into one synthetic actor so uniqueActors
      // and entropy reflect the collapse.
      const subjComm = detection.communityOf.get(subjectWallet);
      const kept = new Map<string, number>();
      for (const [actor, w] of acc.actorWeights) {
        if (detection.communityOf.get(actor) === subjComm) continue; // drop collusive
        kept.set(actor, w);
      }
      if (res.effectiveCollusiveWeight > 0) {
        kept.set(`cocm:collapsed:${subjComm}`, res.effectiveCollusiveWeight);
      }
      acc.actorWeights = kept;

      collapsedAccs++;
      weightRemovedTotal += removed;
    }
    console.log(
      `COCM: collapsed ${collapsedAccs} feedback accumulator(s), removed ${weightRemovedTotal.toFixed(1)} collusive weight.`,
    );
  }

  console.log(`\nWriting ${accs.size} ReputationSignal rows...`);

  // Bulk write. createMany is fine — we already truncated existing rows
  // (or this is a fresh wallet via WALLET= filter), so no conflict risk.
  const rows = Array.from(accs.entries()).map(([_, acc]) => {
    const [subjectWallet, axis, kind] = (_).split('|');
    const entropy = shannonEntropy(acc.actorWeights);
    return {
      subjectWallet,
      axis,
      kind,
      decayedValue: acc.decayedValue,
      lastEventAt: acc.lastEventAt,
      lastDecayAt: acc.lastDecayAt,
      halfLifeDays: halfLifeFor(kind as EventKind) ?? null,
      uniqueActors: acc.actorWeights.size,
      shannonEntropyEst: entropy,
      alpha: acc.alpha,
      beta: acc.beta,
    };
  });

  // createMany has row-size limits; chunk to be safe.
  const CHUNK = 2000;
  let written = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const result = await prisma.reputationSignal.createMany({
      data: chunk,
      skipDuplicates: true,
    });
    written += result.count;
  }

  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  console.log(`\nDone in ${elapsed}s. Wrote ${written} ReputationSignal rows from ${events.length} events.`);
  if (invalidKinds > 0) console.log(`(${invalidKinds} events used the fallback half-life — investigate the kinds vocabulary)`);

  // ── Sanity reports ────────────────────────────────────────────────
  console.log('\n── Accumulator distribution by axis ─────────────────────');
  const byAxis = await prisma.reputationSignal.groupBy({
    by: ['axis'],
    _count: { _all: true },
    _sum: { decayedValue: true },
    orderBy: { _count: { id: 'desc' } },
  });
  for (const r of byAxis) {
    const total = r._sum.decayedValue ?? 0;
    console.log(`  ${r.axis.padEnd(14)} ${String(r._count._all).padStart(6)} rows, total decayed value: ${total.toFixed(1)}`);
  }

  console.log('\n── Top 15 (subject × axis × kind) accumulators by decayedValue ──');
  const top = await prisma.reputationSignal.findMany({
    orderBy: { decayedValue: 'desc' },
    take: 15,
  });
  for (const s of top) {
    console.log(
      `  ${s.subjectWallet.slice(0, 12)}…  ${s.axis.padEnd(12)} ${s.kind.padEnd(28)} value=${s.decayedValue.toFixed(2)}  actors=${s.uniqueActors}  α=${s.alpha.toFixed(1)} β=${s.beta.toFixed(1)}`,
    );
  }

  // Most multi-axis-active agents (sum of decayed delivery + payments)
  console.log('\n── Top 10 agents by total decayedValue (delivery axis) ──');
  const topDeliveryAgg = await prisma.reputationSignal.groupBy({
    by: ['subjectWallet'],
    where: { axis: 'delivery' },
    _sum: { decayedValue: true },
    orderBy: { _sum: { decayedValue: 'desc' } },
    take: 10,
  });
  for (const r of topDeliveryAgg) {
    const totalSignals = await prisma.reputationSignal.count({
      where: { subjectWallet: r.subjectWallet, axis: 'delivery' },
    });
    console.log(
      `  ${r.subjectWallet.slice(0, 16)}…  delivery_sum=${(r._sum.decayedValue ?? 0).toFixed(2)}  rows=${totalSignals}`,
    );
  }

  await prisma.$disconnect();
}

run().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});

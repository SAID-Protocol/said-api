/**
 * Build the TrustEdge graph from ReputationEvent rows.
 *
 * Walks all ReputationEvent rows where:
 *   - actorWallet IS NOT NULL
 *   - actorWallet != subjectWallet
 *   - the event's kind maps to a graph edge type (feedback, attestation,
 *     validation, payment) per graph.ts edgeTypeFor()
 *
 * Aggregates per (fromWallet, toWallet, edgeType) tuple. Each pair gets
 * one TrustEdge row whose `weight` is the decayed sum of contributing
 * events (decayed forward to "now" so the graph reflects current trust).
 *
 * Idempotent: truncates existing TrustEdge rows then rebuilds. Source of
 * truth remains ReputationEvent.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/v8-build-edges.ts
 */
import { PrismaClient } from '@prisma/client';
import { edgeTypeFor } from '../src/reputation-v0.8/graph.js';
import { applyEvent, halfLifeFor } from '../src/reputation-v0.8/decay.js';
import type { EventKind } from '../src/reputation-v0.8/kinds.js';

const prisma = new PrismaClient();

interface EdgeAccumulator {
  from: string;
  to: string;
  edgeType: string;
  decayedWeight: number;
  lastDecayAt: Date;
  lastEventAt: Date | null;
}

function keyOf(from: string, to: string, edgeType: string): string {
  return `${from}|${to}|${edgeType}`;
}

async function run() {
  console.log('Building TrustEdge graph from ReputationEvent...');
  const startedAt = Date.now();

  const cleared = await prisma.trustEdge.deleteMany();
  console.log(`Cleared ${cleared.count} existing TrustEdge rows.`);

  const events = await prisma.reputationEvent.findMany({
    where: { actorWallet: { not: null } },
    orderBy: { occurredAt: 'asc' },
    select: {
      subjectWallet: true,
      actorWallet: true,
      kind: true,
      weight: true,
      occurredAt: true,
    },
  });
  console.log(`Loaded ${events.length} events with non-null actor.`);

  const accs = new Map<string, EdgeAccumulator>();
  let processed = 0;
  let edgeContributions = 0;
  let selfSkipped = 0;
  let nonGraphSkipped = 0;

  for (const ev of events) {
    processed++;
    if (!ev.actorWallet) continue;
    if (ev.actorWallet === ev.subjectWallet) {
      selfSkipped++;
      continue;
    }
    const edgeType = edgeTypeFor(ev.kind);
    if (edgeType === null) {
      nonGraphSkipped++;
      continue;
    }

    const k = keyOf(ev.actorWallet, ev.subjectWallet, edgeType);
    let acc = accs.get(k);
    if (!acc) {
      acc = {
        from: ev.actorWallet,
        to: ev.subjectWallet,
        edgeType,
        decayedWeight: 0,
        lastDecayAt: ev.occurredAt,
        lastEventAt: null,
      };
      accs.set(k, acc);
    }

    const halfLife = halfLifeFor(ev.kind as EventKind);
    const next = applyEvent(
      { decayedValue: acc.decayedWeight, lastDecayAt: acc.lastDecayAt },
      ev.occurredAt,
      ev.weight,
      halfLife,
    );
    acc.decayedWeight = next.decayedValue;
    acc.lastDecayAt = next.lastDecayAt;
    acc.lastEventAt = ev.occurredAt;
    edgeContributions++;
  }

  console.log(`\nProcessed ${processed} events:`);
  console.log(`  ${edgeContributions} contributed to ${accs.size} distinct edges`);
  console.log(`  ${selfSkipped} self-events skipped (actor == subject)`);
  console.log(`  ${nonGraphSkipped} non-graph events skipped (kind has no edge type)`);
  console.log(`  ${processed - edgeContributions - selfSkipped - nonGraphSkipped} unaccounted`);

  console.log(`\nWriting ${accs.size} TrustEdge rows...`);
  const rows = Array.from(accs.values()).map((acc) => ({
    fromWallet: acc.from,
    toWallet: acc.to,
    edgeType: acc.edgeType,
    weight: acc.decayedWeight,
    lastEventAt: acc.lastEventAt,
    lastDecayAt: acc.lastDecayAt,
  }));

  const CHUNK = 2000;
  let written = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const result = await prisma.trustEdge.createMany({
      data: chunk,
      skipDuplicates: true,
    });
    written += result.count;
  }

  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  console.log(`\nDone in ${elapsed}s. Wrote ${written} TrustEdge rows.\n`);

  // ── Reports ─────────────────────────────────────────────────────
  const byType = await prisma.trustEdge.groupBy({
    by: ['edgeType'],
    _count: { _all: true },
    _sum: { weight: true },
  });
  console.log('Edges by type:');
  for (const r of byType) {
    console.log(
      `  ${r.edgeType.padEnd(14)} ${String(r._count._all).padStart(6)} edges, total weight ${(r._sum.weight ?? 0).toFixed(1)}`,
    );
  }

  // Top inbound nodes (most-endorsed agents)
  const topInbound = await prisma.trustEdge.groupBy({
    by: ['toWallet'],
    _count: { _all: true },
    _sum: { weight: true },
    orderBy: { _count: { id: 'desc' } },
    take: 15,
  });
  console.log('\nTop 15 agents by INBOUND edge count (most endorsed):');
  for (const r of topInbound) {
    console.log(
      `  ${r.toWallet.slice(0, 14)}…  ${String(r._count._all).padStart(4)} edges, total weight ${(r._sum.weight ?? 0).toFixed(1)}`,
    );
  }

  // Top outbound nodes (most-active raters — useful for detecting prolific
  // sybils that endorse many distinct targets)
  const topOutbound = await prisma.trustEdge.groupBy({
    by: ['fromWallet'],
    _count: { _all: true },
    _sum: { weight: true },
    orderBy: { _count: { id: 'desc' } },
    take: 15,
  });
  console.log('\nTop 15 agents by OUTBOUND edge count (most active endorsers):');
  for (const r of topOutbound) {
    console.log(
      `  ${r.fromWallet.slice(0, 14)}…  ${String(r._count._all).padStart(4)} edges, total weight ${(r._sum.weight ?? 0).toFixed(1)}`,
    );
  }

  await prisma.$disconnect();
}

run().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});

/**
 * v0.8 backfill — walks every existing reputation-signal source in the
 * DB and emits ReputationEvent rows for historical signals.
 *
 * Sources walked:
 *   - Agent (registration, verification, l2_verified, profile_completed)
 *   - Feedback (pos/neg classified by score)
 *   - Attestation (attestation_received + attestation_given)
 *   - LaunchedToken (token_launched scaled by market cap)
 *   - AgentX402Activity (x402_payment_received/sent — batched per agent)
 *   - AgentSaidEngagement (per-instruction-kind event aggregates)
 *
 * Idempotent: every emitted row has a deterministic sourceKey derived
 * from the source row's stable identifier. Re-running this script is
 * safe — duplicates are skipped, no double-counting.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/v8-backfill-events.ts
 *
 * Optional env:
 *   LIMIT=500              # cap per-source rows processed (dry run)
 *   ONLY=feedback          # restrict to one source — useful when iterating
 *                          # ('agent', 'feedback', 'attestation',
 *                          //  'launched_token', 'x402', 'said_engagement')
 */
import { PrismaClient } from '@prisma/client';
import { emitEvent } from '../src/reputation-v0.8/ingest.js';

const prisma = new PrismaClient();
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : undefined;
const ONLY = process.env.ONLY ?? null;

interface BackfillCounts {
  source: string;
  scanned: number;
  emitted: number;
  skipped: number;
}

function only(name: string): boolean {
  return ONLY === null || ONLY === name;
}

// ── Agent → registered, verified, l2_verified, profile_completed ────
async function backfillAgent(): Promise<BackfillCounts> {
  const counts: BackfillCounts = { source: 'agent', scanned: 0, emitted: 0, skipped: 0 };
  const agents = await prisma.agent.findMany({
    select: {
      id: true,
      wallet: true,
      registeredAt: true,
      isVerified: true,
      verifiedAt: true,
      layer2Verified: true,
      layer2VerifiedAt: true,
      name: true,
      description: true,
      twitter: true,
      website: true,
    },
    ...(LIMIT ? { take: LIMIT } : {}),
  });
  for (const a of agents) {
    counts.scanned++;

    const r1 = await emitEvent(prisma, {
      sourceKey: `agent:registered:${a.id}`,
      subjectWallet: a.wallet,
      actorWallet: a.wallet,
      kind: 'registered',
      occurredAt: a.registeredAt,
    });
    r1.emitted ? counts.emitted++ : counts.skipped++;

    if (a.isVerified && a.verifiedAt) {
      const r2 = await emitEvent(prisma, {
        sourceKey: `agent:verified:${a.id}`,
        subjectWallet: a.wallet,
        actorWallet: a.wallet,
        kind: 'verified',
        occurredAt: a.verifiedAt,
      });
      r2.emitted ? counts.emitted++ : counts.skipped++;
    }

    if (a.layer2Verified && a.layer2VerifiedAt) {
      const r3 = await emitEvent(prisma, {
        sourceKey: `agent:l2_verified:${a.id}`,
        subjectWallet: a.wallet,
        actorWallet: a.wallet,
        kind: 'l2_verified',
        occurredAt: a.layer2VerifiedAt,
      });
      r3.emitted ? counts.emitted++ : counts.skipped++;
    }

    if (a.name && a.description && (a.twitter || a.website)) {
      const r4 = await emitEvent(prisma, {
        sourceKey: `agent:profile_completed:${a.id}`,
        subjectWallet: a.wallet,
        actorWallet: a.wallet,
        kind: 'profile_completed',
        // Profile completion has no precise timestamp; use registration as a floor
        occurredAt: a.registeredAt,
      });
      r4.emitted ? counts.emitted++ : counts.skipped++;
    }
  }
  return counts;
}

// ── Feedback → feedback_pos or feedback_neg ─────────────────────────
async function backfillFeedback(): Promise<BackfillCounts> {
  const counts: BackfillCounts = { source: 'feedback', scanned: 0, emitted: 0, skipped: 0 };
  const rows = await prisma.feedback.findMany({
    select: { id: true, fromWallet: true, toWallet: true, score: true, weight: true, createdAt: true },
    ...(LIMIT ? { take: LIMIT } : {}),
  });
  for (const f of rows) {
    counts.scanned++;
    const positive = f.score >= 50;
    const r = await emitEvent(prisma, {
      sourceKey: `fb:${f.id}`,
      subjectWallet: f.toWallet,
      actorWallet: f.fromWallet,
      kind: positive ? 'feedback_pos' : 'feedback_neg',
      // Scale the raw weight by the Feedback row's weight field (verified
      // raters were stored with weight 2.0). Cap at 3x default.
      weight: positive
        ? Math.min(3.0, 1.0 * (f.weight ?? 1.0))
        : Math.min(3.0, 1.0 * (f.weight ?? 1.0)),
      occurredAt: f.createdAt,
    });
    r.emitted ? counts.emitted++ : counts.skipped++;
  }
  return counts;
}

// ── Attestation → attestation_received + attestation_given ──────────
async function backfillAttestation(): Promise<BackfillCounts> {
  const counts: BackfillCounts = { source: 'attestation', scanned: 0, emitted: 0, skipped: 0 };
  const rows = await prisma.attestation.findMany({
    select: {
      id: true,
      attesterWallet: true,
      subjectWallet: true,
      confidence: true,
      createdAt: true,
      revokedAt: true,
    },
    ...(LIMIT ? { take: LIMIT } : {}),
  });
  for (const att of rows) {
    counts.scanned++;
    // Skip revoked attestations
    if (att.revokedAt) {
      counts.skipped++;
      continue;
    }
    // Subject side — they received an attestation
    const r1 = await emitEvent(prisma, {
      sourceKey: `att:recv:${att.id}`,
      subjectWallet: att.subjectWallet,
      actorWallet: att.attesterWallet,
      kind: 'attestation_received',
      // Scale by confidence (1-100), normalized so confidence=50 ≈ default
      weight: Math.max(0.1, (att.confidence ?? 50) / 50),
      occurredAt: att.createdAt,
    });
    r1.emitted ? counts.emitted++ : counts.skipped++;

    // Actor side — they gave an attestation (weak community signal)
    const r2 = await emitEvent(prisma, {
      sourceKey: `att:given:${att.id}`,
      subjectWallet: att.attesterWallet,
      actorWallet: att.attesterWallet,
      kind: 'attestation_given',
      occurredAt: att.createdAt,
    });
    r2.emitted ? counts.emitted++ : counts.skipped++;
  }
  return counts;
}

// ── LaunchedToken → token_launched scaled by market cap ─────────────
async function backfillLaunchedToken(): Promise<BackfillCounts> {
  const counts: BackfillCounts = { source: 'launched_token', scanned: 0, emitted: 0, skipped: 0 };
  const rows = await prisma.launchedToken.findMany({
    select: {
      id: true,
      mint: true,
      agentWallet: true,
      marketCapUsd: true,
      detectedAt: true,
    },
    ...(LIMIT ? { take: LIMIT } : {}),
  });
  for (const tok of rows) {
    counts.scanned++;
    // Weight scales by market cap. Threshold-based, log-flavored:
    //   no mc data    → weight 0.5
    //   ≥ $100K       → weight 1.0
    //   ≥ $1M         → weight 2.0
    //   ≥ $10M        → weight 4.0
    let weight = 0.5;
    const mc = tok.marketCapUsd ?? 0;
    if (mc >= 10_000_000) weight = 4.0;
    else if (mc >= 1_000_000) weight = 2.0;
    else if (mc >= 100_000) weight = 1.0;
    else if (mc > 0) weight = 0.5;

    const r = await emitEvent(prisma, {
      sourceKey: `token:${tok.mint}`,
      subjectWallet: tok.agentWallet,
      actorWallet: tok.agentWallet,
      kind: 'token_launched',
      weight,
      occurredAt: tok.detectedAt,
      metadata: { mint: tok.mint, marketCapUsd: mc },
    });
    r.emitted ? counts.emitted++ : counts.skipped++;
  }
  return counts;
}

// ── AgentX402Activity → batched provider/buyer events ───────────────
// Source data is aggregated per wallet (we don't have per-tx rows), so
// we emit one synthetic batch event per side, with weight scaled by
// unique counterparties (not raw tx count — counterparty diversity is
// the meaningful quality signal).
async function backfillX402(): Promise<BackfillCounts> {
  const counts: BackfillCounts = { source: 'x402', scanned: 0, emitted: 0, skipped: 0 };
  const rows = await prisma.agentX402Activity.findMany({
    ...(LIMIT ? { take: LIMIT } : {}),
  });
  for (const x of rows) {
    counts.scanned++;

    // Provider side — affects both `payments` and `delivery`.
    //
    // Weight policy: scale linearly by unique counterparties. The batched
    // synthetic event stands in for the N actual transactions we don't
    // have per-row data for. This puts batched and per-row events on the
    // same evidence scale (one unique payer ≈ one endorsement). Without
    // this, agents with batched signals are massively underrepresented
    // vs. agents with per-row Feedback rows.
    if (x.providerUniqueBuyers > 0 && x.providerLastSeenAt) {
      const weight = x.providerUniqueBuyers; // raw count — one event per real customer
      const r1 = await emitEvent(prisma, {
        sourceKey: `x402:provider:payments:${x.wallet}`,
        subjectWallet: x.wallet,
        actorWallet: null,
        kind: 'x402_payment_received',
        weight,
        occurredAt: x.providerLastSeenAt,
        metadata: {
          uniqueBuyers: x.providerUniqueBuyers,
          txCount: x.providerTxCount,
          facilitators: x.providerFacilitators,
        },
      });
      r1.emitted ? counts.emitted++ : counts.skipped++;

      const r2 = await emitEvent(prisma, {
        sourceKey: `x402:provider:delivery:${x.wallet}`,
        subjectWallet: x.wallet,
        actorWallet: null,
        kind: 'x402_payment_received_delivery',
        weight,
        occurredAt: x.providerLastSeenAt,
        metadata: { uniqueBuyers: x.providerUniqueBuyers },
      });
      r2.emitted ? counts.emitted++ : counts.skipped++;
    }

    // Buyer side — affects `payments` only. Lower per-counterparty weight
    // because consuming a service is a weaker reputation signal than
    // attracting customers (cost is lower; it's "I paid for something",
    // not "people paid me").
    if (x.buyerUniqueSellers > 0 && x.buyerLastSeenAt) {
      const weight = x.buyerUniqueSellers * 0.4; // weaker than provider side
      const r = await emitEvent(prisma, {
        sourceKey: `x402:buyer:${x.wallet}`,
        subjectWallet: x.wallet,
        actorWallet: null,
        kind: 'x402_payment_sent',
        weight,
        occurredAt: x.buyerLastSeenAt,
        metadata: {
          uniqueSellers: x.buyerUniqueSellers,
          txCount: x.buyerTxCount,
        },
      });
      r.emitted ? counts.emitted++ : counts.skipped++;
    }
  }
  return counts;
}

// ── AgentSaidEngagement → one event per SAID instruction kind ───────
// Source data is aggregated counts per agent. We emit one batched event
// per non-zero kind with weight log-scaled by count.
async function backfillSaidEngagement(): Promise<BackfillCounts> {
  const counts: BackfillCounts = { source: 'said_engagement', scanned: 0, emitted: 0, skipped: 0 };
  const rows = await prisma.agentSaidEngagement.findMany({
    ...(LIMIT ? { take: LIMIT } : {}),
  });
  for (const s of rows) {
    counts.scanned++;
    const lastAt = s.lastSaidInteractionAt ?? s.syncedAt;

    type Mapping = { count: number; kind: Parameters<typeof emitEvent>[1]['kind']; suffix: string; perItemWeight: number };
    const mappings: Mapping[] = [
      { count: s.submitAnchorCount, kind: 'submit_anchor', suffix: 'submit_anchor', perItemWeight: 1.0 },
      { count: s.validateWorkCount, kind: 'validate_work_done', suffix: 'validate_work', perItemWeight: 1.5 },
      { count: s.stakeCount + s.addStakeCount + s.registerAndStakeCount, kind: 'stake', suffix: 'stake', perItemWeight: 1.5 },
      { count: s.unstakeLifecycleCount, kind: 'unstake_lifecycle', suffix: 'unstake', perItemWeight: 0.0 },
      { count: s.slashAgentCount, kind: 'slashed', suffix: 'slashed', perItemWeight: 5.0 },
    ];

    for (const m of mappings) {
      if (m.count <= 0) continue;
      // Linear weight: count × perItemWeight. The batched synthetic event
      // stands in for `count` actual on-chain events. Putting batched and
      // per-row events on the same evidence scale prevents prolific
      // anchor/stake users from being silently underrepresented vs.
      // agents with feedback rows (which are stored per-row).
      const weight = m.count * m.perItemWeight;
      const r = await emitEvent(prisma, {
        sourceKey: `said:${m.suffix}:${s.wallet}`,
        subjectWallet: s.wallet,
        actorWallet: s.wallet,
        kind: m.kind,
        weight,
        occurredAt: lastAt,
        metadata: { count: m.count },
      });
      r.emitted ? counts.emitted++ : counts.skipped++;
    }
  }
  return counts;
}

// ── Driver ──────────────────────────────────────────────────────────

async function run() {
  console.log(`v0.8 event backfill starting (only=${ONLY ?? 'all'}, limit=${LIMIT ?? 'none'})\n`);
  const startedAt = Date.now();
  const results: BackfillCounts[] = [];

  if (only('agent')) {
    console.log('→ Agent...');
    results.push(await backfillAgent());
  }
  if (only('feedback')) {
    console.log('→ Feedback...');
    results.push(await backfillFeedback());
  }
  if (only('attestation')) {
    console.log('→ Attestation...');
    results.push(await backfillAttestation());
  }
  if (only('launched_token')) {
    console.log('→ LaunchedToken...');
    results.push(await backfillLaunchedToken());
  }
  if (only('x402')) {
    console.log('→ AgentX402Activity...');
    results.push(await backfillX402());
  }
  if (only('said_engagement')) {
    console.log('→ AgentSaidEngagement...');
    results.push(await backfillSaidEngagement());
  }

  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  console.log(`\nDone in ${elapsed}s.\n`);
  console.log(`${'source'.padEnd(18)} ${'scanned'.padStart(8)} ${'emitted'.padStart(8)} ${'skipped'.padStart(8)}`);
  let totalEmitted = 0;
  let totalSkipped = 0;
  for (const r of results) {
    console.log(
      `${r.source.padEnd(18)} ${String(r.scanned).padStart(8)} ${String(r.emitted).padStart(8)} ${String(r.skipped).padStart(8)}`,
    );
    totalEmitted += r.emitted;
    totalSkipped += r.skipped;
  }
  console.log(`${'TOTAL'.padEnd(18)} ${''.padStart(8)} ${String(totalEmitted).padStart(8)} ${String(totalSkipped).padStart(8)}`);

  // Show what the corpus looks like now by kind + axis
  const byKind = await prisma.reputationEvent.groupBy({
    by: ['kind'],
    _count: { _all: true },
    orderBy: { _count: { id: 'desc' } },
  });
  console.log('\nReputationEvent corpus by kind:');
  for (const r of byKind) {
    console.log(`  ${r.kind.padEnd(32)} ${r._count._all}`);
  }

  const byAxis = await prisma.reputationEvent.groupBy({
    by: ['axis'],
    _count: { _all: true },
    orderBy: { _count: { id: 'desc' } },
  });
  console.log('\nReputationEvent corpus by axis:');
  for (const r of byAxis) {
    console.log(`  ${r.axis.padEnd(16)} ${r._count._all}`);
  }

  await prisma.$disconnect();
}

run().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});

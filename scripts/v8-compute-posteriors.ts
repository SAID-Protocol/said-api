/**
 * v0.8 posterior computation — turns ReputationSignal accumulators into
 * per-axis Beta posteriors, composite scores, and tier assignments.
 *
 * Writes to ReputationPosterior (one row per subject × axis).
 *
 * Idempotent: truncates existing posterior rows then recomputes from
 * scratch. Source-of-truth remains ReputationSignal (which derives from
 * ReputationEvent).
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/v8-compute-posteriors.ts
 *
 * Optional env:
 *   WALLET=<wallet>   # only this subject (debugging)
 *   SKIP_CLEAR=1      # don't truncate existing rows
 */
import { PrismaClient } from '@prisma/client';
import {
  computeAgentPosteriors,
  type SignalInput,
} from '../src/reputation-v0.8/posteriors.js';
import { AXES, type Axis } from '../src/reputation-v0.8/axes.js';

const prisma = new PrismaClient();
const WALLET = process.env.WALLET ?? null;
const SKIP_CLEAR = process.env.SKIP_CLEAR === '1';

async function run() {
  console.log(`v0.8 posterior computation starting (wallet=${WALLET ?? 'all'})`);
  const startedAt = Date.now();

  if (!SKIP_CLEAR) {
    const cleared = WALLET
      ? await prisma.reputationPosterior.deleteMany({ where: { subjectWallet: WALLET } })
      : await prisma.reputationPosterior.deleteMany();
    console.log(`Cleared ${cleared.count} existing ReputationPosterior rows.`);
  }

  console.log('Loading ReputationSignal rows grouped by subject...');
  const signals = await prisma.reputationSignal.findMany({
    where: WALLET ? { subjectWallet: WALLET } : {},
    select: {
      subjectWallet: true,
      axis: true,
      kind: true,
      decayedValue: true,
      alpha: true,
      beta: true,
      uniqueActors: true,
      shannonEntropyEst: true,
      lastEventAt: true,
    },
  });
  console.log(`Loaded ${signals.length} signal rows.`);

  // Group by subject
  const bySubject = new Map<string, SignalInput[]>();
  for (const s of signals) {
    const arr = bySubject.get(s.subjectWallet) ?? [];
    arr.push(s);
    bySubject.set(s.subjectWallet, arr);
  }
  console.log(`Computing posteriors for ${bySubject.size} subjects...\n`);

  // Compute per-agent + accumulate into bulk-insert payload
  const allRows: any[] = [];
  const composites: Array<{ wallet: string; composite: number; samples: number; tier: string }> = [];
  let processed = 0;

  for (const [wallet, subjectSignals] of bySubject) {
    const result = computeAgentPosteriors(wallet, subjectSignals);

    for (const axis of AXES) {
      const ax = result.axes[axis];
      allRows.push({
        subjectWallet: wallet,
        axis,
        alpha: ax.alpha,
        beta: ax.beta,
        posteriorMean: ax.posteriorMean,
        posteriorVariance: ax.posteriorVariance,
        lowerBound95: ax.lowerBound95,
        eigentrustScore: 0, // Phase 3
        hittingTimeScore: null,
        compositeScore: result.compositeScore,
        topSourcesJson: ax.topEvidence as never,
        sampleSize: Math.round(ax.effectiveSamples),
      });
    }

    composites.push({
      wallet,
      composite: result.compositeScore,
      samples: result.totalSamples,
      tier: result.tier,
    });

    processed++;
    if (processed % 1000 === 0) {
      console.log(`  ${processed}/${bySubject.size} subjects processed`);
    }
  }

  // Bulk insert
  console.log(`\nWriting ${allRows.length} ReputationPosterior rows...`);
  const CHUNK = 2000;
  let written = 0;
  for (let i = 0; i < allRows.length; i += CHUNK) {
    const chunk = allRows.slice(i, i + CHUNK);
    const result = await prisma.reputationPosterior.createMany({
      data: chunk,
      skipDuplicates: true,
    });
    written += result.count;
  }

  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  console.log(`\nDone in ${elapsed}s. Wrote ${written} rows for ${bySubject.size} subjects.\n`);

  // ── Reports ───────────────────────────────────────────────────────

  console.log('── Tier distribution ───────────────────────────');
  const tierCounts: Record<string, number> = {
    platinum: 0, gold: 0, silver: 0, bronze: 0, unranked: 0,
  };
  for (const c of composites) tierCounts[c.tier]++;
  const total = composites.length;
  for (const t of ['platinum', 'gold', 'silver', 'bronze', 'unranked']) {
    const n = tierCounts[t];
    const pct = ((n / total) * 100).toFixed(1);
    console.log(`  ${t.padEnd(10)} ${String(n).padStart(5)} (${pct}%)`);
  }
  console.log();

  console.log('── Composite score histogram (0.05 buckets) ───');
  const histo: Record<string, number> = {};
  for (const c of composites) {
    const b = Math.floor(c.composite * 20) / 20;
    const k = b.toFixed(2);
    histo[k] = (histo[k] ?? 0) + 1;
  }
  const sortedKeys = Object.keys(histo).sort();
  for (const k of sortedKeys) {
    const n = histo[k];
    const bar = '#'.repeat(Math.min(60, Math.round((n / total) * 200)));
    console.log(`  ${k}  ${String(n).padStart(5)}  ${bar}`);
  }
  console.log();

  console.log('── Top 20 agents by composite score ────────────');
  const top = await prisma.reputationPosterior.findMany({
    where: { axis: 'delivery' }, // composite is duplicated across axes; pick any
    orderBy: { compositeScore: 'desc' },
    take: 20,
    select: {
      subjectWallet: true,
      compositeScore: true,
      sampleSize: true,
    },
  });
  // Resolve names
  const wallets = top.map((t) => t.subjectWallet);
  const agents = await prisma.agent.findMany({
    where: { wallet: { in: wallets } },
    select: { wallet: true, name: true },
  });
  const nameMap = new Map(agents.map((a) => [a.wallet, a.name ?? '(unnamed)']));
  console.log(`  ${'name'.padEnd(28)} ${'composite'.padStart(10)} ${'samples'.padStart(8)} tier`);
  for (const r of top) {
    const c = composites.find((x) => x.wallet === r.subjectWallet);
    const name = nameMap.get(r.subjectWallet) ?? '(unknown)';
    console.log(
      `  ${name.slice(0, 28).padEnd(28)} ${r.compositeScore.toFixed(4).padStart(10)} ${String(r.sampleSize).padStart(8)} ${c?.tier ?? '?'}`,
    );
  }
  console.log();

  // Drill into 3 specific agents to verify the math on familiar examples
  const checks = [
    { name: 'Xona', wallet: '9VaDVp1Wb78G4Wm6VuTiMrpESjrUymXefQTHcJGRSTEA' },
  ];
  // Find SlimeBot dynamically
  const slime = await prisma.agent.findFirst({
    where: { name: { contains: 'SlimeBot', mode: 'insensitive' } },
    select: { wallet: true, name: true },
  });
  if (slime) checks.push({ name: slime.name ?? 'SlimeBot', wallet: slime.wallet });

  console.log('── Drill-down on known agents ──────────────────');
  for (const check of checks) {
    const rows = await prisma.reputationPosterior.findMany({
      where: { subjectWallet: check.wallet },
      orderBy: { axis: 'asc' },
    });
    if (rows.length === 0) {
      console.log(`  ${check.name}: no posteriors found`);
      continue;
    }
    const composite = rows[0].compositeScore;
    const totalSamples = rows.reduce((s, r) => s + r.sampleSize, 0);
    console.log(`  ${check.name} (${check.wallet.slice(0, 12)}…)`);
    console.log(`    composite=${composite.toFixed(4)}  samples=${totalSamples}`);
    for (const r of rows) {
      console.log(
        `    ${r.axis.padEnd(12)} α=${r.alpha.toFixed(1)} β=${r.beta.toFixed(1)} mean=${r.posteriorMean.toFixed(3)} lb95=${r.lowerBound95.toFixed(3)} n=${r.sampleSize}`,
      );
    }
    console.log();
  }

  await prisma.$disconnect();
}

run().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});

/**
 * Run Personalized EigenTrust over the TrustEdge graph and write the
 * resulting eigentrustScore back to ReputationPosterior.
 *
 * Seed set: configured via SEED_WALLETS env var (comma-separated). If
 * empty, falls back to uniform restart vector (vanilla PageRank) which
 * is NOT sybil-resistant — the script logs a loud warning in that case.
 *
 * Idempotent: updates ReputationPosterior in place (the rows already
 * exist from Phase 2a; we just overwrite the eigentrustScore column).
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/v8-compute-eigentrust.ts
 *
 * Optional env:
 *   SEED_WALLETS=wallet1,wallet2,wallet3   # comma-separated trusted seeds
 *   RESTART_ALPHA=0.15                     # restart probability (default 0.15)
 *   MAX_ITER=100
 *   EPSILON=1e-6
 */
import { PrismaClient } from '@prisma/client';
import {
  runEigenTrust,
  type Edge,
  DEFAULT_EIGENTRUST_PARAMS,
} from '../src/reputation-v0.8/graph.js';
import { AXES } from '../src/reputation-v0.8/axes.js';

const prisma = new PrismaClient();

const SEED_WALLETS = (process.env.SEED_WALLETS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const RESTART_ALPHA = Number(process.env.RESTART_ALPHA ?? DEFAULT_EIGENTRUST_PARAMS.restartAlpha);
const MAX_ITER = Number(process.env.MAX_ITER ?? DEFAULT_EIGENTRUST_PARAMS.maxIterations);
const EPSILON = Number(process.env.EPSILON ?? DEFAULT_EIGENTRUST_PARAMS.epsilon);

async function run() {
  console.log('EigenTrust computation starting');
  console.log(`  seed set:      ${SEED_WALLETS.length} wallets`);
  console.log(`  restart α:     ${RESTART_ALPHA}`);
  console.log(`  max iter:      ${MAX_ITER}`);
  console.log(`  epsilon:       ${EPSILON}`);
  if (SEED_WALLETS.length === 0) {
    console.log('  ⚠️  WARNING: no seed set — using uniform restart (NOT sybil-resistant).');
  }

  const startedAt = Date.now();

  // Load all TrustEdge rows into memory
  const trustEdges = await prisma.trustEdge.findMany({
    select: { fromWallet: true, toWallet: true, weight: true },
  });
  console.log(`\nLoaded ${trustEdges.length} TrustEdge rows.`);

  if (trustEdges.length === 0) {
    console.log('No edges to compute over. Exiting.');
    await prisma.$disconnect();
    return;
  }

  const edges: Edge[] = trustEdges.map((e) => ({
    from: e.fromWallet,
    to: e.toWallet,
    weight: e.weight,
  }));

  // Build the node set — every distinct wallet that appears as either
  // source or sink of any edge. We don't score wallets that aren't in
  // the graph (they get no eigentrustScore update; the schema default 0
  // remains).
  const nodeSet = new Set<string>();
  for (const e of edges) {
    nodeSet.add(e.from);
    nodeSet.add(e.to);
  }
  const allNodes = Array.from(nodeSet);
  console.log(`Graph has ${allNodes.length} distinct nodes.`);

  // Run EigenTrust
  console.log('\nRunning power iteration...');
  const iterStartedAt = Date.now();
  const result = runEigenTrust(edges, allNodes, SEED_WALLETS, {
    restartAlpha: RESTART_ALPHA,
    maxIterations: MAX_ITER,
    epsilon: EPSILON,
  });
  const iterElapsed = ((Date.now() - iterStartedAt) / 1000).toFixed(2);
  console.log(`Converged in ${result.iterations} iterations (Δ=${result.finalDelta.toExponential(2)}, ${iterElapsed}s)`);

  // Normalize scores to 0-1 by dividing by the max — makes them easier
  // to interpret as "relative trust mass" in [0, 1].
  let maxScore = 0;
  for (const v of result.scores.values()) maxScore = Math.max(maxScore, v);
  const normalize = (v: number) => (maxScore > 0 ? v / maxScore : 0);

  console.log(`\nMax raw eigentrust mass: ${maxScore.toExponential(3)}`);
  console.log('(Scores normalized to [0, 1] for storage and reporting.)');

  // Write back to ReputationPosterior. We update every axis row for each
  // subject — eigentrustScore is per-agent, not per-axis, so it's
  // duplicated across rows (same pattern as compositeScore).
  console.log('\nUpdating ReputationPosterior.eigentrustScore...');
  let updated = 0;
  for (const [wallet, rawScore] of result.scores) {
    const normalized = normalize(rawScore);
    const r = await prisma.reputationPosterior.updateMany({
      where: { subjectWallet: wallet },
      data: { eigentrustScore: normalized },
    });
    updated += r.count;
  }

  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  console.log(`\nDone in ${elapsed}s. Updated ${updated} ReputationPosterior rows for ${result.scores.size} subjects.\n`);

  // ── Reports ─────────────────────────────────────────────────────
  const top = await prisma.reputationPosterior.findMany({
    where: { axis: 'delivery' },
    orderBy: { eigentrustScore: 'desc' },
    take: 20,
    select: {
      subjectWallet: true,
      eigentrustScore: true,
      compositeScore: true,
      sampleSize: true,
    },
  });

  const wallets = top.map((t) => t.subjectWallet);
  const agents = await prisma.agent.findMany({
    where: { wallet: { in: wallets } },
    select: { wallet: true, name: true },
  });
  const nameMap = new Map(agents.map((a) => [a.wallet, a.name ?? '(unnamed)']));

  console.log('── Top 20 agents by EigenTrust ───────────────────────');
  console.log(`  ${'name'.padEnd(28)} ${'eigentrust'.padStart(10)} ${'composite'.padStart(10)} ${'samples'.padStart(8)}`);
  for (const r of top) {
    const name = nameMap.get(r.subjectWallet) ?? '(unknown)';
    console.log(
      `  ${name.slice(0, 28).padEnd(28)} ${r.eigentrustScore.toFixed(4).padStart(10)} ${r.compositeScore.toFixed(4).padStart(10)} ${String(r.sampleSize).padStart(8)}`,
    );
  }

  // Show divergence: agents with high composite but low eigentrust — these
  // are candidates for sybil suspicion (lots of feedback, but from a
  // tight cluster the graph doesn't reward).
  console.log('\n── Divergence check (composite high, eigentrust low) ──');
  const allRows = await prisma.reputationPosterior.findMany({
    where: { axis: 'delivery' },
    select: { subjectWallet: true, compositeScore: true, eigentrustScore: true, sampleSize: true },
    orderBy: { compositeScore: 'desc' },
    take: 50,
  });
  const divergent = allRows
    .filter((r) => r.compositeScore > 0.60 && r.eigentrustScore < 0.01)
    .slice(0, 15);
  if (divergent.length === 0) {
    console.log('  (none — no obvious sybil candidates)');
  } else {
    console.log(`  ${divergent.length} agents with composite>0.60 but eigentrust<0.01:`);
    const divWallets = divergent.map((d) => d.subjectWallet);
    const divAgents = await prisma.agent.findMany({
      where: { wallet: { in: divWallets } },
      select: { wallet: true, name: true },
    });
    const divNames = new Map(divAgents.map((a) => [a.wallet, a.name ?? '(unnamed)']));
    for (const r of divergent) {
      const name = divNames.get(r.subjectWallet) ?? '(unknown)';
      console.log(
        `    ${name.slice(0, 28).padEnd(28)} composite=${r.compositeScore.toFixed(3)} eigentrust=${r.eigentrustScore.toFixed(4)} samples=${r.sampleSize}`,
      );
    }
  }

  await prisma.$disconnect();
}

run().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});

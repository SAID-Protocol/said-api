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
 *   COCM=true                              # Phase 3b: discount collusive
 *                                          # (reciprocal) intra-cluster edges
 *                                          # before running EigenTrust
 *   COCM_DISCOUNT=0.3                      # floor multiplier for a fully
 *                                          # reciprocal cluster's edges
 *   COCM_MIN_CLUSTER=3                     # min cluster size to discount
 *   GRAPH_BONUS_WEIGHT=0.15                # Phase 3c: fold eigentrust into
 *                                          # composite as an additive,
 *                                          # never-penalty bonus. 0 disables.
 */
import { PrismaClient } from '@prisma/client';
import {
  runEigenTrust,
  type Edge,
  DEFAULT_EIGENTRUST_PARAMS,
} from '../src/reputation-v0.8/graph.js';
import { applyCocmDiscount, type RawEdge } from '../src/reputation-v0.8/cocm.js';
import { compositeFromMeans, applyGraphBonus, assignTier, GRAPH_BONUS_WEIGHT } from '../src/reputation-v0.8/posteriors.js';
import { AXES, type Axis } from '../src/reputation-v0.8/axes.js';

const prisma = new PrismaClient();

const SEED_WALLETS = (process.env.SEED_WALLETS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const RESTART_ALPHA = Number(process.env.RESTART_ALPHA ?? DEFAULT_EIGENTRUST_PARAMS.restartAlpha);
const MAX_ITER = Number(process.env.MAX_ITER ?? DEFAULT_EIGENTRUST_PARAMS.maxIterations);
const EPSILON = Number(process.env.EPSILON ?? DEFAULT_EIGENTRUST_PARAMS.epsilon);
const COCM = process.env.COCM === 'true';
const COCM_DISCOUNT = Number(process.env.COCM_DISCOUNT ?? 0.3);
const COCM_MIN_CLUSTER = Number(process.env.COCM_MIN_CLUSTER ?? 3);
// Phase 3c — graph bonus weight folded into composite (additive, never a
// penalty). Set to 0 to write eigentrustScore only and leave composite alone.
const GRAPH_BONUS = process.env.GRAPH_BONUS_WEIGHT !== undefined ? Number(process.env.GRAPH_BONUS_WEIGHT) : GRAPH_BONUS_WEIGHT;

async function run() {
  console.log('EigenTrust computation starting');
  console.log(`  seed set:      ${SEED_WALLETS.length} wallets`);
  console.log(`  restart α:     ${RESTART_ALPHA}`);
  console.log(`  max iter:      ${MAX_ITER}`);
  console.log(`  epsilon:       ${EPSILON}`);
  console.log(`  cocm:          ${COCM ? `on (discount=${COCM_DISCOUNT}, minCluster=${COCM_MIN_CLUSTER})` : 'off'}`);
  if (SEED_WALLETS.length === 0) {
    console.log('  ⚠️  WARNING: no seed set — using uniform restart (NOT sybil-resistant).');
  }

  const startedAt = Date.now();

  // Load all TrustEdge rows into memory
  const trustEdges = await prisma.trustEdge.findMany({
    select: { fromWallet: true, toWallet: true, edgeType: true, weight: true },
  });
  console.log(`\nLoaded ${trustEdges.length} TrustEdge rows.`);

  if (trustEdges.length === 0) {
    console.log('No edges to compute over. Exiting.');
    await prisma.$disconnect();
    return;
  }

  // Phase 3b — COCM cluster discount. Reciprocal (mutual-admiration)
  // clusters get their intra-edges downweighted before propagation; the
  // sybil ring collapses while legitimate one-directional stars (Xona's
  // buyers) are untouched. Off by default.
  let workingEdges: RawEdge[] = trustEdges.map((e) => ({
    fromWallet: e.fromWallet,
    toWallet: e.toWallet,
    edgeType: e.edgeType,
    weight: e.weight,
  }));

  if (COCM) {
    const cocm = applyCocmDiscount(workingEdges, {
      baseDiscount: COCM_DISCOUNT,
      minClusterSize: COCM_MIN_CLUSTER,
    });
    workingEdges = cocm.edges;
    console.log(
      `\n── COCM ─────────────────────────────────────────────\n` +
        `  ${cocm.numCommunities} communities; discounted ${cocm.discountedClusters.length} collusive cluster(s), ` +
        `${cocm.intraEdgesDiscounted} edges, ${cocm.weightRemovedTotal.toFixed(1)} weight removed`,
    );
    for (const c of cocm.discountedClusters.slice(0, 10)) {
      console.log(
        `    community size=${String(c.size).padStart(3)} intra=${String(c.intraDirectedEdges).padStart(4)} ` +
          `reciprocity=${c.reciprocity.toFixed(2)} ×${c.appliedDiscount.toFixed(2)}  ` +
          `[${c.members.map((m) => m.slice(0, 8)).join(', ')}…]`,
      );
    }
  }

  const edges: Edge[] = workingEdges.map((e) => ({
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

  // Phase 3c — load the stable per-axis means so we can RE-derive the
  // graph-free base composite for each subject and fold in the graph bonus
  // idempotently (re-deriving from means avoids compounding the bonus on
  // re-runs; the stored compositeScore already includes any prior bonus).
  const meansBySubject = new Map<string, Partial<Record<Axis, number>>>();
  if (GRAPH_BONUS > 0) {
    const meanRows = await prisma.reputationPosterior.findMany({
      select: { subjectWallet: true, axis: true, posteriorMean: true },
    });
    for (const r of meanRows) {
      const m = meansBySubject.get(r.subjectWallet) ?? {};
      m[r.axis as Axis] = r.posteriorMean;
      meansBySubject.set(r.subjectWallet, m);
    }
  }

  // Write back to ReputationPosterior. We update every axis row for each
  // subject — eigentrustScore is per-agent, not per-axis, so it's
  // duplicated across rows (same pattern as compositeScore). When
  // GRAPH_BONUS > 0 we also fold the bonus into compositeScore. Graph-absent
  // subjects (not in result.scores) keep their base composite — their bonus
  // would be 0 anyway.
  console.log(
    `\nUpdating eigentrustScore${GRAPH_BONUS > 0 ? ` + composite (graph bonus w=${GRAPH_BONUS})` : ''}...`,
  );
  let updated = 0;
  for (const [wallet, rawScore] of result.scores) {
    const normalized = normalize(rawScore);
    const data: { eigentrustScore: number; compositeScore?: number } = { eigentrustScore: normalized };
    if (GRAPH_BONUS > 0) {
      const base = compositeFromMeans(meansBySubject.get(wallet) ?? {});
      data.compositeScore = applyGraphBonus(base, normalized, GRAPH_BONUS);
    }
    const r = await prisma.reputationPosterior.updateMany({
      where: { subjectWallet: wallet },
      data,
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

  // ── Post-bonus tier distribution (Phase 3c) ──────────────────────
  // compositeScore now includes the graph bonus for graph-present agents,
  // so re-derive tiers here to show the final picture. Tier isn't a stored
  // column — it's computed from composite + total samples + identity mean.
  if (GRAPH_BONUS > 0) {
    const tierRows = await prisma.reputationPosterior.findMany({
      select: { subjectWallet: true, axis: true, posteriorMean: true, compositeScore: true, sampleSize: true },
    });
    const bySubject = new Map<string, { composite: number; samples: number; identity: number }>();
    for (const r of tierRows) {
      const cur = bySubject.get(r.subjectWallet) ?? { composite: r.compositeScore, samples: 0, identity: 0.5 };
      cur.composite = r.compositeScore; // same across a subject's rows
      cur.samples += r.sampleSize;
      if (r.axis === 'identity') cur.identity = r.posteriorMean;
      bySubject.set(r.subjectWallet, cur);
    }
    const tierCounts: Record<string, number> = { platinum: 0, gold: 0, silver: 0, bronze: 0, unranked: 0 };
    const scored: Array<{ wallet: string; composite: number; samples: number; tier: string }> = [];
    for (const [wallet, s] of bySubject) {
      const tier = assignTier(s.composite, s.samples, s.identity);
      tierCounts[tier]++;
      scored.push({ wallet, composite: s.composite, samples: s.samples, tier });
    }
    console.log('\n── Tier distribution (after graph bonus) ─────────────');
    const total = scored.length || 1;
    for (const t of ['platinum', 'gold', 'silver', 'bronze', 'unranked']) {
      console.log(`  ${t.padEnd(10)} ${String(tierCounts[t]).padStart(5)} (${((tierCounts[t] / total) * 100).toFixed(1)}%)`);
    }
    scored.sort((a, b) => b.composite - a.composite);
    const topComposite = scored.slice(0, 15);
    const tcNames = await prisma.agent.findMany({
      where: { wallet: { in: topComposite.map((t) => t.wallet) } },
      select: { wallet: true, name: true },
    });
    const tcMap = new Map(tcNames.map((a) => [a.wallet, a.name ?? '(unnamed)']));
    console.log('\n── Top 15 by composite (after graph bonus) ───────────');
    console.log(`  ${'name'.padEnd(28)} ${'composite'.padStart(10)} ${'samples'.padStart(8)} tier`);
    for (const t of topComposite) {
      console.log(
        `  ${(tcMap.get(t.wallet) ?? '(unknown)').slice(0, 28).padEnd(28)} ${t.composite.toFixed(4).padStart(10)} ${String(t.samples).padStart(8)} ${t.tier}`,
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

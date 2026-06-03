/**
 * Trust graph + Personalized EigenTrust for reputation v0.8.
 *
 * Pure module — no DB access. Takes edges + seed set + params, returns
 * a score per agent. Drivers in scripts/ handle persistence.
 *
 * Algorithm (see docs/reputation-v0.8.md §5.3):
 *
 *   1. Build a weighted directed graph from TrustEdge rows.
 *      Edge (from, to, weight) means "from endorses/pays/validates to."
 *   2. Row-normalize: for each `from`, divide all outgoing weights by
 *      the total so each row sums to 1. This is the transition matrix.
 *   3. Define a personalization vector `e` with mass concentrated on a
 *      curated seed set of trusted agents (partner-vetted, etc.).
 *   4. Power iteration:
 *        t^{k+1} = (1−α) · M^T · t^k + α · e
 *      with restart probability α = 0.15 (PageRank-standard).
 *   5. Iterate until L1 change < ε or max iterations reached.
 *
 * Sybil-resistance properties (per the research):
 *   - Seed-anchored: a sybil cluster with no edges from the seed set
 *     converges to ~0 score because all flow restarts toward seeds.
 *   - Mass-conserving: total score is bounded; new sybils dilute the
 *     overall pool only proportionally to their incoming edge weight
 *     from already-trusted nodes.
 *
 * What this module does NOT do (Phase 3b+):
 *   - COCM cluster discount on the input edges
 *   - MeritRank decay parameters (transitivity decay, connectivity cap)
 *   - Hitting-time secondary score for mutual-admiration detection
 */

/** Map from event kind to TrustEdge.edgeType. */
export type EdgeType = 'feedback' | 'attestation' | 'validation' | 'payment' | 'vouch';

const EVENT_KIND_TO_EDGE_TYPE: Record<string, EdgeType | null> = {
  // Per-row events that ARE directed graph edges (actor → subject)
  feedback_pos: 'feedback',
  feedback_neg: 'feedback',
  attestation_received: 'attestation',
  validate_work_received: 'validation',
  x402_payment_received: 'payment',
  x402_payment_received_delivery: 'payment',

  // Self-events that are NOT graph edges (actor == subject)
  registered: null,
  verified: null,
  l2_verified: null,
  profile_completed: null,
  operator_bound: null,
  pop_linked: null,
  submit_anchor: null,
  validate_work_done: null,        // the doer side; received side carries the edge
  token_launched: null,
  attestation_given: null,         // giver side; received side carries the edge
  stake: null,
  unstake_lifecycle: null,
  slashed: null,
  dispute_opened_against: null,    // disputes are graph-shaped but handled in Phase 6
  dispute_lost: null,
  dispute_won: null,
  x402_payment_sent: null,         // self-payment "outgoing" event; received-side carries graph
};

export function edgeTypeFor(eventKind: string): EdgeType | null {
  if (!(eventKind in EVENT_KIND_TO_EDGE_TYPE)) return null;
  return EVENT_KIND_TO_EDGE_TYPE[eventKind];
}

// ─── EigenTrust math ────────────────────────────────────────────────

export interface Edge {
  from: string;
  to: string;
  weight: number;
}

export interface EigenTrustParams {
  /** Restart probability α. PageRank standard is 0.15. */
  restartAlpha: number;
  /** Max power-iteration steps. */
  maxIterations: number;
  /** L1 convergence threshold. Stop when ‖t_{k+1} − t_k‖₁ < epsilon. */
  epsilon: number;
}

export const DEFAULT_EIGENTRUST_PARAMS: EigenTrustParams = {
  restartAlpha: 0.15,
  maxIterations: 100,
  epsilon: 1e-6,
};

export interface EigenTrustResult {
  /** Score per agent, summing to 1. */
  scores: Map<string, number>;
  iterations: number;
  /** Final L1 delta — how much t changed in the last iteration. */
  finalDelta: number;
  /** Was the seed-set personalization vector empty (uniform fallback)? */
  uniformFallback: boolean;
}

/**
 * Run personalized EigenTrust over an edge list.
 *
 * @param edges       Directed weighted edges. Multiple edges between the
 *                    same (from, to) pair are summed.
 * @param allNodes    The complete set of nodes to score. Nodes with no
 *                    edges still get a score (initialized at the
 *                    personalization vector).
 * @param seedSet     Agents to anchor trust on. Empty = uniform restart
 *                    (falls back to vanilla PageRank, NOT sybil-resistant).
 * @param params      Optional override of restart/iterations/epsilon.
 */
export function runEigenTrust(
  edges: Edge[],
  allNodes: string[],
  seedSet: string[],
  params: EigenTrustParams = DEFAULT_EIGENTRUST_PARAMS,
): EigenTrustResult {
  const n = allNodes.length;
  if (n === 0) {
    return { scores: new Map(), iterations: 0, finalDelta: 0, uniformFallback: true };
  }

  // Personalization vector e
  const seedSetActual = seedSet.filter((s) => allNodes.includes(s));
  const uniformFallback = seedSetActual.length === 0;
  const e = new Map<string, number>();
  if (uniformFallback) {
    for (const node of allNodes) e.set(node, 1 / n);
  } else {
    const mass = 1 / seedSetActual.length;
    for (const node of allNodes) e.set(node, 0);
    for (const seed of seedSetActual) e.set(seed, mass);
  }

  // Group outgoing edges by `from` and compute row sums for normalization.
  const outgoing = new Map<string, Edge[]>();
  const outSum = new Map<string, number>();
  for (const edge of edges) {
    if (edge.weight <= 0) continue;
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge);
    outgoing.set(edge.from, list);
    outSum.set(edge.from, (outSum.get(edge.from) ?? 0) + edge.weight);
  }

  // Initial score vector = personalization vector
  let t = new Map<string, number>(e);

  let iterations = 0;
  let finalDelta = Infinity;
  for (let iter = 0; iter < params.maxIterations; iter++) {
    iterations = iter + 1;
    const tNext = new Map<string, number>();
    for (const node of allNodes) tNext.set(node, params.restartAlpha * (e.get(node) ?? 0));

    // Add (1−α) · M^T · t : flow score from `from` to its out-neighbors
    for (const [from, edgeList] of outgoing) {
      const tFrom = t.get(from) ?? 0;
      if (tFrom === 0) continue;
      const rowSum = outSum.get(from) ?? 0;
      if (rowSum <= 0) continue;
      const factor = (1 - params.restartAlpha) * tFrom;
      for (const edge of edgeList) {
        const share = factor * (edge.weight / rowSum);
        tNext.set(edge.to, (tNext.get(edge.to) ?? 0) + share);
      }
    }

    // Dangling-node mass redistribution: any `from` with no outgoing
    // edges leaks score. Re-add their (1−α) · t mass to the personalization
    // vector so total mass is conserved.
    let danglingMass = 0;
    for (const node of allNodes) {
      if (!outgoing.has(node)) danglingMass += t.get(node) ?? 0;
    }
    if (danglingMass > 0) {
      const factor = (1 - params.restartAlpha) * danglingMass;
      for (const node of allNodes) {
        const share = factor * (e.get(node) ?? 0);
        tNext.set(node, (tNext.get(node) ?? 0) + share);
      }
    }

    // Convergence check (L1 norm)
    let delta = 0;
    for (const node of allNodes) {
      delta += Math.abs((tNext.get(node) ?? 0) - (t.get(node) ?? 0));
    }
    t = tNext;
    finalDelta = delta;
    if (delta < params.epsilon) break;
  }

  return { scores: t, iterations, finalDelta, uniformFallback };
}

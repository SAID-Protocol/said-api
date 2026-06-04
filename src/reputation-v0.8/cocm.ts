/**
 * COCM — collusion-cluster discount for reputation v0.8 (Phase 3b).
 *
 * Two consumers, one detector:
 *   1. Graph path (v8-compute-eigentrust): discount intra-cluster EDGE
 *      weights before EigenTrust. Useful at cluster boundaries.
 *   2. Posterior path (v8-compute-signals): COLLAPSE collusive feedback
 *      toward a single signal before it inflates an agent's Beta posterior.
 *      This is the lever that actually moves tiers — see the note below.
 *
 * The problem, observed in our data: a ~35-agent cluster (EgGjpCck…,
 * 6cQkUCsQ…, 5i1hAmy2… and friends) leave each OTHER positive feedback —
 * high internal reciprocity — and ride it to silver. Genuine agents
 * (Xona) earn trust one-directionally (buyers pay her; she doesn't pay
 * them back), so reciprocity cleanly separates collusion from legitimacy.
 *
 * Why edge-discount alone doesn't work, and collapse does:
 *   - EigenTrust row-normalizes outgoing edges, so scaling ALL of a ring
 *     member's intra-edges by the same factor cancels out. The graph
 *     barely moves.
 *   - A ring member's silver tier comes from their feedback POSTERIOR, not
 *     the graph. And a Beta mean saturates: 50 endorsements → mean ~0.96,
 *     and a 0.3× discount only nudges it. But effectiveSamples (= α+β−prior)
 *     gates the tier (silver needs ≥10), and THAT scales linearly. So we
 *     collapse a collusive cluster's feedback toward a single signal:
 *     effectiveSamples crater, and the ring drops through the sample-gate.
 *
 * Reciprocity drives the magnitude of both operations:
 *   effectiveDiscount = 1 − (1 − baseDiscount)·reciprocity   (edge path)
 *   collapse          = lerp(fullSum → singleSignal, reciprocity)  (posterior path)
 *   reciprocity 0 (one-directional star) → untouched.
 *   reciprocity 1 (tight ring)           → full discount / full collapse.
 *
 * Pure module — no DB.
 */
import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';

export interface RawEdge {
  fromWallet: string;
  toWallet: string;
  edgeType: string;
  weight: number;
}

export interface CocmParams {
  /** Floor multiplier a maximally-collusive (reciprocity=1) cluster's edges are scaled to. */
  baseDiscount: number; // default 0.3
  /** Minimum cluster size to be eligible for discount/collapse — a 2-node back-and-forth is plausibly legit. */
  minClusterSize: number; // default 3
}

export const DEFAULT_COCM_PARAMS: CocmParams = {
  baseDiscount: 0.3,
  minClusterSize: 3,
};

function pairKey(a: string, b: string): string {
  return `${a}|${b}`;
}

// ── Detection ───────────────────────────────────────────────────────

export interface ClusterDetection {
  /** node wallet → community id */
  communityOf: Map<string, number>;
  /** community id → internal directed-edge reciprocity in [0,1] */
  reciprocityOf: Map<number, number>;
  /** community id → member count */
  sizeOf: Map<number, number>;
  /** community id → member wallets */
  membersOf: Map<number, string[]>;
  /** communities eligible for discount/collapse (size ≥ minClusterSize) */
  flagged: Set<number>;
  numCommunities: number;
}

/**
 * Run undirected Louvain on the (weight-collapsed) graph, then measure each
 * community's internal directed reciprocity. No mutation of the input.
 */
export function detectClusters(edges: RawEdge[], params: Partial<CocmParams> = {}): ClusterDetection {
  const { minClusterSize } = { ...DEFAULT_COCM_PARAMS, ...params };

  const g = new Graph({ type: 'undirected', multi: false });
  for (const e of edges) {
    if (e.fromWallet === e.toWallet) continue;
    if (!g.hasNode(e.fromWallet)) g.addNode(e.fromWallet);
    if (!g.hasNode(e.toWallet)) g.addNode(e.toWallet);
    if (g.hasEdge(e.fromWallet, e.toWallet)) {
      const prev = (g.getEdgeAttribute(e.fromWallet, e.toWallet, 'weight') as number) ?? 0;
      g.setEdgeAttribute(e.fromWallet, e.toWallet, 'weight', prev + e.weight);
    } else {
      g.addEdge(e.fromWallet, e.toWallet, { weight: e.weight });
    }
  }

  if (g.order === 0) {
    return {
      communityOf: new Map(),
      reciprocityOf: new Map(),
      sizeOf: new Map(),
      membersOf: new Map(),
      flagged: new Set(),
      numCommunities: 0,
    };
  }

  const communities = louvain(g, { getEdgeWeight: 'weight' }) as Record<string, number>;
  const communityOf = new Map<string, number>(Object.entries(communities));

  const membersOf = new Map<number, string[]>();
  for (const [node, c] of communityOf) {
    const arr = membersOf.get(c) ?? [];
    arr.push(node);
    membersOf.set(c, arr);
  }
  const sizeOf = new Map<number, number>();
  for (const [c, arr] of membersOf) sizeOf.set(c, arr.length);

  // Directed intra-community edge sets, for reciprocity.
  const directedIntra = new Map<number, Set<string>>();
  for (const e of edges) {
    if (e.fromWallet === e.toWallet) continue;
    const ca = communityOf.get(e.fromWallet);
    const cb = communityOf.get(e.toWallet);
    if (ca === undefined || ca !== cb) continue;
    const set = directedIntra.get(ca) ?? new Set<string>();
    set.add(pairKey(e.fromWallet, e.toWallet));
    directedIntra.set(ca, set);
  }

  const reciprocityOf = new Map<number, number>();
  for (const [c, set] of directedIntra) {
    let mutual = 0;
    for (const key of set) {
      const [a, b] = key.split('|');
      if (set.has(pairKey(b, a))) mutual++;
    }
    reciprocityOf.set(c, set.size > 0 ? mutual / set.size : 0);
  }

  const flagged = new Set<number>();
  for (const [c, size] of sizeOf) {
    if (size >= minClusterSize) flagged.add(c);
  }

  return {
    communityOf,
    reciprocityOf,
    sizeOf,
    membersOf,
    flagged,
    numCommunities: sizeOf.size,
  };
}

// ── Graph-path: edge discount ───────────────────────────────────────

export interface ClusterReport {
  community: number;
  size: number;
  intraDirectedEdges: number;
  reciprocity: number;
  appliedDiscount: number; // multiplier applied to this cluster's intra edges (1 = untouched)
  members: string[];
}

export interface CocmResult {
  edges: RawEdge[];
  numCommunities: number;
  discountedClusters: ClusterReport[];
  intraEdgesDiscounted: number;
  weightRemovedTotal: number;
}

/**
 * Detect communities and apply a reciprocity-scaled discount to
 * intra-cluster edge weights. Used by the EigenTrust graph path.
 */
export function applyCocmDiscount(edges: RawEdge[], params: Partial<CocmParams> = {}): CocmResult {
  const { baseDiscount, minClusterSize } = { ...DEFAULT_COCM_PARAMS, ...params };
  const det = detectClusters(edges, { minClusterSize });

  const discountOf = new Map<number, number>();
  for (const c of det.flagged) {
    const recip = det.reciprocityOf.get(c) ?? 0;
    discountOf.set(c, 1 - (1 - baseDiscount) * recip);
  }

  // Count directed intra edges per community for reporting.
  const intraCount = new Map<number, number>();
  for (const e of edges) {
    if (e.fromWallet === e.toWallet) continue;
    const ca = det.communityOf.get(e.fromWallet);
    if (ca === undefined || ca !== det.communityOf.get(e.toWallet)) continue;
    intraCount.set(ca, (intraCount.get(ca) ?? 0) + 1);
  }

  let intraEdgesDiscounted = 0;
  let weightRemovedTotal = 0;
  const discountedEdges = edges.map((e) => {
    if (e.fromWallet === e.toWallet) return e;
    const ca = det.communityOf.get(e.fromWallet);
    if (ca === undefined || ca !== det.communityOf.get(e.toWallet)) return e;
    const mult = discountOf.get(ca) ?? 1;
    if (mult >= 1) return e;
    intraEdgesDiscounted++;
    const newWeight = e.weight * mult;
    weightRemovedTotal += e.weight - newWeight;
    return { ...e, weight: newWeight };
  });

  const discountedClusters: ClusterReport[] = [];
  for (const [c, mult] of discountOf) {
    if (mult >= 1) continue;
    discountedClusters.push({
      community: c,
      size: det.sizeOf.get(c) ?? 0,
      intraDirectedEdges: intraCount.get(c) ?? 0,
      reciprocity: det.reciprocityOf.get(c) ?? 0,
      appliedDiscount: mult,
      members: (det.membersOf.get(c) ?? []).slice(0, 6),
    });
  }
  discountedClusters.sort((a, b) => a.appliedDiscount - b.appliedDiscount);

  return {
    edges: discountedEdges,
    numCommunities: det.numCommunities,
    discountedClusters,
    intraEdgesDiscounted,
    weightRemovedTotal,
  };
}

// ── Posterior-path: feedback collapse ───────────────────────────────

export interface CollapseResult {
  /** Effective contribution after collapse — replaces the raw collusive sum. */
  effectiveCollusiveWeight: number;
  /** How much raw weight was removed (collusiveWeight − effective). */
  weightRemoved: number;
  /** Distinct collusive raters folded into one synthetic signal. */
  collusiveActors: number;
}

/**
 * Collapse a subject's same-cluster (collusive) feedback toward a single
 * signal, scaled by the cluster's reciprocity.
 *
 *   effective = collusiveWeight·(1 − reciprocity) + singleSignal·reciprocity
 *
 * Reciprocity gates this: a one-directional star (legitimate hub endorsed
 * by many independent raters who don't endorse each other) has reciprocity
 * 0 and is left COMPLETELY untouched — Louvain groups it into one community
 * by size, but size alone is not collusion. Only mutual-endorsement rings
 * (reciprocity ≥ minReciprocity) are collapsed.
 *
 * @param subject        the agent receiving feedback
 * @param actorWeights   rater wallet → raw feedback weight for this subject
 * @param det            cluster detection result
 * @param minReciprocity collapse only clusters at or above this reciprocity
 * @returns null if the subject's cluster isn't collusive enough, has no
 *          collusive raters, or nothing would be removed (caller leaves the
 *          accumulator untouched)
 */
export function collapseCollusiveFeedback(
  subject: string,
  actorWeights: Map<string, number>,
  det: ClusterDetection,
  minReciprocity = 0.3,
): CollapseResult | null {
  const subjComm = det.communityOf.get(subject);
  if (subjComm === undefined || !det.flagged.has(subjComm)) return null;

  // Reciprocity gate — a legit star (reciprocity 0) is never collapsed.
  const recip = det.reciprocityOf.get(subjComm) ?? 0;
  if (recip < minReciprocity) return null;

  let collusiveWeight = 0;
  let collusiveActors = 0;
  let singleSignal = 0;
  for (const [actor, w] of actorWeights) {
    if (det.communityOf.get(actor) === subjComm) {
      collusiveWeight += w;
      collusiveActors++;
      if (w > singleSignal) singleSignal = w;
    }
  }
  if (collusiveActors === 0 || collusiveWeight <= 0) return null;

  const effective = collusiveWeight * (1 - recip) + singleSignal * recip;
  if (effective >= collusiveWeight - 1e-9) return null; // nothing meaningful to remove

  return {
    effectiveCollusiveWeight: effective,
    weightRemoved: Math.max(0, collusiveWeight - effective),
    collusiveActors,
  };
}

/**
 * Mutual-pair feedback collapse — the sharper, partition-immune variant.
 *
 * A rater R of subject X is COLLUSIVE iff X also left feedback for R (the
 * pair mutually endorse). Genuine feedback is one-directional — a happy
 * customer endorses X; X doesn't review them back — so legit hubs have zero
 * mutual raters and are untouched. A mutual-admiration RING is dense with
 * mutual pairs, so its members' feedback collapses hard.
 *
 * Unlike the Louvain-community variant, this doesn't care how the graph is
 * partitioned: it looks only at the direct X↔R reciprocal relationship, so
 * cross-sub-cluster back-scratching can't escape it.
 *
 * The whole mutual group collapses to the value of a SINGLE signal (the
 * doc's "feedback from a clustered ring collapses toward the value of a
 * single signal") — N mutual endorsements count as one.
 *
 * @param actorWeights   rater wallet → raw feedback weight for this subject
 * @param subjectEndorsed wallets THIS subject left feedback for (the X→· set)
 * @param minMutual      need at least this many mutual raters to collapse
 *                       (a single reciprocal pair is plausibly legit)
 * @returns null if fewer than minMutual mutual raters (leave untouched)
 */
export function collapseMutualFeedback(
  actorWeights: Map<string, number>,
  subjectEndorsed: Set<string>,
  minMutual = 2,
): CollapseResult | null {
  if (subjectEndorsed.size === 0) return null;

  let collusiveWeight = 0;
  let collusiveActors = 0;
  let singleSignal = 0;
  for (const [actor, w] of actorWeights) {
    if (subjectEndorsed.has(actor)) {
      collusiveWeight += w;
      collusiveActors++;
      if (w > singleSignal) singleSignal = w;
    }
  }
  if (collusiveActors < minMutual || collusiveWeight <= 0) return null;

  // Full collapse: the mutual group is worth one endorsement.
  const effective = singleSignal;
  if (effective >= collusiveWeight - 1e-9) return null;

  return {
    effectiveCollusiveWeight: effective,
    weightRemoved: Math.max(0, collusiveWeight - effective),
    collusiveActors,
  };
}

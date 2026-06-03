/**
 * COCM — cluster-discount for the trust graph (reputation v0.8 Phase 3b).
 *
 * The problem this solves, observed directly in our data: a ring of ~8
 * agents (EgGjpCckE54f…, 6cQkUCsQHJGJ…, 5i1hAmy2gSVQ… and friends) endorse
 * each OTHER — they appear in both the top-inbound and top-outbound edge
 * lists. Uniform EigenTrust rewards that mutual-admiration loop; seeds
 * can't reach it. We need to downweight collusive intra-cluster edges so a
 * sybil farm of size k earns far less than k× the reputation.
 *
 * Why not the naive "Louvain, then flat-discount every intra-cluster edge"
 * the design doc sketches:
 *   Louvain groups Xona's 145 buyers into one community (a dense star).
 *   A flat discount would crush the legitimate hub we just rescued. The
 *   distinction that matters is RECIPROCITY, not cluster membership:
 *     - sybil ring:  A→B and B→A both exist (mutual endorsement)
 *     - payment star: buyer→Xona only; Xona never pays the buyer back
 *   So we scale each community's discount by its internal reciprocity. A
 *   perfectly reciprocal cluster gets the full discount; a one-directional
 *   star (reciprocity 0) is left untouched.
 *
 * Pure module — no DB. Takes directed edges, returns a discounted edge
 * list plus a report. The caller re-runs EigenTrust on the result.
 */
import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';

export interface RawEdge {
  fromWallet: string;
  toWallet: string;
  edgeType: string;
  weight: number;
}

export interface ClusterReport {
  community: number;
  size: number;
  intraDirectedEdges: number;
  reciprocity: number; // 0..1 — fraction of intra edges whose reverse also exists
  appliedDiscount: number; // multiplier actually applied to this cluster's intra edges (1 = untouched)
  members: string[]; // up to a few, for the log
}

export interface CocmResult {
  edges: RawEdge[]; // discounted edge list (same length/order as input)
  numCommunities: number;
  discountedClusters: ClusterReport[]; // clusters that received < 1.0 discount, worst first
  intraEdgesDiscounted: number;
  weightRemovedTotal: number;
}

export interface CocmParams {
  /** Floor multiplier a maximally-collusive (reciprocity=1) cluster's edges are scaled to. */
  baseDiscount: number; // default 0.3
  /** Minimum cluster size to be eligible for discount — a 2-node back-and-forth is plausibly legit. */
  minClusterSize: number; // default 3
}

export const DEFAULT_COCM_PARAMS: CocmParams = {
  baseDiscount: 0.3,
  minClusterSize: 3,
};

function pairKey(a: string, b: string): string {
  return `${a}|${b}`;
}

/**
 * Detect communities (undirected Louvain on collapsed weights) and apply a
 * reciprocity-scaled discount to intra-cluster edges.
 */
export function applyCocmDiscount(edges: RawEdge[], params: Partial<CocmParams> = {}): CocmResult {
  const { baseDiscount, minClusterSize } = { ...DEFAULT_COCM_PARAMS, ...params };

  // 1. Build an undirected, weight-collapsed graph for community detection.
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
    return { edges, numCommunities: 0, discountedClusters: [], intraEdgesDiscounted: 0, weightRemovedTotal: 0 };
  }

  // 2. Louvain → node → community id.
  const communities = louvain(g, { getEdgeWeight: 'weight' }) as Record<string, number>;
  const commOf = new Map<string, number>(Object.entries(communities));
  const numCommunities = new Set(commOf.values()).size;

  // 3. Per-community structure: members + directed intra-edge set (for reciprocity).
  const members = new Map<number, string[]>();
  for (const [node, c] of commOf) {
    const arr = members.get(c) ?? [];
    arr.push(node);
    members.set(c, arr);
  }

  const directedIntra = new Map<number, Set<string>>(); // community → set of "from|to"
  for (const e of edges) {
    if (e.fromWallet === e.toWallet) continue;
    const ca = commOf.get(e.fromWallet);
    const cb = commOf.get(e.toWallet);
    if (ca === undefined || ca !== cb) continue;
    const set = directedIntra.get(ca) ?? new Set<string>();
    set.add(pairKey(e.fromWallet, e.toWallet));
    directedIntra.set(ca, set);
  }

  // 4. Compute each community's reciprocity → effective discount multiplier.
  //    effectiveDiscount = 1 - (1 - baseDiscount) * reciprocity
  //      reciprocity 0  → 1.0   (no discount; legit star)
  //      reciprocity 1  → baseDiscount (full discount; tight ring)
  const discountOf = new Map<number, number>();
  const reciprocityOf = new Map<number, number>();
  for (const [c, set] of directedIntra) {
    const size = members.get(c)?.length ?? 0;
    const total = set.size;
    let mutual = 0;
    for (const key of set) {
      const [a, b] = key.split('|');
      if (set.has(pairKey(b, a))) mutual++;
    }
    const reciprocity = total > 0 ? mutual / total : 0;
    reciprocityOf.set(c, reciprocity);
    const eligible = size >= minClusterSize;
    discountOf.set(c, eligible ? 1 - (1 - baseDiscount) * reciprocity : 1);
  }

  // 5. Apply discount to intra-cluster edges; track what was removed.
  let intraEdgesDiscounted = 0;
  let weightRemovedTotal = 0;
  const discountedEdges = edges.map((e) => {
    if (e.fromWallet === e.toWallet) return e;
    const ca = commOf.get(e.fromWallet);
    const cb = commOf.get(e.toWallet);
    if (ca === undefined || ca !== cb) return e;
    const mult = discountOf.get(ca) ?? 1;
    if (mult >= 1) return e;
    intraEdgesDiscounted++;
    const newWeight = e.weight * mult;
    weightRemovedTotal += e.weight - newWeight;
    return { ...e, weight: newWeight };
  });

  // 6. Build the report, worst (lowest multiplier) first.
  const discountedClusters: ClusterReport[] = [];
  for (const [c, mult] of discountOf) {
    if (mult >= 1) continue;
    discountedClusters.push({
      community: c,
      size: members.get(c)?.length ?? 0,
      intraDirectedEdges: directedIntra.get(c)?.size ?? 0,
      reciprocity: reciprocityOf.get(c) ?? 0,
      appliedDiscount: mult,
      members: (members.get(c) ?? []).slice(0, 6),
    });
  }
  discountedClusters.sort((a, b) => a.appliedDiscount - b.appliedDiscount);

  return {
    edges: discountedEdges,
    numCommunities,
    discountedClusters,
    intraEdgesDiscounted,
    weightRemovedTotal,
  };
}

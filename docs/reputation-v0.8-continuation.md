# Reputation v0.8 — Continuation Plan

**Picking up from:** completion of Phase 3a (TrustEdge + uniform EigenTrust).
**Branch:** `feat/reputation-v0.8`
**Last commit before handoff:** `b867cc7 v0.8 Phase 3a: TrustEdge graph + personalized EigenTrust`

This document is a self-contained guide to continue the v0.8 build. Every command, every file, every decision rationale is here. You don't need to re-read the chat history.

---

## Where we are right now

### What's built and working

| Phase | What it does | Files |
|---|---|---|
| **1a** | Schema for v0.8 (7 new tables: ReputationEvent, ReputationSignal, TrustEdge, ReputationPosterior, Operator, OperatorAgent, Dispute) | `prisma/schema.prisma` |
| **1b** | Event log + idempotent backfill from existing tables | `src/reputation-v0.8/{axes,kinds,ingest}.ts`, `scripts/v8-backfill-events.ts` |
| **1c** | Decay machinery + per-(subject,axis,kind) signal accumulators | `src/reputation-v0.8/decay.ts`, `scripts/v8-compute-signals.ts` |
| **2a** | Beta posterior aggregation + composite + tier assignment | `src/reputation-v0.8/posteriors.ts`, `scripts/v8-compute-posteriors.ts` |
| **3a** | TrustEdge graph + personalized EigenTrust power iteration | `src/reputation-v0.8/graph.ts`, `scripts/v8-build-edges.ts`, `scripts/v8-compute-eigentrust.ts` |

### Data state in prod (as of last run)

- **10,263 ReputationEvent rows** (after weight-policy fix to linear-per-counterparty)
- **9,952 ReputationSignal rows** (accumulators with decay)
- **21,975 ReputationPosterior rows** (5 axes × 4,395 subjects)
- **352 TrustEdge rows** (350 feedback + 2 attestation)
- **42 distinct nodes in the trust graph** (~1% of agents — the rest have only self-events)

### Current tier distribution

```
platinum     0 (0.0%)    — Xona is close at composite 0.79 but needs ≥0.85
gold         1 (0.0%)    — Xona Agent
silver      35 (0.8%)    — agents with real feedback or anchor evidence
bronze    4359 (99.2%)   — verified-but-quiet majority
unranked     0 (0.0%)
```

### Known findings from Phase 3a output

**Sybil cluster confirmed in the data:**
- 3 agents (`EgGjpCckE54fPT…`, `6cQkUCsQHJGJZh…`, `5i1hAmy2gSVQzs…`) each show ~26 inbound + 35 outbound feedback edges
- Secondary tier of ~5 agents (`5ugCP6qhA3faxP…`, `J65J6QTCpBTmbs…`, etc.) at 19 outbound edges each
- Multiple "Cinematic Prompt Architect" + "Cinematic Architect" duplicate-named entries with identical α/β/composite

**Critical architectural gap — Xona has 0 graph footprint:**
- Her 580 x402 buyers have `actorWallet: null` in our events (we never ingested per-tx data)
- So no inbound edges → EigenTrust assigns her ~0 trust mass
- Same problem for SlimeBot, GUSTAV, KaiNova, Maynard, "Your name is lion", Claude Made Me a Millionaire, Degenerate Soldier, RAIDERS, saidagent — 10 agents total with `composite > 0.60 AND eigentrust < 0.01`
- These are the *real* high-quality agents the graph can't see

---

## Immediate next step (recommended)

### **Per-tx x402 ingestion — the biggest single unlock**

This adds **580 buyer→seller edges for Xona alone**, plus 8+ for Sol, Kai, and the other x402-active agents. The graph grows from 42 nodes → 600+ nodes. EigenTrust suddenly has real signal.

**You need to build this script:** `scripts/sync-x402-per-tx.ts`

**What it should do:**

1. Read `AgentX402Activity` rows (only the ones with `providerUniqueBuyers > 0` — currently just Xona, possibly a few others).
2. For each provider wallet, hit x402scan's tRPC endpoint to get the list of distinct buyers (per-recipient transactions endpoint).
3. For each buyer wallet found, emit a `ReputationEvent` with:
   - `kind`: `x402_payment_received` (axis: payments)
   - AND a second event with `kind: x402_payment_received_delivery` (axis: delivery)
   - `subjectWallet`: the provider (e.g., Xona)
   - **`actorWallet`: the buyer wallet** ← this is the key change vs current backfill
   - `weight`: 1.0 per buyer (one buyer = one unit of evidence)
   - `sourceKey`: `x402:pertx:<provider>:<buyer>:<axis>` — deterministic, idempotent

4. After this script runs, re-run the pipeline:
   ```
   npx tsx scripts/v8-compute-signals.ts        # recompute decayed accumulators
   npx tsx scripts/v8-compute-posteriors.ts     # recompute Beta + composite + tier
   npx tsx scripts/v8-build-edges.ts            # rebuild TrustEdge with new edges
   npx tsx scripts/v8-compute-eigentrust.ts     # rerun with new graph
   ```

**x402scan API reference (we already know this works, no auth needed):**

To find buyers of a specific recipient:
```
GET https://www.x402scan.com/api/trpc/public.buyers.all.list?input=<url-encoded-json>
```
Where the input is:
```json
{
  "json": {
    "timeframe": 0,
    "senders": { "include": [<list_of_buyer_wallets>] },
    "pagination": { "page": 0, "page_size": 500 }
  }
}
```

But for *per-recipient buyers*, the better path is the transactions endpoint. Tip: walk the live x402scan recipient page (`https://www.x402scan.com/recipient/<wallet>/transactions`) for the API shape, OR check `apps/scan/src/trpc/routers/public/buyers.ts` in the Merit-Systems/x402scan repo for `all.sellers` which lists which sellers a buyer paid (the inverse — useful for buyer-side activity).

**Estimated runtime:** 1-2 minutes total (small number of providers, each with ≤1000 buyers).

**Predicted impact:** Xona ends up with ~580 inbound edges from real buyers. EigenTrust correctly identifies her as the highest-trust agent. The divergence check shrinks dramatically.

---

## All Railway start commands you might need

Branch is always `feat/reputation-v0.8`. Same `score-backfill` service. Just rotate the Start Command.

| Operation | Start Command | Runtime | When to run |
|---|---|---|---|
| Schema sync | `npx prisma db push --skip-generate --accept-data-loss` | 1 sec | After any schema change |
| Initial event backfill | `npx tsx scripts/v8-backfill-events.ts` | ~30 sec | After schema sync |
| Re-emit batched events (only x402 + said) | `npx tsx scripts/v8-rebackfill-batched.ts` | ~5 sec | After weight policy changes |
| Compute signals | `npx tsx scripts/v8-compute-signals.ts` | ~3 sec | After any event change |
| Compute posteriors | `npx tsx scripts/v8-compute-posteriors.ts` | ~5 sec | After signal change |
| Build TrustEdge | `npx tsx scripts/v8-build-edges.ts` | ~1 sec | After event change |
| Compute EigenTrust | `npx tsx scripts/v8-compute-eigentrust.ts` | ~1 sec | After TrustEdge change |
| **Per-tx x402 sync** *(TO BE BUILT)* | `npx tsx scripts/sync-x402-per-tx.ts` | ~2 min | One-time, then daily |

### Standard recompute order after a data change

```
1. (optional) wipe events: v8-rebackfill-batched.ts OR custom delete
2. emit events:           v8-backfill-events.ts (or your new script)
3. recompute signals:     v8-compute-signals.ts
4. recompute posteriors:  v8-compute-posteriors.ts
5. rebuild edges:         v8-build-edges.ts
6. recompute eigentrust:  v8-compute-eigentrust.ts
```

---

## Environment variables to keep set

In Railway → `score-backfill` service → Variables tab:

| Variable | Value | Notes |
|---|---|---|
| `DATABASE_URL` | reference from Postgres service | Required for all scripts |
| `FAIRSCALE_API_URL` | reference from `said-api` | Used by v0.6/v0.7 sync workers, not v0.8 |
| `FAIRSCALE_API_KEY` | reference from `said-api` | Same |
| `SOLANA_RPC_URL` | your Alchemy URL | Used by `sync-said-engagement` and the new per-tx x402 sync if needed |
| `SEED_WALLETS` | *(see below)* | EigenTrust seed set — comma-separated wallets |

### Recommended seed wallets

Add this to `SEED_WALLETS` when running EigenTrust:
```
72nwTgEMwfuiqHoCr9Z5khjDRnpTPEhJiSJQzccX99b7,32Trg3pfRtCi5S1iZHoyHjbZA832ZJgThXPVfMVCAo3u
```
- `72nwTgEMwfui…` = squire_bot
- `32Trg3pfRtCi…` = NemoClaw

**Caveat:** Both of these are builder-type agents and probably have no outgoing edges in the current graph (they don't leave peer feedback). So seeding with them is mostly cosmetic until per-tx x402 ingestion is built. After per-tx x402 is in, the graph will have hundreds of independent buyer wallets and seeds will matter more.

---

## Roadmap beyond per-tx x402

Once per-tx x402 lands, the next priorities (each ~1 day of work):

### Phase 3b — COCM cluster discount
Detects dense intra-cluster edges via Louvain community detection on the trust graph. Discounts edges within the same cluster so the feedback-ring sybils we can see in the data get downweighted automatically. Works without seeds. **This is the durable answer to the cluster problem.**

Implementation outline:
- New file `src/reputation-v0.8/cocm.ts`
- Run Louvain on TrustEdge weighted graph
- For each cluster found, multiply intra-cluster edge weights by a discount factor (start with 0.3)
- Re-run EigenTrust

Resources: `npm install graphology graphology-communities-louvain`

### Phase 3c — Fold EigenTrust into composite
Update `src/reputation-v0.8/posteriors.ts` `computeComposite()` to incorporate `eigentrustScore`. Two options:
1. Multiply final composite by `(0.5 + 0.5 * eigentrust)` — graph score as a multiplier
2. Add a 6th pseudo-axis `'graph'` with weight 0.15-0.20, posterior mean = eigentrust

Option 2 is cleaner. Option 1 is more punishing (an agent with zero eigentrust loses half their score).

### Phase 2b — First v0.8 API endpoint
Build `GET /api/reputation/v8/:wallet` in `src/index.ts`. Returns:
- Full per-axis posteriors with `α`, `β`, mean, variance, lowerBound95
- EigenTrust score
- Composite score + tier
- Evidence payload (top contributing signals per axis from `topSourcesJson`)
- Operator binding info (if any)

Spec is in `docs/reputation-v0.8.md` §6.

### Phase 4 — KYA operator layer
Build the `Operator` and `OperatorAgent` flow. Allows agents to bind to a Privy-verified human or org for the verified-tier multiplier.

### Phase 5-7 — see `docs/reputation-v0.8.md` §9 (build sequence table)

---

## Files to know

```
docs/reputation-v0.8.md                  ← full design doc (the source of truth)
docs/reputation-v0.8-continuation.md     ← this file

src/reputation-v0.8/
  axes.ts        ← axis vocabulary (identity, delivery, payments, validation, community)
  kinds.ts       ← event kind catalog with default axis/polarity/weight
  ingest.ts      ← emitEvent() helper (idempotent on sourceKey)
  decay.ts       ← decay math + half-life policy
  posteriors.ts  ← Beta aggregation + composite + tier
  graph.ts       ← TrustEdge mapping + EigenTrust power iteration

scripts/
  v8-backfill-events.ts        ← emit events from existing tables
  v8-rebackfill-batched.ts     ← wipe x402+said events for re-emission
  v8-compute-signals.ts        ← signal accumulators with decay
  v8-compute-posteriors.ts     ← posteriors + composite + tier
  v8-build-edges.ts            ← TrustEdge from events
  v8-compute-eigentrust.ts     ← EigenTrust power iteration
  (TO BUILD) sync-x402-per-tx.ts  ← per-tx x402 ingestion with buyer wallets
```

---

## What to do first when you sit down at the laptop

**If you have ~2 hours:** Build `scripts/sync-x402-per-tx.ts`. It's the biggest unlock and unblocks meaningful EigenTrust evaluation.

**If you have ~30 min:** Run the existing seeded EigenTrust to see how Squire+NEMO seeds change the output. Useful sanity-check even if mostly cosmetic.

**If you want to vibe:** Read `docs/reputation-v0.8.md` start to finish. It's the design grounded in 5 streams of production research and it'll make every subsequent decision easier.

---

## Final sanity check before continuing

If something seems off after picking up, run these to verify the data state is consistent:

```sql
SELECT COUNT(*) FROM "ReputationEvent";          -- expect ~10,263
SELECT COUNT(*) FROM "ReputationSignal";         -- expect ~9,952
SELECT COUNT(*) FROM "ReputationPosterior";      -- expect ~21,975
SELECT COUNT(*) FROM "TrustEdge";                -- expect ~352
SELECT COUNT(DISTINCT "subjectWallet") FROM "ReputationPosterior"; -- expect ~4,395
```

If those numbers match, you're picking up exactly where we stopped.

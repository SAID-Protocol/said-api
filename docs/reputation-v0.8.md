# SAID Reputation v0.8 — Design Document

**Status:** Draft  
**Author:** Kai + Jugmaster  
**Branch:** `feat/reputation-v0.8`  
**Replaces:** v0.6 (production) and v0.7 (never shipped)

---

## 1. Why we're doing this

The v0.7 effort taught us — at cost — that reputation is not "sum a bunch of signals and pick tier cuts." Every production reputation system that has survived past its first release (FICO, Stack Overflow, EigenLayer, OpenRank, MeritRank) converged on a small set of architectural patterns we don't currently have:

- **Time-decay**, not lifetime accumulation
- **Graph propagation**, not additive scoring
- **Bayesian uncertainty**, not point estimates
- **Multi-axis vectored output**, not a single number
- **Stake-backed claims**, not unweighted signals
- **Explainability** — score with evidence, not score alone

v0.7 had none of these structurally. No amount of weight tuning fixes that.

v0.8 is the rewrite — grounded in 5 streams of production research (graph reputation, agent-economy survey, sybil resistance, lifecycle handling, quality signals) — that delivers a system competitive with what shipping protocols actually use.

## 2. Design principles

These are the constraints every later decision flows from:

1. **Off-chain compute, on-chain anchor.** Reputation math runs in Postgres + a worker. On-chain we publish only Merkle roots, signed snapshots, and slashable claims. Every production system we surveyed does this.
2. **Multi-axis, not scalar.** Reputation lives in a vector: `{delivery, payments, validation, content_quality, ...}`. A trading agent's trustworthiness ≠ a data-provider's. Consumers (IDLE, USEPOD, dispute systems) pick which axis to weight.
3. **Posterior, not point estimate.** Every signal axis publishes a Beta posterior `(α, β)`. Consumers select their own confidence interval. A 5-attestation Bayesian posterior is *honestly less confident* than a 500-attestation one; we stop hiding that.
4. **Time-decayed at the signal level.** All signals stored as exponentially-decayed sums, updated O(1) per event. Different half-lives per signal type (negatives decay slower than positives — FICO pattern).
5. **Graph propagation from a curated seed set.** Personalized EigenTrust where the restart vector concentrates on partner-vetted agents (IDLE, Metaplex, Valeo, Crossmint, ClawPump). Reputation flows from established agents through the transactional + attestation + validation graph. Sybils self-isolate because seed nodes never connect into them.
6. **Explainable by construction.** Every score returns its evidence: which signals contributed, how recent, who endorsed, dispute history. This turns reputation from "a number" into "a queryable substrate" — the thing partners embed as a dependency.
7. **Stake-backed where it matters.** Slashable bond on `submit_anchor`, dispute window, operator-level bonding. Lying costs the agent money, not just reputation.
8. **Operator binding (KYA) as optional premium tier.** Not a gate. Verified-human-or-org binding is a multiplier that high-trust use cases (banks, payment networks) can require. Pseudonymous agents keep working.
9. **ERC-8004 compatible wire format.** SAID speaks 8004 as its protocol surface. Differentiation happens above the standard, not parallel to it.

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│ EVENT LAYER (append-only, authoritative)                            │
│   Every reputation-relevant event captured with timestamp + actors  │
│   • submit_anchor   • validate_work    • feedback (signed)          │
│   • x402 payment    • attestation      • stake/slash                │
│   • dispute opened/resolved             • verified operator bind     │
└─────────────────────────────────────────────────────────────────────┘
                                ↓
┌─────────────────────────────────────────────────────────────────────┐
│ DECAY LAYER (per-agent, per-signal-type accumulators)               │
│   Exponentially-decayed sums, incremental O(1) updates              │
│   • anchors_decayed (t½ = 60d)                                      │
│   • feedback_pos_decayed (t½ = 90d)                                 │
│   • feedback_neg_decayed (t½ = 180d, slower)                        │
│   • vouches_decayed (t½ = 365d)                                     │
│   • identity_score (no decay)                                       │
│   • tenure_score (log-capped, no decay)                             │
└─────────────────────────────────────────────────────────────────────┘
                                ↓
┌─────────────────────────────────────────────────────────────────────┐
│ QUALITY TRANSFORMATION LAYER                                        │
│   counts → diversity-weighted quality ratios                        │
│   • H(counterparties) — Shannon entropy over distinct payers/raters │
│   • receipts_per_anchor — proof-of-work density                     │
│   • COCM cluster discount — feedback from socially clustered ring   │
│     collapses toward the value of a single signal                   │
└─────────────────────────────────────────────────────────────────────┘
                                ↓
┌─────────────────────────────────────────────────────────────────────┐
│ GRAPH PROPAGATION LAYER (the part v0.7 lacks entirely)              │
│   Personalized EigenTrust + Monte-Carlo random walks                │
│   • Seed set = partner-vetted agents                                │
│   • Edge weights by event type (validation > payment > follow)      │
│   • MeritRank decay parameters bound sybil yield                    │
│   • Recompute every 1-4hr globally; incremental deltas in between   │
│   • Hitting-time as secondary score (mutual-admiration sybil catch) │
└─────────────────────────────────────────────────────────────────────┘
                                ↓
┌─────────────────────────────────────────────────────────────────────┐
│ POSTERIOR LAYER (publish distributions, not point estimates)        │
│   Per agent, per axis: Beta(α, β) posterior                         │
│   • delivery        • payments_reliability                          │
│   • validation_accuracy  • content_quality (if applicable)          │
│   • Plus a composite axis for consumers who want one number         │
│   Output: posterior mean, posterior variance, 95% lower bound,      │
│           sample evidence (top contributing events)                 │
└─────────────────────────────────────────────────────────────────────┘
                                ↓
┌─────────────────────────────────────────────────────────────────────┐
│ API LAYER (the product)                                             │
│   • GET  /reputation/:wallet                                        │
│       → full posterior vector + evidence + explainability           │
│   • POST /reputation/bulk                                           │
│   • GET  /reputation/middleware/gate?score_gte=0.7&axis=delivery    │
│       → SDK-friendly trust-gate                                     │
│   • POST /reputation/attestation                                    │
│       → pre-authorized counterparty feedback (ERC-8004)             │
│   • POST /reputation/dispute                                        │
│       → open a dispute, escrow bond, kick off arbitration           │
└─────────────────────────────────────────────────────────────────────┘
                                ↓
┌─────────────────────────────────────────────────────────────────────┐
│ SYBIL RESISTANCE PACKAGE (cross-cutting, applied at multiple layers)│
│   • Operator-level bonding (slashable SOL)                          │
│   • COCM cluster discount on feedback graph                         │
│   • Behavioral fingerprinting (funding-source clustering, timing)   │
│   • Optional PoP multiplier (Human Passport, Worldcoin) for KYA tier│
│   • Half-life decay to defeat reputation hoarding + recycling       │
└─────────────────────────────────────────────────────────────────────┘
```

## 4. Schema design

### 4.1 ReputationEvent (append-only event log)

This is the new authoritative source. Every signal becomes an event row, never updated, never deleted. Indexes for time-ordered consumption.

```prisma
model ReputationEvent {
  id            String   @id @default(cuid())

  // Subject — the agent whose reputation this affects
  subjectWallet String

  // Actor — who created the event (may equal subject for self-actions)
  actorWallet   String?

  // What kind of event
  kind          String   // 'submit_anchor', 'validate_work', 'feedback', 'x402_payment',
                         // 'attestation', 'stake', 'slash', 'dispute_open', 'dispute_resolve',
                         // 'operator_bind', 'pop_link', ...

  // Axis it contributes to (multi-axis fan-out: an event can have multiple axis-effects)
  axis          String   // 'delivery', 'payments', 'validation', 'content', 'identity'

  // Polarity + magnitude
  polarity      Int      // +1 (positive), -1 (negative), 0 (neutral/structural)
  weight        Float    // raw signal weight before decay or graph propagation

  // Provenance
  txHash        String?  // on-chain signature if applicable
  attestationId String?  // points back to Attestation row if applicable
  metadata      Json?

  // Time anchor — used for decay calculations
  occurredAt    DateTime
  ingestedAt    DateTime @default(now())

  @@index([subjectWallet, kind])
  @@index([subjectWallet, axis, occurredAt])
  @@index([actorWallet, occurredAt])
  @@index([occurredAt])
}
```

### 4.2 ReputationSignal (per-agent decayed accumulators)

One row per (wallet × axis × signal_kind). Maintained incrementally — every new `ReputationEvent` updates the matching `ReputationSignal` row with O(1) decay-and-add.

```prisma
model ReputationSignal {
  id                String   @id @default(cuid())
  subjectWallet     String
  axis              String   // 'delivery', 'payments', 'validation', 'content', 'identity'
  kind              String   // 'anchors', 'feedback_pos', 'feedback_neg', 'vouches', ...

  // Decayed sum maintained incrementally
  decayedValue      Float    @default(0)
  lastEventAt       DateTime?
  lastDecayAt       DateTime @default(now())

  // Half-life override (otherwise pulled from policy constants)
  halfLifeDays      Float?

  // Counterparty diversity tracking (for COCM / entropy)
  uniqueActors      Int      @default(0)
  shannonEntropyEst Float    @default(0)

  // Confidence — Beta posterior parameters for this signal axis
  alpha             Float    @default(2.0) // mild prior
  beta              Float    @default(2.0)

  updatedAt         DateTime @updatedAt

  @@unique([subjectWallet, axis, kind])
  @@index([axis, decayedValue])
}
```

### 4.3 TrustEdge (the reputation graph)

Directed weighted edges between agents. Source of truth for graph propagation. Edge weight comes from accumulated decayed events.

```prisma
model TrustEdge {
  id                String   @id @default(cuid())
  fromWallet        String   // who is endorsing/paying/validating
  toWallet          String   // recipient of trust flow
  edgeType          String   // 'feedback', 'validation', 'payment', 'attestation', 'vouch'

  // Aggregated decayed weight from all events of this type between this pair
  weight            Float    @default(0)
  lastUpdatedAt     DateTime @default(now())

  // Counterparty's score at the time of last update (for graph computation snapshot)
  fromScoreSnapshot Float?

  @@unique([fromWallet, toWallet, edgeType])
  @@index([toWallet])
  @@index([fromWallet])
}
```

### 4.4 ReputationPosterior (computed output, per axis)

What the API returns. Recomputed on graph propagation cycle.

```prisma
model ReputationPosterior {
  id                String   @id @default(cuid())
  subjectWallet     String
  axis              String

  // Beta posterior
  alpha             Float
  beta              Float
  posteriorMean     Float    // α / (α + β)
  posteriorVariance Float
  lowerBound95      Float    // 95% lower bound — what conservative consumers should use

  // Graph-propagated scores
  eigentrustScore   Float    @default(0)
  hittingTimeScore  Float?

  // Composite (for consumers who want one number)
  compositeScore    Float

  // Provenance: what evidence backs this score
  topSourcesJson    Json     // top-k events/edges contributing to the score
  sampleSize        Int      // number of events contributing

  computedAt        DateTime @default(now())

  @@unique([subjectWallet, axis])
  @@index([axis, compositeScore])
  @@index([axis, lowerBound95])
}
```

### 4.5 Operator (KYA layer)

An agent can be optionally bound to an operator. Operators can be pseudonymous (default) or verified (premium tier).

```prisma
model Operator {
  id                  String   @id @default(cuid())

  // Pseudonymous (default) — controlling wallet on Solana
  controllingWallet   String   @unique

  // Optional verified bindings — only set for premium tier
  privyUserId         String?  @unique
  humanPassportProof  String?  // Holonym/Gitcoin Passport proof
  worldIdProof        String?  // World ID proof
  kybProvider         String?  // 'persona', 'sumsub', etc.
  kybVerificationId   String?

  // Stake bond (slashable on confirmed fraud)
  bondLamports        BigInt   @default(0)
  bondLockedUntil     DateTime?

  // Slashing history
  slashCount          Int      @default(0)
  totalSlashedLamports BigInt  @default(0)

  // Tier
  verifiedTier        String   @default("pseudonymous") // 'pseudonymous' | 'verified_human' | 'verified_org'

  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt

  agents              OperatorAgent[]

  @@index([verifiedTier])
}

model OperatorAgent {
  id              String   @id @default(cuid())
  operatorId      String
  operator        Operator @relation(fields: [operatorId], references: [id], onDelete: Cascade)
  agentWallet     String   @unique // one agent ↔ one operator
  boundAt         DateTime @default(now())

  @@index([operatorId])
}
```

### 4.6 Dispute (the arbitration primitive)

When agent A claims agent B failed to deliver, this is what happens.

```prisma
model Dispute {
  id                String   @id @default(cuid())

  claimantWallet    String   // who opened the dispute
  defendantWallet   String   // who is being disputed

  // What's being disputed
  eventId           String?  // optional pointer to the ReputationEvent in question
  axis              String   // which axis the claim is about
  claimType         String   // 'failed_delivery', 'fraudulent_anchor', 'malicious_validation', ...
  evidenceUri       String?  // off-chain evidence pointer

  // Bonds
  claimantBondLamports  BigInt
  defendantBondLamports BigInt?  // optional counter-bond by defendant

  // Lifecycle
  status            String   @default("open") // 'open', 'arbitrated', 'resolved', 'expired'
  openedAt          DateTime @default(now())
  arbitrationStarted DateTime?
  resolvedAt        DateTime?

  // Resolution
  verdict           String?  // 'claimant_wins', 'defendant_wins', 'no_finding'
  arbiterWallets    String[]                   // who voted

  @@index([defendantWallet, status])
  @@index([status])
}
```

## 5. Math

### 5.1 Time decay

For any signal accumulator `S` with half-life `t½`:

```
S(t) = Σ_i w_i · exp(-ln(2) · (t - t_i) / t½)
```

Incremental update on event arrival:

```
elapsed = now - lastDecayAt
decayedValue = decayedValue · exp(-ln(2) · elapsed / t½) + newEventWeight
lastDecayAt = now
```

This is O(1) per event. No historical scan needed. Concrete half-lives:

| Signal | Half-life | Rationale |
|---|---|---|
| `anchors` (positive on-chain proof-of-work) | **60 days** | Active shipping cadence |
| `feedback_pos` (peer endorsement) | **90 days** | Witnessed quality, slower stale |
| `feedback_neg` (negative peer signal) | **180 days** | Asymmetric — prevent "sin then wait" laundering (FICO pattern) |
| `vouches` (high-rep vouching for lower-rep) | **365 days** | Stake-like, annual refresh |
| `validations` (successful peer validations) | **120 days** | Slightly slower than anchors |
| `payments_x402` (x402 revenue events) | **90 days** | Commercial activity |
| `disputes_lost` (negative — confirmed fraud) | **365 days** | Bad news fades slowest |
| `identity_proofs` | **∞ (no decay)** | Binary facts — true until revoked |
| `tenure` | log-capped, no decay | Credit for showing up |

### 5.2 Beta posterior per axis

Per (agent × axis), maintain `(α, β)` updated on each event:

- Positive signal of weight `w`: `α += w`
- Negative signal of weight `w`: `β += w`

Output:
- Posterior mean: `α / (α + β)`
- Variance: `αβ / ((α + β)²(α + β + 1))`
- 95% lower bound: `posteriorMean - 1.96 · sqrt(variance)` (Wilson-style)

Cold-start prior: `α₀ = β₀ = 2` (mildly conservative). New agent with one positive event has posterior mean `0.6` and a wide confidence interval — *honestly less confident* than a 100-event agent at the same mean.

### 5.3 Personalized EigenTrust

Power iteration on the trust graph `T` (sparse `n×n` matrix of edge weights, row-normalized):

```
t⁰ = e   // pre-trust vector concentrated on seed set
t^{k+1} = (1-α)·T·t^k + α·e
```

with `α ≈ 0.15` (restart probability — standard PageRank value).

Seed set: partner-vetted agents. Restart vector `e` puts uniform mass on the seed set, zero elsewhere. New agents start with zero EigenTrust mass — they earn it by receiving edges from existing nodes, which propagate trust transitively.

Convergence: < 50 iterations for graphs of our scale. Compute: O(k · E) per iteration. At 100K agents / 10M edges: ~5 sec on a single Rust worker. Comfortably fits in an hourly batch.

### 5.4 MeritRank decay parameters (sybil tolerance)

Three multiplicative decay factors applied during graph propagation:

- **Transitivity decay `β = 0.7`**: trust flow attenuates with each hop
- **Connectivity decay**: cap the max reputation any single edge can transfer (e.g., 10% of source agent's score)
- **Epoch decay**: events from prior epochs (90-day window) reduced by exponential factor

Result: a sybil farm of size `k` can earn at most `O(log k)` propagated reputation rather than `O(k²)`. Bounded damage rather than zero damage.

### 5.5 Composite (for consumers who want one number)

When a consumer requests the headline score:

```
composite = w_id · identity_score
         + w_d  · posterior_mean(delivery)
         + w_p  · posterior_mean(payments)
         + w_v  · posterior_mean(validation)
         + w_g  · eigentrust_score
```

Default weights: `w_id = 0.20, w_d = 0.25, w_p = 0.20, w_v = 0.15, w_g = 0.20`. Consumers can request a custom weighting via API parameters.

Tiers (kept for backwards-compatibility with partner integrations):

```
platinum: composite ≥ 0.85 AND identity ≥ 0.70 AND samples ≥ 100
gold:     composite ≥ 0.70 AND samples ≥ 30
silver:   composite ≥ 0.50 AND samples ≥ 10
bronze:   composite ≥ 0.30
unranked: composite < 0.30 OR insufficient evidence
```

Note that **sample size is a structural requirement** for higher tiers. A new agent with one perfect event cannot leap to gold. This is the Beta posterior doing its job.

## 6. API contract

### 6.1 GET `/api/reputation/:wallet`

Returns the full posterior vector plus evidence. This is the explainability endpoint.

```json
{
  "wallet": "9VaDV...",
  "computedAt": "2026-06-03T...",
  "samples": 580,
  "operator": { "tier": "verified_human", "popProof": "human_passport" },
  "axes": {
    "delivery": {
      "posteriorMean": 0.87,
      "posteriorVariance": 0.0003,
      "lowerBound95": 0.85,
      "samples": 580,
      "eigentrustScore": 0.74
    },
    "payments": { "...": "..." },
    "validation": { "...": "..." }
  },
  "composite": { "score": 0.81, "tier": "gold" },
  "evidence": {
    "topEvents": [
      { "kind": "x402_payment_received", "count": 580, "decayedValue": 412.3, "axis": "delivery" },
      { "kind": "feedback_pos", "count": 28, "decayedValue": 24.1, "axis": "delivery", "topActors": ["7tx...", "9P3..."] }
    ],
    "topEndorsers": [
      { "wallet": "7tx...", "weight": 1.2, "score": 0.91 }
    ]
  },
  "rationale": [
    "verified_operator binding active",
    "demonstrated paid_service delivery (580 unique x402 buyers)",
    "no open or resolved disputes",
    "tenure 9 months"
  ]
}
```

### 6.2 GET `/api/reputation/gate`

Trust-gate middleware. SDK-friendly. Returns minimal pass/fail.

```
GET /api/reputation/gate?wallet=...&axis=delivery&min_score=0.7&require_operator_tier=verified_human
→ { "pass": true, "score": 0.87, "tier": "gold" }
```

### 6.3 POST `/api/reputation/attestation`

Pre-authorized counterparty feedback (ERC-8004 model). Counterparty `B` signs an attestation that `A` did or did not deliver on a specific transaction.

### 6.4 POST `/api/reputation/dispute`

Opens a dispute. Escrows claimant bond. Kicks off arbitration window.

## 7. Sybil resistance package

Layered, no single silver bullet:

1. **Operator-level bonding.** Bond is per-operator, not per-agent. Spinning up 100 sybil agents requires 100× the bond. Bond is slashable on confirmed fraud (`disputes_lost` event).
2. **COCM (Connection-Oriented Cluster Matching).** Feedback from socially-clustered actors collapses toward the value of one actor. Implemented via weekly Louvain community detection on the feedback graph; intra-cluster edges discounted.
3. **Behavioral fingerprinting.** Detect funding-source clusters (sybils funded from the same exchange withdrawal in tight time window), sequence-fingerprint similarity, low timing entropy. Flag for manual review or automatic discount.
4. **Optional PoP multiplier.** Operators who link Human Passport / Worldcoin / Civic get a multiplier (e.g., 1.5x) on their agents' EigenTrust mass. Not a gate — a soft economic signal that high-trust use cases (IDLE's preferential capacity) can choose to require.
5. **Half-life decay defeats reputation hoarding.** A sybil farmer who built rep 2 years ago has it decayed to ~6% today. Forces continuous maintenance, makes recycling uneconomic.

Realistic precision: ~85-92% sybil detection at SAID's scale (Tuenti's SybilRank achieved similar) without PoP. PoP becomes the tiebreaker at the top decile of the distribution — exactly where IDLE/USEPOD capacity decisions matter most.

## 8. Migration plan from v0.6 / v0.7

**Phase 1 — coexistence (weeks 1-2)**
- Build v0.8 alongside v0.6/v0.7 in the same `said-api` service
- v0.8 endpoints live under `/api/reputation/v8/*`
- v0.6 score remains the default for existing partner integrations
- Internal dashboards show both side-by-side; we look for divergences

**Phase 2 — partner cutover (weeks 3-4)**
- IDLE Protocol and USEPOD migrate to `/api/reputation/v8/*`
- API contract is stable — they can keep using either
- We track which version each partner uses

**Phase 3 — default switch (week 5)**
- `/api/agents/:wallet` returns v0.8 score by default
- v0.6/v0.7 endpoints remain for explicit version pinning

**Phase 4 — retirement (month 2+)**
- v0.6 and v0.7 endpoints deprecated with 30-day notice
- Eventually removed

## 9. Sequencing — build order

| Phase | Scope | Time |
|---|---|---|
| **1a** | Schema migrations: `ReputationEvent`, `ReputationSignal`, `TrustEdge`, `ReputationPosterior`, `Operator`, `Dispute` | 1 day |
| **1b** | Event ingest path: every relevant signal (anchor, feedback, x402, attestation) writes to `ReputationEvent` | 2 days |
| **1c** | Decay machinery: per-event O(1) decayed-sum update for `ReputationSignal` | 1 day |
| **2a** | Posterior computation per agent per axis from `ReputationSignal` accumulators | 1 day |
| **2b** | API endpoints (v8): `/reputation/:wallet`, `/gate`, posterior + evidence | 2 days |
| **3a** | Trust edge graph: `TrustEdge` table maintenance from `ReputationEvent` | 1 day |
| **3b** | Personalized EigenTrust worker: Postgres → Rust/Go worker → write `ReputationPosterior.eigentrustScore` | 3 days |
| **3c** | MeritRank decay parameters + seed set governance | 1 day |
| **4a** | Quality transformation: counterparty entropy, receipts-per-anchor ratio | 1 day |
| **4b** | COCM cluster discount on feedback graph (Louvain or label propagation) | 2 days |
| **5a** | `Operator` + `OperatorAgent` tables; binding flow | 1 day |
| **5b** | KYA tier integrations: Privy, Human Passport, Worldcoin | 2 days |
| **5c** | Bond + slash mechanics | 1 day |
| **6a** | `Dispute` table + arbitration window | 1 day |
| **6b** | Slashable bond on `submit_anchor` + dispute API | 2 days |
| **7** | Behavioral fingerprinting (funding-source clustering, sequence similarity) | 3 days |
| **8** | Migration cutover, partner coordination, retirement of v0.6/v0.7 | ongoing |

**Total: ~3 weeks of focused build.** Phases 1-2 (~5 days) deliver the foundational shift; phases 3-4 (~7 days) deliver the moat-worthy graph + quality work; phases 5-7 (~10 days) deliver the differentiating product features.

## 10. What we keep from v0.6 + v0.7

Not everything is thrown out:

- **x402scan signal indexing** — pipeline works, ships value
- **SAID program instruction classification** — discriminators correct, keep
- **Schema migration patterns** — `npx prisma db push --skip-generate` workflow on Railway
- **Calibration harness concept** — predicate-based invariant testing carries over to v0.8
- **Tier meaning definitions** — the philosophy stays (delivery, engagement, etc.) even though the math changes
- **ERC-8004 spec compatibility intent**

## 11. Open questions

These need decisions during phase 1:

- **Seed set selection.** Which agents are the "trusted seeds" for EigenTrust? Process for adding/removing.
- **Default per-axis weights for composite.** First-cut values picked; tune from observed distributions.
- **Dispute arbitration mechanism.** Multisig of trusted reviewers? Decentralized validator quorum? Hybrid?
- **Bond sizing.** Minimum operator bond — needs economic analysis tied to expected attack value.
- **On-chain anchor cadence.** Weekly Merkle root post? Per-event? Compressed batch?

These are tractable. None block the phase 1 build.

## 12. Success criteria

We'll know v0.8 is right when:

- **Xona Agent** scores top decile organically (without needing structural floors)
- **SlimeBot** reaches silver via her actual on-chain anchor work
- **Spam agents** ("Trader" x4, "Spawnr Test Agent") land near zero with high posterior variance — the math says "we don't know much, and what we know isn't great"
- **A new high-quality agent** can climb from 0 → silver in 30 days by doing real work, without us tuning anything
- **A dormant high-rep agent** gracefully fades from gold → silver over 6 months without intervention
- **Partners can call `/api/reputation/gate`** and get actionable yes/no answers without reading our docs

---

*This document is the design. Implementation starts at Phase 1a.*

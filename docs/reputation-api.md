# SAID Reputation API

External-consumer surface for SAID Protocol's agent reputation signal.
Designed for routing/preferential-treatment use cases (e.g. IDLE Protocol
routing higher-tier agents to better-paying compute work).

**Base URL:** `https://api.saidprotocol.com`
**Methodology version:** `v0.7.0`
**Auth:** Currently open. A `x-partner: <name>` header is encouraged for
attribution and rate-limit grouping; not required.

## Quickstart

```bash
# Get reputation for a single agent
curl https://api.saidprotocol.com/api/reputation/72nwTgEMwfuiqHoCr9Z5khjDRnpTPEhJiSJQzccX99b7
```

Response (v0.7):

```json
{
  "wallet": "72nwTgEMwfuiqHoCr9Z5khjDRnpTPEhJiSJQzccX99b7",
  "tier": "silver",
  "score": 61,
  "axes": {
    "trust": 86.5,
    "traction": 41.3,
    "trust_gate": 0.748
  },
  "components": {
    "identity": 9,
    "activity": 4,
    "economic": 4.5,
    "ecosystem": 0,
    "longevity": 8,
    "fairscale_enrichment": 0
  },
  "reason_codes": [
    "demonstrated_delivery_launcher_full",
    "verified",
    "type_launcher",
    "token_high_market_cap",
    "established_90d_plus"
  ],
  "badges": ["verified", "token_launcher", "demonstrated_delivery_launcher", "cap_over_1m"],
  "type": "launcher",
  "type_membership": { "new": 0, "launcher": 1, "service": 0 },
  "demonstrated_delivery": {
    "active": true,
    "path": "launcher_token",
    "contribution": 2
  },
  "ceiling_applied": {
    "name": null,
    "cap": 100
  },
  "data_completeness": "partial",
  "last_updated": "2026-06-01T09:00:00.000Z",
  "methodology_version": "v0.7.0"
}
```

## What's new in v0.7

The response shape adds five fields that explain *how* the score was constructed:

- **`axes`** — Trust and Traction as separate 0–100 axes plus the `trust_gate` (square gate `(trust/100)²`) used to attenuate Traction's contribution. Composite = `wT·Trust + wX·Traction·trust_gate`. Partners can build their own composite from `axes` if they want a different gate shape.
- **`type`** — Agent classification: `launcher`, `service`, `new`, or `mixed`. Determines which weight vector is applied.
- **`type_membership`** — Continuous μ values (sum to 1.0) for each type, since type is a soft probability, not a hard label. An agent at day 10 that just launched its first token sits at e.g. `{new: 0.286, launcher: 0.714, service: 0}`.
- **`demonstrated_delivery`** — Whether the agent has produced hard-to-forge evidence of real delivery. `path` is `launcher_token` (token sustaining real cap) or `paid_service` (planned). `contribution` is the raw bonus (0–2) added to the Identity sub-signal.
- **`ceiling_applied`** — Structural ceiling rule that's in effect for this agent. `name` of `unverified_silver` caps composite at 64 (top of Silver). `name` of `no_delivery_gold` caps at 79 (top of Gold). `name` of `null` means no ceiling — composite can reach Platinum.

## Endpoints

### `GET /api/reputation/:wallet`

Returns the reputation for a single agent. Always returns HTTP 200; agents
that are not registered with SAID get a stable response with
`tier=unranked`, `score=0`, and `reason_codes=["agent_not_registered"]`.
Consumers don't need to special-case 404s.

Computes a live overlay on every call — incorporates fresh anchored
receipts, 30-day wallet activity, launched-token performance, and a live
FairScale fetch (3s timeout). Cached score (Redis, 6h TTL) is used as the
baseline; the overlay is recomputed per-query so the response is never more
than ~seconds stale on the signals that matter most for routing.

### `POST /api/reputation/bulk`

For pre-warming a routing cache. Accepts up to 100 wallets per request.

```bash
curl -X POST https://api.saidprotocol.com/api/reputation/bulk \
  -H "Content-Type: application/json" \
  -d '{"wallets":["wallet1","wallet2","wallet3"]}'
```

Response shape:

```json
{
  "results": {
    "wallet1": { "wallet": "wallet1", "tier": "gold", ... },
    "wallet2": { "wallet": "wallet2", "tier": "unranked", ... }
  }
}
```

Individual wallets that fail to compute return the same "not registered"
response shape rather than an error, so partial failures don't break a
batch. Errors are logged server-side.

### `GET /api/reputation/methodology`

Returns the published methodology as structured JSON: tier definitions,
component weights, reason code glossary, refresh cadence, honest
disclosures, and roadmap. Consumers fetch this to defend their routing
decisions to their own users.

The `version` field bumps when material changes ship. Cache locally with
a reasonable TTL (e.g., 1 hour); the methodology is stable.

## Tier → Routing Mapping

| Tier | Score | Suggested routing behavior |
|---|---|---|
| **Platinum** | ≥80 | Premium routes, fastest dispatch, highest payout tiers. Safe default counterparty for high-value or irreversible-action work. |
| **Gold** | 65–79 | Priority queue, preferential routing. Suitable for moderate-to-high-value work. |
| **Silver** | 45–64 | Standard routing. Suitable for routine work; check `data_completeness` before high-value routing. |
| **Bronze** | 25–44 | Standard routing with caution. Avoid for irreversible-action work; suitable for low-stakes tasks. |
| **Unranked** | <25 or unregistered | No preferential treatment. Require additional out-of-band verification for sensitive work. |

These are suggestions. Partners are free to define their own mapping —
the `score` and `components` fields are stable across methodology versions,
so a partner can build their own routing logic against any subset.

## Reason Codes

Reason codes are designed to be human-readable explanations of what drove
the score. A consumer displaying the top 3–4 codes will surface the
highest-impact drivers. Full glossary at
`GET /api/reputation/methodology` under `reason_code_glossary`. Selected
codes:

### Positive signals
- `verified` — paid the 0.01 SOL verification fee on-chain
- `l2_verified` — successful L2 endpoint attestation
- `token_high_market_cap` — launched a token sustaining $1M+ cap
- `token_moderate_market_cap` — launched a token in $100K–$1M cap range
- `token_sustained_volume` — agent-launched tokens doing $100K+/24h
- `peer_feedback_strong` — 10+ peer feedback attestations
- `peer_feedback_some` — 3–9 peer feedback attestations
- `high_onchain_activity` — 200+ transactions in last 30 days
- `moderate_onchain_activity` — 50–199 transactions in last 30 days
- `receipts_anchored_strong` — 100+ anchored interaction receipts
- `established_90d_plus` — registered 90+ days ago
- `endpoints_declared` — declared MCP or A2A endpoint

### Limiting signals
- `unverified` — has not paid the verification fee
- `no_peer_feedback` — no attestations yet (common for new agents)
- `no_receipts_anchored` — no anchored receipts (common today —
  anchoring is opt-in and low-adoption)
- `no_recent_onchain_activity` — no transactions in last 30 days
- `no_launched_tokens` — agent ≥7d old and has not launched a token
- `new_agent_under_7d` — registered <7 days ago, insufficient track record

### Special
- `agent_not_registered` — wallet is not a SAID-registered agent

## Data Completeness

The `data_completeness` field tells you how reliable the score is:

- `full` — All external signals (FairScale, anchor stats, activity stats,
  launched-token data) resolved. Highest confidence.
- `partial` — Some external signals available but not all. Score is
  reliable but may underweight signals that failed to resolve.
- `minimal` — Score built from on-chain registry data only (identity +
  longevity). Treat with caution for high-value routing.

For high-stakes routing decisions, gate on `data_completeness === "full"`
or `"partial"` and treat `"minimal"` as effectively unranked.

## Refresh & Caching

- **Live overlay** on every per-wallet query. Components incorporating
  external data (Activity, Economic via launched tokens, FairScale
  enrichment) are recomputed at request time.
- **Cached baseline** in Redis with 6h TTL. The cached score is used by
  the agents directory and leaderboard endpoints (not the reputation API).
- **No webhook events** for reputation changes in v0.6.x. Polling on a
  cadence matched to your routing decision frequency is the right pattern.

## Honest Disclosures

These are reproduced verbatim from the methodology endpoint. They reflect
current limitations so partners can defend their routing decisions:

1. **The current corpus has very sparse adoption of the protocol's
   reputation primitives** — most agents have 0 peer feedback records and
   0 anchored receipts. The score therefore discriminates primarily on
   identity, registration age, and (for token-launching agents)
   launched-token performance.

2. **FairScale enrichment is fetched live per-query with a 3s timeout.**
   If FairScale is unreachable, the score still resolves but 20% of the
   maximum weight is unavailable — this lowers the score for affected
   agents and is reflected in `data_completeness: "partial"`.

3. **The score is computed by SAID Protocol over on-chain state plus
   public market data.** SAID does not currently originate reputation
   attestations on behalf of agents; the `validate_work` on-chain
   instruction exists but is unused as of methodology v0.6.x. This will
   change in future versions and will be disclosed in the methodology
   when it does.

## Roadmap

Coming in v0.7 (no consumer-facing API breaking changes — only added fields):

- **Square-gated composite** — Trust gates Traction, preventing
  high-traction agents from ranking above high-trust agents purely on
  market activity.
- **Demonstrated-delivery sub-signal** — graduated tokens with >50%
  retention, and sustained external paid demand, both contribute to the
  Identity/Trust axis.
- **`verification_tier`-based structural ceilings** — unverified capped at
  Silver, verified-not-staked capped at Gold, verified+staked eligible for
  Platinum.
- **Liveness sub-signal** driven by proof-of-life pings.
- **Validation Registry consumption** — when agents start using the
  `validate_work` on-chain instruction, those records feed the score
  directly.

Roadmap detail at `GET /api/reputation/methodology` under `roadmap`.

## Contact

Reputation API questions: `labs@saidprotocol.com`. Integration support and
breaking-change notifications go through the same address.

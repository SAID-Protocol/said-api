# Asset Passport — spec v0.1

**One line.** A public, free check that tells anyone whether a tokenized asset is the real issuer-backed thing, a synthetic, or a memecoin wearing its name — with the evidence attached.

**Why this shape.** The launch-screen endpoint built on 2026-09-12 requires a launchpad to integrate it. They have no reason to. This inverts it: traders come to us, no platform has to agree to anything, and it rides a narrative people are already repeating ("RWA identity").

---

## The problem, measured 2026-09-13

Searching Jupiter for `NVDAx` returns twenty tokens. One is Backed's real tokenized Nvidia share with 90,812 holders. The rest include tokens with the **exact same symbol** and the **exact same naming convention**:

| Ticker | Real (Backed) | Impersonators found |
|---|---|---|
| SPYx | 71,043 holders | "SP500 xStock", "The Spy" — symbol `SPYx` |
| NVDAx | 90,812 holders | "NVIDIA xStock" ×2 — symbol `NVDAx` |
| HOODx | 12,532 holders | "Robinhood", "HOODx" — symbols `HOODx` / `HOODX` |
| MSFTx | 21,827 holders | "Microsoft xStock", "Micro&Soft" — symbol `MSFTx` |
| GLDx | 21,851 holders | "Gold GLDX", "GOLD" — symbols `GLDx` / `GLDX` |

By this product's own definition — a token using the exact ticker or name of a real tokenized asset, with live liquidity — production counted **92 impersonators carrying $112,399 of combined liquidity across the 12 most-circulated xStock tickers** on 2026-09-15, 41 of them launched via pump.fun, 18 via Meteora, 6 via StonkFun, and **8 created that same day**. NVDAx alone had 16, four of them literally named "NVIDIA xStock", and a batch of five identical "Nvidia Stonk" tokens seeded with ~$6,370 each appeared within one day. Search results are capped per ticker, so these are lower bounds.

*Correction (2026-09-15):* an earlier draft quoted "193 impostors, $10.5M liquidity", a figure that included memecoins using a **stock's** ticker (an "MSTR" token holding $2.34M). Those imitate a stock, not a tokenized asset, and this product does not call them impersonators. The number above is the one to quote.

**What is already solved:** Jupiter tags the real ones `xstocks`, `rwa`, `equities`, `verified`. So the data exists — it is just not in front of the person about to buy, and "verified" on its own does not tell you *backed by a real share* from *synthetic exposure* from *memecoin*.

---

## The four verdicts

| Verdict | Means | Evidence required |
|---|---|---|
| `backed` | 1:1 claim on a real asset, issuer publishes a fetchable reserve figure | On the issuer's canonical list **and** a per-mint reserve number with a named custodian, timestamped under an hour. **Today only Backed/xStocks clears this** (830 of 832 assets). |
| `issuer-claimed` | Issuer says backed, no public proof we can fetch | On the issuer's own mint list only. Stated as exactly that. |
| `synthetic` | Exposure, no underlying share held | Issuer documents it as synthetic (e.g. pre-IPO tokens). |
| `meme` | A coin named after or paired with an asset, no backing claim | Not on any issuer list; launchpad-created. |
| `impersonator` | Uses a real asset's ticker/name but is none of the above | Exact symbol or name collision with a canonical entry, different mint. |

**The hard rule:** never render `backed` without a link a reader can click. Everything else gets its honest label. A trust product does not get a second chance at this.

---

## Endpoints

```
GET /api/asset/:mint          → the passport for one mint
GET /api/asset/search?q=NVDAx → every mint using that symbol, real one first,
                                impersonators flagged with why
GET /api/asset/impersonators  → the live feed: fakes with liquidity, newest first
GET /api/asset/issuers        → canonical issuer list + when each was refreshed
```

Passport response:

```jsonc
{
  "mint": "Xsc9qvGR1e...",
  "symbol": "NVDAx",
  "name": "NVIDIA xStock",
  "verdict": "backed",
  "issuer": { "name": "Backed Finance", "mintListUrl": "...", "proofUrl": "..." },
  "underlying": { "kind": "equity", "ticker": "NVDA", "redeemable": true },
  "evidence": ["on Backed's canonical mint list", "Jupiter verified + xstocks tag"],
  "market": { "holders": 90812, "liquidityUsd": 1840000 },
  "impersonators": { "count": 15, "withLiquidity": 6 },
  "attestation": { "signature": "...", "signedAt": "..." },
  "computedAt": "..."
}
```

Impersonator detection, in order: exact symbol match against a canonical entry with a different mint; case-insensitive symbol match; name collision (`"NVIDIA xStock"`); then rank by liquidity, because a fake with liquidity is the one that can actually take someone's money.

---

## Data sources — verified 2026-09-13

Every source below was fetched this session. Free and unauthenticated unless noted.

| Source | What it gives | Endpoint |
|---|---|---|
| **Backed / xStocks registry** | **832 assets**, each with an **ISIN**, the **underlying's ISIN**, the listing exchange MIC, and per-chain addresses across 11 networks. No key. | `api.xstocks.fi/api/v2/public/assets?page=N` |
| **Backed proof-of-reserves** | **The only real, free, per-mint PoR in the entire market.** 830 of 832 assets: `sharesHeld`, `circulatingSupply`, custodian named (Alpaca 654, GTN 78), attestor The Network Firm, **~10 minute refresh**. Zero assets undercollateralized when measured. | `api.xstocks.fi/api/v2/public/proof-of-reserves/{symbol}` |
| **Backed operational wallets** | Lets us **independently reconcile** circulating supply per chain rather than trusting the issuer's own figure. | `api.xstocks.fi/api/v2/public/system/wallets` |
| **Solana RPC (Token-2022 metadata)** | **The trustless issuer key.** `updateAuthority` + metadata `uri` host groups every issuer perfectly, and cannot be forged. Backed = `5aMNNLQJ…HFvEq`; every Backed mint also starts `Xs` (832/832, zero false positives). One batched call per 100 mints. | `getMultipleAccounts` |
| **GLEIF** | Issuer legal identity. Backed Assets (JE) Limited = LEI `984500001AB7C6C7F577`, Jersey, status ISSUED. No key. | `api.gleif.org/api/v1/lei-records?filter[entity.legalName]=` |
| **Jupiter tokens** | Symbol, name, tags (`xstocks`/`rwa`/`verified`), holders, liquidity, organic score, launchpad, dev wallet. The impersonator spine. | `lite-api.jup.ag/tokens/v2/search|token/{mint}` |
| **CoinGecko** | Independent mint → `Tokenized Stocks` + `Real World Assets` classification, ≥750 assets. Rate-limited on the free tier. | `api.coingecko.com/api/v3/coins/{id}` |
| **Ondo** | Published contract addresses per asset per chain (docs page; their API is key-gated). | `docs.ondo.finance/addresses.md` |
| **Dune Spellbook** | 27 xStock + Ondo Solana mints in plain SQL, free to read on GitHub. Cross-check. | `prices_solana_tokens.sql` |
| **GoPlus** | Mint/freeze authority, supply, holders. | `api.gopluslabs.io/api/v1/solana/token_security` |

**The evidence chain this unlocks.** For a real xStock we can show: on Backed's canonical list → its own ISIN → the underlying's ISIN → the listing exchange → the issuer's LEI and jurisdiction. That is institutional-grade provenance, assembled entirely from free public sources, and no token checker currently shows it.

### Issuer coverage, corrected

| Issuer | Solana mints | Verdict | Why |
|---|---|---|---|
| **Backed / xStocks** | 832 | `backed` | Free per-mint PoR, custodian named, Jersey SPV, **retail-redeemable** at $5k minimum |
| **Ondo** | 451 | `issuer-claimed` | Attestations promised (Ankura Trust) but every URL 404s and they appear KYC-gated |
| **Backpack Securities** | 44 | `issuer-claimed` | Their own table says "Claim on SPV"; no published proof for the token layer |
| **PreStocks** | 9 | `issuer-claimed` | Markets "1:1 backed by SPV exposure"; terms give no enforceable claim and allow synthetic substitution; attestation counts tokens, not shares; conduct consistent with real holdings — see below |
| **Shift** | 8 | `synthetic` | Leveraged synthetics, self-declared |
| **Tessera** | 3 | `synthetic` | Writes *"This is a loan product, not a security"* into its own on-chain metadata |
| **Superstate** | 4 | `backed` (different basis) | The token **is** the share register, via an SEC-registered transfer agent |

**Sunrise is not an issuer** — it is Backpack's listing layer, and its API is the cleanest typed schema anywhere (`assetClass` + `issuer` per token): `api.sunrise.xyz/v1/tokens`. **Dinari is not on Solana at all.**

### PreStocks, stated fairly (steelmanned 2026-09-17)

PreStocks markets its tokens as *"backed 1:1 by SPV exposure to the underlying company shares."* Its terms (8 September 2026) say the exposure may take any form including a derivative or synthetic arrangement on a proxy, may be substituted without notice, creates no trust, custody or segregated claim, gives holders no legal, equitable or contractual right to any underlying share, and that a redemption request creates no entitlement. Its attestations (BlockOffice Pte. Ltd., one page each, "not a statutory audit") verify that minted tokens do not exceed a cap PreStocks set; they say nothing about assets held. No issuing entity, custodian or counterparty is named, by stated policy.

**What that does not establish:** that nothing is held. Conduct is consistent with a real but opaque position book: the xAI to SpaceX conversion at the exact merger ratio, on-chain supplies matching attestations, no exploits, denied redemptions or enforcement, and a SpaceX lockup discount that was disclosed before listing, matches the real unlock schedule, and tracks the share-backed peer Tessera rather than the openly synthetic Republic note.

**SpaceX is unresolved, not failed.** The tokens convert 1:1 into tokenized public stock after the lockup ends (~December 2026); 12 March 2027 is the deadline to convert, not an expiry of value. The first real payout test is that window.

**"No claim on the underlying" is category-wide** (Ondo, Backed, Tessera, Jarsy, Robinhood all say it) and is not a reason to single anyone out. What is specific to PreStocks among issuers marketing themselves as share-backed: no named entity or custodian, token-count-only attestation, and the right to substitute synthetic exposure without notice.

**Verdict on the page:** `issuer-claimed` is the precise label. The reasons quote the homepage and the terms side by side, verbatim and dated, and say the holder has no enforceable claim. The page never asserts that nothing is held. Their terms carry a non-disparagement clause with BVI arbitration; exactness is not optional.

## The existing tools get it backwards

RugCheck scores the **real** Backed Tesla xStock **81/100 "danger"**, flagging mint authority, freeze authority and permanent control — which are exactly the Token-2022 powers a regulated issuer is **required** to retain. The fake "NVIDIA xStock" beside it scores **29/100** with a single "Copycat token" warning. **The impersonator is rated safer than the genuine asset.** GoPlus marks both real tokenized stocks `trusted_token: 0` while marking USDC 1. Phantom's wallet payload has a `categories` field that is **empty** for Tesla xStock and populated for SOL and USDC.

So today's safety tools rate the genuine regulated asset as more dangerous than the token impersonating it. Surfacing issuer control powers as **disclosure** rather than as **risk** is the correction, and it is a large part of what makes this product different.

## What does not exist, and why that matters

- **No regulator anywhere maintains a register of tokenized securities.** ESMA's prospectus register (free Solr JSON) registers prospectuses and issuer LEIs, with no ISINs and no contract addresses. Only three DLT market infrastructures have ever been authorised in the EU.
- **The traditional reference-data stack cannot see these tokens.** OpenFIGI resolves the underlying ISIN for Tesla, Nvidia, SPY, Apple, Alphabet, Microsoft, Coinbase and Meta (8 of 8), and returns *"No identifier found"* for every one of their tokenized versions plus Ondo's NVDAon (0 of 9). Verified 2026-09-15. The token has a real ISIN that the global identifier system does not know.
- **The incumbents are institutional dashboards, not pre-trade safety.** RWA.xyz is the category leader by credibility, cited by the White House, IMF, BIS and the SEC Crypto Task Force, but is login-gated and demo-priced. DefiLlama has the best taxonomy (Stock Backed / Stock Synthetic / Equity Basket, with ISIN columns) behind a $300/month tier. Token Terminal gives RWA metrics free. All of them answer *"how big is the tokenized-asset market"*. **None answers *"is the token in front of me right now the real one"*.** That is the gap.

## Surfaces

1. **The checker page** on saidprotocol.com. Paste a mint or ticker, get the verdict. The screenshot surface.
2. **The badge** — embeddable SVG, same as agent badges today.
3. **@saidagent reply** — "is $NVDAx real?" answered on X. The bot exists; this is the viral loop.
4. **The impersonator feed** — a live list of fakes with liquidity. This is the thing that gets quoted.

## What SAID adds that Jupiter does not

Jupiter says *verified*. The passport says *backed by a real share, by this issuer, here is the proof, and here are the fifteen tokens pretending to be it*. Plus a signed on-chain attestation per asset, which is identity for assets on the registry machinery we already run.

## Build order

1. Issuer lists + classifier + `GET /api/asset/:mint` (with tests on the real/fake pairs found above).
2. `search` and `impersonators` endpoints.
3. The checker page and the badge.
4. The X reply.
5. On-chain attestations last — everything above works without them.

## Honest limits

- We verify *identity and provenance*, not *reserves*. Whether Backed truly holds the shares is their custodian's attestation, which we link and never restate as our own finding.
- Holder count and liquidity are market signals, not proof. A fake with 3 holders is a strong hint, not a verdict on its own.
- New issuers appear. Anything not on a canonical list is `meme` or `impersonator`, never `backed`.

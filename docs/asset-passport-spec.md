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

Across 20 major tickers: **193 exact-ticker impostor mints carrying $10.5M of combined liquidity** (a lower bound — search caps results). One memecoin using the symbol **MSTR** holds **$2.34M**. A fake named **"NVIDIA (Ondo Tokenized)"** has **6.5× the liquidity of the real Ondo NVDAon**. Four separate mints are named "Tesla xStock"; one is Backed's. And **six different issuers sell SpaceX exposure** under near-identical tickers: SPCX, SPCXx, SPCXon, tSpaceX, SPACEX, SPCX2L. The fakes share one playbook: launched via pump.fun, seeded with ~$3,000 of liquidity so they look tradeable, 1–3 holders, organic score 0. Several were created the same day this was measured. The casing trick (`TSLAX` vs `TSLAx`) is invisible in most UIs.

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
| **PreStocks** | 9 | `synthetic` | **Their terms disclaim the backing their API advertises** — see below |
| **Shift** | 8 | `synthetic` | Leveraged synthetics, self-declared |
| **Tessera** | 3 | `synthetic` | Writes *"This is a loan product, not a security"* into its own on-chain metadata |
| **Superstate** | 4 | `backed` (different basis) | The token **is** the share register, via an SEC-registered transfer agent |

**Sunrise is not an issuer** — it is Backpack's listing layer, and its API is the cleanest typed schema anywhere (`assetClass` + `issuer` per token): `api.sunrise.xyz/v1/tokens`. **Dinari is not on Solana at all.**

### The PreStocks finding

PreStocks' API describes its tokens as *"backed 1:1 by SPV exposure."* Its Terms of Service say the exposure *"may take any one or more forms… derivative or synthetic… referencing the relevant company **or a proxy for it**"*, that it *"does not of itself create a security interest, trust, custody relationship, or segregated, ring-fenced, or bankruptcy-remote claim"*, and that holders have *"**no legal, equitable, or contractual right to any underlying share or asset**."* Redemption: *"A request for redemption does not of itself create an entitlement."* No legal entity is named anywhere.

**The live proof of what that is worth:** SpaceX listed on Nasdaq in June 2026. PreStocks SPACEX now trades at **$119.54** against Backed's SPCXx at **$149.61**, a 20% discount, and PreStocks' own banner says the tokens *"will expire worthless"* after 12 March 2027. Same underlying company, two tokens, one redeemable and one not.

## The existing tools get it backwards

RugCheck scores the **real** Backed Tesla xStock **81/100 "danger"**, flagging mint authority, freeze authority and permanent control — which are exactly the Token-2022 powers a regulated issuer is **required** to retain. GoPlus marks both real tokenized stocks `trusted_token: 0` while marking USDC 1. Phantom's wallet payload has a `categories` field that is **empty** for Tesla xStock and populated for SOL and USDC.

So today's safety tools flag the genuine regulated asset as dangerous and say nothing about the impersonator beside it. Surfacing issuer control powers as **disclosure** rather than as **risk** is the correction, and it is a large part of what makes this product different.

## What does not exist, and why that matters

- **No regulator anywhere maintains a register of tokenized securities.** ESMA's prospectus register (free Solr JSON) registers prospectuses and issuer LEIs, with no ISINs and no contract addresses. Only three DLT market infrastructures have ever been authorised in the EU.
- **The traditional reference-data stack cannot see these tokens.** OpenFIGI resolves Tesla's ISIN `US88160R1014` to a Bloomberg FIGI instantly, and returns *"No identifier found"* for Tesla xStock's ISIN `CH1436219252`. Both verified this session. The token has a real ISIN that the global identifier system does not know.
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

/**
 * Asset Passport — issuer registry.
 *
 * Builds the canonical picture of every tokenized real-world asset on Solana
 * from the issuers' own published sources, then keeps it in memory with a
 * daily refresh. Everything here is free and unauthenticated.
 *
 * THE TRUSTLESS KEY. A published list tells us what an issuer claims. The
 * on-chain Token-2022 `updateAuthority` and the metadata `uri` host tell us
 * what is actually true, and cannot be forged. We record both: the list is
 * the fast path, the authority is the proof. A mint that claims to be on a
 * list but carries the wrong authority is an impersonator, not an asset.
 *
 * Sources, all verified 2026-09-13:
 *   Backed/xStocks  api.xstocks.fi/api/v2/public/assets        832 assets, ISINs
 *                   …/proof-of-reserves                        830 with live PoR
 *   Sunrise         api.sunrise.xyz/v1/tokens                  typed assetClass+issuer
 *   PreStocks       prestocks.com/api/prestocks                9 pre-IPO mints
 *   Jupiter         lite-api.jup.ag/tokens/v2/tag?query=verified  the tag taxonomy
 */

export type Backing = 'backed' | 'issuer-claimed' | 'synthetic';

export interface IssuerProfile {
  key: string;
  name: string;
  /** What its tokens are, absent per-asset evidence to the contrary. */
  backing: Backing;
  /** Token-2022 update authority, where one key covers the whole issuer. */
  updateAuthority?: string;
  /** Metadata URI host — the universal key; works even when authorities differ per token. */
  metadataHost?: string;
  /** Mint address prefix, where the issuer uses a vanity prefix (Backed: every mint starts Xs). */
  mintPrefix?: string;
  /** Jupiter's issuer tag. */
  jupTag?: string;
  legal: string;
  redeemable: string;
  /** Only set where a per-mint reserve figure is publicly fetchable. */
  proofOfReservesUrl?: string;
  sourceUrl: string;
  /** Stated when the issuer's own terms contradict its marketing. */
  caveat?: string;
}

export const ISSUERS: Record<string, IssuerProfile> = {
  backed: {
    key: 'backed',
    name: 'Backed Finance (xStocks)',
    backing: 'backed',
    updateAuthority: '5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq',
    metadataHost: 'xstocks-metadata.backed.fi',
    mintPrefix: 'Xs',
    jupTag: 'xstocks',
    legal: 'Backed Assets (JE) Limited, Jersey SPV. Bearer tracker certificates under a Liechtenstein FMA-approved EU base prospectus; collateral in segregated custodian sub-accounts under a three-party control agreement.',
    redeemable: 'Yes, including retail, subject to KYC and a $5,000 minimum. Not offered to US persons.',
    proofOfReservesUrl: 'https://api.xstocks.fi/api/v2/public/proof-of-reserves',
    sourceUrl: 'https://api.xstocks.fi/api/v2/public/assets',
  },
  ondo: {
    key: 'ondo',
    name: 'Ondo Global Markets',
    backing: 'issuer-claimed',
    updateAuthority: '9foMHsSDq7nMg4WPusSz9eY7tyxyukqborA8GyU5cUxD',
    jupTag: 'ondo',
    legal: 'Ondo Global Markets (BVI) Limited. Swiss-law bearer tracker certificates; custody at Alpaca Securities and BitGo Trust. Reg S, non-US.',
    redeemable: 'Primary redemption is KYC-gated and closed to US and Canadian persons.',
    sourceUrl: 'https://docs.ondo.finance/addresses',
    caveat: 'Daily attestations by Ankura Trust are promised in their documentation, but no attestation URL resolves publicly; they appear to sit behind a login.',
  },
  backpack: {
    key: 'backpack',
    name: 'Backpack Securities',
    backing: 'issuer-claimed',
    updateAuthority: '2cVYpagTt7ZGc3mmTXBa7fAznUtx5DUu6aCq8uVDaf4a',
    jupTag: 'backpack',
    legal: "Backpack's own comparison table gives the tokenized form as a claim on an SPV holding the underlying. Sunrise's terms name a Trek Nexus Markets bare-trust structure that Backpack's own docs never mention.",
    redeemable: 'Stated as 1:1 redeemable into real shares with a Backpack Securities account; secondary buyers may have no direct redemption right.',
    sourceUrl: 'https://api.sunrise.xyz/v1/tokens',
    caveat: 'No proof of reserves published for the token layer. Backpack’s audited proof-of-reserves covers exchange crypto balances, not these mints.',
  },
  prestocks: {
    key: 'prestocks',
    name: 'PreStocks',
    backing: 'issuer-claimed',
    updateAuthority: 'WV9PJN7XTmTLVwbutCLFxp8TyePee6Xq5mRq6Fti5Wc',
    jupTag: 'prestocks',
    legal: 'Pre-IPO exposure tokens. No issuing entity, custodian or counterparty is named, by stated policy; governing law is the British Virgin Islands. Attestations by BlockOffice Pte. Ltd. verify token supply against a cap PreStocks set, not assets held.',
    redeemable: 'No right to redeem. Their terms: a request for redemption does not of itself create an entitlement to have tokens redeemed.',
    sourceUrl: 'https://prestocks.com/api/prestocks',
    caveat: 'The homepage says "backed 1:1 by SPV exposure to the underlying company shares". The terms (8 September 2026) say the exposure may take any form including a derivative or synthetic arrangement on a proxy, may be substituted without notice, and gives holders no legal, equitable or contractual right to any underlying share. Whether shares are held is not verifiable from outside; conduct through the xAI merger and the SpaceX lockup has been consistent with real holdings.',
  },
  tessera: {
    key: 'tessera',
    name: 'Tessera',
    backing: 'synthetic',
    updateAuthority: 'EXvTtxurWBUNNCtLojaN8ZBJFNJPZFSH3szoih9hh7YW',
    jupTag: 'tessera',
    legal: 'Cayman SPC segregated portfolio. States in its own on-chain metadata: "This is a loan product, not a security."',
    redeemable: 'Loan participation right. No ownership, voting or dividend rights.',
    sourceUrl: 'https://lite-api.jup.ag/tokens/v2/search?query=tessera',
  },
  shift: {
    key: 'shift',
    name: 'Shift',
    backing: 'synthetic',
    metadataHost: 'tokens-data.shiftrwa.xyz',
    jupTag: 'shift',
    legal: 'Leveraged synthetic exposure (2x and 3x long and short).',
    redeemable: 'No.',
    sourceUrl: 'https://lite-api.jup.ag/tokens/v2/search?query=shift',
  },
};

// ─── Canonical entry ────────────────────────────────────────────────────────

export interface CanonicalAsset {
  mint: string;
  symbol: string;
  name: string;
  issuer: string;
  backing: Backing;
  isin?: string;
  underlyingSymbol?: string;
  underlyingIsin?: string;
  exchangeMic?: string;
  /** Live reserve figures, Backed only today. */
  reserve?: { sharesHeld: number; circulating: number; ratio: number; custodians: string[]; asOf: string };
}

interface Registry {
  /** mint → canonical entry */
  byMint: Map<string, CanonicalAsset>;
  /** lowercased symbol → canonical entries (a symbol can be issued by several issuers) */
  bySymbol: Map<string, CanonicalAsset[]>;
  /** lowercased name → canonical entries, for name-collision detection */
  byName: Map<string, CanonicalAsset[]>;
  builtAt: string;
  reservesRefreshedAt?: string;
  counts: Record<string, number>;
  errors: string[];
}

let registry: Registry | null = null;
let building: Promise<Registry> | null = null;
const REFRESH_MS = 24 * 60 * 60 * 1000;

async function getJson(url: string, ms = 15000): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

/** Backed: paginate the asset list, then fold in proof-of-reserves by symbol. */
async function loadBacked(): Promise<CanonicalAsset[]> {
  const assets: CanonicalAsset[] = [];
  for (let page = 0; page < 12; page += 1) {
    const body = await getJson(`https://api.xstocks.fi/api/v2/public/assets?page=${page}`, 20000);
    for (const n of body.nodes ?? []) {
      const sol = (n.deployments ?? []).find((d: any) => /solana/i.test(d.network ?? ''));
      if (!sol?.address) continue;
      assets.push({
        mint: sol.address, symbol: n.symbol, name: n.name, issuer: 'backed', backing: 'backed',
        isin: n.isin, underlyingSymbol: n.underlyingSymbol, underlyingIsin: n.underlyingIsin,
        exchangeMic: n.trading?.exchange?.mic ?? undefined,
      });
    }
    if (!body.page?.hasNextPage) break;
  }
  await applyBackedReserves(assets);
  return assets;
}

function reserveFrom(r: any): CanonicalAsset['reserve'] | null {
  const held = Number(r?.sharesHeld); const circ = Number(r?.circulatingSupply);
  if (!Number.isFinite(held) || !Number.isFinite(circ) || circ <= 0) return null;
  return { sharesHeld: held, circulating: circ, ratio: held / circ, custodians: (r.holdings ?? []).map((h: any) => h.provider).filter(Boolean), asOf: r.timestamp };
}

/**
 * Fold Backed's proof-of-reserves into the given assets, by symbol, in place.
 * Called at build AND every ten minutes after: Backed republishes roughly
 * every ten minutes, and the classifier refuses to call anything `backed` on a
 * figure older than six hours. Reserves captured once a day would therefore
 * be "stale" for eighteen hours of every twenty-four — which is exactly what
 * happened in production on 2026-09-16. Returns how many were updated.
 */
export async function applyBackedReserves(assets: Iterable<CanonicalAsset>): Promise<number> {
  const bySymbol = new Map<string, CanonicalAsset>();
  for (const a of assets) if (a.issuer === 'backed') bySymbol.set(a.symbol, a);
  let updated = 0;
  for (let page = 0; page < 12; page += 1) {
    let body: any;
    try { body = await getJson(`https://api.xstocks.fi/api/v2/public/proof-of-reserves?page=${page}`, 20000); }
    catch { break; }
    for (const r of body.nodes ?? []) {
      const a = bySymbol.get(r.symbol);
      const reserve = a ? reserveFrom(r) : null;
      if (a && reserve) { a.reserve = reserve; updated += 1; }
    }
    if (!body.page?.hasNextPage) break;
  }
  return updated;
}

/** One asset's reserves, live. Used when a request finds the cached figure stale. */
const liveReserveCache = new Map<string, { at: number; reserve: CanonicalAsset['reserve'] | null }>();
export async function refreshReserve(asset: CanonicalAsset): Promise<CanonicalAsset['reserve'] | null> {
  if (asset.issuer !== 'backed') return asset.reserve ?? null;
  const hit = liveReserveCache.get(asset.symbol);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.reserve;
  let reserve: CanonicalAsset['reserve'] | null = null;
  try { const body = await getJson(`https://api.xstocks.fi/api/v2/public/proof-of-reserves/${encodeURIComponent(asset.symbol)}`, 15000); reserve = reserveFrom(body.data ?? body); }
  catch { reserve = null; }
  liveReserveCache.set(asset.symbol, { at: Date.now(), reserve });
  if (reserve) asset.reserve = reserve;
  return reserve;
}

/** Sunrise: the cleanest typed source, and how we reach Backpack's mints. */
async function loadSunrise(): Promise<CanonicalAsset[]> {
  // The API rejects limit>200 and rejects an offset param, so this is one page.
  // It currently returns ~74 tokens, well inside the cap; Jupiter's issuer tags
  // are the backstop if that ever changes.
  const body = await getJson('https://api.sunrise.xyz/v1/tokens?limit=200', 20000);
  const tokens: any[] = body.data?.tokens ?? body.tokens ?? [];
  const out: CanonicalAsset[] = [];
  for (const t of tokens) {
    if (!t.address || !/solana/i.test(t.chain ?? 'solana')) continue;
    if (t.assetClass && !['stock', 'commodity', 'index'].includes(String(t.assetClass))) continue;
    const issuerKey = /backpack/i.test(t.issuer ?? '') ? 'backpack' : null;
    if (!issuerKey) continue;
    out.push({ mint: t.address, symbol: t.symbol, name: t.name ?? t.symbol, issuer: issuerKey, backing: ISSUERS[issuerKey].backing });
  }
  return out;
}

/** PreStocks: synthetic by their own terms. */
async function loadPreStocks(): Promise<CanonicalAsset[]> {
  const body = await getJson('https://prestocks.com/api/prestocks', 15000);
  const list = Array.isArray(body) ? body : (body.data ?? []);
  return list
    .filter((t: any) => t.contract_address)
    .map((t: any) => ({ mint: t.contract_address, symbol: t.symbol, name: t.name ?? t.symbol, issuer: 'prestocks', backing: 'synthetic' as Backing }));
}

/**
 * Jupiter's verified list: the tag taxonomy, which catches issuers we have no
 * direct feed for (Tessera, Shift) and cross-checks the ones we do.
 */
async function loadJupiterTagged(): Promise<CanonicalAsset[]> {
  const list = await getJson('https://lite-api.jup.ag/tokens/v2/tag?query=verified', 45000);
  const tokens = Array.isArray(list) ? list : (list.tokens ?? []);
  const byTag = new Map(Object.values(ISSUERS).filter((i) => i.jupTag).map((i) => [i.jupTag!, i]));
  const out: CanonicalAsset[] = [];
  for (const t of tokens) {
    const tags: string[] = t.tags ?? [];
    const issuer = tags.map((x) => byTag.get(x)).find(Boolean);
    if (!issuer) continue;
    const mint = t.id ?? t.address;
    if (!mint) continue;
    out.push({ mint, symbol: t.symbol, name: t.name ?? t.symbol, issuer: issuer.key, backing: issuer.backing });
  }
  return out;
}

async function build(): Promise<Registry> {
  const errors: string[] = [];
  const results = await Promise.allSettled([loadBacked(), loadSunrise(), loadPreStocks(), loadJupiterTagged()]);
  const names = ['backed', 'sunrise', 'prestocks', 'jupiter'];
  const all: CanonicalAsset[] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') all.push(...r.value);
    else errors.push(`${names[i]}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
  });

  // Direct issuer feeds win over Jupiter's tags, because they carry ISINs and reserves.
  const byMint = new Map<string, CanonicalAsset>();
  for (const a of all) {
    const prev = byMint.get(a.mint);
    if (!prev || (!prev.isin && a.isin) || (!prev.reserve && a.reserve)) byMint.set(a.mint, { ...prev, ...a });
  }
  const bySymbol = new Map<string, CanonicalAsset[]>();
  const byName = new Map<string, CanonicalAsset[]>();
  for (const a of byMint.values()) {
    const s = (a.symbol ?? '').toLowerCase();
    const n = (a.name ?? '').toLowerCase();
    if (s) bySymbol.set(s, [...(bySymbol.get(s) ?? []), a]);
    if (n) byName.set(n, [...(byName.get(n) ?? []), a]);
  }
  const counts: Record<string, number> = {};
  for (const a of byMint.values()) counts[a.issuer] = (counts[a.issuer] ?? 0) + 1;
  counts.total = byMint.size;
  counts.withReserve = [...byMint.values()].filter((a) => a.reserve).length;

  if (byMint.size === 0) throw new Error(`registry empty; sources failed: ${errors.join(' | ')}`);
  return { byMint, bySymbol, byName, builtAt: new Date().toISOString(), counts, errors };
}

const RESERVE_REFRESH_MS = 10 * 60 * 1000;
let reserveTimer: ReturnType<typeof setInterval> | null = null;
let refreshingReserves = false;
function startReserveRefresher(): void {
  if (reserveTimer) return;
  reserveTimer = setInterval(async () => {
    if (!registry || refreshingReserves) return;
    refreshingReserves = true;
    try {
      const n = await applyBackedReserves(registry.byMint.values());
      registry.counts.withReserve = [...registry.byMint.values()].filter((a) => a.reserve).length;
      registry.reservesRefreshedAt = new Date().toISOString();
      if (n === 0) console.warn('[asset-passport] reserve refresh returned nothing; existing figures kept');
      else {
        // Log success too. A refresh that applies an unchanged figure is
        // otherwise invisible, which made the first production tick look like
        // a failure on 2026-09-16.
        let newest = '';
        for (const a of registry.byMint.values()) if (a.reserve && a.reserve.asOf > newest) newest = a.reserve.asOf;
        console.log(`[asset-passport] reserves refreshed: ${n} assets, newest figure ${newest}`);
      }
    } catch (err) {
      console.error('[asset-passport] reserve refresh failed; existing figures kept:', err instanceof Error ? err.message : err);
    } finally { refreshingReserves = false; }
  }, RESERVE_REFRESH_MS);
  reserveTimer.unref?.();
  console.log(`[asset-passport] reserve refresher armed, every ${RESERVE_REFRESH_MS / 60000} min`);
}

/** The registry, built on first use and refreshed daily; reserves every ten minutes. Never throws to callers mid-flight. */
export async function getRegistry(force = false): Promise<Registry> {
  if (!force && registry && Date.now() - Date.parse(registry.builtAt) < REFRESH_MS) return registry;
  if (building) return building;
  building = build()
    .then((r) => { registry = r; startReserveRefresher(); return r; })
    .catch((err) => {
      if (registry) { console.error('[asset-passport] refresh failed, serving previous registry:', err); return registry; }
      throw err;
    })
    .finally(() => { building = null; });
  return building;
}

export function issuerProfile(key: string): IssuerProfile | undefined {
  return ISSUERS[key];
}

/**
 * Asset Passport — the classifier.
 *
 * Answers one question about a Solana mint: is this the real tokenized asset,
 * or something wearing its name?
 *
 * Five verdicts, and the rule that governs all of them: never render `backed`
 * without a reserve figure a reader can go and fetch for themselves. A trust
 * product does not get a second chance at that.
 *
 * A note on the risk flags. Mint authority, freeze authority and permanent
 * delegate are exactly the Token-2022 powers a regulated issuer is REQUIRED to
 * retain — to honour corporate actions, court orders and redemptions. Today's
 * scanners score the real Backed Tesla xStock 81/100 "danger" for holding
 * them, while the fake "NVIDIA xStock" beside it scores 29 with a single
 * copycat warning — the impersonator rates safer than the genuine asset. We
 * surface those powers as DISCLOSURE, never as a risk score.
 */

import type { CanonicalAsset } from './issuers.js';
import { getRegistry, issuerProfile, refreshReserve } from './issuers.js';

export type Verdict = 'backed' | 'issuer-claimed' | 'synthetic' | 'meme' | 'impersonator';

/** Reserves older than this stop supporting a `backed` verdict. Backed refreshes ~10 min. */
const RESERVE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export interface MarketView {
  symbol?: string;
  name?: string;
  verifiedOnJupiter: boolean;
  tags: string[];
  holders?: number | null;
  liquidityUsd?: number | null;
  organicScore?: number | null;
  launchpad?: string | null;
  dev?: string | null;
}

export interface Impersonation {
  /** The canonical asset this mint is imitating. */
  imitates: { mint: string; symbol: string; name: string; issuer: string };
  /** How the collision was detected. */
  basis: 'exact-symbol' | 'symbol-case' | 'name';
}

export interface Passport {
  mint: string;
  symbol: string | null;
  name: string | null;
  verdict: Verdict;
  /** Plain sentences a person can read. */
  reasons: string[];
  issuer: {
    key: string; name: string; legal: string; redeemable: string;
    sourceUrl: string; proofOfReservesUrl?: string; caveat?: string;
  } | null;
  identifiers: { isin?: string; underlyingSymbol?: string; underlyingIsin?: string; exchangeMic?: string } | null;
  reserve: { sharesHeld: number; circulating: number; ratio: number; custodians: string[]; asOf: string; fresh: boolean } | null;
  market: MarketView | null;
  impersonating: Impersonation | null;
  /** Canonical assets sharing this symbol — what the user probably meant. */
  alsoKnownAs: Array<{ mint: string; symbol: string; issuer: string; verdict: Verdict }>;
  disclosure: string[];
  computedAt: string;
  source: string;
}

/** Issuer-level backing, adjusted by per-asset evidence. Pure and testable. */
export function verdictFor(
  canonical: CanonicalAsset | undefined,
  market: MarketView | null,
  impersonating: Impersonation | null,
  now = Date.now(),
): { verdict: Verdict; reasons: string[] } {
  const reasons: string[] = [];

  if (!canonical) {
    if (impersonating) {
      reasons.push(`uses the ${impersonating.basis === 'name' ? 'name' : 'ticker'} of ${impersonating.imitates.symbol}, a real tokenized asset from ${issuerProfile(impersonating.imitates.issuer)?.name ?? impersonating.imitates.issuer}, but is a different mint`);
      if (market && (market.holders ?? 0) <= 5) reasons.push(`${market.holders ?? 0} holder${(market.holders ?? 0) === 1 ? '' : 's'}`);
      if (market?.liquidityUsd) reasons.push(`$${Math.round(market.liquidityUsd).toLocaleString()} of liquidity, so it can be bought`);
      if (market?.launchpad) reasons.push(`launched via ${market.launchpad}`);
      return { verdict: 'impersonator', reasons };
    }
    // Not a tokenized asset is a STATEMENT OF SCOPE, not an allegation. Most
    // tokens are not tokenized assets and there is nothing wrong with that.
    // Only `impersonator` is a warning.
    reasons.push('No issuer publishes this as a tokenized real-world asset, so there is no share, bond or commodity behind it.');
    if (market?.verifiedOnJupiter) reasons.push('It is on Jupiter’s verified list, so the ticker is recognised. That says nothing about backing either way.');
    if ((market?.holders ?? 0) > 1000) reasons.push(`${market!.holders!.toLocaleString()} holders.`);
    if (market?.launchpad) reasons.push(`Launched via ${market.launchpad}.`);
    return { verdict: 'meme', reasons };
  }

  const profile = issuerProfile(canonical.issuer);
  reasons.push(`published by ${profile?.name ?? canonical.issuer} on its own canonical list`);

  if (canonical.backing === 'synthetic') {
    // Synthetic means the holder has no enforceable claim on the underlying.
    // It does NOT mean nothing is held — that is unknowable from outside, and
    // the page must never say it. Say exactly what the terms establish.
    reasons.push('The holder has no enforceable claim on any underlying share. The issuer may hold something, but nothing in its terms gives a token holder a right to it or to redeem.');
    if (profile?.caveat) reasons.push(profile.caveat);
    return { verdict: 'synthetic', reasons };
  }

  if (canonical.backing === 'backed') {
    const r = canonical.reserve;
    if (!r) {
      reasons.push('the issuer publishes reserves, but none is available for this asset, so it is recorded as a claim rather than as proof');
      return { verdict: 'issuer-claimed', reasons };
    }
    const ageMs = now - Date.parse(r.asOf);
    if (!Number.isFinite(ageMs) || ageMs > RESERVE_MAX_AGE_MS) {
      reasons.push(`the last published reserve figure is stale (${r.asOf}), so it is recorded as a claim rather than as proof`);
      return { verdict: 'issuer-claimed', reasons };
    }
    if (r.ratio < 1) {
      reasons.push(`reserves cover only ${(r.ratio * 100).toFixed(2)}% of circulating supply`);
      return { verdict: 'issuer-claimed', reasons };
    }
    reasons.push(`${r.sharesHeld.toLocaleString()} shares held against ${Math.round(r.circulating).toLocaleString()} circulating, a ratio of ${r.ratio.toFixed(4)}`);
    if (r.custodians.length) reasons.push(`held at ${r.custodians.join(', ')}`);
    reasons.push(`reserve figure published ${r.asOf}, fetchable by anyone`);
    return { verdict: 'backed', reasons };
  }

  reasons.push('The issuer claims backing but publishes no reserve figure at the asset level that a reader can fetch, so it is recorded as a claim rather than as proof.');
  if (profile?.caveat) reasons.push(profile.caveat);
  return { verdict: 'issuer-claimed', reasons };
}

/** Token-2022 powers, reported as disclosure rather than scored as risk. */
export function disclosureFor(market: MarketView | null, canonical: CanonicalAsset | undefined): string[] {
  const out: string[] = [];
  if (!canonical) return out;
  out.push('The issuer retains mint, freeze and transfer powers over this token. For a regulated issuer these are required to honour corporate actions, redemptions and court orders, and are not on their own a sign of risk.');
  if (canonical.reserve) out.push('Reserves are attested by the issuer’s auditor with read-only access to the custodian. The circulating supply can be checked on chain; the shares held at the custodian cannot, and rest on that attestation.');
  return out;
}

/**
 * GoPlus fallback for symbol and name. Jupiter indexes on its own schedule, so
 * a mint minutes old can be missing from it entirely — and that is exactly when
 * an impersonator is most dangerous. Without a symbol we cannot detect a
 * collision at all, so we go to chain metadata rather than give up.
 */
async function onChainIdentity(mint: string): Promise<{ symbol?: string; name?: string } | null> {
  try {
    const res = await fetch(`https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${encodeURIComponent(mint)}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const body = await res.json();
    const t = body.result?.[mint] ?? Object.values(body.result ?? {})[0];
    const meta = (t as any)?.metadata;
    if (!meta) return null;
    return { symbol: meta.symbol, name: meta.name };
  } catch { return null; }
}

async function jupiter(mint: string): Promise<MarketView | null> {
  try {
    const res = await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${encodeURIComponent(mint)}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const body = await res.json();
    const list = Array.isArray(body) ? body : (body.tokens ?? []);
    const t = list.find((x: any) => (x.id ?? x.address) === mint) ?? list[0];
    if (!t) return null;
    return {
      symbol: t.symbol, name: t.name, verifiedOnJupiter: !!t.isVerified, tags: t.tags ?? [],
      holders: t.holderCount ?? null, liquidityUsd: t.liquidity ?? null,
      organicScore: t.organicScore ?? null, launchpad: t.launchpad ?? null, dev: t.dev ?? null,
    };
  } catch { return null; }
}

/** Is this mint wearing a canonical asset's symbol or name? */
export function detectImpersonation(
  mint: string,
  market: MarketView | null,
  bySymbol: Map<string, CanonicalAsset[]>,
  byName: Map<string, CanonicalAsset[]>,
): Impersonation | null {
  const sym = (market?.symbol ?? '').trim();
  const name = (market?.name ?? '').trim();
  const pick = (list: CanonicalAsset[] | undefined) => list?.find((c) => c.mint !== mint);

  const bySym = pick(bySymbol.get(sym.toLowerCase()));
  if (bySym) {
    const exact = bySym.symbol === sym;
    return { imitates: { mint: bySym.mint, symbol: bySym.symbol, name: bySym.name, issuer: bySym.issuer }, basis: exact ? 'exact-symbol' : 'symbol-case' };
  }
  const byN = pick(byName.get(name.toLowerCase()));
  if (byN) return { imitates: { mint: byN.mint, symbol: byN.symbol, name: byN.name, issuer: byN.issuer }, basis: 'name' };
  return null;
}

export async function buildPassport(mint: string): Promise<Passport> {
  const reg = await getRegistry();
  const canonical = reg.byMint.get(mint);
  // A stale cached reserve must not decide the verdict when a live one is a
  // single call away. The ten-minute refresher makes this rare; this makes it
  // impossible to be wrong merely because the refresher has not run yet.
  if (canonical?.backing === 'backed' && (!canonical.reserve || Date.now() - Date.parse(canonical.reserve.asOf) > RESERVE_MAX_AGE_MS)) {
    await refreshReserve(canonical);
  }
  let market = await jupiter(mint);
  if (!canonical && !market?.symbol) {
    const chain = await onChainIdentity(mint);
    if (chain?.symbol || chain?.name) {
      market = { verifiedOnJupiter: false, tags: [], ...(market ?? {}), symbol: chain.symbol, name: chain.name };
    }
  }
  const impersonating = canonical ? null : detectImpersonation(mint, market, reg.bySymbol, reg.byName);
  const { verdict, reasons } = verdictFor(canonical, market, impersonating);
  const profile = canonical ? issuerProfile(canonical.issuer) : undefined;

  const symbolKey = (canonical?.symbol ?? market?.symbol ?? '').toLowerCase();
  const alsoKnownAs = (reg.bySymbol.get(symbolKey) ?? [])
    .filter((c) => c.mint !== mint)
    .map((c) => ({ mint: c.mint, symbol: c.symbol, issuer: c.issuer, verdict: verdictFor(c, null, null).verdict }));

  return {
    mint,
    symbol: canonical?.symbol ?? market?.symbol ?? null,
    name: canonical?.name ?? market?.name ?? null,
    verdict,
    reasons,
    issuer: profile ? {
      key: profile.key, name: profile.name, legal: profile.legal, redeemable: profile.redeemable,
      sourceUrl: profile.sourceUrl,
      ...(profile.proofOfReservesUrl && canonical?.symbol ? { proofOfReservesUrl: `${profile.proofOfReservesUrl}/${canonical.symbol}` } : {}),
      ...(profile.caveat ? { caveat: profile.caveat } : {}),
    } : null,
    identifiers: canonical ? {
      ...(canonical.isin ? { isin: canonical.isin } : {}),
      ...(canonical.underlyingSymbol ? { underlyingSymbol: canonical.underlyingSymbol } : {}),
      ...(canonical.underlyingIsin ? { underlyingIsin: canonical.underlyingIsin } : {}),
      ...(canonical.exchangeMic ? { exchangeMic: canonical.exchangeMic } : {}),
    } : null,
    reserve: canonical?.reserve ? { ...canonical.reserve, fresh: Date.now() - Date.parse(canonical.reserve.asOf) < RESERVE_MAX_AGE_MS } : null,
    market,
    impersonating,
    alsoKnownAs,
    disclosure: disclosureFor(market, canonical),
    computedAt: new Date().toISOString(),
    source: 'SAID Protocol asset passport v0.1',
  };
}

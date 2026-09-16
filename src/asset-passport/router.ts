/**
 * Asset Passport — HTTP surface.
 *
 *   GET /api/asset/:mint          the passport for one mint
 *   GET /api/asset/search?q=NVDAx every mint using that symbol, real one first
 *   GET /api/asset/impersonators  the live feed: fakes with liquidity
 *   GET /api/asset/issuers        who we cover and what we can prove about each
 *   GET /api/asset/stats          call counts, so demand is visible from day one
 *
 * Free and unauthenticated by design: the point is that traders reach it
 * without any platform having to integrate anything.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { PublicKey } from '@solana/web3.js';
import { buildPassport, verdictFor, detectImpersonation, type Verdict } from './classify.js';
import { getRegistry, ISSUERS, refreshReserve } from './issuers.js';

const stats = {
  calls: 0,
  byVerdict: {} as Record<string, number>,
  searches: 0,
  errors: 0,
  since: new Date().toISOString(),
};

/**
 * Short TTL caches. A shared link fans out to many viewers hitting the same
 * ticker within minutes; without this every one of them is a Jupiter call,
 * and the impersonator feed alone is twelve. Results change slowly.
 */
const SEARCH_TTL_MS = 2 * 60 * 1000;
const FEED_TTL_MS = 10 * 60 * 1000;
const searchCache = new Map<string, { at: number; body: unknown }>();
let feedCache: { at: number; body: unknown } | null = null;
function cached<T>(map: Map<string, { at: number; body: unknown }>, key: string, ttl: number): T | null {
  const hit = map.get(key);
  return hit && Date.now() - hit.at < ttl ? (hit.body as T) : null;
}

function isMint(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  try { new PublicKey(s); return true; } catch { return false; }
}

/** Jupiter search by ticker, used to find the impostors wearing a symbol. */
async function searchBySymbol(query: string): Promise<any[]> {
  const res = await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) return [];
  const body = await res.json();
  return Array.isArray(body) ? body : (body.tokens ?? []);
}

export function createAssetPassportRouter(): Hono {
  const router = new Hono();

  router.get('/stats', (c: Context) => c.json(stats));

  router.get('/issuers', async (c: Context) => {
    const reg = await getRegistry();
    return c.json({
      issuers: Object.values(ISSUERS).map((i) => ({
        key: i.key, name: i.name, backing: i.backing, legal: i.legal, redeemable: i.redeemable,
        assetsOnSolana: reg.counts[i.key] ?? 0,
        proofOfReserves: i.proofOfReservesUrl ?? null,
        sourceUrl: i.sourceUrl,
        ...(i.caveat ? { caveat: i.caveat } : {}),
      })),
      totals: reg.counts,
      builtAt: reg.builtAt,
      ...(reg.errors.length ? { sourceErrors: reg.errors } : {}),
    });
  });

  /**
   * Everything trading under a ticker: the real asset first, then everything
   * wearing its name. This is the answer to "I searched NVDAx and got twenty
   * results" — which is the moment the confusion actually happens.
   */
  router.get('/search', async (c: Context) => {
    const q = (c.req.query('q') ?? '').trim();
    if (q.length < 2 || q.length > 32) return c.json({ error: 'q must be a ticker or name, 2 to 32 characters' }, 400);
    stats.searches += 1;
    const key = q.toLowerCase();
    const hit = cached<object>(searchCache, key, SEARCH_TTL_MS);
    if (hit) return c.json(hit);
    try {
      const reg = await getRegistry();
      // A ticker or a name: "TSLAx" and "Tesla xStock" must both find the real one.
      const canonical = reg.bySymbol.get(q.toLowerCase()) ?? reg.byName.get(q.toLowerCase()) ?? [];
      for (const a of canonical) if (a.backing === 'backed' && (!a.reserve || Date.now() - Date.parse(a.reserve.asOf) > 6 * 60 * 60 * 1000)) await refreshReserve(a);
      const hits = await searchBySymbol(q);
      const impostors = hits
        .filter((t) => {
          const mint = t.id ?? t.address;
          if (!mint || reg.byMint.has(mint)) return false;
          const sym = (t.symbol ?? '').toLowerCase();
          const name = (t.name ?? '').toLowerCase();
          return reg.bySymbol.has(sym) || reg.byName.has(name);
        })
        .map((t) => ({
          mint: t.id ?? t.address, symbol: t.symbol, name: t.name,
          verdict: 'impersonator' as Verdict,
          holders: t.holderCount ?? null, liquidityUsd: t.liquidity ?? null,
          launchpad: t.launchpad ?? null,
          imitates: detectImpersonation(t.id ?? t.address, { symbol: t.symbol, name: t.name, verifiedOnJupiter: !!t.isVerified, tags: t.tags ?? [] }, reg.bySymbol, reg.byName)?.imitates ?? null,
        }))
        .sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0));

      // No canonical tokenized asset uses this ticker. Do not answer "nothing
      // found" — the ticker is usually a real token, and the useful answer is
      // what it actually is, plus any same-ticker lookalikes beside it. A
      // lookalike here imitates another ordinary token, not a tokenized asset,
      // so it is named differently and never called an impersonator.
      if (canonical.length === 0) {
        const sameTicker = hits
          .filter((t) => (t.symbol ?? '').toLowerCase() === q.toLowerCase() || (t.name ?? '').toLowerCase() === q.toLowerCase())
          .sort((a, b) => (b.liquidity ?? 0) - (a.liquidity ?? 0));
        const [dominant, ...rest] = sameTicker;
        const body = {
          query: q,
          notATokenizedAsset: true,
          real: [],
          dominant: dominant ? {
            mint: dominant.id ?? dominant.address, symbol: dominant.symbol, name: dominant.name,
            verdict: 'meme' as Verdict, verifiedOnJupiter: !!dominant.isVerified,
            liquidityUsd: dominant.liquidity ?? null, holders: dominant.holderCount ?? null,
          } : null,
          lookalikes: rest.map((t) => ({
            mint: t.id ?? t.address, symbol: t.symbol, name: t.name,
            liquidityUsd: t.liquidity ?? null, holders: t.holderCount ?? null,
            launchpad: t.launchpad ?? null, verifiedOnJupiter: !!t.isVerified,
          })),
          impersonators: [],
          summary: dominant
            ? `${q} is not a tokenized stock. ${sameTicker.length} token${sameTicker.length === 1 ? ' trades' : 's trade'} under this ticker${rest.length ? `, and ${rest.length} ${rest.length === 1 ? 'of them is not' : 'of them are not'} the main one` : ''}.`
            : `Nothing is trading under ${q}.`,
          computedAt: new Date().toISOString(),
        };
        searchCache.set(key, { at: Date.now(), body });
        return c.json(body);
      }

      const body = {
        query: q,
        real: canonical.map((a) => ({
          mint: a.mint, symbol: a.symbol, name: a.name, issuer: a.issuer,
          verdict: verdictFor(a, null, null).verdict,
          isin: a.isin ?? null,
          reserve: a.reserve ? { ratio: Number(a.reserve.ratio.toFixed(4)), custodians: a.reserve.custodians, asOf: a.reserve.asOf } : null,
        })),
        impersonators: impostors,
        summary: `${canonical.length} real, ${impostors.length} using the name, ${impostors.filter((i) => (i.liquidityUsd ?? 0) > 0).length} of those with liquidity`,
        computedAt: new Date().toISOString(),
      };
      searchCache.set(key, { at: Date.now(), body });
      return c.json(body);
    } catch (err) {
      stats.errors += 1;
      console.error('[asset-passport] search failed', q, err);
      return c.json({ error: 'search failed', details: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  /**
   * The live feed of impostors carrying real liquidity, across the tickers
   * most worth faking. This is the thing that gets quoted.
   */
  router.get('/impersonators', async (c: Context) => {
    const limit = Math.min(Number(c.req.query('limit') ?? 25) || 25, 100);
    if (feedCache && Date.now() - feedCache.at < FEED_TTL_MS) {
      const b = feedCache.body as any;
      return c.json({ ...b, impersonators: b.impersonators.slice(0, limit), cached: true });
    }
    try {
      const reg = await getRegistry();
      // The most-faked tickers: the real assets with the deepest markets.
      const tickers = [...reg.bySymbol.values()]
        .map((list) => list[0])
        .filter((a) => a.issuer === 'backed' && a.reserve)
        .sort((a, b) => (b.reserve?.circulating ?? 0) - (a.reserve?.circulating ?? 0))
        .slice(0, 12)
        .map((a) => a.symbol);

      const found: any[] = [];
      for (const t of tickers) {
        const hits = await searchBySymbol(t);
        for (const x of hits) {
          const mint = x.id ?? x.address;
          if (!mint || reg.byMint.has(mint)) continue;
          if ((x.symbol ?? '').toLowerCase() !== t.toLowerCase() && (x.name ?? '').toLowerCase() !== (reg.bySymbol.get(t.toLowerCase())?.[0]?.name ?? '').toLowerCase()) continue;
          if ((x.liquidity ?? 0) <= 0) continue;
          found.push({
            mint, symbol: x.symbol, name: x.name, imitates: t,
            liquidityUsd: Math.round(x.liquidity), holders: x.holderCount ?? null,
            launchpad: x.launchpad ?? null, firstPoolAt: x.firstPool?.createdAt ?? null,
          });
        }
      }
      found.sort((a, b) => b.liquidityUsd - a.liquidityUsd);
      const totalLiquidity = found.reduce((n, f) => n + f.liquidityUsd, 0);
      const body = {
        tickersChecked: tickers,
        count: found.length,
        totalLiquidityUsd: totalLiquidity,
        note: 'Tokens using the ticker or name of a real tokenized asset, with live liquidity, which are not that asset. Search results are capped per ticker, so this is a lower bound.',
        impersonators: found,
        computedAt: new Date().toISOString(),
      };
      feedCache = { at: Date.now(), body };
      return c.json({ ...body, impersonators: found.slice(0, limit) });
    } catch (err) {
      stats.errors += 1;
      console.error('[asset-passport] impersonator feed failed', err);
      return c.json({ error: 'feed failed', details: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  router.get('/:mint', async (c: Context) => {
    const mint = c.req.param('mint');
    if (!isMint(mint)) return c.json({ error: 'path must be a Solana mint address' }, 400);
    stats.calls += 1;
    try {
      const passport = await buildPassport(mint);
      stats.byVerdict[passport.verdict] = (stats.byVerdict[passport.verdict] ?? 0) + 1;
      return c.json(passport);
    } catch (err) {
      stats.errors += 1;
      console.error('[asset-passport] passport failed', mint, err);
      return c.json({ error: 'Failed to build passport', details: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  return router;
}

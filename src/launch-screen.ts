/**
 * SAID Protocol — Launch Screen
 *
 * A launch-time deployer verdict for stock-paired (and any other) memecoin
 * launches. Built for launchpads: StonkFun, pump.fun Custom Pairs, ClawPump.
 *
 *   GET /api/launch-screen?launcher=<wallet>[&mint=<mint>]
 *   GET /api/launch-screen/stats
 *
 * Why this exists (measured 2026-09-11 on live StonkFun launches): in a
 * launch's first minutes BOTH incumbent signals are blind. Token-safety
 * scanners have no record of a mint that is minutes old, and the launcher is
 * almost never a registered agent. The only signal that exists at launch time
 * is the launcher's own on-chain history — and it separates cleanly (a wallet
 * six minutes old with thousands of transactions is not a person).
 *
 * The verdict has three layers, kept separate and labelled so nothing is
 * overclaimed:
 *
 *   history   the launcher wallet's age, activity scale, funder, and how many
 *             launch pools it currently has open. Available for ANY wallet.
 *   identity  whether the launcher is a registered + verified SAID agent, its
 *             reputation tier/score, and whether it has stake at risk. This is
 *             the badge: the thing an anonymous launcher can EARN to clear a
 *             history flag. Screening is the stick; identity is the carrot.
 *   token     GoPlus token-safety on the mint, when a mint is supplied. A
 *             commodity input; honestly "no record yet" for fresh mints.
 *
 * Read-only. Public RPC-safe (bounded pagination, cached). Every call is
 * counted — the trust screen shipped without a counter and nobody could tell
 * whether anyone ever used it; this one will not repeat that.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { Connection, PublicKey } from '@solana/web3.js';
import type { PrismaClient } from '@prisma/client';
import { getV8Reputation } from './reputation-v0.8/read.js';
import { getEnforcementStatus } from './enforcement.js';

// ─── Raydium LaunchLab (what StonkFun launches through) ─────────────────────
// PoolState is 170 bytes with the creator pubkey at byte 133 — derived
// byte-exactly against live pools on 2026-09-11, not taken from a layout doc.
// Graduated pools close their account, so a creator's OPEN pool count
// undercounts lifetime launches; it is reported as exactly that.
export const LAUNCHLAB_PROGRAM = 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj';
export const LAUNCHLAB_POOL_SIZE = 170;
export const LAUNCHLAB_CREATOR_OFFSET = 133;

const SIG_PAGE = 1000;
const MAX_SIG_PAGES = 3; // ≤3,000 signatures walked; beyond that age is a floor
const CACHE_TTL_MS = 5 * 60 * 1000;
const GOPLUS = 'https://api.gopluslabs.io/api/v1/solana/token_security';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface LauncherHistory {
  walletAgeHours: number | null;
  /** True when the signature walk hit its cap: age is a floor, txCount a floor. */
  truncated: boolean;
  firstTxAt: string | null;
  txCount: number;
  /** Wallet that funded the launcher's first transaction, when it can be read. */
  fundedBy: string | null;
  /** LaunchLab pools this wallet currently has open. Undercounts: graduated pools close. */
  openLaunchPools: number | null;
}

export interface LauncherIdentity {
  registered: boolean;
  verified: boolean;
  tier: string;
  score: number | null;
  scored: boolean;
  staked: boolean;
  stakeSol: number;
  slashed: boolean;
  /** The badge a launchpad can render. */
  badge: 'verified-launcher' | 'registered' | 'unverified';
}

export interface TokenSafety {
  available: boolean;
  symbol?: string;
  name?: string;
  holders?: number | null;
  mintable?: boolean;
  freezable?: boolean;
  flags: string[];
  risk: 'clean' | 'caution' | 'high' | 'unknown';
  reason?: string;
}

export type LaunchVerdict = 'clear' | 'caution' | 'high-risk';

export interface LaunchScreenResult {
  launcher: string;
  mint: string | null;
  verdict: LaunchVerdict;
  reasons: string[];
  history: LauncherHistory;
  identity: LauncherIdentity;
  token: TokenSafety | null;
  computedAt: string;
  source: string;
}

// ─── The verdict (pure, tested) ─────────────────────────────────────────────

/**
 * Transparent rules, in order of severity. Token danger and a brand-new wallet
 * can never be argued down; a verified SAID identity with stake can clear the
 * softer history flags — that is the whole point of the badge.
 */
export function judge(
  history: LauncherHistory,
  identity: LauncherIdentity,
  token: TokenSafety | null,
): { verdict: LaunchVerdict; reasons: string[] } {
  const reasons: string[] = [];
  // Held in an object: TypeScript narrows a plain `let` to its initializer and
  // cannot see assignments made inside the `bump` closure.
  const v: { verdict: LaunchVerdict } = { verdict: 'clear' };
  const rank: Record<LaunchVerdict, number> = { clear: 0, caution: 1, 'high-risk': 2 };
  const bump = (to: LaunchVerdict) => { if (rank[to] > rank[v.verdict]) v.verdict = to; };

  // Token: can only make things worse.
  if (token?.available) {
    if (token.risk === 'high') { bump('high-risk'); reasons.push(`token: ${token.flags.join('; ')}`); }
    else if (token.risk === 'caution') { bump('caution'); reasons.push(`token: ${token.flags.join('; ')}`); }
  } else if (token && !token.available) {
    reasons.push(`token: no safety record yet (${token.reason ?? 'fresh mint'})`);
  }

  // History: the launch-time signal.
  const age = history.walletAgeHours;
  const botScale = history.txCount >= 5000 || (history.truncated && history.txCount >= 3000);
  if (age !== null && age < 1) {
    bump('high-risk'); reasons.push(`launcher wallet is ${Math.max(1, Math.round(age * 60))} minutes old`);
  } else if (age !== null && age < 24 && botScale) {
    bump('high-risk'); reasons.push(`launcher wallet is under a day old with ${history.txCount}+ transactions (fresh bot wallet)`);
  } else if (age !== null && age < 24) {
    bump('caution'); reasons.push(`launcher wallet is ${age.toFixed(1)} hours old`);
  } else if (age !== null && age < 24 * 7) {
    bump('caution'); reasons.push(`launcher wallet is ${Math.round(age / 24)} days old`);
  }
  if (botScale && !(age !== null && age < 24)) {
    bump('caution'); reasons.push(`bot-scale activity (${history.truncated ? '≥' : ''}${history.txCount} transactions)`);
  }
  if (history.openLaunchPools !== null && history.openLaunchPools >= 3) {
    bump('caution'); reasons.push(`serial launcher: ${history.openLaunchPools} launch pools currently open`);
  }
  if (age === null) {
    // Missing evidence is not a clean bill. A launchpad must never render
    // "clear" because the RPC was slow; a verified identity can still clear this.
    bump('caution'); reasons.push('launcher history unavailable');
  }

  // Identity: the carrot. A verified launcher with stake clears the soft flags.
  if (identity.slashed) {
    bump('high-risk'); reasons.push('launcher has been slashed on SAID');
  } else if (identity.badge === 'verified-launcher') {
    reasons.push(`identity: SAID-verified launcher${identity.scored ? `, ${identity.tier} ${identity.score}/100` : ''}${identity.staked ? `, ${identity.stakeSol} SOL at stake` : ''}`);
    if (v.verdict === 'caution') { v.verdict = 'clear'; reasons.push('history flags cleared by verified identity'); }
  } else if (identity.registered) {
    reasons.push('identity: registered on SAID, not verified');
  } else {
    reasons.push('identity: launcher is not a registered SAID agent');
    if (v.verdict === 'clear' && age !== null && age < 24 * 90) bump('caution');
  }

  return { verdict: v.verdict, reasons };
}

// ─── History (bounded, cached) ──────────────────────────────────────────────

const historyCache = new Map<string, { at: number; value: LauncherHistory }>();

export async function launcherHistory(connection: Connection, wallet: string): Promise<LauncherHistory> {
  const hit = historyCache.get(wallet);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const pubkey = new PublicKey(wallet);
  let before: string | undefined;
  let oldest: { signature: string; blockTime?: number | null } | undefined;
  let txCount = 0;
  let pages = 0;
  while (pages < MAX_SIG_PAGES) {
    const sigs = await connection.getSignaturesForAddress(pubkey, { limit: SIG_PAGE, ...(before ? { before } : {}) });
    if (sigs.length === 0) break;
    txCount += sigs.length;
    oldest = sigs[sigs.length - 1];
    pages += 1;
    if (sigs.length < SIG_PAGE) break;
    before = oldest.signature;
  }
  const truncated = pages >= MAX_SIG_PAGES && txCount >= MAX_SIG_PAGES * SIG_PAGE;
  const firstMs = oldest?.blockTime ? oldest.blockTime * 1000 : null;

  // Funder: in the first transaction, the account whose SOL fell while this wallet's rose.
  let fundedBy: string | null = null;
  if (oldest && !truncated) {
    try {
      const tx = await connection.getTransaction(oldest.signature, { maxSupportedTransactionVersion: 0 });
      const keys = tx?.transaction.message.getAccountKeys().staticAccountKeys.map((k) => k.toBase58()) ?? [];
      const pre = tx?.meta?.preBalances ?? [];
      const post = tx?.meta?.postBalances ?? [];
      const me = keys.indexOf(wallet);
      if (me >= 0 && post[me] > pre[me]) {
        const gained = post[me] - pre[me];
        const src = keys.findIndex((_, i) => i !== me && pre[i] - post[i] >= gained - 10_000);
        if (src >= 0) fundedBy = keys[src];
      } else if (keys[0] && keys[0] !== wallet) {
        fundedBy = keys[0];
      }
    } catch { /* funder is best-effort */ }
  }

  // Open LaunchLab pools by this creator (exact for OPEN pools; graduated ones are gone).
  let openLaunchPools: number | null = null;
  try {
    const accounts = await connection.getProgramAccounts(new PublicKey(LAUNCHLAB_PROGRAM), {
      dataSlice: { offset: 0, length: 0 },
      filters: [{ dataSize: LAUNCHLAB_POOL_SIZE }, { memcmp: { offset: LAUNCHLAB_CREATOR_OFFSET, bytes: wallet } }],
    });
    openLaunchPools = accounts.length;
  } catch { openLaunchPools = null; }

  const value: LauncherHistory = {
    walletAgeHours: firstMs ? (Date.now() - firstMs) / 3_600_000 : null,
    truncated,
    firstTxAt: firstMs ? new Date(firstMs).toISOString() : null,
    txCount,
    fundedBy,
    openLaunchPools,
  };
  historyCache.set(wallet, { at: Date.now(), value });
  return value;
}

// ─── Identity ───────────────────────────────────────────────────────────────

export async function launcherIdentity(prisma: PrismaClient, connection: Connection, wallet: string): Promise<LauncherIdentity> {
  const agent = await prisma.agent.findUnique({ where: { wallet }, select: { isVerified: true } }).catch(() => null);
  const rep = agent ? await getV8Reputation(prisma, wallet).catch(() => null) : null;
  // Enforcement reads the on-chain stake; one known account-layout mismatch (Xona) throws — never let it take the verdict down.
  const enf = agent ? await getEnforcementStatus(connection, wallet).catch(() => null) : null;
  const registered = !!agent;
  const verified = !!agent?.isVerified;
  const scored = !!rep?.found;
  return {
    registered,
    verified,
    tier: scored ? rep!.tier : 'unranked',
    score: scored ? Math.round(rep!.compositeScore * 100) : null,
    scored,
    staked: !!enf?.staked,
    stakeSol: enf?.stakeAmountSol ?? 0,
    slashed: !!enf?.isSlashed,
    badge: verified ? 'verified-launcher' : registered ? 'registered' : 'unverified',
  };
}

// ─── Token safety (GoPlus, optional) ────────────────────────────────────────

export async function tokenSafety(mint: string): Promise<TokenSafety> {
  try {
    const res = await fetch(`${GOPLUS}?contract_addresses=${encodeURIComponent(mint)}`, { signal: AbortSignal.timeout(6000) });
    const body = (await res.json()) as { result?: Record<string, any> };
    const t = body.result?.[mint] ?? Object.values(body.result ?? {})[0];
    if (!t) return { available: false, flags: [], risk: 'unknown', reason: 'no GoPlus record yet' };
    const mintable = t.mintable?.status === '1';
    const freezable = t.freezable?.status === '1';
    const flags: string[] = [];
    if (mintable) flags.push('mint authority live (supply can inflate)');
    if (freezable) flags.push('freeze authority live (accounts can be frozen)');
    if (t.non_transferable === '1') flags.push('non-transferable');
    if (t.transfer_hook?.status === '1') flags.push('transfer hook set');
    if (t.transfer_fee && Object.keys(t.transfer_fee).length) flags.push('transfer fee token');
    return {
      available: true,
      symbol: t.metadata?.symbol,
      name: t.metadata?.name,
      holders: Number(t.holder_count) || null,
      mintable,
      freezable,
      flags,
      risk: flags.length === 0 ? 'clean' : flags.length <= 1 ? 'caution' : 'high',
    };
  } catch (err) {
    return { available: false, flags: [], risk: 'unknown', reason: err instanceof Error ? err.message : 'lookup failed' };
  }
}

// ─── Router ─────────────────────────────────────────────────────────────────

const stats = { calls: 0, byVerdict: { clear: 0, caution: 0, 'high-risk': 0 } as Record<LaunchVerdict, number>, errors: 0, since: new Date().toISOString() };

function isPubkey(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  try { new PublicKey(s); return true; } catch { return false; }
}

export async function buildLaunchScreen(
  prisma: PrismaClient,
  connection: Connection,
  launcher: string,
  mint: string | null,
): Promise<LaunchScreenResult> {
  const [history, identity, token] = await Promise.all([
    launcherHistory(connection, launcher).catch((): LauncherHistory => ({ walletAgeHours: null, truncated: false, firstTxAt: null, txCount: 0, fundedBy: null, openLaunchPools: null })),
    launcherIdentity(prisma, connection, launcher),
    mint ? tokenSafety(mint) : Promise.resolve(null),
  ]);
  const { verdict, reasons } = judge(history, identity, token);
  return { launcher, mint, verdict, reasons, history, identity, token, computedAt: new Date().toISOString(), source: 'SAID Protocol launch screen v0.1' };
}

export function createLaunchScreenRouter(connection: Connection, prisma: PrismaClient): Hono {
  const router = new Hono();

  router.get('/stats', (c: Context) => c.json(stats));

  router.get('/', async (c: Context) => {
    const launcher = c.req.query('launcher');
    const mint = c.req.query('mint') ?? null;
    if (!isPubkey(launcher)) return c.json({ error: 'Required query param: launcher (a Solana wallet address)' }, 400);
    if (mint !== null && !isPubkey(mint)) return c.json({ error: 'mint must be a Solana mint address' }, 400);
    stats.calls += 1;
    try {
      const result = await buildLaunchScreen(prisma, connection, launcher, mint);
      stats.byVerdict[result.verdict] += 1;
      return c.json(result);
    } catch (err) {
      stats.errors += 1;
      console.error('[launch-screen] failed', launcher, err);
      return c.json({ error: 'Failed to screen launcher', details: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  return router;
}

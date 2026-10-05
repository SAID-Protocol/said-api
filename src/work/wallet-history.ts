/**
 * Work loop — the wallet-history job.
 *
 * One job = "summarise wallet W's signatures between two pinned times".
 * This file is the single definition of that computation. The worker client
 * runs it on the worker's own RPC; the server runs it for spot checks. Both
 * import the same code, so two honest runs produce the same bytes.
 *
 * Determinism rules, because panel answers must match exactly:
 *   - the window is pinned by the job ([fromTime, toTime) in unix seconds),
 *     and toTime is always in the past, so late transactions cannot land in it
 *   - only finalized signatures are read
 *   - signatures with no blockTime are ignored
 *   - if the window holds more than maxSignatures, the newest maxSignatures
 *     are kept and `truncated` is set
 *   - the digest is over the signatures sorted as strings, so page order
 *     never matters
 */

import { createHash } from 'crypto';
import { Connection, PublicKey } from '@solana/web3.js';

export const WALLET_HISTORY_KIND = 'wallet_history_v1';

export interface WalletHistorySpec {
  wallet: string;
  fromTime: number; // unix seconds, inclusive
  toTime: number; // unix seconds, exclusive
  maxSignatures: number;
}

export interface WalletHistoryResult {
  v: 1;
  wallet: string;
  fromTime: number;
  toTime: number;
  txCount: number;
  failedCount: number;
  activeDays: number;
  firstBlockTime: number | null;
  lastBlockTime: number | null;
  truncated: boolean;
  signaturesDigest: string;
}

/** The subset of an RPC signature record the job reads. */
export interface SigInfo {
  signature: string;
  blockTime?: number | null;
  err?: unknown;
}

const SIG_PAGE = 1000;
// Bound on pages walked before reaching the window. toTime is minutes old
// when a job is cut, so only a wallet doing thousands of transactions in
// those minutes could exhaust this; such a job fails rather than guesses.
const MAX_PAGES = 25;

export function isValidSpec(spec: unknown): spec is WalletHistorySpec {
  if (spec === null || typeof spec !== 'object') return false;
  const s = spec as Record<string, unknown>;
  if (typeof s.wallet !== 'string') return false;
  try {
    new PublicKey(s.wallet);
  } catch {
    return false;
  }
  return (
    Number.isInteger(s.fromTime) &&
    Number.isInteger(s.toTime) &&
    Number.isInteger(s.maxSignatures) &&
    (s.fromTime as number) < (s.toTime as number) &&
    (s.maxSignatures as number) > 0
  );
}

/** Pure: the signatures a job covers, newest-first, with the cap applied. */
export function windowSignatures(sigs: SigInfo[], spec: WalletHistorySpec): { kept: SigInfo[]; truncated: boolean } {
  const inWindow = sigs.filter(
    (s) => typeof s.blockTime === 'number' && s.blockTime >= spec.fromTime && s.blockTime < spec.toTime,
  );
  const truncated = inWindow.length > spec.maxSignatures;
  return { kept: truncated ? inWindow.slice(0, spec.maxSignatures) : inWindow, truncated };
}

/**
 * Pure: turn the signatures of a window into the job result. `sigs` must be
 * newest-first, as the RPC returns them; anything outside the window or
 * without a blockTime is dropped here, so callers may over-supply.
 */
export function summarize(sigs: SigInfo[], spec: WalletHistorySpec): WalletHistoryResult {
  const { kept, truncated } = windowSignatures(sigs, spec);

  const days = new Set<number>();
  let failedCount = 0;
  let first: number | null = null;
  let last: number | null = null;
  for (const s of kept) {
    const t = s.blockTime as number;
    days.add(Math.floor(t / 86400));
    if (s.err !== null && s.err !== undefined) failedCount++;
    if (first === null || t < first) first = t;
    if (last === null || t > last) last = t;
  }

  const sorted = kept.map((s) => s.signature).sort();
  const signaturesDigest = createHash('sha256').update(sorted.join('\n')).digest('hex');

  return {
    v: 1,
    wallet: spec.wallet,
    fromTime: spec.fromTime,
    toTime: spec.toTime,
    txCount: kept.length,
    failedCount,
    activeDays: days.size,
    firstBlockTime: first,
    lastBlockTime: last,
    truncated,
    signaturesDigest,
  };
}

/** Walk the wallet's signatures newest-first until the window is covered. */
export async function fetchWindowSignatures(conn: Connection, spec: WalletHistorySpec): Promise<SigInfo[]> {
  const pk = new PublicKey(spec.wallet);
  const out: SigInfo[] = [];
  let before: string | undefined;
  let inWindow = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await conn.getSignaturesForAddress(pk, { limit: SIG_PAGE, before }, 'finalized');
    if (batch.length === 0) return out;
    for (const s of batch) {
      if (typeof s.blockTime !== 'number') continue;
      if (s.blockTime < spec.fromTime) return out; // past the window's old edge
      if (s.blockTime < spec.toTime) {
        out.push({ signature: s.signature, blockTime: s.blockTime, err: s.err });
        // One past the cap is enough for summarize() to see the truncation.
        if (++inWindow > spec.maxSignatures) return out;
      }
    }
    if (batch.length < SIG_PAGE) return out;
    before = batch[batch.length - 1].signature;
  }
  throw new Error(`wallet history: window not reached within ${MAX_PAGES} pages for ${spec.wallet}`);
}

export async function runWalletHistory(conn: Connection, spec: WalletHistorySpec): Promise<WalletHistoryResult> {
  return summarize(await fetchWindowSignatures(conn, spec), spec);
}

const RESULT_KEYS: Array<keyof WalletHistoryResult> = [
  'v',
  'wallet',
  'fromTime',
  'toTime',
  'txCount',
  'failedCount',
  'activeDays',
  'firstBlockTime',
  'lastBlockTime',
  'truncated',
  'signaturesDigest',
];

/**
 * Validate an untrusted result and rebuild it with exactly the known keys in
 * a fixed order. Returns null when it is not a well-formed answer to `spec`.
 */
export function canonicalResult(input: unknown, spec: WalletHistorySpec): WalletHistoryResult | null {
  if (input === null || typeof input !== 'object') return null;
  const r = input as Record<string, unknown>;
  const count = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;
  const time = (v: unknown) => v === null || Number.isInteger(v);
  if (r.v !== 1) return null;
  if (r.wallet !== spec.wallet || r.fromTime !== spec.fromTime || r.toTime !== spec.toTime) return null;
  if (!count(r.txCount) || !count(r.failedCount) || !count(r.activeDays)) return null;
  if ((r.txCount as number) > spec.maxSignatures || (r.failedCount as number) > (r.txCount as number)) return null;
  if (!time(r.firstBlockTime) || !time(r.lastBlockTime)) return null;
  if (typeof r.truncated !== 'boolean') return null;
  if (typeof r.signaturesDigest !== 'string' || !/^[0-9a-f]{64}$/.test(r.signaturesDigest)) return null;
  const out: Record<string, unknown> = {};
  for (const k of RESULT_KEYS) out[k] = r[k];
  return out as unknown as WalletHistoryResult;
}

/** The value panel members must agree on. Always computed server-side. */
export function hashResult(result: WalletHistoryResult): string {
  const ordered = RESULT_KEYS.map((k) => [k, result[k]]);
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

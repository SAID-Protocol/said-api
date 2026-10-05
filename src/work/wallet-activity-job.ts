/**
 * Work loop — the wallet-activity job.
 *
 * The wallet-history job plus what the reputation layer's activity stats
 * need: SOL moved, distinct counterparties and mints the wallet initialised.
 * Those come from the transactions themselves, so this job costs a worker
 * roughly one RPC call per hundred transactions on top of the history walk.
 *
 * The derivations mirror src/services/wallet-activity.ts (the API's own
 * scanner) so an accepted answer can stand in for a scan of the same window:
 *   - only successful transactions count
 *   - volume is the absolute change in the wallet's own SOL balance, summed
 *   - a counterparty is any other account in the transaction except the
 *     system program
 *   - a launched mint is an InitializeMint whose authority is the wallet
 *
 * An answer is only produced when the RPC returned every transaction; a
 * partial read throws, and the lease expires instead of a guess being sent.
 */

import { createHash } from 'crypto';
import { Connection, PublicKey } from '@solana/web3.js';
import type { PrismaClient } from '@prisma/client';
import {
  fetchWindowSignatures,
  summarize,
  windowSignatures,
  type SigInfo,
  type WalletHistoryResult,
  type WalletHistorySpec,
} from './wallet-history.js';

export const WALLET_ACTIVITY_KIND = 'wallet_activity_v1';

const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const INIT_MINT_TYPES = new Set(['initializeMint', 'initializeMint2', 'initializeMintCloseAuthority']);
const TX_BATCH = 100;
const MAX_MINTS = 1000;

export interface WalletActivityResult extends Omit<WalletHistoryResult, 'v'> {
  v: 1;
  successCount: number;
  successActiveDays: number;
  firstSuccessTime: number | null;
  lastSuccessTime: number | null;
  volumeLamports: string; // decimal string: can exceed a JS safe integer
  uniqueCounterparties: number;
  launchedMints: string[]; // sorted
}

/** The parts of a parsed transaction this job reads. */
export interface TxView {
  accountKeys: string[];
  preBalances: number[];
  postBalances: number[];
  instructions: Array<{ programId: string; parsed?: { type?: string; info?: Record<string, unknown> } }>;
}

/** Pure: fold the successful transactions of a window into the activity result. */
export function summarizeActivity(
  sigs: SigInfo[],
  txBySignature: Map<string, TxView>,
  spec: WalletHistorySpec,
): WalletActivityResult {
  const history = summarize(sigs, spec);
  const { kept } = windowSignatures(sigs, spec);
  const counterparties = new Set<string>();
  const mints = new Set<string>();
  const days = new Set<number>();
  let volume = 0n;
  let successCount = 0;
  let first: number | null = null;
  let last: number | null = null;

  for (const s of kept) {
    if (s.err !== null && s.err !== undefined) continue;
    const tx = txBySignature.get(s.signature);
    if (!tx) throw new Error(`wallet activity: transaction ${s.signature} was not returned by the RPC`);
    successCount++;
    const t = s.blockTime as number;
    days.add(Math.floor(t / 86400));
    if (first === null || t < first) first = t;
    if (last === null || t > last) last = t;

    const idx = tx.accountKeys.indexOf(spec.wallet);
    if (idx >= 0) {
      const delta = BigInt(tx.postBalances[idx] ?? 0) - BigInt(tx.preBalances[idx] ?? 0);
      volume += delta < 0n ? -delta : delta;
    }
    for (let k = 0; k < tx.accountKeys.length; k++) {
      const addr = tx.accountKeys[k];
      if (k !== idx && addr && addr !== SYSTEM_PROGRAM) counterparties.add(addr);
    }
    for (const ix of tx.instructions) {
      if (ix.programId !== SPL_TOKEN_PROGRAM && ix.programId !== TOKEN_2022_PROGRAM) continue;
      if (!ix.parsed?.type || !INIT_MINT_TYPES.has(ix.parsed.type)) continue;
      const info = ix.parsed.info ?? {};
      const authority = info.mintAuthority ?? info.authority;
      if (authority === spec.wallet && typeof info.mint === 'string') mints.add(info.mint);
    }
  }

  return {
    ...history,
    successCount,
    successActiveDays: days.size,
    firstSuccessTime: first,
    lastSuccessTime: last,
    volumeLamports: volume.toString(),
    uniqueCounterparties: counterparties.size,
    launchedMints: [...mints].sort(),
  };
}

function keyString(k: unknown): string {
  const any = k as { pubkey?: { toString(): string }; toString?: () => string };
  return any?.pubkey ? any.pubkey.toString() : (any?.toString?.() ?? '');
}

type ParsedTx = Awaited<ReturnType<Connection['getParsedTransaction']>>;
const SINGLE_CONCURRENCY = 4;

/**
 * One batched read where the RPC allows it. Free and public endpoints often
 * refuse batches outright; for those, read the transactions a few at a time.
 * A rate limit (429) is not a refusal and is left to the caller to retry.
 */
async function fetchTransactions(conn: Connection, signatures: string[]): Promise<ParsedTx[]> {
  const opts = { maxSupportedTransactionVersion: 0, commitment: 'finalized' as const };
  try {
    return await conn.getParsedTransactions(signatures, opts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/batch|not supported|not allowed|403|413|paid plan|specific RPC call/i.test(msg)) throw err;
  }
  const out: ParsedTx[] = new Array(signatures.length).fill(null);
  for (let i = 0; i < signatures.length; i += SINGLE_CONCURRENCY) {
    const chunk = signatures.slice(i, i + SINGLE_CONCURRENCY);
    const got = await Promise.all(chunk.map((sig) => conn.getParsedTransaction(sig, opts)));
    got.forEach((tx, j) => (out[i + j] = tx));
  }
  return out;
}

export async function runWalletActivity(conn: Connection, spec: WalletHistorySpec): Promise<WalletActivityResult> {
  const sigs = await fetchWindowSignatures(conn, spec);
  const { kept } = windowSignatures(sigs, spec);
  const ok = kept.filter((s) => s.err === null || s.err === undefined).map((s) => s.signature);
  const views = new Map<string, TxView>();

  for (let i = 0; i < ok.length; i += TX_BATCH) {
    const slice = ok.slice(i, i + TX_BATCH);
    const txs = await fetchTransactions(conn, slice);
    txs.forEach((tx, j) => {
      if (!tx) return; // summarizeActivity refuses to answer without it
      const instructions = [
        ...tx.transaction.message.instructions,
        ...(tx.meta?.innerInstructions?.flatMap((ii) => ii.instructions) ?? []),
      ].map((ix) => ({
        programId: (ix as { programId: PublicKey }).programId.toString(),
        parsed: (ix as { parsed?: unknown }).parsed as TxView['instructions'][number]['parsed'],
      }));
      views.set(slice[j], {
        accountKeys: tx.transaction.message.accountKeys.map(keyString),
        preBalances: tx.meta?.preBalances ?? [],
        postBalances: tx.meta?.postBalances ?? [],
        instructions: instructions.filter((ix) => ix.parsed && typeof ix.parsed === 'object'),
      });
    });
  }
  return summarizeActivity(sigs, views, spec);
}

const ACTIVITY_KEYS: Array<keyof WalletActivityResult> = [
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
  'successCount',
  'successActiveDays',
  'firstSuccessTime',
  'lastSuccessTime',
  'volumeLamports',
  'uniqueCounterparties',
  'launchedMints',
];

function isPubkey(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

/** Validate an untrusted answer and rebuild it with exactly the known keys. */
export function canonicalActivity(input: unknown, spec: WalletHistorySpec): WalletActivityResult | null {
  if (input === null || typeof input !== 'object') return null;
  const r = input as Record<string, unknown>;
  const count = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;
  const time = (v: unknown) => v === null || Number.isInteger(v);
  if (r.v !== 1) return null;
  if (r.wallet !== spec.wallet || r.fromTime !== spec.fromTime || r.toTime !== spec.toTime) return null;
  for (const k of ['txCount', 'failedCount', 'activeDays', 'successCount', 'successActiveDays', 'uniqueCounterparties']) {
    if (!count(r[k])) return null;
  }
  if ((r.txCount as number) > spec.maxSignatures) return null;
  if ((r.successCount as number) + (r.failedCount as number) !== (r.txCount as number)) return null;
  for (const k of ['firstBlockTime', 'lastBlockTime', 'firstSuccessTime', 'lastSuccessTime']) if (!time(r[k])) return null;
  if (typeof r.truncated !== 'boolean') return null;
  if (typeof r.signaturesDigest !== 'string' || !/^[0-9a-f]{64}$/.test(r.signaturesDigest)) return null;
  if (typeof r.volumeLamports !== 'string' || !/^(0|[1-9]\d{0,29})$/.test(r.volumeLamports)) return null;
  const mints = r.launchedMints;
  if (!Array.isArray(mints) || mints.length > MAX_MINTS || !mints.every(isPubkey)) return null;
  if (mints.some((m, i) => i > 0 && mints[i - 1] >= m)) return null; // sorted, no repeats
  const out: Record<string, unknown> = {};
  for (const k of ACTIVITY_KEYS) out[k] = r[k];
  return out as unknown as WalletActivityResult;
}

export function hashActivity(result: WalletActivityResult): string {
  return createHash('sha256').update(JSON.stringify(ACTIVITY_KEYS.map((k) => [k, result[k]]))).digest('hex');
}

/**
 * Write an accepted answer where the API's own scanner writes its scans, so
 * the scanner (which refreshes the stalest rows first) leaves this wallet
 * alone until the answer ages. Called only when the operator opted in.
 */
export async function applyActivityResult(prisma: PrismaClient, result: WalletActivityResult, windowDays: number): Promise<void> {
  const date = (t: number | null) => (t === null ? null : new Date(t * 1000));
  const data = {
    windowDays,
    txCount: result.successCount,
    volumeSolLamports: BigInt(result.volumeLamports),
    uniqueCounterparties: result.uniqueCounterparties,
    activeDays: result.successActiveDays,
    oldestSeen: date(result.firstSuccessTime),
    latestSeen: date(result.lastSuccessTime),
    computedAt: new Date(),
    source: 'work-panel',
  };
  await prisma.agentActivityStats.upsert({ where: { wallet: result.wallet }, update: data, create: { wallet: result.wallet, ...data } });
  for (const mint of result.launchedMints) {
    await prisma.launchedToken.upsert({ where: { mint }, update: {}, create: { mint, agentWallet: result.wallet } });
  }
}

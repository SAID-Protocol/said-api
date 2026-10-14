/**
 * Work loop — automatic reward periods and payouts.
 *
 * Once a day, for each UTC day that has ended and settled:
 *   1. record a reward period for that day. Its earnings are the SOL the
 *      payout wallet received that day from the creator wallet
 *      (WORK_EARNINGS_SOURCE): the share of $SAID creator rewards sent to
 *      the work loop. Transfers from anywhere else are not counted.
 *   2. pay the workers' shares in SOL from the payout wallet, oldest first.
 *
 * The server holds the payout wallet's key for this, so the wallet is meant
 * to hold a small float, topped up by hand. Safety rails:
 *   - nothing runs unless WORK_AUTO_PAY=true and a key is set
 *   - a period whose worker pool is over WORK_AUTO_MAX_LAMPORTS is recorded
 *     but never sent automatically; it waits for a person
 *   - shares are sent only while the wallet can cover them plus fees; the rest
 *     stay pending and go out after a top-up
 *   - each payout is sent at most once: pending → sending (signature stored
 *     before broadcast) → paid, and anything left in 'sending' is settled from
 *     the chain, never re-sent
 * Buying and locking $SAID is not automatic; the period shows it as owed.
 */

import type { PrismaClient } from '@prisma/client';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SendTransactionError, SystemProgram, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { isPubkey } from './auth.js';
import type { WorkConfig } from './engine.js';
import { createEpoch } from './payouts.js';

const DAY_MS = 86400 * 1000;
const BATCH = 10;
const FEE_BUFFER_LAMPORTS = 10_000n;
const SENDING_GIVE_UP_MS = 5 * 60 * 1000;
// The first day automatic periods may cover. Earlier work was paid by hand.
const AUTO_START_DEFAULT = '2026-10-14';

export interface AutoPayConfig {
  enabled: boolean;
  payer: Keypair | null;
  source: PublicKey | null;
  maxPoolLamports: bigint;
  marginMs: number;
  startDay: string;
}

export function loadAutoPayConfig(env: NodeJS.ProcessEnv): AutoPayConfig {
  let payer: Keypair | null = null;
  const raw = env.WORK_PAYOUT_SECRET?.trim();
  if (raw) {
    try {
      payer = Keypair.fromSecretKey(raw.startsWith('[') ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw));
    } catch {
      console.error('[work] WORK_PAYOUT_SECRET is not a valid Solana secret key; automatic payouts are off');
    }
  }
  let source: PublicKey | null = null;
  if (env.WORK_EARNINGS_SOURCE) {
    try {
      source = new PublicKey(env.WORK_EARNINGS_SOURCE.trim());
    } catch {
      console.error('[work] WORK_EARNINGS_SOURCE is not a valid address; automatic payouts are off');
    }
  }
  const max = Number(env.WORK_AUTO_MAX_LAMPORTS);
  const margin = Number(env.WORK_EPOCH_MARGIN_HOURS);
  const start =
    env.WORK_AUTO_START_DAY && /^\d{4}-\d{2}-\d{2}$/.test(env.WORK_AUTO_START_DAY) ? env.WORK_AUTO_START_DAY : AUTO_START_DEFAULT;
  return {
    enabled: env.WORK_AUTO_PAY === 'true' && payer !== null && source !== null,
    payer,
    source,
    maxPoolLamports: BigInt(Number.isInteger(max) && max > 0 ? max : 500_000_000),
    marginMs: (Number.isFinite(margin) && margin >= 0 && margin <= 72 ? margin : 6) * 3600 * 1000,
    startDay: start,
  };
}

const dayStart = (day: string) => new Date(`${day}T00:00:00.000Z`);
const dayOf = (d: Date) => d.toISOString().slice(0, 10);

/**
 * SOL the payout wallet received from the earnings source in [start, end):
 * the sum of the payout wallet's balance gains in transactions signed by the
 * source. Read from the chain, so it is exactly what arrived.
 */
export async function receivedFrom(conn: Connection, payout: PublicKey, source: PublicKey, start: Date, end: Date): Promise<bigint> {
  const from = Math.floor(start.getTime() / 1000);
  const to = Math.floor(end.getTime() / 1000);
  let before: string | undefined;
  let total = 0n;
  for (let page = 0; page < 20; page++) {
    const sigs = await conn.getSignaturesForAddress(payout, { limit: 1000, before }, 'finalized');
    if (sigs.length === 0) break;
    for (const s of sigs) {
      if (s.err || typeof s.blockTime !== 'number' || s.blockTime >= to || s.blockTime < from) continue;
      const tx = await conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: 'finalized' });
      if (!tx?.meta) continue;
      const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
      const signedBySource = tx.transaction.message.accountKeys.some((k) => k.signer && k.pubkey.equals(source));
      const i = keys.indexOf(payout.toBase58());
      if (!signedBySource || i < 0) continue;
      const gain = BigInt(tx.meta.postBalances[i]) - BigInt(tx.meta.preBalances[i]);
      if (gain > 0n) total += gain;
    }
    const oldest = sigs[sigs.length - 1];
    if (sigs.length < 1000 || (typeof oldest.blockTime === 'number' && oldest.blockTime < from)) break;
    before = oldest.signature;
  }
  return total;
}

/** Record a period for every settled day not yet covered, from the start day on. */
export async function recordDuePeriods(
  prisma: PrismaClient,
  conn: Connection,
  cfg: WorkConfig,
  auto: AutoPayConfig,
  now: Date = new Date(),
): Promise<string[]> {
  if (!auto.payer || !auto.source) return [];
  const recorded: string[] = [];
  // Start after the last recorded period, so manual and automatic ones never overlap.
  const last = await prisma.workEpoch.findFirst({ orderBy: { endsAt: 'desc' }, select: { endsAt: true } });
  let day = dayStart(auto.startDay);
  if (last && last.endsAt > day) day = new Date(Math.ceil(last.endsAt.getTime() / DAY_MS) * DAY_MS);
  for (let i = 0; i < 14; i++) {
    const end = new Date(day.getTime() + DAY_MS);
    if (end.getTime() > now.getTime() - auto.marginMs) break;
    const received = await receivedFrom(conn, auto.payer.publicKey, auto.source, day, end);
    const label = `auto-${dayOf(day)}`;
    await createEpoch(
      prisma,
      cfg,
      {
        label,
        startsAt: day.toISOString(),
        endsAt: end.toISOString(),
        rewardsLamports: received.toString(),
      },
      now,
    );
    console.log(`[work] recorded ${label}: ${Number(received) / LAMPORTS_PER_SOL} SOL received from the creator wallet`);
    recorded.push(label);
    day = end;
  }
  return recorded;
}

/** Settle payouts a previous run left in 'sending', from the chain. */
async function resolveSending(prisma: PrismaClient, conn: Connection): Promise<void> {
  const stuck = await prisma.workPayout.findMany({ where: { status: 'sending' } });
  for (const sig of new Set(stuck.map((p) => p.txSignature))) {
    const rows = stuck.filter((p) => p.txSignature === sig);
    const ids = rows.map((p) => p.id);
    if (!sig) {
      await prisma.workPayout.updateMany({ where: { id: { in: ids } }, data: { status: 'pending', paidAt: null } });
      continue;
    }
    const status = (await conn.getSignatureStatus(sig, { searchTransactionHistory: true })).value;
    const landed = status && !status.err && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized');
    if (landed) {
      await prisma.workPayout.updateMany({ where: { id: { in: ids } }, data: { status: 'paid', paidAt: new Date() } });
    } else if (status?.err || (!status && Date.now() - (rows[0].paidAt?.getTime() ?? 0) > SENDING_GIVE_UP_MS)) {
      await prisma.workPayout.updateMany({ where: { id: { in: ids } }, data: { status: 'pending', txSignature: null, paidAt: null } });
    }
  }
}

/** Pay pending shares of automatic periods while the wallet can cover them. */
export async function payDue(prisma: PrismaClient, conn: Connection, auto: AutoPayConfig): Promise<number> {
  if (!auto.payer) return 0;
  await resolveSending(prisma, conn);
  if ((await prisma.workPayout.count({ where: { status: 'sending' } })) > 0) return 0; // still settling

  const epochs = await prisma.workEpoch.findMany({
    where: { label: { startsWith: 'auto-' }, payouts: { some: { status: 'pending' } } },
    orderBy: { endsAt: 'asc' },
    include: { payouts: { where: { status: 'pending' } } },
  });
  let balance = BigInt(await conn.getBalance(auto.payer.publicKey, 'confirmed'));
  let paid = 0;
  for (const epoch of epochs) {
    if (epoch.workerPoolLamports > auto.maxPoolLamports) {
      console.error(
        `[work] ${epoch.label}: worker pool ${Number(epoch.workerPoolLamports) / LAMPORTS_PER_SOL} SOL is over the automatic limit; waiting for a person`,
      );
      continue;
    }
    const rows = epoch.payouts.filter((p) => p.lamports > 0n && isPubkey(p.workerWallet));
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      const total = batch.reduce((a, p) => a + p.lamports, 0n);
      if (balance < total + FEE_BUFFER_LAMPORTS) {
        console.error(
          `[work] payout wallet ${auto.payer.publicKey.toBase58()} holds ${Number(balance) / LAMPORTS_PER_SOL} SOL, too little for ${epoch.label}; top it up`,
        );
        return paid;
      }
      const tx = new Transaction();
      for (const p of batch) {
        tx.add(SystemProgram.transfer({ fromPubkey: auto.payer.publicKey, toPubkey: new PublicKey(p.workerWallet), lamports: p.lamports }));
      }
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = auto.payer.publicKey;
      tx.sign(auto.payer);
      const signature = bs58.encode(tx.signature!);
      const ids = batch.map((p) => p.id);

      const claimed = await prisma.workPayout.updateMany({
        where: { id: { in: ids }, status: 'pending' },
        data: { status: 'sending', txSignature: signature, paidAt: new Date() },
      });
      if (claimed.count !== ids.length) return paid; // something else touched these rows

      try {
        await conn.sendRawTransaction(tx.serialize());
      } catch (err) {
        if (err instanceof SendTransactionError) {
          await prisma.workPayout.updateMany({ where: { id: { in: ids } }, data: { status: 'pending', txSignature: null, paidAt: null } });
        }
        throw err; // anything else stays 'sending' and is settled from the chain next time
      }
      const result = await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
      if (result.value.err) {
        await prisma.workPayout.updateMany({ where: { id: { in: ids } }, data: { status: 'pending', txSignature: null, paidAt: null } });
        throw new Error(`payout ${signature} failed on chain: ${JSON.stringify(result.value.err)}`);
      }
      await prisma.workPayout.updateMany({ where: { id: { in: ids } }, data: { status: 'paid', paidAt: new Date() } });
      balance -= total + 5_000n;
      paid += batch.length;
      console.log(`[work] ${epoch.label}: paid ${batch.length} workers in ${signature}`);
    }
  }
  return paid;
}

/** One pass: record due periods, then pay what the wallet can cover. Never throws. */
export async function autoPayTick(prisma: PrismaClient, conn: Connection, cfg: WorkConfig, auto: AutoPayConfig): Promise<void> {
  if (!auto.enabled) return;
  try {
    await recordDuePeriods(prisma, conn, cfg, auto);
    await payDue(prisma, conn, auto);
  } catch (err) {
    console.error('[work] automatic payout pass failed:', err instanceof Error ? err.message : err);
  }
}

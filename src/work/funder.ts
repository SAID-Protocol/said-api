/**
 * Work loop — who paid for a wallet's first transaction.
 *
 * A new wallet cannot act until someone sends it SOL, so the fee payer of its
 * oldest transaction is the wallet that created it in practice. Slots whose
 * agent wallets share that funder are treated as one operator.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import type { PrismaClient } from '@prisma/client';

const SIG_PAGE = 1000;
// Wallets with more history than this are left unknown rather than walked.
const MAX_PAGES = 5;
const RETRY_AFTER_MS = 6 * 60 * 60 * 1000;

/** The funder, or null when it cannot be read (too much history, RPC trouble, self-funded). */
export async function findFunder(conn: Connection, wallet: string): Promise<string | null> {
  const pk = new PublicKey(wallet);
  let before: string | undefined;
  let oldest: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await conn.getSignaturesForAddress(pk, { limit: SIG_PAGE, before }, 'finalized');
    if (batch.length === 0) break;
    oldest = batch[batch.length - 1].signature;
    if (batch.length < SIG_PAGE) {
      before = undefined;
      break;
    }
    before = oldest;
    if (page === MAX_PAGES - 1) return null; // history runs deeper than we walk
  }
  if (!oldest) return null;
  const tx = await conn.getParsedTransaction(oldest, { maxSupportedTransactionVersion: 0, commitment: 'finalized' });
  const payer = tx?.transaction.message.accountKeys[0]?.pubkey.toString();
  return payer && payer !== wallet ? payer : null;
}

/** Look a slot's funder up once, and again later if it could not be read. Never throws. */
export async function refreshFunder(prisma: PrismaClient, conn: Connection, wallet: string, now: Date = new Date()): Promise<void> {
  try {
    const slot = await prisma.workSlot.findUnique({ where: { wallet }, select: { funder: true, funderCheckedAt: true } });
    if (!slot || slot.funder) return;
    if (slot.funderCheckedAt && now.getTime() - slot.funderCheckedAt.getTime() < RETRY_AFTER_MS) return;
    await prisma.workSlot.update({ where: { wallet }, data: { funderCheckedAt: now } });
    const funder = await findFunder(conn, wallet);
    if (funder) await prisma.workSlot.update({ where: { wallet }, data: { funder } });
  } catch (err) {
    console.error(`[work] funder lookup failed for ${wallet}:`, err instanceof Error ? err.message : err);
  }
}

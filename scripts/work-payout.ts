/**
 * Send a reward period's worker payouts in SOL.
 *
 *   DATABASE_URL=... SOLANA_RPC_URL=... npx tsx scripts/work-payout.ts --epoch 2026-W41
 *       Dry run: lists what would be sent. Sends nothing.
 *
 *   ... WORK_PAYOUT_SECRET=<payer secret key> npx tsx scripts/work-payout.ts --epoch 2026-W41 --send
 *       Sends. Transfers cannot be undone.
 *
 * The period and each share are created first, through
 * POST /api/work/admin/epochs. This script only moves money for rows that
 * already exist, and each row is paid at most once:
 *   pending → sending (signature recorded before we wait) → paid
 * A run that dies mid-way leaves rows in `sending`; the next run looks each
 * signature up on chain and either marks it paid or, once the transaction
 * can no longer land, returns it to pending.
 *
 * WORK_PAYOUT_SECRET is a base58 secret key or a JSON byte array.
 */
import { PrismaClient } from '@prisma/client';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { isPubkey } from '../src/work/auth.js';

const BATCH = 10; // transfers per transaction
const FEE_BUFFER_LAMPORTS = 10_000n; // per transaction, generous
// A transaction's blockhash expires after ~90s; past this it can never land.
const SENDING_GIVE_UP_MS = 5 * 60 * 1000;

const prisma = new PrismaClient();
const sol = (lamports: bigint) => (Number(lamports) / LAMPORTS_PER_SOL).toFixed(6);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Settle rows a previous run left in `sending`. Returns how many are still unresolved. */
async function resolveSending(conn: Connection, epochId: string): Promise<number> {
  const stuck = await prisma.workPayout.findMany({ where: { epochId, status: 'sending' } });
  let unresolved = 0;
  for (const sig of new Set(stuck.map((p) => p.txSignature))) {
    const rows = stuck.filter((p) => p.txSignature === sig);
    const ids = rows.map((p) => p.id);
    if (!sig) {
      // Marked but never broadcast: nothing was sent.
      await prisma.workPayout.updateMany({ where: { id: { in: ids } }, data: { status: 'pending' } });
      continue;
    }
    const status = (await conn.getSignatureStatus(sig, { searchTransactionHistory: true })).value;
    if (status && !status.err && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) {
      await prisma.workPayout.updateMany({ where: { id: { in: ids } }, data: { status: 'paid', paidAt: new Date() } });
      console.log(`recovered: ${sig} landed, ${ids.length} payouts marked paid`);
    } else if (status?.err || (!status && Date.now() - rows[0].paidAt!.getTime() > SENDING_GIVE_UP_MS)) {
      await prisma.workPayout.updateMany({ where: { id: { in: ids } }, data: { status: 'pending', txSignature: null, paidAt: null } });
      console.log(`recovered: ${sig} did not land, ${ids.length} payouts returned to pending`);
    } else {
      unresolved += ids.length;
      console.log(`waiting:   ${sig} is not settled yet (${ids.length} payouts); run again in a few minutes`);
    }
  }
  return unresolved;
}

async function main() {
  const label = arg('epoch');
  const send = process.argv.includes('--send');
  if (!label) throw new Error('usage: work-payout.ts --epoch <label> [--send]');

  const epoch = await prisma.workEpoch.findUnique({ where: { label } });
  if (!epoch) throw new Error(`no reward period "${label}"; create it with POST /api/work/admin/epochs`);
  const conn = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');

  if (send && (await resolveSending(conn, epoch.id)) > 0) return;

  const pending = (await prisma.workPayout.findMany({ where: { epochId: epoch.id, status: 'pending' }, orderBy: { lamports: 'desc' } }))
    .filter((p) => p.lamports > 0n);
  const bad = pending.filter((p) => !isPubkey(p.workerWallet));
  const good = pending.filter((p) => isPubkey(p.workerWallet));
  const total = good.reduce((a, p) => a + p.lamports, 0n);

  console.log(`period ${epoch.label}: worker pool ${sol(epoch.workerPoolLamports)} SOL, ${good.length} payouts pending, ${sol(total)} SOL to send`);
  for (const p of good) console.log(`  ${p.workerWallet}  ${sol(p.lamports)} SOL  (${p.goodCount} accepted, ${p.wrongCount} wrong)`);
  for (const p of bad) console.log(`  SKIPPING ${p.workerWallet}: not a valid address`);
  if (good.length === 0) return console.log('nothing to send');
  if (!send) return console.log('\ndry run: nothing sent. Re-run with --send to pay.');

  const secret = process.env.WORK_PAYOUT_SECRET;
  if (!secret) throw new Error('WORK_PAYOUT_SECRET is not set');
  const payer = Keypair.fromSecretKey(secret.trim().startsWith('[') ? Uint8Array.from(JSON.parse(secret)) : bs58.decode(secret.trim()));
  const batches = Math.ceil(good.length / BATCH);
  const balance = BigInt(await conn.getBalance(payer.publicKey));
  const needed = total + FEE_BUFFER_LAMPORTS * BigInt(batches);
  if (balance < needed) throw new Error(`payer ${payer.publicKey.toBase58()} holds ${sol(balance)} SOL; ${sol(needed)} needed`);
  console.log(`\npaying from ${payer.publicKey.toBase58()} (${sol(balance)} SOL) in ${batches} transaction(s)`);

  for (let i = 0; i < good.length; i += BATCH) {
    const batch = good.slice(i, i + BATCH);
    const ids = batch.map((p) => p.id);
    const tx = new Transaction();
    for (const p of batch) {
      tx.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: new PublicKey(p.workerWallet), lamports: p.lamports }));
    }
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = payer.publicKey;
    tx.sign(payer);
    const signature = bs58.encode(tx.signature!);

    // Claim the rows and record the signature BEFORE broadcasting, so a
    // crash after this line can always be resolved from the chain.
    const claimed = await prisma.workPayout.updateMany({
      where: { id: { in: ids }, status: 'pending' },
      data: { status: 'sending', txSignature: signature, paidAt: new Date() },
    });
    if (claimed.count !== ids.length) throw new Error('payout rows changed underneath this run; stopping');

    try {
      await conn.sendRawTransaction(tx.serialize());
    } catch (err) {
      // Rejected before broadcast (failed simulation): nothing was sent.
      await prisma.workPayout.updateMany({ where: { id: { in: ids } }, data: { status: 'pending', txSignature: null, paidAt: null } });
      throw err;
    }
    const result = await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
    if (result.value.err) {
      await prisma.workPayout.updateMany({ where: { id: { in: ids } }, data: { status: 'pending', txSignature: null, paidAt: null } });
      throw new Error(`transaction ${signature} failed on chain: ${JSON.stringify(result.value.err)}`);
    }
    await prisma.workPayout.updateMany({ where: { id: { in: ids } }, data: { status: 'paid', paidAt: new Date() } });
    console.log(`paid ${batch.length} workers: ${signature}`);
  }
  console.log('done');
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

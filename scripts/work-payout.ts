/**
 * Send a reward period's worker payouts in SOL.
 *
 *   SAID_API_URL=... SAID_ADMIN_SECRET=... SOLANA_RPC_URL=... \
 *     npx tsx scripts/work-payout.ts --epoch 2026-W41
 *       Dry run: lists what would be sent. Sends nothing.
 *
 *   ... WORK_PAYOUT_KEY_FILE=<path> npx tsx scripts/work-payout.ts --epoch 2026-W41 --send
 *       Sends. Transfers cannot be undone.
 *
 * Talks to the SAID API, never to the database: the payout key stays on the
 * machine running this, and the database stays private. The period and each
 * share are created first, through POST /api/work/admin/epochs. Each payout is
 * paid at most once:
 *   pending → sending (signature recorded on the API before we broadcast) → paid
 * A run that dies mid-way leaves rows in `sending`; the next run looks each
 * signature up on chain and either marks it paid or, once the transaction can
 * no longer land, returns it to pending.
 *
 * The key file holds a base58 secret key or a JSON byte array.
 */
import { readFileSync } from 'fs';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SendTransactionError, SystemProgram, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { isPubkey } from '../src/work/auth.js';

const BATCH = 10; // transfers per transaction
const FEE_BUFFER_LAMPORTS = 10_000n; // per transaction, generous
// A transaction's blockhash expires after ~90s; past this it can never land.
const SENDING_GIVE_UP_MS = 5 * 60 * 1000;

const API = (process.env.SAID_API_URL || 'https://api.saidprotocol.com').replace(/\/+$/, '');
const SECRET = process.env.SAID_ADMIN_SECRET || process.env.ADMIN_SECRET || '';
const sol = (lamports: bigint) => (Number(lamports) / LAMPORTS_PER_SOL).toFixed(6);

interface Row {
  id: string;
  wallet: string;
  lamports: string;
  good: number;
  wrong: number;
  status: string;
  txSignature: string | null;
  sentAt: string | null;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function api(method: 'GET' | 'POST', path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${API}/api/work/admin${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-admin-secret': SECRET },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json.error ?? ''}`);
  return json;
}

/** Settle rows a previous run left in `sending`. Returns how many are still unresolved. */
async function resolveSending(conn: Connection, label: string, rows: Row[]): Promise<number> {
  const stuck = rows.filter((r) => r.status === 'sending');
  let unresolved = 0;
  for (const sig of new Set(stuck.map((r) => r.txSignature).filter((s): s is string => Boolean(s)))) {
    const batch = stuck.filter((r) => r.txSignature === sig);
    const status = (await conn.getSignatureStatus(sig, { searchTransactionHistory: true })).value;
    const landed = status && !status.err && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized');
    const sentAt = batch[0].sentAt ? Date.parse(batch[0].sentAt) : 0;
    if (landed) {
      await api('POST', `/epochs/${encodeURIComponent(label)}/settle`, { signature: sig, outcome: 'paid' });
      console.log(`recovered: ${sig} landed, ${batch.length} payouts marked paid`);
    } else if (status?.err || (!status && Date.now() - sentAt > SENDING_GIVE_UP_MS)) {
      await api('POST', `/epochs/${encodeURIComponent(label)}/settle`, { signature: sig, outcome: 'not_sent' });
      console.log(`recovered: ${sig} did not land, ${batch.length} payouts returned to pending`);
    } else {
      unresolved += batch.length;
      console.log(`waiting:   ${sig} is not settled yet (${batch.length} payouts); run again in a few minutes`);
    }
  }
  return unresolved;
}

async function main() {
  const label = arg('epoch');
  const send = process.argv.includes('--send');
  if (!label) throw new Error('usage: work-payout.ts --epoch <label> [--send]');
  if (!SECRET) throw new Error('SAID_ADMIN_SECRET is not set');
  const conn = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');
  const path = `/epochs/${encodeURIComponent(label)}/payouts`;

  if (send && (await resolveSending(conn, label, (await api('GET', path)).payouts)) > 0) return;

  const data = await api('GET', path);
  const pending = (data.payouts as Row[]).filter((p) => p.status === 'pending' && BigInt(p.lamports) > 0n);
  const bad = pending.filter((p) => !isPubkey(p.wallet));
  const good = pending.filter((p) => isPubkey(p.wallet));
  const total = good.reduce((a, p) => a + BigInt(p.lamports), 0n);

  console.log(`period ${label}: worker pool ${sol(BigInt(data.workerPoolLamports))} SOL, ${good.length} payouts pending, ${sol(total)} SOL to send`);
  for (const p of good) console.log(`  ${p.wallet}  ${sol(BigInt(p.lamports))} SOL  (${p.good} accepted, ${p.wrong} wrong)`);
  for (const p of bad) console.log(`  SKIPPING ${p.wallet}: not a valid address`);
  if (good.length === 0) return console.log('nothing to send');
  if (!send) return console.log('\ndry run: nothing sent. Re-run with --send to pay.');

  const keyFile = process.env.WORK_PAYOUT_KEY_FILE;
  const raw = keyFile ? readFileSync(keyFile, 'utf8').trim() : process.env.WORK_PAYOUT_SECRET?.trim();
  if (!raw) throw new Error('set WORK_PAYOUT_KEY_FILE to the payout key file');
  const payer = Keypair.fromSecretKey(raw.startsWith('[') ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw));
  const batches = Math.ceil(good.length / BATCH);
  const balance = BigInt(await conn.getBalance(payer.publicKey));
  const needed = total + FEE_BUFFER_LAMPORTS * BigInt(batches);
  if (balance < needed) throw new Error(`payer ${payer.publicKey.toBase58()} holds ${sol(balance)} SOL; ${sol(needed)} needed`);
  console.log(`\npaying from ${payer.publicKey.toBase58()} (${sol(balance)} SOL) in ${batches} transaction(s)`);

  for (let i = 0; i < good.length; i += BATCH) {
    const batch = good.slice(i, i + BATCH);
    const tx = new Transaction();
    for (const p of batch) {
      tx.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: new PublicKey(p.wallet), lamports: BigInt(p.lamports) }));
    }
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = payer.publicKey;
    tx.sign(payer);
    const signature = bs58.encode(tx.signature!);

    // Record the signature on the API BEFORE broadcasting, so a crash after
    // this line can always be settled from the chain.
    await api('POST', `/epochs/${encodeURIComponent(label)}/sending`, { ids: batch.map((p) => p.id), signature });

    try {
      await conn.sendRawTransaction(tx.serialize());
    } catch (err) {
      // Only a simulation rejection proves nothing was sent. Anything else can
      // come after the RPC forwarded it, so the rows stay 'sending'.
      if (err instanceof SendTransactionError) {
        await api('POST', `/epochs/${encodeURIComponent(label)}/settle`, { signature, outcome: 'not_sent' });
      } else {
        console.error(`sending ${signature} may or may not have reached the network; run again in a few minutes to settle it from the chain`);
      }
      throw err;
    }
    const result = await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
    if (result.value.err) {
      await api('POST', `/epochs/${encodeURIComponent(label)}/settle`, { signature, outcome: 'not_sent' });
      throw new Error(`transaction ${signature} failed on chain: ${JSON.stringify(result.value.err)}`);
    }
    await api('POST', `/epochs/${encodeURIComponent(label)}/settle`, { signature, outcome: 'paid' });
    console.log(`paid ${batch.length} workers: ${signature}`);
  }
  console.log('done');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

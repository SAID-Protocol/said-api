/**
 * Recycle verification fees into the sponsor wallet.
 *
 * Every sponsored registration sends 0.01 SOL to the program treasury and
 * 0.0024 SOL of rent into the agent's identity account. The treasury's SOL
 * is withdrawable by its hard-coded authority; the rent is not. Run this to
 * pull the treasury down to its rent floor and forward the SOL to the sponsor,
 * so the sponsor only ever needs topping up for the rent.
 *
 * Run it from YOUR machine. The authority key is also the program's upgrade
 * authority; it must never live on a shared server.
 *
 *   TREASURY_AUTHORITY_SECRET=<base58 or JSON array> npx tsx scripts/withdraw-fees-to-sponsor.ts          # dry run
 *   TREASURY_AUTHORITY_SECRET=... npx tsx scripts/withdraw-fees-to-sponsor.ts --send
 *   optional: SOLANA_RPC_URL, SPONSOR_WALLET, KEEP_SOL (left in the authority for fees, default 0.01)
 */
import { createHash } from 'node:crypto';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, LAMPORTS_PER_SOL, sendAndConfirmTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

const PROGRAM_ID = new PublicKey('5dpw6KEQPn248pnkkaYyWfHwu2nfb3LUMbTucb6LaA8G');
const SPONSOR = new PublicKey(process.env.SPONSOR_WALLET ?? 'HUpEuDs3FC4T3xMZ3n8EGe16QLJFSnjbd1Kzh6C22YyP');
const RPC = process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com';
const SEND = process.argv.includes('--send');
const KEEP = Number(process.env.KEEP_SOL ?? 0.01);
const TREASURY_ACCOUNT_SPACE = 8 + 32 + 8 + 1; // discriminator + authority + total_collected + bump

function loadKey(): Keypair {
  const raw = (process.env.TREASURY_AUTHORITY_SECRET ?? '').trim();
  if (!raw) throw new Error('TREASURY_AUTHORITY_SECRET is not set');
  const bytes = raw.startsWith('[') ? Uint8Array.from(JSON.parse(raw) as number[]) : bs58.decode(raw);
  return Keypair.fromSecretKey(bytes);
}

async function main() {
  const conn = new Connection(RPC, 'confirmed');
  const authority = loadKey();
  const [treasury] = PublicKey.findProgramAddressSync([Buffer.from('treasury')], PROGRAM_ID);
  const info = await conn.getAccountInfo(treasury);
  if (!info) throw new Error('treasury account not found');
  const onChainAuthority = new PublicKey(info.data.subarray(8, 40));
  if (!onChainAuthority.equals(authority.publicKey)) throw new Error(`this key is ${authority.publicKey.toBase58()}, the treasury authority is ${onChainAuthority.toBase58()}`);
  const floor = await conn.getMinimumBalanceForRentExemption(TREASURY_ACCOUNT_SPACE);
  const withdrawable = Math.max(0, info.lamports - floor - 1_000); // a hair above the floor so the program's check passes
  const authBal = await conn.getBalance(authority.publicKey);
  const sponsorBal = await conn.getBalance(SPONSOR);
  console.log(`treasury ${treasury.toBase58()}: ${(info.lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL, floor ${(floor / LAMPORTS_PER_SOL).toFixed(4)}, withdrawable ${(withdrawable / LAMPORTS_PER_SOL).toFixed(4)}`);
  console.log(`authority ${authority.publicKey.toBase58()}: ${(authBal / LAMPORTS_PER_SOL).toFixed(4)} SOL | sponsor ${SPONSOR.toBase58().slice(0, 8)}…: ${(sponsorBal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  if (withdrawable < 0.01 * LAMPORTS_PER_SOL) { console.log('less than 0.01 SOL to withdraw; nothing to do'); return; }

  // withdraw_fees(amount): Anchor discriminator + u64 LE
  const disc = createHash('sha256').update('global:withdraw_fees').digest().subarray(0, 8);
  const data = Buffer.alloc(16); disc.copy(data, 0); data.writeBigUInt64LE(BigInt(withdrawable), 8);
  const withdrawIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
  // forward everything above KEEP to the sponsor, in the same transaction
  const forward = Math.max(0, authBal + withdrawable - Math.round(KEEP * LAMPORTS_PER_SOL) - 10_000);
  const forwardIx = SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: SPONSOR, lamports: forward });
  console.log(`plan: withdraw ${(withdrawable / LAMPORTS_PER_SOL).toFixed(4)} SOL from the treasury, forward ${(forward / LAMPORTS_PER_SOL).toFixed(4)} SOL to the sponsor, keep ~${KEEP} SOL in the authority`);
  if (!SEND) { console.log('dry run; add --send to execute'); return; }
  const tx = new Transaction().add(withdrawIx, forwardIx);
  const sig = await sendAndConfirmTransaction(conn, tx, [authority], { commitment: 'confirmed' });
  console.log('sent:', sig);
  console.log(`sponsor now ${((await conn.getBalance(SPONSOR)) / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
}
main().catch((e) => { console.error('failed:', e.message); process.exit(1); });

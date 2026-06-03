/**
 * Walk each verified SAID agent's transaction history, filter for
 * transactions that invoke SAID_PROGRAM_ID, classify by Anchor
 * instruction discriminator, and persist per-wallet aggregate counts
 * to AgentSaidEngagement.
 *
 * Source-of-truth for instruction names: SAID-Protocol/said
 * programs/said/src/lib.rs. There are 21 instructions; this script
 * tracks the 20 relevant ones (initialize_treasury is admin-only).
 *
 * What this fuels:
 *   The v0.7.1 said_engagement sub-signal in reputation-engine-v7.ts.
 *   Lets us distinguish an agent that actually USES SAID (anchors
 *   receipts, validates work, submits feedback, stakes) from one
 *   that only registered and filled out a profile.
 *
 * Usage:
 *   DATABASE_URL=...  ALCHEMY_SOLANA_RPC_URL=... \
 *     npx tsx scripts/sync-said-engagement.ts
 *
 * Optional env:
 *   LIMIT=200                    # cap on agents processed
 *   CONCURRENCY=2                # parallel wallet workers (default lowered to 2
 *                                # to be polite to Alchemy's 2300 CUPS plan)
 *   MAX_SIGS_PER_WALLET=1000     # scan budget per wallet (oldest-newest)
 *   PARSED_TX_CHUNK=100          # how many tx sigs to parse per batch — keep
 *                                # ≤100 to avoid 413 Payload Too Large from
 *                                # Alchemy on high-volume wallets
 */
import { PrismaClient } from '@prisma/client';
import { Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { createHash } from 'crypto';

const prisma = new PrismaClient();

const SAID_PROGRAM_ID = new PublicKey('5dpw6KEQPn248pnkkaYyWfHwu2nfb3LUMbTucb6LaA8G');
const SAID_PROGRAM_ID_STR = SAID_PROGRAM_ID.toBase58();
const SOLANA_RPC_URL =
  process.env.ALCHEMY_SOLANA_RPC_URL ||
  process.env.SOLANA_RPC_URL ||
  'https://api.mainnet-beta.solana.com';
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : null;
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 2);
const MAX_SIGS_PER_WALLET = Number(process.env.MAX_SIGS_PER_WALLET ?? 1000);
const SIG_PAGE = 1000;
const PARSED_TX_CHUNK = Number(process.env.PARSED_TX_CHUNK ?? 100);

// Compute Anchor discriminators: first 8 bytes of
// sha256("global:<instruction_name>"). All names below are copied
// verbatim from programs/said/src/lib.rs in SAID-Protocol/said.
function discriminatorFor(instructionName: string): string {
  const hash = createHash('sha256').update(`global:${instructionName}`).digest();
  return hash.subarray(0, 8).toString('hex');
}

// All 20 user-callable instructions (initialize_treasury excluded — admin-only).
const KNOWN_INSTRUCTIONS = {
  // Identity lifecycle
  register_agent: discriminatorFor('register_agent'),
  get_verified: discriminatorFor('get_verified'),
  register_and_stake: discriminatorFor('register_and_stake'),
  sponsor_register: discriminatorFor('sponsor_register'),
  sponsor_verify: discriminatorFor('sponsor_verify'),
  update_agent: discriminatorFor('update_agent'),
  // Active protocol participation
  submit_anchor: discriminatorFor('submit_anchor'),
  validate_work: discriminatorFor('validate_work'),
  submit_feedback: discriminatorFor('submit_feedback'),
  // Economic commitment
  stake: discriminatorFor('stake'),
  add_stake: discriminatorFor('add_stake'),
  request_unstake: discriminatorFor('request_unstake'),
  complete_unstake: discriminatorFor('complete_unstake'),
  cancel_unstake: discriminatorFor('cancel_unstake'),
  emergency_unstake: discriminatorFor('emergency_unstake'),
  // Wallet linking
  link_wallet: discriminatorFor('link_wallet'),
  unlink_wallet: discriminatorFor('unlink_wallet'),
  transfer_authority: discriminatorFor('transfer_authority'),
  // Admin / negative
  withdraw_fees: discriminatorFor('withdraw_fees'),
  slash_agent: discriminatorFor('slash_agent'),
} as const;

// Reverse lookup: discriminator hex → instruction name
const DISCRIMINATOR_TO_NAME = new Map<string, keyof typeof KNOWN_INSTRUCTIONS>();
for (const [name, disc] of Object.entries(KNOWN_INSTRUCTIONS)) {
  DISCRIMINATOR_TO_NAME.set(disc, name as keyof typeof KNOWN_INSTRUCTIONS);
}

interface InstructionCounts {
  registerCount: number;
  getVerifiedCount: number;
  registerAndStakeCount: number;
  sponsorRegisterCount: number;
  sponsorVerifyCount: number;
  updateAgentCount: number;
  submitAnchorCount: number;
  validateWorkCount: number;
  submitFeedbackCount: number;
  stakeCount: number;
  addStakeCount: number;
  unstakeLifecycleCount: number;
  linkWalletCount: number;
  unlinkWalletCount: number;
  transferAuthorityCount: number;
  slashAgentCount: number;
  otherSaidCount: number;
  totalSaidInstructions: number;
  firstAt: Date | null;
  lastAt: Date | null;
  lastSigScanned: string | null;
}

function emptyCounts(): InstructionCounts {
  return {
    registerCount: 0,
    getVerifiedCount: 0,
    registerAndStakeCount: 0,
    sponsorRegisterCount: 0,
    sponsorVerifyCount: 0,
    updateAgentCount: 0,
    submitAnchorCount: 0,
    validateWorkCount: 0,
    submitFeedbackCount: 0,
    stakeCount: 0,
    addStakeCount: 0,
    unstakeLifecycleCount: 0,
    linkWalletCount: 0,
    unlinkWalletCount: 0,
    transferAuthorityCount: 0,
    slashAgentCount: 0,
    otherSaidCount: 0,
    totalSaidInstructions: 0,
    firstAt: null,
    lastAt: null,
    lastSigScanned: null,
  };
}

function discriminatorOf(data: string | undefined | null): string | null {
  if (!data) return null;
  try {
    const bytes = bs58.decode(data);
    if (bytes.length < 8) return null;
    return Buffer.from(bytes.subarray(0, 8)).toString('hex');
  } catch {
    return null;
  }
}

function classifyAndIncrement(counts: InstructionCounts, discHex: string | null): void {
  counts.totalSaidInstructions++;
  if (!discHex) {
    counts.otherSaidCount++;
    return;
  }
  const name = DISCRIMINATOR_TO_NAME.get(discHex);
  switch (name) {
    case 'register_agent':
      counts.registerCount++;
      break;
    case 'get_verified':
      counts.getVerifiedCount++;
      break;
    case 'register_and_stake':
      counts.registerAndStakeCount++;
      break;
    case 'sponsor_register':
      counts.sponsorRegisterCount++;
      break;
    case 'sponsor_verify':
      counts.sponsorVerifyCount++;
      break;
    case 'update_agent':
      counts.updateAgentCount++;
      break;
    case 'submit_anchor':
      counts.submitAnchorCount++;
      break;
    case 'validate_work':
      counts.validateWorkCount++;
      break;
    case 'submit_feedback':
      counts.submitFeedbackCount++;
      break;
    case 'stake':
      counts.stakeCount++;
      break;
    case 'add_stake':
      counts.addStakeCount++;
      break;
    case 'request_unstake':
    case 'complete_unstake':
    case 'cancel_unstake':
    case 'emergency_unstake':
      counts.unstakeLifecycleCount++;
      break;
    case 'link_wallet':
      counts.linkWalletCount++;
      break;
    case 'unlink_wallet':
      counts.unlinkWalletCount++;
      break;
    case 'transfer_authority':
      counts.transferAuthorityCount++;
      break;
    case 'slash_agent':
      counts.slashAgentCount++;
      break;
    case 'withdraw_fees':
      // admin-only, not relevant to engagement signal
      counts.otherSaidCount++;
      break;
    default:
      counts.otherSaidCount++;
  }
}

async function scanWallet(conn: Connection, wallet: string): Promise<InstructionCounts> {
  const counts = emptyCounts();
  const pk = new PublicKey(wallet);

  let before: string | undefined = undefined;
  let scannedSigs = 0;
  let newestSig: string | null = null;

  while (scannedSigs < MAX_SIGS_PER_WALLET) {
    const sigs = await conn.getSignaturesForAddress(pk, {
      limit: Math.min(SIG_PAGE, MAX_SIGS_PER_WALLET - scannedSigs),
      before,
    });
    if (sigs.length === 0) break;
    if (newestSig === null) newestSig = sigs[0].signature;

    // Process signatures in smaller chunks for getParsedTransactions to
    // avoid 413 Payload Too Large on high-volume wallets like Xona.
    for (let off = 0; off < sigs.length; off += PARSED_TX_CHUNK) {
      const chunk = sigs.slice(off, off + PARSED_TX_CHUNK);
      const txs = await conn.getParsedTransactions(
        chunk.map((s) => s.signature),
        { maxSupportedTransactionVersion: 0 },
      );

      for (let i = 0; i < txs.length; i++) {
        const tx = txs[i];
        if (!tx) continue;
        const sig = chunk[i];
        const blockTime = sig.blockTime ? new Date(sig.blockTime * 1000) : null;

        const topIxs = tx.transaction.message.instructions;
        const innerIxs =
          tx.meta?.innerInstructions?.flatMap((ii) => ii.instructions) ?? [];

        for (const ix of [...topIxs, ...innerIxs]) {
          const pidStr = 'programId' in ix ? ix.programId.toBase58() : null;
          if (pidStr !== SAID_PROGRAM_ID_STR) continue;

          const rawData =
            'data' in ix && typeof ix.data === 'string' ? ix.data : null;
          const disc = discriminatorOf(rawData);
          classifyAndIncrement(counts, disc);

          if (blockTime) {
            if (!counts.firstAt || blockTime < counts.firstAt) counts.firstAt = blockTime;
            if (!counts.lastAt || blockTime > counts.lastAt) counts.lastAt = blockTime;
          }
        }
      }
    }

    scannedSigs += sigs.length;
    if (sigs.length < SIG_PAGE) break;
    before = sigs[sigs.length - 1].signature;
  }

  counts.lastSigScanned = newestSig;
  return counts;
}

async function persist(wallet: string, counts: InstructionCounts): Promise<void> {
  if (counts.totalSaidInstructions === 0) return;

  const data = {
    registerCount: counts.registerCount,
    getVerifiedCount: counts.getVerifiedCount,
    registerAndStakeCount: counts.registerAndStakeCount,
    sponsorRegisterCount: counts.sponsorRegisterCount,
    sponsorVerifyCount: counts.sponsorVerifyCount,
    updateAgentCount: counts.updateAgentCount,
    submitAnchorCount: counts.submitAnchorCount,
    validateWorkCount: counts.validateWorkCount,
    submitFeedbackCount: counts.submitFeedbackCount,
    stakeCount: counts.stakeCount,
    addStakeCount: counts.addStakeCount,
    unstakeLifecycleCount: counts.unstakeLifecycleCount,
    linkWalletCount: counts.linkWalletCount,
    unlinkWalletCount: counts.unlinkWalletCount,
    transferAuthorityCount: counts.transferAuthorityCount,
    slashAgentCount: counts.slashAgentCount,
    otherSaidCount: counts.otherSaidCount,
    totalSaidInstructions: counts.totalSaidInstructions,
    firstSaidInteractionAt: counts.firstAt,
    lastSaidInteractionAt: counts.lastAt,
    scannedUpToSignature: counts.lastSigScanned,
    syncedAt: new Date(),
  };

  await prisma.agentSaidEngagement.upsert({
    where: { wallet },
    create: { wallet, ...data },
    update: data,
  });
}

async function run() {
  console.log(
    `Loading verified SAID agents (rpc=${
      SOLANA_RPC_URL.includes('alchemy') ? 'alchemy' : 'public'
    })...`,
  );
  const agents = await prisma.agent.findMany({
    where: { isVerified: true },
    select: { wallet: true },
    ...(LIMIT ? { take: LIMIT } : {}),
  });
  console.log(
    `Scanning ${agents.length} agents (concurrency=${CONCURRENCY}, max_sigs/wallet=${MAX_SIGS_PER_WALLET}, parsed_tx_chunk=${PARSED_TX_CHUNK})\n`,
  );
  console.log('Known SAID Anchor discriminators (from programs/said/src/lib.rs):');
  for (const [name, disc] of Object.entries(KNOWN_INSTRUCTIONS)) {
    console.log(`  ${name.padEnd(22)} ${disc}`);
  }
  console.log();

  const startedAt = Date.now();
  let processed = 0;
  let withActivity = 0;
  const failedWallets: Array<{ wallet: string; reason: string }> = [];
  const tallies: Record<string, number> = {};
  const conn = new Connection(SOLANA_RPC_URL, 'confirmed');

  let idx = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (true) {
        const myIdx = idx++;
        if (myIdx >= agents.length) return;
        const wallet = agents[myIdx].wallet;
        try {
          const counts = await scanWallet(conn, wallet);
          await persist(wallet, counts);
          if (counts.totalSaidInstructions > 0) withActivity++;
          for (const [k, v] of Object.entries(counts)) {
            if (typeof v === 'number' && k !== 'totalSaidInstructions') {
              tallies[k] = (tallies[k] ?? 0) + v;
            }
          }
        } catch (err: any) {
          const reason = err?.message ? String(err.message).slice(0, 120) : String(err);
          failedWallets.push({ wallet, reason });
          console.error(`  ${wallet}: ${reason}`);
        }
        processed++;
        if (processed % 100 === 0) {
          const el = Math.round((Date.now() - startedAt) / 1000);
          console.log(
            `  ${processed}/${agents.length} (${el}s elapsed, with_activity=${withActivity}, errors=${failedWallets.length})`,
          );
        }
      }
    }),
  );

  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  console.log(
    `\nDone in ${elapsed}s. processed=${processed} with_activity=${withActivity} errors=${failedWallets.length}\n`,
  );

  console.log('Aggregate counts across all scanned agents:');
  const ordered = [
    'submitAnchorCount',
    'validateWorkCount',
    'submitFeedbackCount',
    'registerAndStakeCount',
    'stakeCount',
    'addStakeCount',
    'unstakeLifecycleCount',
    'sponsorRegisterCount',
    'sponsorVerifyCount',
    'updateAgentCount',
    'linkWalletCount',
    'unlinkWalletCount',
    'transferAuthorityCount',
    'slashAgentCount',
    'registerCount',
    'getVerifiedCount',
    'otherSaidCount',
  ];
  for (const k of ordered) {
    const v = tallies[k] ?? 0;
    console.log(`  ${k.padEnd(24)} ${v}`);
  }

  const top = await prisma.agentSaidEngagement.findMany({
    orderBy: [
      { submitAnchorCount: 'desc' },
      { validateWorkCount: 'desc' },
      { totalSaidInstructions: 'desc' },
    ],
    take: 15,
  });
  if (top.length > 0) {
    console.log(`\nTop 15 agents by submit_anchor (then validate_work, then total):`);
    console.log(
      `  ${'wallet'.padEnd(46)} anchor  valid  feedback  stake_evts  other  total`,
    );
    for (const t of top) {
      const stakeEvts = t.registerAndStakeCount + t.stakeCount + t.addStakeCount;
      console.log(
        `  ${t.wallet.padEnd(46)} ${String(t.submitAnchorCount).padStart(6)}  ${String(t.validateWorkCount).padStart(5)}  ${String(t.submitFeedbackCount).padStart(8)}  ${String(stakeEvts).padStart(10)}  ${String(t.otherSaidCount).padStart(5)}  ${t.totalSaidInstructions}`,
      );
    }
  }

  if (failedWallets.length > 0) {
    console.log(`\n${failedWallets.length} wallets failed (re-run separately):`);
    const byReason: Record<string, string[]> = {};
    for (const f of failedWallets) {
      const key = f.reason.includes('413')
        ? '413 Payload Too Large'
        : f.reason.includes('429')
          ? '429 rate limited'
          : f.reason.slice(0, 40);
      (byReason[key] ??= []).push(f.wallet);
    }
    for (const [reason, wallets] of Object.entries(byReason)) {
      console.log(`  ${reason}: ${wallets.length} wallet(s)`);
      for (const w of wallets.slice(0, 10)) console.log(`    ${w}`);
      if (wallets.length > 10) console.log(`    ... +${wallets.length - 10} more`);
    }
  }

  await prisma.$disconnect();
}

run().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});

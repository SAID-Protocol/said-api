/**
 * Walk each verified SAID agent's transaction history, filter for
 * transactions that invoke SAID_PROGRAM_ID, classify by Anchor
 * instruction discriminator, and persist per-wallet aggregate counts
 * to AgentSaidEngagement.
 *
 * What this fuels:
 *   The v0.7.1 said_engagement sub-signal in reputation-engine-v7.ts.
 *   Lets us distinguish an agent that actually USES SAID (anchors
 *   receipts, submits feedback) from one that only registered and
 *   filled out a profile.
 *
 * Why this matters:
 *   In the first v0.7 comparison run, ~36% of verified agents landed
 *   in silver based purely on "registered + verified + filled profile
 *   + minimal generic on-chain activity." That's exactly the
 *   "registration tourist" failure mode this sub-signal kills.
 *
 * Strategy:
 *   For each wallet, page through signatures via Alchemy until we
 *   either (a) reach the previously-scanned signature (incremental
 *   resume) or (b) hit our scan budget. For each batch of signatures,
 *   call getParsedTransactions and inspect both top-level instructions
 *   and inner instructions for any with programId == SAID_PROGRAM_ID.
 *   Classify the instruction by the first 8 bytes of its data (Anchor
 *   discriminator).
 *
 * Usage:
 *   DATABASE_URL=...  ALCHEMY_SOLANA_RPC_URL=... \
 *     npx tsx scripts/sync-said-engagement.ts
 *
 * Optional env:
 *   LIMIT=200                # cap on agents processed
 *   CONCURRENCY=4            # parallel wallet workers
 *   MAX_SIGS_PER_WALLET=1000 # scan budget per wallet (oldest-newest)
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
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 4);
const MAX_SIGS_PER_WALLET = Number(process.env.MAX_SIGS_PER_WALLET ?? 1000);
const SIG_PAGE = 1000; // Alchemy maxes at 1000 per getSignaturesForAddress call

// Compute Anchor discriminators on startup: first 8 bytes of
// sha256("global:<instruction_name>"). Source: Anchor framework.
function discriminatorFor(instructionName: string): string {
  const hash = createHash('sha256').update(`global:${instructionName}`).digest();
  return hash.subarray(0, 8).toString('hex');
}

const KNOWN_INSTRUCTIONS: Record<string, string> = {
  register_agent: discriminatorFor('register_agent'),
  get_verified: discriminatorFor('get_verified'),
  submit_feedback: discriminatorFor('submit_feedback'),
  anchor_receipt: discriminatorFor('anchor_receipt'),
  link_wallet: discriminatorFor('link_wallet'),
  unlink_wallet: discriminatorFor('unlink_wallet'),
  transfer_authority: discriminatorFor('transfer_authority'),
  attest: discriminatorFor('attest'),
  attest_agent: discriminatorFor('attest_agent'),
  create_attestation: discriminatorFor('create_attestation'),
  update_metadata: discriminatorFor('update_metadata'),
  update_agent: discriminatorFor('update_agent'),
};

// Reverse map for fast lookup: discriminator hex → instruction name
const DISCRIMINATOR_TO_NAME = new Map<string, string>();
for (const [name, disc] of Object.entries(KNOWN_INSTRUCTIONS)) {
  DISCRIMINATOR_TO_NAME.set(disc, name);
}

interface InstructionCounts {
  register: number;
  getVerified: number;
  submitFeedback: number;
  anchorReceipt: number;
  linkWallet: number;
  unlinkWallet: number;
  transferAuthority: number;
  attestation: number;
  updateMetadata: number;
  other: number;
  total: number;
  firstAt: Date | null;
  lastAt: Date | null;
  lastSigScanned: string | null;
}

function emptyCounts(): InstructionCounts {
  return {
    register: 0,
    getVerified: 0,
    submitFeedback: 0,
    anchorReceipt: 0,
    linkWallet: 0,
    unlinkWallet: 0,
    transferAuthority: 0,
    attestation: 0,
    updateMetadata: 0,
    other: 0,
    total: 0,
    firstAt: null,
    lastAt: null,
    lastSigScanned: null,
  };
}

/**
 * Decode an instruction's data field and return its discriminator hex,
 * or null if the data is too short / un-decodable.
 */
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
  counts.total++;
  if (!discHex) {
    counts.other++;
    return;
  }
  const name = DISCRIMINATOR_TO_NAME.get(discHex);
  switch (name) {
    case 'register_agent':
      counts.register++;
      break;
    case 'get_verified':
      counts.getVerified++;
      break;
    case 'submit_feedback':
      counts.submitFeedback++;
      break;
    case 'anchor_receipt':
      counts.anchorReceipt++;
      break;
    case 'link_wallet':
      counts.linkWallet++;
      break;
    case 'unlink_wallet':
      counts.unlinkWallet++;
      break;
    case 'transfer_authority':
      counts.transferAuthority++;
      break;
    case 'attest':
    case 'attest_agent':
    case 'create_attestation':
      counts.attestation++;
      break;
    case 'update_metadata':
    case 'update_agent':
      counts.updateMetadata++;
      break;
    default:
      counts.other++;
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

    // Batch fetch parsed transactions — getParsedTransactions accepts an
    // array of signatures and returns the same length array of results.
    const txs = await conn.getParsedTransactions(
      sigs.map((s) => s.signature),
      { maxSupportedTransactionVersion: 0 },
    );

    for (let i = 0; i < txs.length; i++) {
      const tx = txs[i];
      if (!tx) continue;
      const sig = sigs[i];
      const blockTime = sig.blockTime ? new Date(sig.blockTime * 1000) : null;

      // Top-level instructions
      const topIxs = tx.transaction.message.instructions;
      // Plus all inner instructions
      const innerIxs = tx.meta?.innerInstructions?.flatMap((ii) => ii.instructions) ?? [];

      for (const ix of [...topIxs, ...innerIxs]) {
        const pidStr = 'programId' in ix ? ix.programId.toBase58() : null;
        if (pidStr !== SAID_PROGRAM_ID_STR) continue;

        // Raw (un-parsed Anchor) instruction has a `data` base58 field.
        // Parsed instructions (rare for Anchor without IDL) have a
        // `parsed` field instead — count as "other" since we can't see
        // the discriminator easily.
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

    scannedSigs += sigs.length;
    if (sigs.length < SIG_PAGE) break; // exhausted history
    before = sigs[sigs.length - 1].signature;
  }

  counts.lastSigScanned = newestSig;
  return counts;
}

async function persist(wallet: string, counts: InstructionCounts): Promise<void> {
  // Don't write rows for agents with zero SAID activity — keeps the
  // table sparse. Engine treats missing as zero.
  if (counts.total === 0) return;

  const data = {
    registerCount: counts.register,
    getVerifiedCount: counts.getVerified,
    submitFeedbackCount: counts.submitFeedback,
    anchorReceiptCount: counts.anchorReceipt,
    linkWalletCount: counts.linkWallet,
    unlinkWalletCount: counts.unlinkWallet,
    transferAuthorityCount: counts.transferAuthority,
    attestationCount: counts.attestation,
    updateMetadataCount: counts.updateMetadata,
    otherSaidCount: counts.other,
    totalSaidInstructions: counts.total,
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
  console.log(`Loading verified SAID agents (alchemy=${SOLANA_RPC_URL.includes('alchemy')})...`);
  const agents = await prisma.agent.findMany({
    where: { isVerified: true },
    select: { wallet: true },
    ...(LIMIT ? { take: LIMIT } : {}),
  });
  console.log(
    `Scanning ${agents.length} agents (concurrency=${CONCURRENCY}, max_sigs/wallet=${MAX_SIGS_PER_WALLET})\n`,
  );
  console.log('Known Anchor discriminators:');
  for (const [name, disc] of Object.entries(KNOWN_INSTRUCTIONS)) {
    console.log(`  ${name.padEnd(22)} ${disc}`);
  }
  console.log();

  const startedAt = Date.now();
  let processed = 0;
  let withActivity = 0;
  let errors = 0;
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
          if (counts.total > 0) withActivity++;
          for (const [k, v] of Object.entries(counts)) {
            if (typeof v === 'number' && k !== 'total') {
              tallies[k] = (tallies[k] ?? 0) + v;
            }
          }
        } catch (err: any) {
          errors++;
          console.error(`  ${wallet}: ${err?.message ?? err}`);
        }
        processed++;
        if (processed % 100 === 0) {
          const el = Math.round((Date.now() - startedAt) / 1000);
          console.log(
            `  ${processed}/${agents.length} (${el}s elapsed, with_activity=${withActivity}, errors=${errors})`,
          );
        }
      }
    }),
  );

  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  console.log(`\nDone in ${elapsed}s. processed=${processed} with_activity=${withActivity} errors=${errors}\n`);
  console.log('Aggregate counts across all scanned agents:');
  for (const [k, v] of Object.entries(tallies).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(22)} ${v}`);
  }

  // Top 10 agents by total SAID engagement
  const top = await prisma.agentSaidEngagement.findMany({
    orderBy: { totalSaidInstructions: 'desc' },
    take: 10,
  });
  if (top.length > 0) {
    console.log(`\nTop 10 agents by total SAID instructions:`);
    for (const t of top) {
      console.log(
        `  ${t.wallet}  total=${t.totalSaidInstructions}  anchors=${t.anchorReceiptCount}  feedback=${t.submitFeedbackCount}  other=${t.otherSaidCount}`,
      );
    }
  }

  await prisma.$disconnect();
}

run().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});

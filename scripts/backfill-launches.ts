/**
 * One-time backfill: scan each verified agent's FULL signature history for
 * token launches and populate LaunchedToken.
 *
 * Why this exists separately from the wallet-activity worker: that worker
 * only scans a recent (~1000-sig / 30-day) window, but launches are often
 * months old — frequently an agent's very FIRST transaction (e.g.
 * squire_bot launched on its registration day). So existing launches are
 * invisible to the live worker and need this one-time full-history pass.
 *
 * Detection (matches src/services/wallet-activity.ts findLaunchedMints):
 *   the agent is the fee-payer of a transaction that (a) invokes a
 *   launchpad program (pump.fun — which clawpump.tech routes through) and
 *   (b) creates a new mint. The launchpad PDA is the mint authority, NOT
 *   the agent, so we key off fee-payer + launchpad, never mint authority.
 *
 * Idempotent: LaunchedToken.mint is unique; re-running is safe. DexScreener
 * market-cap enrichment runs separately (wallet-activity enrich loop).
 *
 * Usage:
 *   DATABASE_URL=... ALCHEMY_SOLANA_RPC_URL=... npx tsx scripts/backfill-launches.ts
 * Optional env: LIMIT, CONCURRENCY (default 3), MAX_SIGS (default 5000).
 */
import { PrismaClient } from '@prisma/client';
import { Connection, PublicKey } from '@solana/web3.js';

const prisma = new PrismaClient();
const RPC =
  process.env.ALCHEMY_SOLANA_RPC_URL ||
  process.env.SOLANA_RPC_URL ||
  'https://api.mainnet-beta.solana.com';
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : null;
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 3);
const MAX_SIGS = Number(process.env.MAX_SIGS ?? 20000); // ceiling on signatures listed per agent
const OLDEST_SCAN = Number(process.env.OLDEST_SCAN ?? 500); // parse the oldest N (launches are early)
const RECENT_SCAN = Number(process.env.RECENT_SCAN ?? 200); // ...plus recent N, for a later launch

const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const LAUNCHPAD_PROGRAMS = new Set<string>([
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // pump.fun
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', // pumpswap
]);

/* eslint-disable @typescript-eslint/no-explicit-any */
const programIdOf = (ix: any): string => ix?.programId?.toString?.() ?? '';
const accountOf = (k: any): string => k?.pubkey?.toString?.() ?? k?.toString?.() ?? '';

function launchedMints(tx: any, wallet: string): { mint: string; launchedAt: Date | null }[] {
  const keys = tx?.transaction?.message?.accountKeys ?? [];
  if (accountOf(keys[0]) !== wallet) return []; // agent must be fee-payer
  const ixs = [
    ...(tx.transaction.message.instructions ?? []),
    ...((tx.meta?.innerInstructions ?? []).flatMap((ii: any) => ii.instructions) ?? []),
  ];
  if (!ixs.some((ix: any) => LAUNCHPAD_PROGRAMS.has(programIdOf(ix)))) return [];
  const launchedAt: Date | null = tx.blockTime ? new Date(tx.blockTime * 1000) : null;
  const out: { mint: string; launchedAt: Date | null }[] = [];
  for (const ix of ixs) {
    const pid = programIdOf(ix);
    if (pid !== SPL_TOKEN_PROGRAM && pid !== TOKEN_2022_PROGRAM) continue;
    const p = ix.parsed;
    if (!p || typeof p !== 'object') continue;
    if (!['initializeMint', 'initializeMint2', 'initializeMintCloseAuthority'].includes(p.type)) continue;
    if (p.info?.mint) out.push({ mint: p.info.mint, launchedAt });
  }
  return out;
}

async function scanAgent(
  conn: Connection,
  wallet: string,
): Promise<{ mint: string; launchedAt: Date | null }[]> {
  let pk: PublicKey;
  try {
    pk = new PublicKey(wallet);
  } catch {
    return [];
  }
  // Page the full signature list to the oldest (listing is cheap). Launches
  // are almost always among an agent's EARLIEST transactions — often the
  // very first — so paging from newest with a cap misses them on active
  // wallets (squire_bot's launch is its oldest tx, ~5.6k sigs back).
  const all: string[] = [];
  let before: string | undefined;
  while (all.length < MAX_SIGS) {
    const page = await conn.getSignaturesForAddress(pk, { limit: 1000, before });
    if (page.length === 0) break;
    all.push(...page.map((s) => s.signature));
    before = page[page.length - 1].signature;
    if (page.length < 1000) break;
  }
  // Parse the oldest slice (where launches live) plus a recent slice (a
  // later launch), de-duped — bounded cost regardless of wallet size.
  const toParse = Array.from(
    new Set([...all.slice(-OLDEST_SCAN), ...all.slice(0, RECENT_SCAN)]),
  );
  const launches = new Map<string, Date | null>();
  for (let i = 0; i < toParse.length; i += 100) {
    const txs = await conn.getParsedTransactions(toParse.slice(i, i + 100), {
      maxSupportedTransactionVersion: 0,
    });
    for (const tx of txs) {
      if (!tx) continue;
      for (const { mint, launchedAt } of launchedMints(tx, wallet)) {
        if (!launches.has(mint)) launches.set(mint, launchedAt);
      }
    }
  }
  return [...launches.entries()].map(([mint, launchedAt]) => ({ mint, launchedAt }));
}

async function run() {
  const agents = await prisma.agent.findMany({
    where: { isVerified: true, wallet: { not: undefined } },
    select: { wallet: true },
    ...(LIMIT ? { take: LIMIT } : {}),
  });
  console.log(
    `scanning ${agents.length} agents for launches (max_sigs/agent=${MAX_SIGS}, concurrency=${CONCURRENCY}, rpc=${RPC.includes('alchemy') ? 'alchemy' : 'other'})`,
  );
  const conn = new Connection(RPC, 'confirmed');
  let idx = 0;
  let found = 0;
  let processed = 0;
  const startedAt = Date.now();
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (true) {
        const my = idx++;
        if (my >= agents.length) return;
        const wallet = agents[my].wallet;
        if (!wallet) continue;
        try {
          const launches = await scanAgent(conn, wallet);
          for (const { mint, launchedAt } of launches) {
            await prisma.launchedToken.upsert({
              where: { mint },
              update: launchedAt ? { launchedAt } : {},
              create: { mint, agentWallet: wallet, launchedAt },
            });
            found++;
            console.log(
              `  launch: ${wallet} → ${mint}${launchedAt ? ` (${launchedAt.toISOString().slice(0, 10)})` : ''}`,
            );
          }
        } catch (err: any) {
          console.error(`  ${wallet}: ${err?.message ?? err}`);
        }
        processed++;
        if (processed % 100 === 0) {
          const s = Math.round((Date.now() - startedAt) / 1000);
          console.log(`  ${processed}/${agents.length} (${s}s, launches found=${found})`);
        }
      }
    }),
  );
  console.log(`\ndone. agents=${processed} launches_found=${found}`);
  await prisma.$disconnect();
}

run().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});

/**
 * Wallet activity + launched-token detection.
 *
 * For each agent's wallet, scan recent tx history once per refresh cycle:
 *   1. Aggregate volume / counterparty / active-day stats over a 30-day
 *      window → AgentActivityStats row
 *   2. Detect token launches — the agent is the fee-payer of a launchpad
 *      (pump.fun) tx that creates a new mint → LaunchedToken row per mint
 *      (the launchpad PDA is the mint authority, not the agent)
 *
 * Single pass over each agent's signatures, so the two outputs cost what
 * the activity ingest already costs. DexScreener enrichment happens on a
 * separate (slower) loop.
 *
 * RPC: prefers Alchemy via ALCHEMY_SOLANA_RPC_URL. Falls back to whatever
 * SOLANA_RPC_URL is set to (Helius today) if Alchemy is missing.
 */

import { Connection, PublicKey, ParsedInstruction, PartiallyDecodedInstruction } from '@solana/web3.js';
import type { PrismaClient } from '@prisma/client';

const ALCHEMY_URL = process.env.ALCHEMY_SOLANA_RPC_URL;
const FALLBACK_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const RPC_URL = ALCHEMY_URL || FALLBACK_URL;

const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

// Launchpad programs that mint on the agent's behalf: the agent is the
// fee-payer/signer, but the launchpad PDA — not the agent — is the mint
// authority. clawpump.tech routes through pump.fun.
const LAUNCHPAD_PROGRAMS = new Set<string>([
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // pump.fun
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', // pumpswap (pump.fun AMM)
]);

const WINDOW_DAYS = 30;
const SIG_LIMIT = 1000;
const TX_BATCH = 100;
const INTER_BATCH_DELAY_MS = 100;

// How many agents to refresh per worker tick, how concurrently within
// a tick, and how often the tick fires.
//
// Per-agent cost is roughly 30k CU on Alchemy (~10 batches of 100 parsed
// txs at ~3k CU each), spread over ~10s of wall time, so per-agent
// sustained rate ≈ 1.5k CU/s. At PER_AGENT_CONCURRENCY=4 that's ~6k
// CU/s per pod, comfortably under the 10k CU/s ceiling. Two replicas
// would brush ~12k briefly — recoverable via the SDK's built-in
// backoff. (Longer term, move workers to a single dedicated job.)
//
// Throughput: 200 agents every 5 min ≈ 40/min ≈ full sweep of ~3.7k
// verified agents in ~90 min, then continuous refresh of the oldest.
const AGENTS_PER_TICK = 100;
const PER_AGENT_CONCURRENCY = 2;
const TICK_INTERVAL_MS = 5 * 60 * 1000;
const ENRICHMENT_INTERVAL_MS = 30 * 60 * 1000;
const ENRICHMENT_BATCH = 100;
const ENRICHMENT_STALE_MS = 6 * 60 * 60 * 1000; // re-enrich a token's DexScreener data every 6h

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ActivityResult {
  txCount: number;
  volumeSolLamports: bigint;
  uniqueCounterparties: number;
  activeDays: number;
  oldestSeen: Date | null;
  latestSeen: Date | null;
  launchedMints: string[];
}

function getAccountAddress(k: unknown): string {
  // ParsedMessageAccount has .pubkey; raw key may be PublicKey or string.
  const anyK = k as { pubkey?: { toString?: () => string }; toString?: () => string };
  if (anyK?.pubkey?.toString) return anyK.pubkey.toString();
  return anyK?.toString?.() ?? '';
}

function isTokenProgram(programId: string): boolean {
  return programId === SPL_TOKEN_PROGRAM || programId === TOKEN_2022_PROGRAM;
}

// Detect a token LAUNCH by the agent. On a launchpad (pump.fun, which
// clawpump.tech routes through) the agent is the fee-payer/signer of the
// create tx, but the mint authority is the launchpad PDA — NOT the agent.
// So we key off (fee-payer === wallet) + a launchpad program in the tx,
// not mintAuthority === wallet (which a launchpad launch never satisfies).
// Requiring fee-payer also excludes mints the agent merely traded/bought.
function findLaunchedMints(
  tx: NonNullable<Awaited<ReturnType<Connection['getParsedTransaction']>>>,
  wallet: string,
): string[] {
  const feePayer = getAccountAddress(tx.transaction.message.accountKeys[0]);
  if (feePayer !== wallet) return [];

  const allIxs: (ParsedInstruction | PartiallyDecodedInstruction)[] = [
    ...tx.transaction.message.instructions,
    ...(tx.meta?.innerInstructions?.flatMap((ii) => ii.instructions) ?? []),
  ];
  const programIdOf = (ix: ParsedInstruction | PartiallyDecodedInstruction): string =>
    (ix as { programId?: { toString?: () => string } }).programId?.toString?.() ?? '';

  // Must be a launchpad transaction — not a raw SPL mint init.
  if (!allIxs.some((ix) => LAUNCHPAD_PROGRAMS.has(programIdOf(ix)))) return [];

  const found: string[] = [];
  for (const ix of allIxs) {
    if (!isTokenProgram(programIdOf(ix))) continue;
    const parsed = (ix as ParsedInstruction).parsed;
    if (!parsed || typeof parsed !== 'object') continue;
    const type = parsed.type;
    if (type !== 'initializeMint' && type !== 'initializeMint2' && type !== 'initializeMintCloseAuthority') continue;
    const info = parsed.info as { mint?: string };
    if (info.mint) found.push(info.mint);
  }
  return found;
}

async function fetchActivityAndMints(wallet: string): Promise<ActivityResult | null> {
  const conn = new Connection(RPC_URL, 'confirmed');
  // Some Agent rows have placeholder strings instead of real wallets
  // ("SAID_PROTOCOL", debug values, etc.). Skip those cleanly instead of
  // letting the PublicKey constructor throw.
  let pubkey: PublicKey;
  try {
    pubkey = new PublicKey(wallet);
  } catch {
    return null;
  }
  const cutoffSeconds = Math.floor(Date.now() / 1000) - WINDOW_DAYS * 24 * 3600;

  let sigs;
  try {
    sigs = await conn.getSignaturesForAddress(pubkey, { limit: SIG_LIMIT });
  } catch (err) {
    console.error(`[wallet-activity] getSignaturesForAddress failed for ${wallet}:`, err);
    return null;
  }

  const inWindow = sigs.filter((s) => (s.blockTime ?? 0) >= cutoffSeconds);
  if (inWindow.length === 0) {
    return {
      txCount: 0,
      volumeSolLamports: 0n,
      uniqueCounterparties: 0,
      activeDays: 0,
      oldestSeen: null,
      latestSeen: null,
      launchedMints: [],
    };
  }

  const counterparties = new Set<string>();
  const activeDays = new Set<string>();
  const launchedMints = new Set<string>();
  let txCount = 0;
  let volumeSolLamports = 0n;
  let oldestSeen: Date | null = null;
  let latestSeen: Date | null = null;

  for (let i = 0; i < inWindow.length; i += TX_BATCH) {
    const slice = inWindow.slice(i, i + TX_BATCH);
    let txs;
    try {
      txs = await conn.getParsedTransactions(
        slice.map((s) => s.signature),
        { maxSupportedTransactionVersion: 0 },
      );
    } catch (err) {
      console.error(`[wallet-activity] getParsedTransactions failed for ${wallet}:`, err);
      continue;
    }

    for (let j = 0; j < txs.length; j++) {
      const tx = txs[j];
      const sigInfo = slice[j];
      if (!tx || tx.meta?.err) continue;
      txCount++;

      const blockTime = tx.blockTime ?? sigInfo.blockTime ?? 0;
      if (blockTime) {
        const date = new Date(blockTime * 1000);
        activeDays.add(date.toISOString().slice(0, 10));
        if (!oldestSeen || date < oldestSeen) oldestSeen = date;
        if (!latestSeen || date > latestSeen) latestSeen = date;
      }

      const accountKeys = tx.transaction.message.accountKeys;
      const walletIdx = accountKeys.findIndex((k) => getAccountAddress(k) === wallet);
      if (walletIdx >= 0) {
        const pre = tx.meta?.preBalances?.[walletIdx] ?? 0;
        const post = tx.meta?.postBalances?.[walletIdx] ?? 0;
        const delta = BigInt(Math.abs(post - pre));
        volumeSolLamports += delta;
      }
      for (let k = 0; k < accountKeys.length; k++) {
        if (k === walletIdx) continue;
        const addr = getAccountAddress(accountKeys[k]);
        if (!addr || addr === SYSTEM_PROGRAM) continue;
        counterparties.add(addr);
      }

      for (const mint of findLaunchedMints(tx, wallet)) {
        launchedMints.add(mint);
      }
    }

    if (i + TX_BATCH < inWindow.length) await sleep(INTER_BATCH_DELAY_MS);
  }

  return {
    txCount,
    volumeSolLamports,
    uniqueCounterparties: counterparties.size,
    activeDays: activeDays.size,
    oldestSeen,
    latestSeen,
    launchedMints: Array.from(launchedMints),
  };
}

async function processOneAgent(prisma: PrismaClient, wallet: string): Promise<void> {
  const result = await fetchActivityAndMints(wallet);
  if (!result) return;

  await prisma.agentActivityStats.upsert({
    where: { wallet },
    update: {
      txCount: result.txCount,
      volumeSolLamports: result.volumeSolLamports,
      uniqueCounterparties: result.uniqueCounterparties,
      activeDays: result.activeDays,
      oldestSeen: result.oldestSeen,
      latestSeen: result.latestSeen,
      computedAt: new Date(),
      source: ALCHEMY_URL ? 'alchemy' : 'fallback',
    },
    create: {
      wallet,
      txCount: result.txCount,
      volumeSolLamports: result.volumeSolLamports,
      uniqueCounterparties: result.uniqueCounterparties,
      activeDays: result.activeDays,
      oldestSeen: result.oldestSeen,
      latestSeen: result.latestSeen,
      source: ALCHEMY_URL ? 'alchemy' : 'fallback',
    },
  });

  for (const mint of result.launchedMints) {
    try {
      await prisma.launchedToken.upsert({
        where: { mint },
        update: {},
        create: { mint, agentWallet: wallet },
      });
    } catch (err) {
      console.error(`[wallet-activity] failed to upsert launched token ${mint} for ${wallet}:`, err);
    }
  }
}

async function refreshOldestAgents(prisma: PrismaClient): Promise<void> {
  // Pick the AGENTS_PER_TICK agents that are either missing stats entirely
  // or have the oldest computedAt — round-robin coverage.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const candidates: { wallet: string }[] = await prisma.$queryRaw<{ wallet: string }[]>`
    SELECT a.wallet
    FROM "Agent" a
    LEFT JOIN "AgentActivityStats" s ON s.wallet = a.wallet
    WHERE a."isVerified" = true AND a.wallet IS NOT NULL
    ORDER BY s."computedAt" ASC NULLS FIRST
    LIMIT ${AGENTS_PER_TICK}
  `;
  if (candidates.length === 0) return;
  const startedAt = Date.now();
  console.log(
    `[wallet-activity] refreshing ${candidates.length} agents (concurrency=${PER_AGENT_CONCURRENCY})`,
  );
  let completed = 0;
  let errors = 0;
  // Process in concurrent chunks. Each chunk runs PER_AGENT_CONCURRENCY
  // agents in parallel; we wait for the chunk before starting the next
  // so the in-flight Alchemy CU draw stays bounded.
  for (let i = 0; i < candidates.length; i += PER_AGENT_CONCURRENCY) {
    const chunk = candidates.slice(i, i + PER_AGENT_CONCURRENCY);
    await Promise.all(
      chunk.map(async (c) => {
        try {
          await processOneAgent(prisma, c.wallet);
          completed++;
        } catch (err) {
          errors++;
          console.error(`[wallet-activity] processOneAgent error for ${c.wallet}:`, err);
        }
      }),
    );
  }
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[wallet-activity] tick done: completed=${completed} errors=${errors} in ${seconds}s`);
}

interface DexScreenerPair {
  priceUsd?: string;
  marketCap?: number;
  fdv?: number;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  dexId?: string;
}

async function enrichLaunchedTokens(prisma: PrismaClient): Promise<void> {
  const staleCutoff = new Date(Date.now() - ENRICHMENT_STALE_MS);
  const tokens = await prisma.launchedToken.findMany({
    where: {
      OR: [{ enrichedAt: null }, { enrichedAt: { lt: staleCutoff } }],
    },
    take: ENRICHMENT_BATCH,
    orderBy: { enrichedAt: { sort: 'asc', nulls: 'first' } },
  });
  if (tokens.length === 0) return;
  console.log(`[wallet-activity] enriching ${tokens.length} launched tokens via DexScreener`);

  for (const t of tokens) {
    try {
      // DexScreener 403s requests without a browser-like User-Agent.
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${t.mint}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SAIDProtocol/1.0; +https://saidprotocol.com)' },
      });
      if (!res.ok) {
        await prisma.launchedToken.update({ where: { id: t.id }, data: { enrichedAt: new Date() } });
        continue;
      }
      const data = (await res.json()) as { pairs?: DexScreenerPair[] };
      const pairs = data.pairs ?? [];
      // Pick the deepest-liquidity pair as authoritative.
      const top = pairs.reduce<DexScreenerPair | null>((best, p) => {
        const liq = p.liquidity?.usd ?? 0;
        const bestLiq = best?.liquidity?.usd ?? -1;
        return liq > bestLiq ? p : best;
      }, null);

      await prisma.launchedToken.update({
        where: { id: t.id },
        data: {
          priceUsd: top?.priceUsd ? Number(top.priceUsd) : null,
          marketCapUsd: top?.marketCap ?? top?.fdv ?? null,
          liquidityUsd: top?.liquidity?.usd ?? null,
          volume24hUsd: top?.volume?.h24 ?? null,
          dexId: top?.dexId ?? null,
          enrichedAt: new Date(),
        },
      });
    } catch (err) {
      console.error(`[wallet-activity] DexScreener enrich failed for ${t.mint}:`, err);
    }
    await sleep(150);
  }
}

export function startWalletActivityWorkers(prisma: PrismaClient): void {
  if (!ALCHEMY_URL) {
    console.warn('[wallet-activity] ALCHEMY_SOLANA_RPC_URL not set — using fallback RPC. Performance and rate limits will suffer.');
  } else {
    console.log('[wallet-activity] Using Alchemy as primary RPC');
  }
  // Don't await — let the server start without blocking on the first sweep.
  refreshOldestAgents(prisma).catch((err) => console.error('[wallet-activity] initial sweep error:', err));
  setInterval(() => {
    refreshOldestAgents(prisma).catch((err) => console.error('[wallet-activity] tick error:', err));
  }, TICK_INTERVAL_MS);

  enrichLaunchedTokens(prisma).catch((err) => console.error('[wallet-activity] initial enrich error:', err));
  setInterval(() => {
    enrichLaunchedTokens(prisma).catch((err) => console.error('[wallet-activity] enrich tick error:', err));
  }, ENRICHMENT_INTERVAL_MS);
}

// Read helpers exported for scoring use.
export async function getActivityStatsForWallet(
  prisma: PrismaClient,
  wallet: string,
): Promise<{
  txCount: number;
  volumeSol: number;
  uniqueCounterparties: number;
  activeDays: number;
} | null> {
  const row = await prisma.agentActivityStats.findUnique({ where: { wallet } });
  if (!row) return null;
  return {
    txCount: row.txCount,
    volumeSol: Number(row.volumeSolLamports) / 1_000_000_000,
    uniqueCounterparties: row.uniqueCounterparties,
    activeDays: row.activeDays,
  };
}

export async function getLaunchedTokenStatsForWallet(
  prisma: PrismaClient,
  wallet: string,
): Promise<{
  tokenCount: number;
  totalMarketCapUsd: number;
  totalVolume24hUsd: number;
  topMarketCapUsd: number;
}> {
  const tokens = await prisma.launchedToken.findMany({
    where: { agentWallet: wallet },
    select: { marketCapUsd: true, volume24hUsd: true },
  });
  let totalMarketCapUsd = 0;
  let totalVolume24hUsd = 0;
  let topMarketCapUsd = 0;
  for (const t of tokens) {
    const mc = t.marketCapUsd ?? 0;
    const v = t.volume24hUsd ?? 0;
    totalMarketCapUsd += mc;
    totalVolume24hUsd += v;
    if (mc > topMarketCapUsd) topMarketCapUsd = mc;
  }
  return {
    tokenCount: tokens.length,
    totalMarketCapUsd,
    totalVolume24hUsd,
    topMarketCapUsd,
  };
}

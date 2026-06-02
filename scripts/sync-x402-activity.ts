/**
 * Sync x402 micropayment activity for every verified SAID agent from
 * x402scan's public tRPC, persisting per-wallet rows in
 * AgentX402Activity.
 *
 * What this fuels:
 *   The v0.7 paid_service path of demonstrated-delivery — see
 *   reputation-engine-v7.ts detectDemonstratedDelivery. Without this
 *   data the paid_service path never activates and active providers
 *   (Xona, etc.) can't break past the no_delivery_gold ceiling.
 *
 * Why call x402scan and not Coinbase CDP:
 *   CDP /discovery/merchant only indexes the Coinbase facilitator
 *   subset. x402scan aggregates coinbase + dexter + payAI + relai +
 *   corbits — gets the full picture. No auth required.
 *
 * Cadence:
 *   Run once for the initial backfill, then on a 12-24h schedule.
 *   Idempotent (upsert), so re-running is safe.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/sync-x402-activity.ts
 *
 * Optional env:
 *   BATCH_SIZE=100        # wallets per tRPC request (max ~150 before URL too long)
 *   LIMIT=200             # cap on wallets processed, for dry runs
 *   ONLY_VERIFIED=true    # default true; set false to include unverified
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const X402SCAN_BASE = 'https://www.x402scan.com/api/trpc';
const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? 100);
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : null;
const ONLY_VERIFIED = process.env.ONLY_VERIFIED !== 'false';
const REQUEST_DELAY_MS = 150;

interface X402ListItem {
  recipient?: string;
  sender?: string;
  facilitator_ids: string[];
  tx_count: number;
  total_amount: number;
  latest_block_timestamp: string;
  unique_buyers?: number;
  unique_sellers?: number;
  chains: string[];
}

interface X402ListResponse {
  result: { data: { json: { items: X402ListItem[]; total_count: number } } };
}

function encodeInput(input: object): string {
  return encodeURIComponent(JSON.stringify({ json: input }));
}

async function fetchSide(
  side: 'sellers' | 'buyers',
  wallets: string[],
): Promise<X402ListItem[]> {
  const field = side === 'sellers' ? 'recipients' : 'senders';
  const input = encodeInput({
    timeframe: 0,
    [field]: { include: wallets },
    pagination: { page: 0, page_size: 500 },
  });
  const url = `${X402SCAN_BASE}/public.${side}.all.list?input=${input}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`x402scan ${side} batch failed: HTTP ${res.status} (${wallets.length} wallets)`);
  }
  const body = (await res.json()) as X402ListResponse;
  return body.result?.data?.json?.items ?? [];
}

async function processBatch(wallets: string[]): Promise<{ providers: number; buyers: number }> {
  const [sellers, buyers] = await Promise.all([
    fetchSide('sellers', wallets),
    fetchSide('buyers', wallets),
  ]);

  const byWallet = new Map<
    string,
    {
      providerTxCount?: number;
      providerAmountAtomic?: bigint;
      providerUniqueBuyers?: number;
      providerFacilitators?: string[];
      providerLastSeenAt?: Date;
      buyerTxCount?: number;
      buyerAmountAtomic?: bigint;
      buyerUniqueSellers?: number;
      buyerFacilitators?: string[];
      buyerLastSeenAt?: Date;
    }
  >();

  for (const item of sellers) {
    const w = item.recipient;
    if (!w) continue;
    const row = byWallet.get(w) ?? {};
    row.providerTxCount = item.tx_count;
    row.providerAmountAtomic = BigInt(Math.floor(item.total_amount));
    row.providerUniqueBuyers = item.unique_buyers ?? 0;
    row.providerFacilitators = item.facilitator_ids;
    row.providerLastSeenAt = new Date(item.latest_block_timestamp);
    byWallet.set(w, row);
  }
  for (const item of buyers) {
    const w = item.sender;
    if (!w) continue;
    const row = byWallet.get(w) ?? {};
    row.buyerTxCount = item.tx_count;
    row.buyerAmountAtomic = BigInt(Math.floor(item.total_amount));
    row.buyerUniqueSellers = item.unique_sellers ?? 0;
    row.buyerFacilitators = item.facilitator_ids;
    row.buyerLastSeenAt = new Date(item.latest_block_timestamp);
    byWallet.set(w, row);
  }

  // Upsert one row per wallet that has any activity. Wallets with zero
  // activity get no row written (saves space and the engine treats
  // missing == zero by default).
  for (const [wallet, data] of byWallet.entries()) {
    await prisma.agentX402Activity.upsert({
      where: { wallet },
      create: {
        wallet,
        providerTxCount: data.providerTxCount ?? 0,
        providerAmountAtomic: data.providerAmountAtomic ?? 0n,
        providerUniqueBuyers: data.providerUniqueBuyers ?? 0,
        providerFacilitators: data.providerFacilitators ?? [],
        providerLastSeenAt: data.providerLastSeenAt ?? null,
        buyerTxCount: data.buyerTxCount ?? 0,
        buyerAmountAtomic: data.buyerAmountAtomic ?? 0n,
        buyerUniqueSellers: data.buyerUniqueSellers ?? 0,
        buyerFacilitators: data.buyerFacilitators ?? [],
        buyerLastSeenAt: data.buyerLastSeenAt ?? null,
      },
      update: {
        providerTxCount: data.providerTxCount ?? 0,
        providerAmountAtomic: data.providerAmountAtomic ?? 0n,
        providerUniqueBuyers: data.providerUniqueBuyers ?? 0,
        providerFacilitators: data.providerFacilitators ?? [],
        providerLastSeenAt: data.providerLastSeenAt ?? null,
        buyerTxCount: data.buyerTxCount ?? 0,
        buyerAmountAtomic: data.buyerAmountAtomic ?? 0n,
        buyerUniqueSellers: data.buyerUniqueSellers ?? 0,
        buyerFacilitators: data.buyerFacilitators ?? [],
        buyerLastSeenAt: data.buyerLastSeenAt ?? null,
        syncedAt: new Date(),
      },
    });
  }

  return { providers: sellers.length, buyers: buyers.length };
}

async function run() {
  console.log(`Loading SAID agent wallets (only_verified=${ONLY_VERIFIED})...`);
  const where = ONLY_VERIFIED ? { isVerified: true } : {};
  const agents = await prisma.agent.findMany({
    where,
    select: { wallet: true },
    ...(LIMIT ? { take: LIMIT } : {}),
  });
  console.log(`Syncing x402 activity for ${agents.length} agents (batch_size=${BATCH_SIZE})\n`);

  const startedAt = Date.now();
  let processed = 0;
  let totalProviders = 0;
  let totalBuyers = 0;
  let batchErrors = 0;

  for (let i = 0; i < agents.length; i += BATCH_SIZE) {
    const batch = agents.slice(i, i + BATCH_SIZE).map((a) => a.wallet);
    try {
      const r = await processBatch(batch);
      totalProviders += r.providers;
      totalBuyers += r.buyers;
    } catch (err: any) {
      batchErrors++;
      console.error(`  batch ${i}-${i + batch.length} failed: ${err?.message ?? err}`);
    }
    processed += batch.length;
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    if (processed % 500 === 0 || processed === agents.length) {
      console.log(
        `  ${processed}/${agents.length} (${elapsed}s elapsed, providers=${totalProviders}, buyers=${totalBuyers}, errors=${batchErrors})`,
      );
    }
    if (REQUEST_DELAY_MS > 0 && i + BATCH_SIZE < agents.length) {
      await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
    }
  }

  console.log(
    `\nDone in ${Math.round((Date.now() - startedAt) / 1000)}s. Processed=${processed}, providers=${totalProviders}, buyers=${totalBuyers}, batch_errors=${batchErrors}`,
  );

  // Sanity table of who ended up with non-trivial paid_service signal
  const topProviders = await prisma.agentX402Activity.findMany({
    where: { providerUniqueBuyers: { gte: 1 } },
    orderBy: { providerUniqueBuyers: 'desc' },
    take: 20,
  });
  if (topProviders.length > 0) {
    console.log(`\nTop providers in AgentX402Activity:`);
    for (const p of topProviders) {
      console.log(
        `  ${p.wallet}  buyers=${p.providerUniqueBuyers}  txs=${p.providerTxCount}  facilitators=[${p.providerFacilitators.join(',')}]`,
      );
    }
  } else {
    console.log('\n(No agents with provider activity found.)');
  }

  await prisma.$disconnect();
}

run().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});

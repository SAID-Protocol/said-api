/**
 * Per-transaction x402 ingestion — the buyer-wallet unlock for the
 * reputation graph.
 *
 * The aggregate sync (scripts/sync-x402-activity.ts) fills
 * AgentX402Activity with *counts*: a provider knows it had N unique
 * buyers, but not *who* they were. The v0.8 backfill turns that into a
 * single batched ReputationEvent with actorWallet=null — so it
 * contributes to posteriors but produces ZERO TrustEdge rows (build-edges
 * skips actorWallet IS NULL). Result: high-revenue providers like Xona
 * have hundreds of real customers yet no inbound graph edges, so
 * EigenTrust can't see them.
 *
 * This script closes that gap. For every provider with x402 activity it
 * walks x402scan's per-tx transfers endpoint, recovers each distinct
 * buyer wallet, and emits per-buyer ReputationEvents WITH actorWallet set
 * — so build-edges turns each buyer into a buyer→provider payment edge.
 *
 * Double-count guard: the batched provider events
 * (x402:provider:{payments,delivery}:<wallet>) carry weight =
 * providerUniqueBuyers. Once we have per-buyer rows (weight 1.0 each,
 * counterparty-diversity scale — same as the batched policy), the batched
 * rows would double the evidence. So after a provider is successfully
 * expanded we DELETE its two batched rows; the per-buyer rows supersede
 * them on the same one-buyer-≈-one-unit scale.
 *
 * Idempotent: emitEvent is keyed on sourceKey
 * (x402:pertx:<provider>:<buyer>:<axis>); re-running is safe. The batched
 * deleteMany is a no-op once they're gone.
 *
 * After this runs, re-run the pipeline:
 *   npx tsx scripts/v8-compute-signals.ts
 *   npx tsx scripts/v8-compute-posteriors.ts
 *   npx tsx scripts/v8-build-edges.ts
 *   npx tsx scripts/v8-compute-eigentrust.ts
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/sync-x402-per-tx.ts
 *
 * Optional env:
 *   PROVIDER=<wallet>     # expand a single provider instead of all
 *   LIMIT=50              # cap on providers processed (dry runs)
 *   PAGE_SIZE=500         # transfers per tRPC page (max ~500)
 *   MAX_PAGES=200         # safety cap on pages per provider (200*500=100k tx)
 *   DRY_RUN=true          # fetch + report, write nothing
 */
import { PrismaClient } from '@prisma/client';
import { emitEvent } from '../src/reputation-v0.8/ingest.js';

const prisma = new PrismaClient();

const X402SCAN_BASE = 'https://www.x402scan.com/api/trpc';
const PAGE_SIZE = Number(process.env.PAGE_SIZE ?? 500);
const MAX_PAGES = Number(process.env.MAX_PAGES ?? 200);
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : null;
const PROVIDER = process.env.PROVIDER ?? null;
const DRY_RUN = process.env.DRY_RUN === 'true';
const REQUEST_DELAY_MS = 150;

// One per-tx transfer row from public.transfers.list. We only need a few
// fields; the rest of the row is ignored.
interface TransferRow {
  sender: string; // buyer wallet  (the actor whose trust flows to provider)
  recipient: string; // provider wallet (== the wallet we filtered on)
  amount: number;
  block_timestamp: string;
  tx_hash: string;
}

interface TransfersResponse {
  result: { data: { json: { items: TransferRow[]; hasNextPage: boolean; page: number } } };
}

function encodeInput(input: object): string {
  return encodeURIComponent(JSON.stringify({ json: input }));
}

// Fetch a single page of Solana transfers TO `recipient`, newest first.
async function fetchTransfersPage(recipient: string, page: number): Promise<{ items: TransferRow[]; hasNextPage: boolean }> {
  const input = encodeInput({
    timeframe: 0,
    chain: 'solana',
    recipients: { include: [recipient] },
    sorting: { id: 'block_timestamp', desc: true },
    pagination: { page, page_size: PAGE_SIZE },
  });
  const url = `${X402SCAN_BASE}/public.transfers.list?input=${input}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`x402scan transfers failed: HTTP ${res.status} (recipient ${recipient}, page ${page})`);
  }
  const body = (await res.json()) as TransfersResponse;
  const data = body.result?.data?.json;
  return { items: data?.items ?? [], hasNextPage: data?.hasNextPage ?? false };
}

interface BuyerAgg {
  txCount: number;
  totalAmount: number;
  latestTs: Date;
}

// Walk every page of transfers to `provider`, aggregating per distinct
// buyer wallet. Self-payments (buyer == provider) are dropped — they
// can't become a graph edge and would be self-trust.
async function collectBuyers(provider: string): Promise<Map<string, BuyerAgg>> {
  const buyers = new Map<string, BuyerAgg>();
  for (let page = 0; page < MAX_PAGES; page++) {
    const { items, hasNextPage } = await fetchTransfersPage(provider, page);
    for (const t of items) {
      if (!t.sender || t.sender === provider) continue;
      const ts = new Date(t.block_timestamp);
      const prev = buyers.get(t.sender);
      if (prev) {
        prev.txCount += 1;
        prev.totalAmount += t.amount;
        if (ts > prev.latestTs) prev.latestTs = ts;
      } else {
        buyers.set(t.sender, { txCount: 1, totalAmount: t.amount, latestTs: ts });
      }
    }
    if (!hasNextPage) break;
    if (REQUEST_DELAY_MS > 0) await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
  }
  return buyers;
}

// Emit the payments + delivery events for one (provider, buyer) pair.
async function emitBuyerEvents(provider: string, buyer: string, agg: BuyerAgg): Promise<number> {
  const metadata = { txCount: agg.txCount, totalAmountAtomic: agg.totalAmount };
  let emitted = 0;

  const payments = await emitEvent(prisma, {
    sourceKey: `x402:pertx:${provider}:${buyer}:payments`,
    subjectWallet: provider,
    actorWallet: buyer,
    kind: 'x402_payment_received',
    weight: 1.0, // one buyer = one unit of evidence (counterparty diversity)
    occurredAt: agg.latestTs,
    metadata,
  });
  if (payments.emitted) emitted++;

  const delivery = await emitEvent(prisma, {
    sourceKey: `x402:pertx:${provider}:${buyer}:delivery`,
    subjectWallet: provider,
    actorWallet: buyer,
    kind: 'x402_payment_received_delivery',
    weight: 1.0,
    occurredAt: agg.latestTs,
    metadata,
  });
  if (delivery.emitted) emitted++;

  return emitted;
}

// Remove the batched synthetic provider events now superseded by per-buyer
// rows. Returns how many rows were deleted.
async function supersedeBatched(provider: string): Promise<number> {
  const { count } = await prisma.reputationEvent.deleteMany({
    where: {
      sourceKey: {
        in: [`x402:provider:payments:${provider}`, `x402:provider:delivery:${provider}`],
      },
    },
  });
  return count;
}

async function run() {
  // Provider work-list: either a single PROVIDER override, or every wallet
  // in AgentX402Activity that actually received x402 payments.
  let providers: string[];
  if (PROVIDER) {
    providers = [PROVIDER];
  } else {
    const rows = await prisma.agentX402Activity.findMany({
      where: { providerUniqueBuyers: { gt: 0 } },
      orderBy: { providerUniqueBuyers: 'desc' },
      select: { wallet: true },
      ...(LIMIT ? { take: LIMIT } : {}),
    });
    providers = rows.map((r) => r.wallet);
  }

  console.log(
    `Per-tx x402 ingestion: ${providers.length} provider(s)` +
      `${DRY_RUN ? ' [DRY RUN — no writes]' : ''} (page_size=${PAGE_SIZE})\n`,
  );

  const startedAt = Date.now();
  let totalBuyers = 0;
  let totalEvents = 0;
  let totalBatchedRemoved = 0;
  let providerErrors = 0;

  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i];
    try {
      const buyers = await collectBuyers(provider);
      totalBuyers += buyers.size;

      if (buyers.size === 0) {
        console.log(`  [${i + 1}/${providers.length}] ${provider.slice(0, 12)}…  no buyers found — left batched event intact`);
        continue;
      }

      if (DRY_RUN) {
        console.log(`  [${i + 1}/${providers.length}] ${provider.slice(0, 12)}…  ${buyers.size} buyers (dry run)`);
      } else {
        let emitted = 0;
        for (const [buyer, agg] of buyers.entries()) {
          emitted += await emitBuyerEvents(provider, buyer, agg);
        }
        const removed = await supersedeBatched(provider);
        totalEvents += emitted;
        totalBatchedRemoved += removed;
        console.log(
          `  [${i + 1}/${providers.length}] ${provider.slice(0, 12)}…  ${buyers.size} buyers → ${emitted} events emitted, ${removed} batched superseded`,
        );
      }
    } catch (err: any) {
      providerErrors++;
      console.error(`  [${i + 1}/${providers.length}] ${provider.slice(0, 12)}…  FAILED: ${err?.message ?? err}`);
    }
    if (REQUEST_DELAY_MS > 0 && i + 1 < providers.length) {
      await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
    }
  }

  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  console.log(
    `\nDone in ${elapsed}s. providers=${providers.length}, distinct_buyer_edges=${totalBuyers}, ` +
      `events_emitted=${totalEvents}, batched_superseded=${totalBatchedRemoved}, errors=${providerErrors}`,
  );
  if (!DRY_RUN && totalEvents > 0) {
    console.log(
      '\nNext: recompute the pipeline —\n' +
        '  npx tsx scripts/v8-compute-signals.ts\n' +
        '  npx tsx scripts/v8-compute-posteriors.ts\n' +
        '  npx tsx scripts/v8-build-edges.ts\n' +
        '  npx tsx scripts/v8-compute-eigentrust.ts',
    );
  }

  await prisma.$disconnect();
}

run().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});

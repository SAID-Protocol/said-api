/**
 * v0.7 backfill v2 — proper detection of create-token actions across the
 * entire wallet history.
 *
 * v1 bug: scanned only the most-recent 200 sigs of a wallet, then took
 * the first 30 oldest of THAT. For wallets with thousands of sigs the
 * actual launch tx was outside the window. Fixed here by paginating to
 * the true beginning of history.
 *
 * Detection rule:
 *   Across every successful tx in the wallet's history, look for a
 *   `Pump.fun program invocation` co-located with an `initializeMint2`
 *   in the inner instructions. If both fire in the same tx, the mint
 *   that got initialized is a token this wallet either created or
 *   participated in creating. Record it.
 *
 * For efficiency: most wallets have <500 sigs and only a handful touch
 * Pump.fun, so we paginate cheaply via getSignaturesForAddress and fetch
 * full parsed details only for sigs that look like Pump.fun txs based
 * on the Helius enhanced view (or fall back to checking the full tx).
 */
import { Connection, PublicKey, ParsedInstruction } from '@solana/web3.js';
import {
  computeTrustScoreV7,
  type V7ScoreResult,
} from '/Users/callum/said-api/src/reputation-engine-v7.ts';

const SAID_API = 'https://api.saidprotocol.com';
const ALCHEMY = 'https://solana-mainnet.g.alchemy.com/v2/IDEFlrzwbGmzujtisWINo';
const PUMP_PROG = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const WSOL = 'So11111111111111111111111111111111111111112';

const SAMPLE_SIZE = 50;
const SIG_PAGE_SIZE = 1000;
const MAX_SIG_PAGES = 10; // up to 10,000 lifetime sigs per wallet
const TX_BATCH = 25;
const INTER_BATCH_DELAY_MS = 80;

const conn = new Connection(ALCHEMY, 'confirmed');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface DetectedLaunch {
  agent: string;
  agentName: string;
  mint: string;
  pattern: 'A_signer' | 'B_recipient';
  launchSig: string;
  blockTime: number;
  marketCapUsd?: number;
  volume24hUsd?: number;
  liquidityUsd?: number;
  dexId?: string;
}

/**
 * For a parsed tx, return the mints created via initializeMint2 inside
 * a tx that also invokes the Pump.fun program. Includes whether the
 * agent wallet was a signer (Pattern A) or only a writable participant
 * (Pattern B — currently we don't try to discriminate further).
 */
function extractPumpFunCreates(
  tx: NonNullable<Awaited<ReturnType<Connection['getParsedTransaction']>>>,
  agentWallet: string,
): { mint: string; pattern: 'A_signer' | 'B_recipient' }[] {
  const topPrograms = tx.transaction.message.instructions.map(
    (ix) => (ix as { programId?: { toString?: () => string } }).programId?.toString?.() ?? '',
  );
  const innerPrograms = (tx.meta?.innerInstructions ?? []).flatMap((g) =>
    g.instructions.map(
      (ix) => (ix as { programId?: { toString?: () => string } }).programId?.toString?.() ?? '',
    ),
  );
  const usesPump = topPrograms.includes(PUMP_PROG) || innerPrograms.includes(PUMP_PROG);
  if (!usesPump) return [];

  const mintsCreated: string[] = [];
  for (const group of tx.meta?.innerInstructions ?? []) {
    for (const ix of group.instructions) {
      const parsed = (ix as ParsedInstruction).parsed;
      if (parsed && typeof parsed === 'object') {
        const t = parsed.type;
        if (t === 'initializeMint' || t === 'initializeMint2') {
          const info = parsed.info as { mint?: string };
          if (info.mint && info.mint !== WSOL) mintsCreated.push(info.mint);
        }
      }
    }
  }
  if (mintsCreated.length === 0) return [];

  const signers = tx.transaction.message.accountKeys
    .filter((k) => (k as { signer?: boolean }).signer)
    .map((k) => (k as { pubkey?: { toString?: () => string } }).pubkey?.toString?.() ?? '');
  const isSigner = signers.includes(agentWallet);

  return mintsCreated.map((m) => ({
    mint: m,
    pattern: isSigner ? ('A_signer' as const) : ('B_recipient' as const),
  }));
}

async function detectAllLaunches(wallet: string, name: string): Promise<DetectedLaunch[]> {
  let pubkey: PublicKey;
  try {
    pubkey = new PublicKey(wallet);
  } catch {
    return [];
  }

  // Paginate the entire wallet history. For most wallets this is 1-2
  // pages; for very active wallets (squire_bot has ~4k sigs) it's a
  // handful.
  let allSigs: { signature: string; blockTime: number | null; err: unknown }[] = [];
  let before: string | undefined;
  for (let page = 0; page < MAX_SIG_PAGES; page++) {
    let batch;
    try {
      batch = await conn.getSignaturesForAddress(pubkey, {
        limit: SIG_PAGE_SIZE,
        ...(before ? { before } : {}),
      });
    } catch {
      break;
    }
    if (!batch.length) break;
    allSigs.push(...batch);
    before = batch[batch.length - 1].signature;
    if (batch.length < SIG_PAGE_SIZE) break;
  }
  const successful = allSigs.filter((s) => !s.err);
  if (successful.length === 0) return [];

  // Sort oldest first (the create is in the early txs, but we'll still
  // walk everything because we don't want to miss anything).
  successful.sort((a, b) => (a.blockTime ?? 0) - (b.blockTime ?? 0));

  const detected = new Map<string, DetectedLaunch>();
  for (let i = 0; i < successful.length; i += TX_BATCH) {
    const slice = successful.slice(i, i + TX_BATCH);
    let txs;
    try {
      txs = await conn.getParsedTransactions(
        slice.map((s) => s.signature),
        { maxSupportedTransactionVersion: 0 },
      );
    } catch {
      continue;
    }
    for (let j = 0; j < txs.length; j++) {
      const tx = txs[j];
      if (!tx || tx.meta?.err) continue;
      const creates = extractPumpFunCreates(tx, wallet);
      for (const c of creates) {
        if (!detected.has(c.mint)) {
          detected.set(c.mint, {
            agent: wallet,
            agentName: name,
            mint: c.mint,
            pattern: c.pattern,
            launchSig: slice[j].signature,
            blockTime: slice[j].blockTime ?? 0,
          });
        }
      }
    }
    if (i + TX_BATCH < successful.length) await sleep(INTER_BATCH_DELAY_MS);
  }
  return Array.from(detected.values());
}

async function enrich(launch: DetectedLaunch): Promise<DetectedLaunch> {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${launch.mint}`);
    if (!res.ok) return launch;
    const data = (await res.json()) as { pairs?: Array<any> };
    const pairs = data.pairs ?? [];
    if (pairs.length === 0) return launch;
    const top = pairs.reduce<any>((best, p) => {
      const liq = p.liquidity?.usd ?? 0;
      const bestLiq = best?.liquidity?.usd ?? -1;
      return liq > bestLiq ? p : best;
    }, null);
    return {
      ...launch,
      marketCapUsd: top?.marketCap ?? top?.fdv ?? 0,
      volume24hUsd: top?.volume?.h24 ?? 0,
      liquidityUsd: top?.liquidity?.usd ?? 0,
      dexId: top?.dexId,
    };
  } catch {
    return launch;
  }
}

async function getAgentBase(wallet: string) {
  try {
    const res = await fetch(`${SAID_API}/api/agents/${wallet}`);
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

async function resolveNamed(name: string): Promise<{ wallet: string; name: string } | null> {
  try {
    const res = await fetch(`${SAID_API}/api/agents?search=${encodeURIComponent(name)}&verified=true`);
    const data = await res.json();
    const hit = (data.agents || []).find((a: any) => a.name === name);
    if (!hit) return null;
    return { wallet: hit.wallet, name: hit.name };
  } catch {
    return null;
  }
}

async function run() {
  console.log('Fetching SAID directory + named targets...');
  const listRes = await fetch(`${SAID_API}/api/agents?limit=80&verified=true`);
  const listData = await listRes.json();
  const sample: Map<string, string> = new Map(
    (listData.agents || []).slice(0, SAMPLE_SIZE).map((a: any) => [a.wallet, a.name || a.wallet.slice(0, 8)]),
  );
  const targets = ['squire_bot', 'NemoClaw', 'Dishxnet', 'Test', 'Daberle', 'Xona Agent', 'MEME Factory', 'Atelier', 'TrollXBT'];
  for (const n of targets) {
    const r = await resolveNamed(n);
    if (r) sample.set(r.wallet, r.name);
  }
  console.log(`Scanning ${sample.size} agents (full-history pagination)...\n`);

  const allLaunches: DetectedLaunch[] = [];
  let i = 0;
  for (const [wallet, name] of sample) {
    i++;
    const t0 = Date.now();
    const launches = await detectAllLaunches(wallet, name);
    const dur = ((Date.now() - t0) / 1000).toFixed(1);
    if (launches.length > 0) {
      for (let k = 0; k < launches.length; k++) {
        launches[k] = await enrich(launches[k]);
        await sleep(150);
      }
      allLaunches.push(...launches);
      const top = launches[0];
      const mcStr = top.marketCapUsd != null && top.marketCapUsd > 0
        ? `$${Math.round(top.marketCapUsd).toLocaleString()}`
        : '—';
      console.log(`  [${i}/${sample.size}] ✓ ${name.padEnd(28)} ${launches.length} mint(s) top=${top.mint.slice(0, 8)}… ${mcStr} (${top.pattern}, ${dur}s)`);
    } else {
      console.log(`  [${i}/${sample.size}] · ${name.padEnd(28)} no launches (${dur}s)`);
    }
    await sleep(50);
  }

  // Aggregate by agent
  console.log('\n=== DETECTION SUMMARY ===');
  console.log(`Agents scanned: ${sample.size}`);
  console.log(`Launches detected: ${allLaunches.length}`);
  const byPattern = { A_signer: 0, B_recipient: 0 };
  for (const l of allLaunches) byPattern[l.pattern]++;
  console.log(`  Pattern A (agent signed):    ${byPattern.A_signer}`);
  console.log(`  Pattern B (agent recipient): ${byPattern.B_recipient}`);
  const enriched = allLaunches.filter((l) => l.marketCapUsd && l.marketCapUsd > 0);
  console.log(`Enriched (have real cap data): ${enriched.length}`);
  if (enriched.length > 0) {
    enriched.sort((a, b) => (b.marketCapUsd ?? 0) - (a.marketCapUsd ?? 0));
    console.log('\nTop 10 by market cap:');
    for (let k = 0; k < Math.min(10, enriched.length); k++) {
      const e = enriched[k];
      console.log(
        `  $${Math.round(e.marketCapUsd!).toLocaleString().padStart(14)}  ${e.agentName.padEnd(24)}  ${e.mint.slice(0, 8)}…  dex=${e.dexId ?? '—'}`,
      );
    }
  }

  // Recompute v0.7
  const launchesByAgent = new Map<string, DetectedLaunch[]>();
  for (const l of allLaunches) {
    if (!launchesByAgent.has(l.agent)) launchesByAgent.set(l.agent, []);
    launchesByAgent.get(l.agent)!.push(l);
  }

  console.log('\n=== RECOMPUTING v0.7 WITH BACKFILLED DATA ===\n');
  const recomputed: Array<{
    name: string;
    wallet: string;
    v6: number;
    v7Before: V7ScoreResult;
    v7After: V7ScoreResult;
    topCap: number;
  }> = [];
  for (const [wallet, name] of sample) {
    const base = await getAgentBase(wallet);
    if (!base) continue;
    const launches = launchesByAgent.get(wallet) ?? [];
    const validLaunches = launches.filter((l) => (l.marketCapUsd ?? 0) > 0);
    const fsSub = base.fairscale && base.fairscale.max > 0
      ? Math.max(0, Math.min(10, (base.fairscale.score / base.fairscale.max) * 10))
      : 0;
    const before = computeTrustScoreV7(base, base.anchorStats, base.activityStats, base.launchedTokens, fsSub);
    let after = before;
    let topCap = 0;
    if (validLaunches.length > 0) {
      const tokenCount = validLaunches.length;
      const totalMcap = validLaunches.reduce((s, l) => s + (l.marketCapUsd ?? 0), 0);
      const totalVol = validLaunches.reduce((s, l) => s + (l.volume24hUsd ?? 0), 0);
      topCap = Math.max(...validLaunches.map((l) => l.marketCapUsd ?? 0));
      after = computeTrustScoreV7(
        base,
        base.anchorStats,
        base.activityStats,
        { tokenCount, totalMarketCapUsd: totalMcap, totalVolume24hUsd: totalVol, topMarketCapUsd: topCap },
        fsSub,
      );
    }
    recomputed.push({ name, wallet, v6: base.trustScore?.score ?? 0, v7Before: before, v7After: after, topCap });
  }

  recomputed.sort((a, b) => b.v7After.score - a.v7After.score);
  console.log('TOP 20 AFTER BACKFILL:');
  console.log('rank | name                       | v0.6 | before | after | tier   | trust | tract | delivery     | top cap');
  console.log('-'.repeat(140));
  for (let k = 0; k < Math.min(20, recomputed.length); k++) {
    const x = recomputed[k];
    const cap = x.topCap > 0 ? `$${Math.round(x.topCap).toLocaleString()}` : '—';
    const delivery = x.v7After.demonstrated_delivery.path
      ? `${x.v7After.demonstrated_delivery.path}/${x.v7After.demonstrated_delivery.contribution}`
      : '—';
    console.log(
      `${String(k + 1).padStart(4)} | ${x.name.slice(0, 26).padEnd(26)} | ${String(x.v6).padStart(4)} | ${String(x.v7Before.score).padStart(6)} | ${String(x.v7After.score).padStart(5)} | ${x.v7After.tier.padEnd(6)} | ${String(x.v7After.trust).padStart(5)} | ${String(x.v7After.traction).padStart(5)} | ${delivery.padEnd(12)} | ${cap}`,
    );
  }

  console.log('\nLITMUS:');
  for (const n of targets) {
    const hit = recomputed.find((r) => r.name === n);
    if (!hit) { console.log(`  ${n}: NOT FOUND`); continue; }
    const cap = hit.topCap > 0 ? `$${Math.round(hit.topCap).toLocaleString()}` : '—';
    console.log(
      `  ${n.padEnd(18)} v0.6=${hit.v6.toString().padStart(3)} → before=${hit.v7Before.score.toString().padStart(3)} ${hit.v7Before.tier.padEnd(7)} → after=${hit.v7After.score.toString().padStart(3)} ${hit.v7After.tier.padEnd(7)} delivery=${hit.v7After.demonstrated_delivery.path ?? '—'} cap=${cap}`,
    );
  }

  const dist: Record<string, number> = { unranked: 0, bronze: 0, silver: 0, gold: 0, platinum: 0 };
  for (const r of recomputed) dist[r.v7After.tier]++;
  console.log('\nTIER DISTRIBUTION (after):');
  for (const tier of ['platinum', 'gold', 'silver', 'bronze', 'unranked']) {
    console.log(`  ${tier.padEnd(10)} ${String(dist[tier]).padStart(4)}  (${((dist[tier] / recomputed.length) * 100).toFixed(0)}%)`);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});

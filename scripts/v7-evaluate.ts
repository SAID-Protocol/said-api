/**
 * v0.7 evaluation against a properly-sampled slice of the corpus.
 *
 * Earlier smoke tests sampled the directory's top-N by reputationScore.
 * That biases the sample toward identity-baseline agents and excludes the
 * exact population v0.7 was designed to surface — token launchers whose
 * v0.6 reputation is low because feedback is sparse. This script fixes
 * that by spreading the sample across the corpus via offset paging plus
 * an explicit litmus list of named agents.
 *
 * Outputs:
 *   - Tier distribution across the sample
 *   - Top 30 by v0.7 score with key signals
 *   - Named litmus agents (v0.6 → v0.7 deltas)
 *   - Top 15 by detected token cap
 *   - Sanity checks (ceiling-firing, demonstrated-delivery counts)
 *   - data/v7-backfill.json — every detected (wallet, mint, cap) tuple,
 *     ready to upsert into LaunchedToken when the production backfill
 *     endpoint runs
 *
 * Run from said-api root:  npx tsx scripts/v7-evaluate.ts
 */
import { writeFileSync, mkdirSync } from 'fs';
import { Connection, PublicKey, ParsedInstruction } from '@solana/web3.js';
import {
  computeTrustScoreV7,
  type V7ScoreResult,
} from '../src/reputation-engine-v7.js';

const SAID_API = 'https://api.saidprotocol.com';
const ALCHEMY = process.env.ALCHEMY_SOLANA_RPC_URL
  || process.env.SOLANA_RPC_URL
  || 'https://api.mainnet-beta.solana.com';
if (!process.env.ALCHEMY_SOLANA_RPC_URL && !process.env.SOLANA_RPC_URL) {
  console.warn('⚠️  No ALCHEMY_SOLANA_RPC_URL set — using public Solana RPC. Expect 429s.');
}
const PUMP_PROG = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const WSOL = 'So11111111111111111111111111111111111111112';

// Sampling: spread 50 agents across each of these offsets via the directory API,
// which gives us roughly-uniform coverage of the corpus by v0.6 reputation tier.
const OFFSETS = [0, 500, 1000, 1500, 2000, 3000];
const PER_OFFSET = 50;
const CONCURRENCY = 4;
const SIG_PAGE_SIZE = 1000;
const MAX_SIG_PAGES = 10;
const TX_BATCH = 25;

// Named litmus agents — explicitly included so we always evaluate against
// these regardless of the random slice.
const LITMUS_NAMES = [
  'squire_bot', 'NemoClaw', 'Atelier', 'Dishxnet', 'Test',
  'Daberle', 'Xona Agent', 'MEME Factory', 'TrollXBT', 'Trollguy',
  'ClawdPoly', 'JumpBot', 'OpenAI', 'Kibi.bot', 'A167',
];

const conn = new Connection(ALCHEMY, 'confirmed');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface DetectedLaunch {
  agentWallet: string;
  agentName: string;
  mint: string;
  launchSig: string;
  blockTime: number;
  marketCapUsd?: number;
  volume24hUsd?: number;
  liquidityUsd?: number;
  dexId?: string;
}

function extractPumpFunCreates(tx: any, wallet: string): { mint: string; isSigner: boolean }[] {
  const topProgs = tx.transaction.message.instructions.map((ix: any) => ix.programId?.toString?.() ?? '');
  const innerProgs = (tx.meta?.innerInstructions ?? []).flatMap((g: any) =>
    g.instructions.map((ix: any) => ix.programId?.toString?.() ?? ''));
  if (!topProgs.includes(PUMP_PROG) && !innerProgs.includes(PUMP_PROG)) return [];
  const mints: string[] = [];
  for (const g of tx.meta?.innerInstructions ?? []) {
    for (const ix of g.instructions) {
      const p = (ix as ParsedInstruction).parsed;
      if (p && typeof p === 'object' && (p.type === 'initializeMint' || p.type === 'initializeMint2')) {
        const info = p.info as { mint?: string };
        if (info.mint && info.mint !== WSOL) mints.push(info.mint);
      }
    }
  }
  if (mints.length === 0) return [];
  const signers = tx.transaction.message.accountKeys
    .filter((k: any) => k.signer)
    .map((k: any) => k.pubkey?.toString?.() ?? '');
  const isSigner = signers.includes(wallet);
  return mints.map((m) => ({ mint: m, isSigner }));
}

async function detectForWallet(wallet: string, name: string): Promise<DetectedLaunch[]> {
  let pubkey: PublicKey;
  try { pubkey = new PublicKey(wallet); } catch { return []; }
  let allSigs: any[] = [];
  let before: string | undefined;
  for (let page = 0; page < MAX_SIG_PAGES; page++) {
    let batch;
    try { batch = await conn.getSignaturesForAddress(pubkey, { limit: SIG_PAGE_SIZE, ...(before ? { before } : {}) }); }
    catch { break; }
    if (!batch.length) break;
    allSigs.push(...batch);
    before = batch[batch.length - 1].signature;
    if (batch.length < SIG_PAGE_SIZE) break;
  }
  const ok = allSigs.filter((s) => !s.err).sort((a, b) => (a.blockTime ?? 0) - (b.blockTime ?? 0));
  const found = new Map<string, DetectedLaunch>();
  for (let i = 0; i < ok.length; i += TX_BATCH) {
    const slice = ok.slice(i, i + TX_BATCH);
    let txs;
    try { txs = await conn.getParsedTransactions(slice.map((s) => s.signature), { maxSupportedTransactionVersion: 0 }); }
    catch { continue; }
    for (let j = 0; j < txs.length; j++) {
      const tx = txs[j];
      if (!tx || tx.meta?.err) continue;
      const creates = extractPumpFunCreates(tx, wallet);
      for (const c of creates) {
        if (!found.has(c.mint)) {
          found.set(c.mint, {
            agentWallet: wallet, agentName: name, mint: c.mint,
            launchSig: slice[j].signature,
            blockTime: slice[j].blockTime ?? 0,
          });
        }
      }
    }
    if (i + TX_BATCH < ok.length) await sleep(60);
  }
  return Array.from(found.values());
}

async function enrich(l: DetectedLaunch): Promise<DetectedLaunch> {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${l.mint}`);
    if (!res.ok) return l;
    const d = (await res.json()) as any;
    const pairs = d.pairs ?? [];
    if (!pairs.length) return l;
    const top = pairs.reduce((b: any, p: any) =>
      (p.liquidity?.usd ?? 0) > (b?.liquidity?.usd ?? -1) ? p : b, null);
    return {
      ...l,
      marketCapUsd: top?.marketCap ?? top?.fdv ?? 0,
      volume24hUsd: top?.volume?.h24 ?? 0,
      liquidityUsd: top?.liquidity?.usd ?? 0,
      dexId: top?.dexId,
    };
  } catch { return l; }
}

async function getBase(wallet: string): Promise<any | null> {
  // Retry once on failure for resilience to transient API hiccups.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(`${SAID_API}/api/agents/${wallet}`);
      if (r.ok) return await r.json();
      if (r.status === 404) return null;
      await sleep(500);
    } catch { await sleep(500); }
  }
  return null;
}

async function fetchOffset(offset: number, limit: number): Promise<Array<{ wallet: string; name: string }>> {
  try {
    const r = await fetch(`${SAID_API}/api/agents?limit=${limit}&offset=${offset}&verified=true`);
    if (!r.ok) return [];
    const d = await r.json();
    return (d.agents || []).map((a: any) => ({ wallet: a.wallet, name: a.name || a.wallet.slice(0, 8) }));
  } catch { return []; }
}

async function resolveNamed(name: string): Promise<{ wallet: string; name: string } | null> {
  try {
    const r = await fetch(`${SAID_API}/api/agents?search=${encodeURIComponent(name)}&verified=true`);
    const d = await r.json();
    const hit = (d.agents || []).find((a: any) => a.name === name);
    return hit ? { wallet: hit.wallet, name: hit.name } : null;
  } catch { return null; }
}

async function withConcurrency<T, R>(items: T[], conc: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: conc }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx]);
    }
  }));
  return out;
}

async function run() {
  console.log('Building diverse sample across the corpus...');
  const sample = new Map<string, string>();
  for (const offset of OFFSETS) {
    const slice = await fetchOffset(offset, PER_OFFSET);
    for (const a of slice) sample.set(a.wallet, a.name);
    console.log(`  offset=${offset.toString().padStart(5)}: +${slice.length} agents (total unique: ${sample.size})`);
  }
  console.log('\nResolving named litmus targets...');
  for (const name of LITMUS_NAMES) {
    const r = await resolveNamed(name);
    if (r) { sample.set(r.wallet, r.name); console.log(`  ✓ ${name}`); }
    else console.log(`  ✗ ${name} (not found)`);
  }
  console.log(`\nTotal sample: ${sample.size} agents\n`);

  // Phase 1: detect launches across all samples (concurrent)
  console.log(`Phase 1: detecting launches (concurrency=${CONCURRENCY})...`);
  const items = Array.from(sample, ([wallet, name]) => ({ wallet, name }));
  const t0 = Date.now();
  let done = 0;
  const allLaunches: DetectedLaunch[] = [];
  await withConcurrency(items, CONCURRENCY, async ({ wallet, name }) => {
    const launches = await detectForWallet(wallet, name);
    if (launches.length > 0) allLaunches.push(...launches);
    done++;
    if (done % 25 === 0 || done === items.length) {
      const dur = ((Date.now() - t0) / 1000).toFixed(0);
      console.log(`  ${done}/${items.length} scanned (${dur}s, ${allLaunches.length} mints found)`);
    }
  });

  // Phase 2: enrich detected mints via Dexscreener (lower concurrency to be polite)
  console.log(`\nPhase 2: enriching ${allLaunches.length} mints via Dexscreener...`);
  let enrichedDone = 0;
  await withConcurrency(allLaunches, 2, async (l) => {
    const enriched = await enrich(l);
    Object.assign(l, enriched);
    enrichedDone++;
    if (enrichedDone % 25 === 0 || enrichedDone === allLaunches.length) {
      console.log(`  ${enrichedDone}/${allLaunches.length} enriched`);
    }
    await sleep(80);
  });

  const enrichedLaunches = allLaunches.filter((l) => (l.marketCapUsd ?? 0) > 0);
  console.log(`  ${enrichedLaunches.length} mints have cap data`);

  // Persist backfill JSON
  mkdirSync('/Users/callum/said-api/data', { recursive: true });
  writeFileSync(
    '/Users/callum/said-api/data/v7-backfill.json',
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      sampleSize: sample.size,
      launches: allLaunches.map((l) => ({
        agentWallet: l.agentWallet,
        agentName: l.agentName,
        mint: l.mint,
        launchSig: l.launchSig,
        blockTime: l.blockTime,
        marketCapUsd: l.marketCapUsd,
        volume24hUsd: l.volume24hUsd,
        liquidityUsd: l.liquidityUsd,
        dexId: l.dexId,
      })),
    }, null, 2),
  );
  console.log('  → wrote /Users/callum/said-api/data/v7-backfill.json');

  // Phase 3: recompute v0.7 scores using backfilled launch data
  console.log(`\nPhase 3: recomputing v0.7 scores...`);
  const launchesByAgent = new Map<string, DetectedLaunch[]>();
  for (const l of allLaunches) {
    if (!launchesByAgent.has(l.agentWallet)) launchesByAgent.set(l.agentWallet, []);
    launchesByAgent.get(l.agentWallet)!.push(l);
  }

  const scores: Array<{
    name: string; wallet: string; v6: number; v7: V7ScoreResult; topCap: number; nLaunches: number;
  }> = [];
  let scoreDone = 0;
  await withConcurrency(items, CONCURRENCY, async ({ wallet, name }) => {
    const base = await getBase(wallet);
    scoreDone++;
    if (scoreDone % 50 === 0) console.log(`  ${scoreDone}/${items.length} scored`);
    if (!base) return;
    const launches = (launchesByAgent.get(wallet) ?? []).filter((l) => (l.marketCapUsd ?? 0) > 0);
    let launchedStats;
    let topCap = 0;
    if (launches.length > 0) {
      topCap = Math.max(...launches.map((l) => l.marketCapUsd ?? 0));
      launchedStats = {
        tokenCount: launches.length,
        totalMarketCapUsd: launches.reduce((s, l) => s + (l.marketCapUsd ?? 0), 0),
        totalVolume24hUsd: launches.reduce((s, l) => s + (l.volume24hUsd ?? 0), 0),
        topMarketCapUsd: topCap,
      };
    }
    const fsSub = base.fairscale && base.fairscale.max > 0
      ? Math.max(0, Math.min(10, (base.fairscale.score / base.fairscale.max) * 10)) : 0;
    const v7 = computeTrustScoreV7(base, base.anchorStats, base.activityStats, launchedStats ?? base.launchedTokens, fsSub);
    scores.push({ name, wallet, v6: base.trustScore?.score ?? 0, v7, topCap, nLaunches: launches.length });
  });

  scores.sort((a, b) => b.v7.score - a.v7.score);

  console.log(`\n${'='.repeat(80)}\nRESULTS: ${scores.length} agents scored\n${'='.repeat(80)}`);

  // Tier distribution
  const dist: Record<string, number> = { unranked: 0, bronze: 0, silver: 0, gold: 0, platinum: 0 };
  for (const s of scores) dist[s.v7.tier]++;
  console.log('\n=== TIER DISTRIBUTION ===');
  for (const t of ['platinum', 'gold', 'silver', 'bronze', 'unranked']) {
    const bar = '█'.repeat(Math.round((dist[t] / scores.length) * 50));
    console.log(`  ${t.padEnd(10)} ${String(dist[t]).padStart(4)} (${((dist[t] / scores.length) * 100).toFixed(1).padStart(5)}%)  ${bar}`);
  }

  // Top 30
  console.log('\n=== TOP 30 BY v0.7 ===');
  console.log('rank | name                       | v0.6 → v0.7  | tier   | trust | tract | delivery     | top cap');
  console.log('-'.repeat(132));
  for (let k = 0; k < Math.min(30, scores.length); k++) {
    const x = scores[k];
    const delivery = x.v7.demonstrated_delivery.path
      ? `${x.v7.demonstrated_delivery.path}/${x.v7.demonstrated_delivery.contribution}`
      : '—';
    const cap = x.topCap > 0 ? `$${Math.round(x.topCap).toLocaleString()}` : '—';
    console.log(`${String(k + 1).padStart(4)} | ${x.name.slice(0, 26).padEnd(26)} | ${String(x.v6).padStart(3)} → ${String(x.v7.score).padStart(3)}     | ${x.v7.tier.padEnd(6)} | ${String(x.v7.trust).padStart(5)} | ${String(x.v7.traction).padStart(5)} | ${delivery.padEnd(12)} | ${cap}`);
  }

  // Named litmus
  console.log('\n=== NAMED LITMUS AGENTS ===');
  for (const n of LITMUS_NAMES) {
    const hit = scores.find((s) => s.name === n);
    if (!hit) { console.log(`  ${n.padEnd(20)} NOT IN SCORED SAMPLE`); continue; }
    const delivery = hit.v7.demonstrated_delivery.path
      ? `${hit.v7.demonstrated_delivery.path}/${hit.v7.demonstrated_delivery.contribution}`
      : '—';
    const cap = hit.topCap > 0 ? `$${Math.round(hit.topCap).toLocaleString()}` : '—';
    console.log(`  ${n.padEnd(20)} v0.6=${hit.v6.toString().padStart(3)} → v0.7=${hit.v7.score.toString().padStart(3)} ${hit.v7.tier.padEnd(7)}  delivery=${delivery.padEnd(12)} cap=${cap}`);
  }

  // Top by detected cap
  console.log('\n=== TOP 15 BY DETECTED TOKEN CAP ===');
  const byCap = scores.filter((s) => s.topCap > 0).sort((a, b) => b.topCap - a.topCap).slice(0, 15);
  for (const s of byCap) {
    const delivery = s.v7.demonstrated_delivery.active ? '✓' : '·';
    console.log(`  $${Math.round(s.topCap).toLocaleString().padStart(14)}  ${s.name.padEnd(28)}  v0.7=${s.v7.score} ${s.v7.tier.padEnd(7)} ${delivery} delivery`);
  }

  // Sanity
  console.log('\n=== SANITY CHECKS ===');
  const unverifiedAtGold = scores.filter((s) => !s.v7.badges.includes('verified') && s.v7.score >= 65);
  console.log(`  Unverified reaching Gold+:    ${unverifiedAtGold.length} (expect 0 — ceiling caps unverified at Silver 64)`);
  const noDeliveryAtPlatinum = scores.filter((s) => !s.v7.demonstrated_delivery.active && s.v7.score >= 80);
  console.log(`  No-delivery at Platinum:      ${noDeliveryAtPlatinum.length} (expect 0 — ceiling caps no-delivery at Gold 79)`);
  const deliveryActive = scores.filter((s) => s.v7.demonstrated_delivery.active);
  console.log(`  With demonstrated_delivery:   ${deliveryActive.length} of ${scores.length} (${((deliveryActive.length / scores.length) * 100).toFixed(1)}%)`);
  console.log(`  With detected launches:       ${scores.filter((s) => s.nLaunches > 0).length} of ${scores.length}`);

  const summary = {
    runAt: new Date().toISOString(),
    sampleSize: sample.size,
    scoredCount: scores.length,
    tierDistribution: dist,
    metrics: {
      withDetectedLaunches: scores.filter((s) => s.nLaunches > 0).length,
      withDemonstratedDelivery: deliveryActive.length,
      unverifiedReachingGold: unverifiedAtGold.length,
      noDeliveryAtPlatinum: noDeliveryAtPlatinum.length,
    },
  };
  writeFileSync(
    '/Users/callum/said-api/data/v7-evaluation-summary.json',
    JSON.stringify(summary, null, 2),
  );
  console.log(`\n→ wrote /Users/callum/said-api/data/v7-evaluation-summary.json`);
}

run().catch((e) => { console.error(e); process.exit(1); });

/**
 * SAID worker — the reference client for the work loop.
 *
 * Runs on the agent operator's own machine, with their own Solana RPC. It
 * takes wallet jobs from the SAID API, computes them with the same code the
 * server checks against (src/work/kinds.ts), and submits the answer.
 *
 * Shipped to agents as one bundled file (scripts/build-worker.mjs), served by
 * the API at /work/said-worker.cjs. From this repo, run it with
 * `npx tsx worker/said-worker.ts <command>`.
 *
 *   init --wallet-secret-env <VAR>   wallet secret key read from an env var
 *   init --wallet-keypair <path>     wallet secret key read from a keypair file
 *       Create a worker key and bind it to your verified agent's slot. The
 *       wallet key signs one message locally and is never stored or sent.
 *
 *   init --wallet <address>
 *       For wallets this machine cannot sign with: prints the message to
 *       sign elsewhere, then finish with
 *       `init --wallet <address> --timestamp <ms> --signature <base58>`.
 *
 *   start    run in the background (log and pid file in the worker home)
 *   stop     stop the background worker
 *   run      run in the foreground until stopped (`--once` for a single job)
 *   status   slot, record, announcements, and whether the worker is running
 *
 * Env:
 *   SAID_API_URL     default https://api.saidprotocol.com
 *   SOLANA_RPC_URL   your RPC. The public endpoint is rate limited; use your own.
 *   SAID_WORKER_HOME where the worker key lives. Default ~/.said-worker
 */

import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { openSync } from 'fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { jobClaimMessage, signMessage, slotClaimMessage, submitMessage } from '../src/work/auth.js';
import { jobKind } from '../src/work/kinds.js';

const VERSION = '0.3.0';
const API = (process.env.SAID_API_URL || 'https://api.saidprotocol.com').replace(/\/+$/, '');
const RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const HOME = process.env.SAID_WORKER_HOME || join(homedir(), '.said-worker');
const KEY_FILE = join(HOME, 'worker-key.json');
const CONFIG_FILE = join(HOME, 'config.json');
const PID_FILE = join(HOME, 'worker.pid');
const LOG_FILE = join(HOME, 'worker.log');

const IDLE_MS = 30_000;
const BETWEEN_JOBS_MS = 1_000;
const ERROR_BACKOFF_MS = 15_000;
const NOTICE_INTERVAL_MS = 60 * 60 * 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function getJson(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(30_000) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** A Solana secret key as either a JSON byte array (solana-keygen) or base58. */
function parseSecret(raw: string): Keypair {
  const text = raw.trim();
  const bytes = text.startsWith('[') ? Uint8Array.from(JSON.parse(text)) : bs58.decode(text);
  return Keypair.fromSecretKey(bytes);
}

async function loadWorkerKey(): Promise<Keypair | null> {
  try {
    return parseSecret(await readFile(KEY_FILE, 'utf8'));
  } catch {
    return null;
  }
}

async function loadOrCreateWorkerKey(): Promise<Keypair> {
  const existing = await loadWorkerKey();
  if (existing) return existing;
  const kp = Keypair.generate();
  await mkdir(HOME, { recursive: true });
  await writeFile(KEY_FILE, JSON.stringify(Array.from(kp.secretKey)));
  await chmod(KEY_FILE, 0o600);
  log(`created worker key ${kp.publicKey.toBase58()} at ${KEY_FILE}`);
  return kp;
}

async function loadConfig(): Promise<{ wallet?: string; lastUpdateId?: string }> {
  try {
    return JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * What the operator should know: whether this file is older than the one the
 * API serves, and any announcement not yet shown. The worker never updates
 * itself; it says so and leaves the download to the operator.
 */
async function notices(markSeen: boolean): Promise<string[]> {
  const out: string[] = [];
  try {
    const protocol = (await getJson('/api/work/protocol')).body;
    const self = process.argv[1] ?? '';
    if (protocol.worker?.sha256 && self.endsWith('.cjs')) {
      const mine = createHash('sha256').update(await readFile(self)).digest('hex');
      if (mine !== protocol.worker.sha256) out.push(`a newer worker is available: download ${protocol.worker.url} again and restart`);
    }
    const updates = (await getJson('/api/work/updates?limit=5')).body.updates ?? [];
    const config = await loadConfig();
    const seenAt = updates.findIndex((u: { id: string }) => u.id === config.lastUpdateId);
    const fresh = (seenAt < 0 ? updates : updates.slice(0, seenAt)).reverse();
    for (const u of fresh) out.push(`announcement: ${u.title}. ${u.body}`);
    if (markSeen && updates.length && updates[0].id !== config.lastUpdateId) {
      await writeFile(CONFIG_FILE, JSON.stringify({ ...config, lastUpdateId: updates[0].id }, null, 2));
    }
  } catch {
    // Notices are a courtesy; never let them stop the worker.
  }
  return out;
}

/** The pid of a live background or foreground worker for this home, if any. */
async function runningPid(): Promise<number | null> {
  try {
    const pid = Number(await readFile(PID_FILE, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) return null;
    process.kill(pid, 0); // throws when no such process
    return pid;
  } catch {
    return null;
  }
}

async function init(): Promise<void> {
  const worker = await loadOrCreateWorkerKey();
  const workerKey = worker.publicKey.toBase58();
  const keypairPath = arg('wallet-keypair');
  const secretEnv = arg('wallet-secret-env');

  let wallet: string;
  let timestamp: number;
  let signature: string;
  if (keypairPath || secretEnv) {
    let raw: string | undefined;
    if (secretEnv) raw = process.env[secretEnv];
    else raw = await readFile(keypairPath as string, 'utf8');
    if (!raw) throw new Error(`env var ${secretEnv} is empty`);
    const agent = parseSecret(raw);
    wallet = agent.publicKey.toBase58();
    timestamp = Date.now();
    signature = signMessage(slotClaimMessage(wallet, workerKey, timestamp), agent.secretKey);
  } else {
    const given = arg('wallet');
    if (!given) throw new Error('init needs --wallet-secret-env <VAR>, --wallet-keypair <path> or --wallet <address>');
    wallet = given;
    const sig = arg('signature');
    const ts = Number(arg('timestamp'));
    if (!sig || !Number.isFinite(ts)) {
      const now = Date.now();
      console.log('\nSign this exact message with your agent wallet (valid for 5 minutes):\n');
      console.log(`  ${slotClaimMessage(wallet, workerKey, now)}\n`);
      console.log('Then run:\n');
      console.log(`  init --wallet ${wallet} --timestamp ${now} --signature <base58 signature>\n`);
      return;
    }
    timestamp = ts;
    signature = sig;
  }

  const res = await post('/api/work/slots/claim', { wallet, workerKey, timestamp, signature });
  if (res.status !== 200 && res.status !== 201) throw new Error(`slot claim refused (${res.status}): ${res.body.error ?? 'unknown error'}`);
  await writeFile(CONFIG_FILE, JSON.stringify({ wallet }, null, 2));
  log(`${res.body.created ? 'slot claimed' : 'slot re-bound'} for ${wallet}; worker key ${workerKey}`);
}

async function status(): Promise<void> {
  const worker = await loadWorkerKey();
  const { wallet } = await loadConfig();
  const pid = await runningPid();
  console.log(`version:    ${VERSION}`);
  console.log(`api:        ${API}`);
  console.log(`rpc:        ${new URL(RPC).host}`);
  console.log(`worker key: ${worker ? worker.publicKey.toBase58() : `none (run init) — looked in ${KEY_FILE}`}`);
  console.log(`wallet:     ${wallet ?? 'none (run init)'}`);
  console.log(`running:    ${pid ? `yes (pid ${pid})` : 'no'}`);
  if (wallet) {
    const slot = await getJson(`/api/work/slots/${wallet}`);
    if (slot.status === 200) {
      console.log(`worker:     #${slot.body.number}`);
      console.log(`record:     ${slot.body.accepted} accepted, ${slot.body.disagreed} disagreed, ${slot.body.wrong} wrong`);
      console.log(`paid:       ${(Number(slot.body.paidLamports) / 1e9).toFixed(6)} SOL`);
      if (slot.body.workerKey !== worker?.publicKey.toBase58()) console.log('warning:    the slot is bound to a different worker key; run init again');
    } else {
      console.log('record:     no slot for this wallet');
    }
  }
  if (wallet) {
    const st = await getJson(`/api/work/workers/${wallet}/standing`);
    if (st.status === 200) {
      const b: string[] = st.body.blocked ?? [];
      console.log(`getting work: ${b.length ? `no (${b.join(', ')})` : `yes (${st.body.queue.eligibleForYou} jobs open to you)`}`);
      if (st.body.pay) console.log(`pay rate:   ${st.body.pay.ratePct}% of base (reputation tier: ${st.body.pay.tier})`);
      if (st.body.standing.paused) console.log(`paused until: ${st.body.standing.pausedUntil}`);
      for (const f of (st.body.standing.recentFailures ?? []).slice(0, 3)) console.log(`failed:     ${f.at} ${f.reason} (job ${f.jobId})`);
    }
  }
  const stats = (await getJson('/api/work/stats')).body;
  console.log(`network:    ${stats.slots.claimed}/${stats.slots.cap} slots, ${stats.workersOnline} online, ${stats.jobs.open} jobs open`);
  for (const n of await notices(false)) console.log(`notice:     ${n}`);
}

async function start(): Promise<void> {
  if (!(await loadWorkerKey())) throw new Error(`no worker key at ${KEY_FILE}; run init first`);
  const already = await runningPid();
  if (already) return log(`already running (pid ${already})`);
  await mkdir(HOME, { recursive: true });
  const out = openSync(LOG_FILE, 'a');
  // Same interpreter and flags as this process, so it works both as the
  // bundled file under node and as TypeScript under tsx.
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1], 'run'], {
    detached: true,
    stdio: ['ignore', out, out],
    env: process.env,
  });
  child.unref();
  log(`started in the background (pid ${child.pid}); log at ${LOG_FILE}`);
}

async function stop(): Promise<void> {
  const pid = await runningPid();
  if (!pid) return log('not running');
  process.kill(pid, 'SIGTERM');
  log(`stopped (pid ${pid})`);
}

async function run(): Promise<void> {
  const worker = await loadWorkerKey();
  if (!worker) throw new Error(`no worker key at ${KEY_FILE}; run init first`);
  const workerKey = worker.publicKey.toBase58();
  const conn = new Connection(RPC, 'finalized');
  const once = process.argv.includes('--once');

  if (!once) {
    const other = await runningPid();
    if (other && other !== process.pid) throw new Error(`a worker is already running for this home (pid ${other})`);
    await writeFile(PID_FILE, String(process.pid));
    const cleanup = () => {
      rm(PID_FILE, { force: true }).finally(() => process.exit(0));
    };
    process.on('SIGTERM', cleanup);
    process.on('SIGINT', cleanup);
  }
  log(`worker ${workerKey} v${VERSION} starting against ${API}`);
  let noticesAt = 0;

  for (;;) {
    try {
      if (!once && Date.now() - noticesAt > NOTICE_INTERVAL_MS) {
        noticesAt = Date.now();
        for (const n of await notices(true)) log(`notice: ${n}`);
      }
      const ts = Date.now();
      const claim = await post('/api/work/jobs/claim', {
        workerKey,
        timestamp: ts,
        signature: signMessage(jobClaimMessage(workerKey, ts), worker.secretKey),
      });
      if (claim.status === 401 || claim.status === 403) throw new Error(`not allowed to work: ${claim.body.error}`);
      if (claim.status === 503) {
        // Closed for now; check back slowly rather than hammering.
        log(`${claim.body.error ?? 'not open'}; checking again in 10 minutes`);
        if (once) return;
        await sleep(10 * 60 * 1000);
        continue;
      }
      if (claim.status !== 200) {
        log(`claim refused (${claim.status}): ${claim.body.error ?? ''}`);
        if (once) return;
        await sleep(ERROR_BACKOFF_MS);
        continue;
      }
      const a = claim.body.assignment;
      if (!a) {
        if (once) return log('no job available');
        await sleep((claim.body.retryAfterSeconds ?? 30) * 1000 || IDLE_MS);
        continue;
      }
      const kind = jobKind(a.kind);
      if (!kind || !kind.isValidSpec(a.spec)) {
        // A job kind this build does not know. Claiming again would only
        // pile up leases that expire against the record, so stop here.
        await rm(PID_FILE, { force: true });
        throw new Error(`job ${a.jobId} is of kind "${a.kind}", which this worker does not know: download the worker again and restart`);
      }

      const result = await kind.run(conn, a.spec);
      const resultHash = kind.hash(result);
      const sts = Date.now();
      const sub = await post(`/api/work/assignments/${a.id}/submit`, {
        workerKey,
        result,
        timestamp: sts,
        signature: signMessage(submitMessage(a.id, resultHash, sts), worker.secretKey),
      });
      if (sub.status !== 200) log(`submit refused (${sub.status}): ${sub.body.error ?? ''}`);
      else log(`job ${a.jobId} ${a.spec.wallet}: ${result.txCount} tx → ${sub.body.jobStatus}`);
      if (once) return;
      await sleep(BETWEEN_JOBS_MS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith('not allowed to work')) {
        await rm(PID_FILE, { force: true });
        throw err;
      }
      log(`error: ${msg}`);
      if (once) return;
      await sleep(ERROR_BACKOFF_MS);
    }
  }
}

const command = process.argv[2];
const commands: Record<string, () => Promise<void>> = { init, start, stop, run, status };
if (!command || !commands[command]) {
  console.error(`said-worker ${VERSION}\nusage: said-worker <init|start|stop|run|status>\n  init --wallet-secret-env <VAR> | --wallet-keypair <path> | --wallet <address>`);
  process.exit(2);
}
commands[command]().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

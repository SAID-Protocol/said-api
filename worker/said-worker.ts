/**
 * SAID worker — the reference client for the work loop.
 *
 * Runs on the agent operator's own machine, with their own Solana RPC. It
 * takes wallet-history jobs from the SAID API, computes them with the same
 * code the server checks against (src/work/wallet-history.ts), and submits
 * the answer.
 *
 *   npx tsx worker/said-worker.ts init --wallet-keypair <path>
 *       Create a worker key and bind it to your verified agent's slot. The
 *       wallet keypair signs one message locally and is never stored or sent.
 *
 *   npx tsx worker/said-worker.ts init --wallet <address>
 *       Same, without a keypair file: prints the message to sign in your
 *       wallet, then finish with
 *       `init --wallet <address> --timestamp <ms> --signature <base58>`.
 *
 *   npx tsx worker/said-worker.ts run
 *       Work until stopped.
 *
 *   npx tsx worker/said-worker.ts status
 *
 * Env:
 *   SAID_API_URL     default https://api.saidprotocol.com
 *   SOLANA_RPC_URL   your RPC. The public endpoint is rate limited; use your own.
 *   SAID_WORKER_HOME where the worker key lives. Default ~/.said-worker
 */

import { mkdir, readFile, writeFile, chmod } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { Connection, Keypair } from '@solana/web3.js';
import { jobClaimMessage, signMessage, slotClaimMessage, submitMessage } from '../src/work/auth.js';
import { WALLET_HISTORY_KIND, hashResult, isValidSpec, runWalletHistory } from '../src/work/wallet-history.js';

const API = (process.env.SAID_API_URL || 'https://api.saidprotocol.com').replace(/\/+$/, '');
const RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const HOME = process.env.SAID_WORKER_HOME || join(homedir(), '.said-worker');
const KEY_FILE = join(HOME, 'worker-key.json');

const IDLE_MS = 30_000;
const BETWEEN_JOBS_MS = 1_000;
const ERROR_BACKOFF_MS = 15_000;

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

async function loadWorkerKey(): Promise<Keypair | null> {
  try {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(KEY_FILE, 'utf8'))));
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

async function init(): Promise<void> {
  const worker = await loadOrCreateWorkerKey();
  const workerKey = worker.publicKey.toBase58();
  const keypairPath = arg('wallet-keypair');

  let wallet: string;
  let timestamp: number;
  let signature: string;
  if (keypairPath) {
    const agent = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(keypairPath, 'utf8'))));
    wallet = agent.publicKey.toBase58();
    timestamp = Date.now();
    signature = signMessage(slotClaimMessage(wallet, workerKey, timestamp), agent.secretKey);
  } else {
    const given = arg('wallet');
    if (!given) throw new Error('init needs --wallet-keypair <path> or --wallet <address>');
    wallet = given;
    const sig = arg('signature');
    const ts = Number(arg('timestamp'));
    if (!sig || !Number.isFinite(ts)) {
      const now = Date.now();
      console.log('\nSign this exact message with your agent wallet (valid for 5 minutes):\n');
      console.log(`  ${slotClaimMessage(wallet, workerKey, now)}\n`);
      console.log('Then run:\n');
      console.log(`  npx tsx worker/said-worker.ts init --wallet ${wallet} --timestamp ${now} --signature <base58 signature>\n`);
      return;
    }
    timestamp = ts;
    signature = sig;
  }

  const res = await post('/api/work/slots/claim', { wallet, workerKey, timestamp, signature });
  if (res.status !== 200 && res.status !== 201) throw new Error(`slot claim refused (${res.status}): ${res.body.error ?? 'unknown error'}`);
  log(`${res.body.created ? 'slot claimed' : 'slot re-bound'} for ${wallet}; worker key ${workerKey}`);
}

async function status(): Promise<void> {
  const worker = await loadWorkerKey();
  console.log(`api:        ${API}`);
  console.log(`rpc:        ${RPC.replace(/([?&/])[A-Za-z0-9_-]{20,}/g, '$1…')}`);
  console.log(`worker key: ${worker ? worker.publicKey.toBase58() : `none (run init) — looked in ${KEY_FILE}`}`);
  const stats = await fetch(`${API}/api/work/stats`).then((r) => r.json());
  console.log(`slots:      ${stats.slots.claimed}/${stats.slots.cap}, ${stats.workersOnline} online, ${stats.jobs.open} jobs open`);
}

async function run(): Promise<void> {
  const worker = await loadWorkerKey();
  if (!worker) throw new Error(`no worker key at ${KEY_FILE}; run init first`);
  const workerKey = worker.publicKey.toBase58();
  const conn = new Connection(RPC, 'finalized');
  const once = process.argv.includes('--once');
  log(`worker ${workerKey} starting against ${API}`);

  for (;;) {
    try {
      const ts = Date.now();
      const claim = await post('/api/work/jobs/claim', {
        workerKey,
        timestamp: ts,
        signature: signMessage(jobClaimMessage(workerKey, ts), worker.secretKey),
      });
      if (claim.status === 401 || claim.status === 403) throw new Error(`not allowed to work: ${claim.body.error}`);
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
      if (a.kind !== WALLET_HISTORY_KIND || !isValidSpec(a.spec)) {
        // A job kind this build does not know: let the lease expire.
        log(`skipping job ${a.jobId}: unknown kind ${a.kind}`);
        if (once) return;
        await sleep(BETWEEN_JOBS_MS);
        continue;
      }

      const result = await runWalletHistory(conn, a.spec);
      const resultHash = hashResult(result);
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
      if (msg.startsWith('not allowed to work')) throw err;
      log(`error: ${msg}`);
      if (once) return;
      await sleep(ERROR_BACKOFF_MS);
    }
  }
}

const command = process.argv[2];
const commands: Record<string, () => Promise<void>> = { init, run, status };
if (!command || !commands[command]) {
  console.error('usage: said-worker <init|run|status>   (see the header of this file)');
  process.exit(2);
}
commands[command]().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

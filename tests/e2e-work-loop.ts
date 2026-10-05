/**
 * Work loop — end to end against a locally booted server and a scratch
 * Postgres (see .claude/skills/verify). Seeds its own agents, then drives the
 * real HTTP routes with real signatures and real mainnet wallet history.
 *
 * Boot the server with:
 *   WORK_SLOT_CAP=5 WORK_JOB_BATCH=3 WORK_SPOT_CHECK_RATE=1 WORK_RECHECK_HOURS=0
 *
 * Run:
 *   DATABASE_URL=postgresql://…/said_verify_scratch API=http://localhost:3999 \
 *     npx tsx tests/e2e-work-loop.ts
 *
 * Never point DATABASE_URL at a real database: this writes test agents.
 */
import { PrismaClient } from '@prisma/client';
import { Connection, Keypair } from '@solana/web3.js';
import { jobClaimMessage, signMessage, slotClaimMessage, submitMessage } from '../src/work/auth.js';
import { loadWorkConfig, settleDailyEvidence } from '../src/work/engine.js';
import { hashResult, runWalletHistory, type WalletHistoryResult, type WalletHistorySpec } from '../src/work/wallet-history.js';

const API = process.env.API || 'http://localhost:3999';
const RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? '')) {
  console.error('Refusing to run: DATABASE_URL must be a local scratch database.');
  process.exit(2);
}

const prisma = new PrismaClient();
const conn = new Connection(RPC, { commitment: 'finalized', disableRetryOnRateLimit: true });
const SYSTEM_WALLET = '72onvrQJZkPGLAhWK5MeYc73iyM72P2ABKzDMQ4NpQBL';

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
  if (!ok) failures += 1;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post(path: string, body: unknown) {
  const res = await fetch(`${API}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}
async function get(path: string) {
  const res = await fetch(`${API}${path}`);
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

interface TestAgent {
  name: string;
  agent: Keypair;
  worker: Keypair;
}
const mk = (name: string): TestAgent => ({ name, agent: Keypair.generate(), worker: Keypair.generate() });

async function seedAgent(wallet: string, name: string, isVerified: boolean, owner = wallet) {
  await prisma.agent.upsert({
    where: { wallet },
    update: {},
    create: {
      wallet,
      pda: `e2e-pda-${wallet}`,
      owner,
      metadataUri: 'https://example.invalid/e2e',
      registeredAt: new Date(),
      isVerified,
      name,
    },
  });
}

function claimSlotBody(a: TestAgent, opts: { timestamp?: number; signer?: Keypair } = {}) {
  const wallet = a.agent.publicKey.toBase58();
  const workerKey = a.worker.publicKey.toBase58();
  const timestamp = opts.timestamp ?? Date.now();
  return { wallet, workerKey, timestamp, signature: signMessage(slotClaimMessage(wallet, workerKey, timestamp), (opts.signer ?? a.agent).secretKey) };
}

async function claimJob(a: TestAgent) {
  const workerKey = a.worker.publicKey.toBase58();
  const timestamp = Date.now();
  return post('/api/work/jobs/claim', { workerKey, timestamp, signature: signMessage(jobClaimMessage(workerKey, timestamp), a.worker.secretKey) });
}

async function submit(a: TestAgent, assignmentId: string, result: WalletHistoryResult, signedHash = hashResult(result)) {
  const timestamp = Date.now();
  return post(`/api/work/assignments/${assignmentId}/submit`, {
    workerKey: a.worker.publicKey.toBase58(),
    result,
    timestamp,
    signature: signMessage(submitMessage(assignmentId, signedHash, timestamp), a.worker.secretKey),
  });
}

// The public RPC endpoint rate-limits hard; wait it out rather than fail.
async function rpcRun(spec: WalletHistorySpec): Promise<WalletHistoryResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await runWalletHistory(conn, spec);
    } catch (err) {
      if (attempt >= 5 || !/429/.test(String(err))) throw err;
      await sleep(12_000);
    }
  }
}

// One RPC run per job after the first, to stay inside the public endpoint's
// limits. The first job is computed independently by every worker.
const cache = new Map<string, WalletHistoryResult>();
let independentRuns = 0;
async function compute(spec: WalletHistorySpec, jobId: string, independentJob: string | null): Promise<WalletHistoryResult> {
  if (jobId === independentJob) {
    independentRuns++;
    return rpcRun(spec);
  }
  const hit = cache.get(jobId);
  if (hit) return hit;
  const r = await rpcRun(spec);
  cache.set(jobId, r);
  return r;
}

async function main() {
  const w1 = mk('e2e-w1');
  const w2 = mk('e2e-w2');
  const w3 = mk('e2e-w3');
  const w4 = mk('e2e-w4-same-owner-as-w1');
  const w5 = mk('e2e-w5');
  const over = mk('e2e-over-cap');
  const unverified = mk('e2e-unverified');
  const stranger = mk('e2e-unregistered');

  await seedAgent(SYSTEM_WALLET, 'SAID system', true);
  for (const w of [w1, w2, w3, w5, over]) await seedAgent(w.agent.publicKey.toBase58(), w.name, true);
  await seedAgent(w4.agent.publicKey.toBase58(), w4.name, true, w1.agent.publicKey.toBase58());
  await seedAgent(unverified.agent.publicKey.toBase58(), unverified.name, false);

  // ── Slots ────────────────────────────────────────────────────────────────
  check('unregistered wallet cannot claim a slot', (await post('/api/work/slots/claim', claimSlotBody(stranger))).status, 404);
  check('unverified agent cannot claim a slot', (await post('/api/work/slots/claim', claimSlotBody(unverified))).status, 403);
  check('a signature from the wrong key is refused', (await post('/api/work/slots/claim', claimSlotBody(w1, { signer: w2.agent }))).status, 401);
  check('a stale timestamp is refused', (await post('/api/work/slots/claim', claimSlotBody(w1, { timestamp: Date.now() - 10 * 60 * 1000 }))).status, 400);
  check('a verified agent claims a slot', (await post('/api/work/slots/claim', claimSlotBody(w1))).status, 201);
  check('claiming again re-binds, not duplicates', (await post('/api/work/slots/claim', claimSlotBody(w1))).status, 200);
  for (const w of [w2, w3, w4, w5]) check(`${w.name} claims a slot`, (await post('/api/work/slots/claim', claimSlotBody(w))).status, 201);
  const overCap = await post('/api/work/slots/claim', claimSlotBody(over));
  check('the slot cap holds', [overCap.status, /slots are taken/.test(overCap.body.error ?? '')], [409, true]);
  check('a worker key without a slot cannot take jobs', (await claimJob(over)).status, 401);
  check('slot lookup', (await get(`/api/work/slots/${w1.agent.publicKey.toBase58()}`)).body.workerKey, w1.worker.publicKey.toBase58());

  // ── Jobs: three honest workers, with one tampered answer ────────────────
  const honest = [w1, w2, w3];
  let independentJob: string | null = null;
  let tamperJob: string | null = null;
  let tamperedAssignment: string | null = null;
  let firstAssignment: { worker: TestAgent; id: string; result: WalletHistoryResult } | null = null;
  const seenJobs = new Set<string>();

  for (let round = 0; round < 12; round++) {
    for (const w of honest) {
      const claim = await claimJob(w);
      if (claim.status !== 200) {
        check(`claim by ${w.name}`, claim.status, 200);
        continue;
      }
      const a = claim.body.assignment;
      if (!a) continue;
      seenJobs.add(a.jobId);
      if (!independentJob) independentJob = a.jobId;
      const result = await compute(a.spec, a.jobId, independentJob);

      // w3's first job that is not the independent one gets a wrong count.
      if (w === w3 && !tamperJob && a.jobId !== independentJob && result.txCount < a.spec.maxSignatures) {
        tamperJob = a.jobId;
        tamperedAssignment = a.id;
        const bad = await submit(w, a.id, { ...result, txCount: result.txCount + 1 });
        check('a tampered but well-formed answer is taken as an answer', bad.status, 200);
        continue;
      }
      if (!firstAssignment) {
        const wrongSig = await submit(w, a.id, result, 'f'.repeat(64));
        check('a signature over a different hash is refused', wrongSig.status, 401);
        const other = honest.find((x) => x !== w)!;
        check('another worker cannot submit this assignment', (await submit(other, a.id, result)).status, 404);
      }
      const sub = await submit(w, a.id, result);
      check(`submit by ${w.name} on ${a.jobId.slice(-6)}`, sub.status, 200);
      if (!firstAssignment) {
        firstAssignment = { worker: w, id: a.id, result };
        check('a second submit on the same assignment is refused', (await submit(w, a.id, result)).status, 409);
      }
    }
    const settled = await prisma.workJob.count({ where: { id: { in: [...seenJobs] }, status: { not: 'open' } } });
    if (settled >= 3 && tamperJob && (await prisma.workJob.findUnique({ where: { id: tamperJob } }))?.status !== 'open') break;
  }

  check('every worker computed the first job independently', independentRuns, 3);
  const indep = await prisma.workJob.findUnique({ where: { id: independentJob! }, include: { assignments: true } });
  check('three independent runs of the same job agree', indep?.status, 'accepted');
  check('the accepted job stores the result', (indep?.result as any)?.wallet, (indep?.spec as any)?.wallet);

  const tampered = await prisma.workJob.findUnique({ where: { id: tamperJob ?? '' } });
  check('a job with one wrong answer is not accepted', tampered?.status, 'disagreed');
  check('a disagreed job records no result', tampered?.result ?? null, null);

  // The server re-runs disagreed jobs itself; that is asynchronous.
  let verdicts: Array<{ id: string; verdict: string | null }> = [];
  for (let i = 0; i < 40; i++) {
    verdicts = await prisma.workAssignment.findMany({ where: { jobId: tamperJob ?? '', status: 'submitted' }, select: { id: true, verdict: true } });
    if (verdicts.length && verdicts.every((v) => v.verdict === 'correct' || v.verdict === 'wrong')) break;
    await sleep(1500);
  }
  check('our re-run marks the tampered answer wrong', verdicts.find((v) => v.id === tamperedAssignment)?.verdict, 'wrong');
  check('our re-run marks the honest answers correct', verdicts.filter((v) => v.id !== tamperedAssignment).map((v) => v.verdict), ['correct', 'correct']);
  const w3slot = await prisma.workSlot.findUnique({ where: { wallet: w3.agent.publicKey.toBase58() } });
  check('the wrong answer is counted against the worker', w3slot?.wrongCount, 1);

  // ── Separation rules ────────────────────────────────────────────────────
  for (let i = 0; i < 4; i++) {
    for (const w of [w4, w5]) {
      const claim = await claimJob(w);
      const a = claim.body.assignment;
      if (a) await submit(w, a.id, await compute(a.spec, a.jobId, null));
    }
  }
  const all = await prisma.workAssignment.findMany({ include: { job: { select: { subjectWallet: true, panelSize: true } } } });
  check('no worker was given its own wallet', all.filter((a) => a.workerWallet === a.job.subjectWallet).length, 0);
  const w1Wallet = w1.agent.publicKey.toBase58();
  const w4Wallet = w4.agent.publicKey.toBase58();
  check('a worker is never given a wallet under the same owner', all.filter((a) => a.workerWallet === w4Wallet && a.job.subjectWallet === w1Wallet).length, 0);
  const w1Jobs = new Set(all.filter((a) => a.workerWallet === w1Wallet).map((a) => a.jobId));
  check('two agents under one owner never share a panel', all.filter((a) => a.workerWallet === w4Wallet && w1Jobs.has(a.jobId)).length, 0);
  check('the same-owner worker still gets other work', all.some((a) => a.workerWallet === w4Wallet), true);
  const perJob = new Map<string, number>();
  for (const a of all) if (a.status !== 'expired') perJob.set(a.jobId, (perJob.get(a.jobId) ?? 0) + 1);
  check('no panel is over-filled', [...perJob.values()].some((n) => n > 3), false);

  // ── Public read side ────────────────────────────────────────────────────
  const stats = (await get('/api/work/stats')).body;
  check('stats: slots and cap', [stats.slots.claimed, stats.slots.cap], [5, 5]);
  check('stats: workers are online', stats.workersOnline >= 3, true);
  check('stats: accepted jobs are counted', stats.jobs.accepted >= 1 && stats.jobs.accepted24h >= 1, true);
  check('stats: reputation writes are off by default', stats.reputationWrites, false);
  const feed = (await get('/api/work/feed?limit=20')).body.jobs as any[];
  check('feed lists the accepted job with its panel', feed.find((j) => j.jobId === independentJob)?.panel.length, 3);
  check('feed shows the disagreed job without a summary', feed.find((j) => j.jobId === tamperJob)?.summary ?? null, null);
  const workers = (await get('/api/work/workers')).body.workers as any[];
  check('workers list shows the wrong count', workers.find((w) => w.wallet === w3.agent.publicKey.toBase58())?.wrong, 1);
  const page = await fetch(`${API}/work`);
  check('the feed page is served', [page.status, (await page.text()).includes('Agents at work')], [200, true]);
  check('protocol document is served', (await get('/api/work/protocol')).body.jobKinds, ['wallet_history_v1']);

  // ── Daily reputation rows (off on the server; exercised directly) ───────
  const cfg = loadWorkConfig({ WORK_EVIDENCE_WEIGHT: '0.5', WORK_EVIDENCE_MIN_ACCEPTED: '1' });
  const offRun = await settleDailyEvidence(prisma, loadWorkConfig({}), new Date());
  check('with no weight set, nothing is written', [offRun.enabled, offRun.positive, offRun.negative], [false, 0, 0]);
  const first = await settleDailyEvidence(prisma, cfg, new Date());
  check('one positive row per honest worker', first.positive >= 2, true);
  check('one negative row for the worker with a wrong answer', first.negative, 1);
  const again = await settleDailyEvidence(prisma, cfg, new Date());
  check('running it again writes nothing new', [again.positive, again.negative], [0, 0]);
  const rows = await prisma.feedback.findMany({ where: { sourceKey: { startsWith: 'src:said-work:' } }, select: { toWallet: true, score: true, weight: true } });
  check('the wrong-answer worker gets the negative score', rows.find((r) => r.toWallet === w3.agent.publicKey.toBase58())?.score, 20);
  check('an honest worker gets the positive score at the set weight', (({ score, weight }) => [score, weight])(rows.find((r) => r.toWallet === w1Wallet)!), [80, 0.5]);
  check('one row per worker per day, however many jobs', rows.filter((r) => r.toWallet === w1Wallet).length, 1);

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});

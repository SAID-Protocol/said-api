/**
 * Work loop — end to end against a locally booted server and a scratch
 * Postgres (see .claude/skills/verify). Seeds its own agents, then drives the
 * real HTTP routes with real signatures and real mainnet wallet history.
 *
 * Boot the server with:
 *   WORK_OPEN=true ADMIN_SECRET=vk WORK_SLOT_CAP=7 WORK_JOB_BATCH=3 WORK_SPOT_CHECK_RATE=1 WORK_RECHECK_HOURS=0
 *   WORK_JOB_KIND=wallet_activity_v1 WORK_APPLY_ACTIVITY=true   (optional: the fuller job)
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
import { jobKind, type JobResult } from '../src/work/kinds.js';
import { computeShares } from '../src/work/payouts.js';
import { leafHash, verifyProof } from '../src/work/records.js';
import type { WalletHistorySpec } from '../src/work/wallet-history.js';

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

async function post(path: string, body: unknown, ip?: string) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(ip ? { 'x-real-ip': ip } : {}) },
    body: JSON.stringify(body),
  });
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
  ip: string; // the network address this worker appears to come from
}
let nextIp = 10;
const mk = (name: string, ip = `203.0.113.${nextIp++}`): TestAgent => ({ name, agent: Keypair.generate(), worker: Keypair.generate(), ip });

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
  return post('/api/work/jobs/claim', { workerKey, timestamp, signature: signMessage(jobClaimMessage(workerKey, timestamp), a.worker.secretKey) }, a.ip);
}

let KIND = 'wallet_history_v1';
const hashOf = (r: JobResult) => jobKind(KIND)!.hash(r);

async function submit(a: TestAgent, assignmentId: string, result: JobResult, signedHash = hashOf(result)) {
  const timestamp = Date.now();
  return post(`/api/work/assignments/${assignmentId}/submit`, {
    workerKey: a.worker.publicKey.toBase58(),
    result,
    timestamp,
    signature: signMessage(submitMessage(assignmentId, signedHash, timestamp), a.worker.secretKey),
  });
}

// The public RPC endpoint rate-limits hard; wait it out rather than fail.
async function rpcRun(spec: WalletHistorySpec): Promise<JobResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await jobKind(KIND)!.run(conn, spec);
    } catch (err) {
      if (attempt >= 5 || !/429/.test(String(err))) throw err;
      await sleep(12_000);
    }
  }
}

// One RPC run per job after the first, to stay inside the public endpoint's
// limits. The first job is computed independently by every worker.
const cache = new Map<string, JobResult>();
let independentRuns = 0;
async function compute(spec: WalletHistorySpec, jobId: string, independentJob: string | null): Promise<JobResult> {
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
  const w5 = mk('e2e-w5-same-address-as-w2', w2.ip);
  const x1 = mk('e2e-third-under-w1-owner');
  const x2 = mk('e2e-fourth-under-w1-owner');
  const filler = mk('e2e-filler');
  const over = mk('e2e-over-cap');
  const unverified = mk('e2e-unverified');
  const stranger = mk('e2e-unregistered');

  await seedAgent(SYSTEM_WALLET, 'SAID system', true);
  for (const w of [w1, w2, w3, w5, filler, over]) await seedAgent(w.agent.publicKey.toBase58(), w.name, true);
  for (const w of [w4, x1, x2]) await seedAgent(w.agent.publicKey.toBase58(), w.name, true, w1.agent.publicKey.toBase58());
  await seedAgent(unverified.agent.publicKey.toBase58(), unverified.name, false);

  KIND = (await get('/api/work/protocol')).body.currentJobKind;
  console.log(`job kind under test: ${KIND}`);
  const startedAt = new Date();

  // ── Slots ────────────────────────────────────────────────────────────────
  check('unregistered wallet cannot claim a slot', (await post('/api/work/slots/claim', claimSlotBody(stranger))).status, 404);
  check('unverified agent cannot claim a slot', (await post('/api/work/slots/claim', claimSlotBody(unverified))).status, 403);
  check('a signature from the wrong key is refused', (await post('/api/work/slots/claim', claimSlotBody(w1, { signer: w2.agent }))).status, 401);
  check('a stale timestamp is refused', (await post('/api/work/slots/claim', claimSlotBody(w1, { timestamp: Date.now() - 10 * 60 * 1000 }))).status, 400);
  check('a verified agent claims a slot', (await post('/api/work/slots/claim', claimSlotBody(w1))).status, 201);
  check('claiming again re-binds, not duplicates', (await post('/api/work/slots/claim', claimSlotBody(w1))).status, 200);
  for (const w of [w2, w3, w4, w5]) check(`${w.name} claims a slot`, (await post('/api/work/slots/claim', claimSlotBody(w))).status, 201);
  check('a third slot under one owner is allowed', (await post('/api/work/slots/claim', claimSlotBody(x1))).status, 201);
  const fourth = await post('/api/work/slots/claim', claimSlotBody(x2));
  check('a fourth slot under one owner is refused', [fourth.status, /at most 3/.test(fourth.body.error ?? '')], [409, true]);
  check('the filler claims the last slot', (await post('/api/work/slots/claim', claimSlotBody(filler))).status, 201);
  const overCap = await post('/api/work/slots/claim', claimSlotBody(over));
  check('the slot cap holds', [overCap.status, /slots are taken/.test(overCap.body.error ?? '')], [409, true]);
  check('a worker key without a slot cannot take jobs', (await claimJob(over)).status, 401);
  check('slot lookup', (await get(`/api/work/slots/${w1.agent.publicKey.toBase58()}`)).body.workerKey, w1.worker.publicKey.toBase58());

  // ── Jobs: three honest workers, with one tampered answer ────────────────
  const honest = [w1, w2, w3];
  let independentJob: string | null = null;
  let tamperJob: string | null = null;
  let tamperedAssignment: string | null = null;
  let firstAssignment: { worker: TestAgent; id: string; result: JobResult } | null = null;
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

      // w3's first job that is not the independent one gets a changed digest.
      // (Not a job about w1 or w2: they could never sit on its panel to fill it.)
      const fillable = !honest.some((x) => x.agent.publicKey.toBase58() === a.spec.wallet);
      if (w === w3 && !tamperJob && a.jobId !== independentJob && fillable) {
        tamperJob = a.jobId;
        tamperedAssignment = a.id;
        const bad = await submit(w, a.id, { ...result, signaturesDigest: 'f'.repeat(64) });
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
  const w2Wallet = w2.agent.publicKey.toBase58();
  const w5Wallet = w5.agent.publicKey.toBase58();
  const w2Jobs = new Set(all.filter((a) => a.workerWallet === w2Wallet).map((a) => a.jobId));
  check('two workers at one network address never share a panel', all.filter((a) => a.workerWallet === w5Wallet && w2Jobs.has(a.jobId)).length, 0);
  check('nor is one asked to check the other', all.filter((a) => (a.workerWallet === w5Wallet && a.job.subjectWallet === w2Wallet) || (a.workerWallet === w2Wallet && a.job.subjectWallet === w5Wallet)).length, 0);
  check('the same-address worker still gets other work', all.some((a) => a.workerWallet === w5Wallet), true);
  const clusters = await fetch(`${API}/api/work/admin/clusters`, { headers: { 'x-admin-secret': 'vk' } }).then((r) => r.json() as any);
  check('the operator view groups the two by address', clusters.byAddress.some((g: any) => g.size === 2 && g.slots.every((x: any) => [w2Wallet, w5Wallet].includes(x.wallet))), true);
  check('the operator view needs the admin secret', (await fetch(`${API}/api/work/admin/clusters`)).status, 404);
  check('standing tells a worker it shares an operator', (await get(`/api/work/workers/${w5Wallet}/standing`)).body.sameOperatorSlots, 1);
  const perJob = new Map<string, number>();
  for (const a of all) if (a.status !== 'expired') perJob.set(a.jobId, (perJob.get(a.jobId) ?? 0) + 1);
  check('no panel is over-filled', [...perJob.values()].some((n) => n > 3), false);

  // ── Public read side ────────────────────────────────────────────────────
  const stats = (await get('/api/work/stats')).body;
  check('stats: slots and cap', [stats.slots.claimed, stats.slots.cap], [7, 7]);
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
  check('protocol lists both job kinds', (await get('/api/work/protocol')).body.jobKinds, ['wallet_history_v1', 'wallet_activity_v1']);
  check('workers are numbered in joining order', workers.map((w) => w.number).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7]);

  if (KIND === 'wallet_activity_v1') {
    const subject = (indep?.spec as any).wallet as string;
    const stats2 = await prisma.agentActivityStats.findUnique({ where: { wallet: subject } });
    check('an accepted activity answer is written to the activity stats', stats2?.source, 'work-panel');
    check('the stats carry the agreed transaction count', stats2?.txCount, (indep?.result as any).successCount);
  }

  // ── Standing and the one-call snapshot ──────────────────────────────────
  const st = (await get(`/api/work/workers/${w3.agent.publicKey.toBase58()}/standing`)).body;
  check('standing lists the wrong answer with its reason', st.standing.recentFailures.some((f: any) => f.reason === 'wrong_answer' && f.jobId === tamperJob), true);
  check('one wrong answer does not pause a worker', [st.standing.paused, st.blocked.includes('paused')], [false, false]);
  check('standing reports limits and the queue', [st.limits.maxLeases, typeof st.queue.eligibleForYou, st.presence.online], [3, 'number', true]);
  check('standing for a wallet without a slot is 404', (await get(`/api/work/workers/${over.agent.publicKey.toBase58()}/standing`)).status, 404);
  const swarmRes = await fetch(`${API}/api/work/swarm`, { headers: { Origin: 'https://example.org' } });
  const swarm = (await swarmRes.json()) as any;
  check('the snapshot is readable from any origin', swarmRes.headers.get('access-control-allow-origin'), '*');
  check('the snapshot carries stats, workers, feed and the payout formula', [swarm.open, swarm.workers.length, swarm.feed.length > 0, /tier rate/.test(swarm.rules.payout.formula)], [true, 7, true, true]);

  // ── Daily record and announcements ──────────────────────────────────────
  const today = new Date().toISOString().slice(0, 10);
  const record = (await get(`/api/work/records/${today}`)).body;
  check('today\'s record lists the accepted job and is not final yet', [record.final, record.leaves.some((l: any) => l.jobId === independentJob)], [false, true]);
  const proof = (await get(`/api/work/jobs/${independentJob}/proof`)).body;
  check('an accepted job proves against the day root', verifyProof(proof.leaf, proof.proof, record.root), true);
  check('the proof leaf is the job id and its answer hash', proof.leaf, leafHash(independentJob!, indep!.resultHash!));
  check('a disagreed job has no proof', (await get(`/api/work/jobs/${tamperJob}/proof`)).status, 404);
  check('a malformed day is refused', (await get('/api/work/records/2026-13-40')).status, 400);
  const yesterday = new Date(Date.now() - 86400e3).toISOString().slice(0, 10);
  const closed = (await get(`/api/work/records/${yesterday}`)).body;
  check('a day that has ended is final, even when empty', [closed.final, closed.count], [true, 0]);
  const adminPost = (path: string, body: unknown, secret = 'vk') =>
    fetch(`${API}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-secret': secret }, body: JSON.stringify(body) })
      .then(async (r) => ({ status: r.status, body: (await r.json().catch(() => ({}))) as any }));
  check('an announcement needs the admin secret', (await adminPost('/api/work/admin/updates', { title: 'x', body: 'y' }, 'nope')).status, 404);
  check('an announcement is posted', (await adminPost('/api/work/admin/updates', { title: 'First payout sent', body: 'Period e2e paid three workers.' })).status, 201);
  check('announcements are public, newest first', (await get('/api/work/updates')).body.updates[0].title, 'First payout sent');
  check('an anchor transaction can be attached to a closed day', (await adminPost(`/api/work/admin/records/${yesterday}/anchor`, { tx: '3'.repeat(88) })).body.anchorTx, '3'.repeat(88));

  // ── Reward period and payouts ───────────────────────────────────────────
  const period = { label: 'e2e-period', startsAt: startedAt.toISOString(), endsAt: new Date().toISOString(), rewardsLamports: '1000000000' };
  const admin = (path: string, body: unknown, secret = 'vk') =>
    fetch(`${API}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-secret': secret }, body: JSON.stringify(body) })
      .then(async (r) => ({ status: r.status, body: (await r.json().catch(() => ({}))) as any }));
  check('a reward period cannot be recorded without the admin secret', (await admin('/api/work/admin/epochs', period, 'nope')).status, 404);
  check('a period that has not ended is refused', (await admin('/api/work/admin/epochs', { ...period, endsAt: new Date(Date.now() + 3600e3).toISOString() })).status, 400);
  const made = await admin('/api/work/admin/epochs', period);
  check('a reward period is recorded with the published split', [made.status, made.body.workerPoolLamports, made.body.lockLamports], [201, '400000000', '400000000']);
  check('the same period cannot be recorded twice', (await admin('/api/work/admin/epochs', period)).status, 409);
  check('an overlapping period is refused', (await admin('/api/work/admin/epochs', { ...period, label: 'e2e-overlap' })).status, 409);
  const epochs = (await get('/api/work/payouts')).body.epochs as any[];
  const ep = epochs.find((e) => e.label === 'e2e-period');
  const pay = (wallet: string) => ep.payouts.find((p: any) => p.wallet === wallet);
  check('the worker with a wrong answer is paid nothing', [pay(w3.agent.publicKey.toBase58()).lamports, pay(w3.agent.publicKey.toBase58()).status], ['0', 'skipped']);
  check('honest workers have a pending payout', [pay(w1Wallet).status, BigInt(pay(w1Wallet).lamports) > 0n], ['pending', true]);
  check('with no tier rates set, every payout is at the base rate', ep.payouts.every((p: any) => p.ratePct === 100 && p.tier === 'unranked'), true);
  const standingPay = (await get(`/api/work/workers/${w1Wallet}/standing`)).body.pay;
  check('standing shows the worker its tier and rate', [standingPay.tier, standingPay.ratePct], ['unranked', 100]);
  const sum = ep.payouts.reduce((a: bigint, p: any) => a + BigInt(p.lamports), 0n);
  check('payouts never exceed the worker pool', sum <= 400000000n && sum > 399999000n, true);
  const expected = computeShares(400000000n, new Map(ep.payouts.map((p: any) => [p.wallet, Math.max(0, p.good - 10 * p.wrong)])), 1000000n);
  check('each share is proportional to accepted work', ep.payouts.map((p: any) => p.lamports), expected.map((s) => s.lamports.toString()));
  const lockSig = '5'.repeat(88);
  check('the buy-and-lock transaction can be attached', (await admin('/api/work/admin/epochs/e2e-period/lock', { tx: lockSig })).body.lockTx, lockSig);
  check('a slot shows what it has been paid', (await get(`/api/work/slots/${w1Wallet}`)).body.paidLamports, '0');

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

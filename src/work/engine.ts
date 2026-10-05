/**
 * Work loop — slots, jobs, panels and settlement.
 *
 * The rules, in one place:
 *   - only a verified agent can hold a slot, and slots are capped
 *   - a job goes to `panelSize` workers who are unrelated to the wallet being
 *     checked and to each other
 *   - a job is accepted only when every panel answer hashes the same;
 *     otherwise nothing is recorded for it
 *   - a job whose panel never fills expires
 *   - we re-run every disagreed job and a random sample of accepted ones
 *     ourselves, and mark each answer correct or wrong against that
 *   - reputation is written once per worker per day, never per job, so a
 *     large job count cannot inflate a score on its own
 *
 * No payouts live here. Kept free of HTTP so it can be driven from tests.
 */

import { Prisma, type PrismaClient } from '@prisma/client';
import { PublicKey } from '@solana/web3.js';
import { isFresh, jobClaimMessage, slotClaimMessage, submitMessage, verifyMessage } from './auth.js';
import { jobKind, type JobResult } from './kinds.js';
import { WALLET_HISTORY_KIND, isValidSpec, type WalletHistorySpec } from './wallet-history.js';

export class WorkError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 429 | 503,
    message: string,
  ) {
    super(message);
  }
}

export interface WorkConfig {
  /** Master switch. Until it is on, nobody can claim a slot or a job; reads still work. */
  open: boolean;
  slotCap: number;
  panelSize: number;
  leaseSeconds: number;
  maxLeasesPerWorker: number;
  /** Ceiling on jobs one worker may take per hour: protects the operator's RPC quota and stops one worker taking the whole board. */
  maxJobsPerHour: number;
  windowDays: number;
  maxSignatures: number;
  /** The kind new jobs are cut as. Existing jobs keep the kind they were cut with. */
  jobKind: string;
  jobBatch: number;
  jobTtlHours: number;
  recheckHours: number;
  spotCheckRate: number;
  /** Null disables reputation writes entirely. Set from env so the value stays out of the repo. */
  evidenceWeight: number | null;
  evidenceMinAccepted: number;
  /** Write accepted wallet-activity answers into the API's activity stats. */
  applyActivity: boolean;
  /** Share of each period's rewards, in basis points. The remainder is unallocated. */
  workersBps: number;
  lockBps: number;
  /** One owner may hold at most this many slots. */
  maxSlotsPerOwner: number;
  /** Treat workers claiming from one network address as one operator. */
  ipSeparation: boolean;
  /** Funding wallets too common to mean "same operator" (a sponsor wallet, an exchange). */
  commonFunders: Set<string>;
  /** A share smaller than this is not sent (it would cost more to send than it is worth). */
  minPayoutLamports: number;
}

function num(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

export function loadWorkConfig(env: NodeJS.ProcessEnv): WorkConfig {
  const weight = Number(env.WORK_EVIDENCE_WEIGHT);
  const workersBps = num(env.WORK_SPLIT_WORKERS_BPS, 4000, 0, 10000);
  return {
    open: env.WORK_OPEN === 'true',
    jobKind: jobKind(env.WORK_JOB_KIND ?? '') ? (env.WORK_JOB_KIND as string) : WALLET_HISTORY_KIND,
    slotCap: num(env.WORK_SLOT_CAP, 500, 1, 100000),
    panelSize: num(env.WORK_PANEL_SIZE, 3, 2, 15),
    leaseSeconds: num(env.WORK_LEASE_SECONDS, 300, 30, 3600),
    maxLeasesPerWorker: num(env.WORK_MAX_LEASES, 3, 1, 20),
    maxJobsPerHour: num(env.WORK_MAX_JOBS_PER_HOUR, 600, 1, 100000),
    windowDays: num(env.WORK_WINDOW_DAYS, 30, 1, 365),
    maxSignatures: num(env.WORK_MAX_SIGNATURES, 1000, 1, 10000),
    jobBatch: num(env.WORK_JOB_BATCH, 50, 1, 1000),
    jobTtlHours: num(env.WORK_JOB_TTL_HOURS, 6, 0.1, 24 * 30),
    recheckHours: num(env.WORK_RECHECK_HOURS, 24, 0, 24 * 90),
    spotCheckRate: num(env.WORK_SPOT_CHECK_RATE, 0.05, 0, 1),
    evidenceWeight: env.WORK_EVIDENCE_WEIGHT && Number.isFinite(weight) && weight > 0 && weight <= 3 ? weight : null,
    evidenceMinAccepted: num(env.WORK_EVIDENCE_MIN_ACCEPTED, 10, 1, 100000),
    applyActivity: env.WORK_APPLY_ACTIVITY === 'true',
    maxSlotsPerOwner: num(env.WORK_MAX_SLOTS_PER_OWNER, 3, 1, 1000),
    ipSeparation: env.WORK_IP_SEPARATION !== 'false',
    commonFunders: new Set((env.WORK_COMMON_FUNDERS ?? '').split(',').map((w) => w.trim()).filter(Boolean)),
    workersBps,
    lockBps: Math.min(num(env.WORK_SPLIT_LOCK_BPS, 4000, 0, 10000), 10000 - workersBps),
    minPayoutLamports: num(env.WORK_MIN_PAYOUT_LAMPORTS, 1_000_000, 0, 1e12),
  };
}

/** Our own run of a job, used to judge panel answers. */
export type ReferenceRunner = (kind: string, spec: WalletHistorySpec) => Promise<JobResult>;

export interface SettleHooks {
  reference: ReferenceRunner | null;
  /** Called once when a panel agrees, with the agreed answer. */
  onAccepted?: (job: { id: string; kind: string; result: JobResult }) => Promise<void>;
}

// Same system wallet the partner outcome door writes from (index.ts).
const SYSTEM_WALLET = '72onvrQJZkPGLAhWK5MeYc73iyM72P2ABKzDMQ4NpQBL';
const EVIDENCE_SOURCE = 'said-work';
const EVIDENCE_SCORE_POSITIVE = 80;
const EVIDENCE_SCORE_NEGATIVE = 20;

// Jobs are cut for a window that ended this long ago, so every panel member
// reads finalized history that can no longer change.
const WINDOW_SETTLE_SECONDS = 10 * 60;
const ONLINE_WINDOW_MS = 10 * 60 * 1000;

// pg_advisory_xact_lock keys: serialise slot claims and job cutting.
const LOCK_SLOTS = 74110001;
const LOCK_JOBS = 74110002;

function isPubkey(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

// ─── Slots ──────────────────────────────────────────────────────────────────

export interface SlotClaimBody {
  wallet?: unknown;
  workerKey?: unknown;
  timestamp?: unknown;
  signature?: unknown;
}

const NOT_OPEN = 'The work loop is not open yet';

export async function claimSlot(prisma: PrismaClient, cfg: WorkConfig, body: SlotClaimBody, ipHash: string | null = null) {
  if (!cfg.open) throw new WorkError(503, NOT_OPEN);
  const { wallet, workerKey, timestamp, signature } = body;
  if (!isPubkey(wallet) || !isPubkey(workerKey)) throw new WorkError(400, 'wallet and workerKey must be base58 public keys');
  if (wallet === workerKey) throw new WorkError(400, 'workerKey must be a separate key from the agent wallet');
  if (!isFresh(timestamp)) throw new WorkError(400, 'timestamp must be unix milliseconds within 5 minutes of now');
  if (!verifyMessage(slotClaimMessage(wallet, workerKey, timestamp), signature, wallet)) {
    throw new WorkError(401, 'signature does not match the agent wallet');
  }

  const agent = await prisma.agent.findUnique({ where: { wallet }, select: { isVerified: true, owner: true } });
  if (!agent) throw new WorkError(404, 'Agent not registered on SAID');
  if (!agent.isVerified) throw new WorkError(403, 'Only verified agents can claim a worker slot');

  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_SLOTS})`;
      const existing = await tx.workSlot.findUnique({ where: { wallet } });
      if (existing) {
        if (existing.status !== 'active') throw new WorkError(403, 'This slot has been revoked');
        // Re-claiming rotates the worker key; the slot and its record carry over.
        const slot = await tx.workSlot.update({ where: { wallet }, data: { workerKey } });
        return { slot, created: false };
      }
      const taken = await tx.workSlot.count({ where: { status: 'active' } });
      if (taken >= cfg.slotCap) throw new WorkError(409, `All ${cfg.slotCap} worker slots are taken`);
      const siblings = await tx.agent.findMany({ where: { owner: agent.owner }, select: { wallet: true } });
      const held = await tx.workSlot.count({ where: { status: 'active', wallet: { in: siblings.map((a) => a.wallet) } } });
      if (held >= cfg.maxSlotsPerOwner) throw new WorkError(409, `One owner can hold at most ${cfg.maxSlotsPerOwner} worker slots`);
      const slot = await tx.workSlot.create({ data: { wallet, workerKey, ipHash } });
      return { slot, created: true };
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new WorkError(409, 'That worker key is already bound to another slot');
    }
    throw err;
  }
}

async function activeSlotForKey(prisma: PrismaClient, workerKey: unknown) {
  if (!isPubkey(workerKey)) throw new WorkError(400, 'workerKey must be a base58 public key');
  const slot = await prisma.workSlot.findUnique({ where: { workerKey } });
  if (!slot || slot.status !== 'active') throw new WorkError(401, 'No active slot for this worker key');
  return slot;
}

/**
 * Every wallet a worker must never be asked to check: its own, its owner's,
 * its linked and delegated wallets, and other agents under the same owner.
 */
export async function relatedWallets(
  prisma: PrismaClient,
  wallet: string,
  cfg?: WorkConfig,
): Promise<{ owner: string; wallets: string[] }> {
  const agent = await prisma.agent.findUnique({ where: { wallet }, select: { id: true, pda: true, owner: true } });
  if (!agent) throw new WorkError(403, 'Agent is no longer registered');
  const [siblings, linksOut, linkIn, delegated] = await Promise.all([
    prisma.agent.findMany({ where: { owner: agent.owner }, select: { wallet: true } }),
    prisma.walletLink.findMany({ where: { agentPda: agent.pda }, select: { wallet: true } }),
    prisma.walletLink.findUnique({ where: { wallet }, select: { agentPda: true } }),
    prisma.agentWallet.findMany({ where: { agentId: agent.id }, select: { publicKey: true } }),
  ]);
  const set = new Set<string>([wallet, agent.owner]);
  for (const s of siblings) set.add(s.wallet);
  for (const l of linksOut) set.add(l.wallet);
  for (const d of delegated) set.add(d.publicKey);
  if (linkIn) {
    const parent = await prisma.agent.findUnique({ where: { pda: linkIn.agentPda }, select: { wallet: true } });
    if (parent) set.add(parent.wallet);
  }
  if (cfg) for (const w of await sameOperatorSlots(prisma, cfg, wallet)) set.add(w);
  return { owner: agent.owner, wallets: [...set] };
}

/**
 * Other slots that look like the same operator: funded by the same wallet, or
 * working from the same network address. Either can be faked around at a
 * cost; the point is to make a farm of slots more expensive than one honest
 * worker, not to prove who anyone is.
 */
export async function sameOperatorSlots(prisma: PrismaClient, cfg: WorkConfig, wallet: string): Promise<string[]> {
  const me = await prisma.workSlot.findUnique({ where: { wallet }, select: { ipHash: true, funder: true } });
  if (!me) return [];
  const or: Prisma.WorkSlotWhereInput[] = [];
  if (cfg.ipSeparation && me.ipHash) or.push({ ipHash: me.ipHash });
  if (me.funder && !cfg.commonFunders.has(me.funder)) or.push({ funder: me.funder });
  // A slot whose funder is another slot's wallet, or the reverse.
  or.push({ funder: wallet });
  if (me.funder) or.push({ wallet: me.funder });
  const rows = await prisma.workSlot.findMany({ where: { status: 'active', wallet: { not: wallet }, OR: or }, select: { wallet: true } });
  return rows.map((r) => r.wallet);
}

/** Groups of slots that share a funder or an address, for an operator to review. */
export async function getClusters(prisma: PrismaClient, cfg: WorkConfig) {
  const slots = await prisma.workSlot.findMany({ where: { status: 'active' }, select: { wallet: true, number: true, ipHash: true, funder: true, acceptedCount: true } });
  const group = (key: (s: (typeof slots)[number]) => string | null) => {
    const m = new Map<string, typeof slots>();
    for (const s of slots) {
      const k = key(s);
      if (k) m.set(k, [...(m.get(k) ?? []), s]);
    }
    return [...m].filter(([, v]) => v.length > 1).map(([k, v]) => ({ key: k, size: v.length, slots: v.map((x) => ({ wallet: x.wallet, number: x.number, accepted: x.acceptedCount })) }));
  };
  return {
    byFunder: group((s) => s.funder).map((g) => ({ funder: g.key, treatedAsCommon: cfg.commonFunders.has(g.key), size: g.size, slots: g.slots })),
    byAddress: cfg.ipSeparation ? group((s) => s.ipHash).map((g) => ({ addressHash: g.key.slice(0, 12), size: g.size, slots: g.slots })) : [],
    unknownFunder: slots.filter((s) => !s.funder).length,
  };
}

// ─── Standing ───────────────────────────────────────────────────────────────

// A worker whose last BREAKER_FAILURES jobs all went bad is paused for
// BREAKER_COOLDOWN_MS from the latest of them. The pause lifts by itself;
// nothing is stored, it is read off the worker's recent assignments.
export const BREAKER_FAILURES = 3;
export const BREAKER_COOLDOWN_MS = 15 * 60 * 1000;

export interface FinishedAssignment {
  jobId: string;
  status: string; // submitted | expired
  verdict: string | null;
  endedAt: Date;
}

export type FailureReason = 'lease_expired' | 'wrong_answer';

export function failureReason(a: FinishedAssignment): FailureReason | null {
  if (a.status === 'expired') return 'lease_expired';
  if (a.verdict === 'wrong') return 'wrong_answer';
  return null;
}

/** Pure: is the breaker open? `recent` is newest first. */
export function breakerState(recent: FinishedAssignment[], now: Date): { pausedUntil: Date | null; consecutiveFailures: number } {
  let consecutive = 0;
  for (const a of recent) {
    if (failureReason(a) === null) break;
    consecutive++;
  }
  if (consecutive < BREAKER_FAILURES || recent.length === 0) return { pausedUntil: null, consecutiveFailures: consecutive };
  const until = new Date(recent[0].endedAt.getTime() + BREAKER_COOLDOWN_MS);
  return { pausedUntil: until > now ? until : null, consecutiveFailures: consecutive };
}

async function recentFinished(prisma: PrismaClient, wallet: string, now: Date, take: number): Promise<FinishedAssignment[]> {
  const rows = await prisma.workAssignment.findMany({
    where: { workerWallet: wallet, OR: [{ status: 'submitted' }, { status: 'expired' }, { status: 'leased', leaseExpiresAt: { lt: now } }] },
    orderBy: { createdAt: 'desc' },
    take,
    select: { jobId: true, status: true, verdict: true, submittedAt: true, leaseExpiresAt: true },
  });
  return rows.map((r) => ({
    jobId: r.jobId,
    status: r.status === 'leased' ? 'expired' : r.status,
    verdict: r.verdict,
    endedAt: r.submittedAt ?? r.leaseExpiresAt,
  }));
}

/** Open jobs this worker would be allowed to take right now. */
async function eligibleJobCount(prisma: PrismaClient, wallet: string, related: { owner: string; wallets: string[] }): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n
    FROM "WorkJob" j
    WHERE j.status = 'open'
      AND j."subjectWallet" <> ALL(${related.wallets})
      AND NOT EXISTS (SELECT 1 FROM "WorkAssignment" a WHERE a."jobId" = j.id AND a."workerWallet" = ${wallet})
      AND (SELECT count(*) FROM "WorkAssignment" a WHERE a."jobId" = j.id AND a.status <> 'expired') < j."panelSize"
      AND NOT EXISTS (
        SELECT 1 FROM "WorkAssignment" a
        JOIN "Agent" g ON g.wallet = a."workerWallet"
        WHERE a."jobId" = j.id AND a.status <> 'expired'
          AND (g.owner = ${related.owner} OR a."workerWallet" = ANY(${related.wallets}))
      )
  `;
  return Number(rows[0]?.n ?? 0);
}

/**
 * Everything a worker's operator needs to answer "why am I not getting
 * work?": the slot, whether it is paused and why, and what is blocking it.
 */
export async function getStanding(prisma: PrismaClient, cfg: WorkConfig, wallet: string, now: Date = new Date()) {
  const slot = await prisma.workSlot.findUnique({ where: { wallet } });
  if (!slot) return null;
  const agent = await prisma.agent.findUnique({ where: { wallet }, select: { isVerified: true } });
  const recent = await recentFinished(prisma, wallet, now, 20);
  const breaker = breakerState(recent, now);
  const hourAgo = new Date(now.getTime() - 3600 * 1000);
  const [usedThisHour, openLeases, openJobs] = await Promise.all([
    prisma.workAssignment.count({ where: { workerWallet: wallet, createdAt: { gte: hourAgo } } }),
    prisma.workAssignment.count({ where: { workerWallet: wallet, status: 'leased', leaseExpiresAt: { gte: now } } }),
    prisma.workJob.count({ where: { status: 'open' } }),
  ]);
  const eligible = agent ? await eligibleJobCount(prisma, wallet, await relatedWallets(prisma, wallet, cfg)) : 0;
  const sameOperator = (await sameOperatorSlots(prisma, cfg, wallet)).length;

  const blocked: string[] = [];
  if (!cfg.open) blocked.push('loop_closed');
  if (slot.status !== 'active') blocked.push('slot_revoked');
  if (!agent?.isVerified) blocked.push('agent_not_verified');
  if (breaker.pausedUntil) blocked.push('paused');
  if (usedThisHour >= cfg.maxJobsPerHour) blocked.push('hourly_cap');
  if (openLeases >= cfg.maxLeasesPerWorker) blocked.push('open_leases_at_limit');
  // New jobs are cut when a worker asks and finds none, so this only blocks
  // when every verified wallet has been checked recently.
  if (blocked.length === 0 && eligible === 0 && openJobs > 0) blocked.push('no_eligible_jobs');

  return {
    wallet,
    number: slot.number,
    presence: {
      lastSeenAt: slot.lastSeenAt?.toISOString() ?? null,
      online: slot.lastSeenAt !== null && now.getTime() - slot.lastSeenAt.getTime() <= ONLINE_WINDOW_MS,
    },
    record: { accepted: slot.acceptedCount, disagreed: slot.disagreedCount, wrong: slot.wrongCount },
    standing: {
      paused: breaker.pausedUntil !== null,
      pausedUntil: breaker.pausedUntil?.toISOString() ?? null,
      consecutiveFailures: breaker.consecutiveFailures,
      rules: { failures: BREAKER_FAILURES, cooldownMs: BREAKER_COOLDOWN_MS },
      recentFailures: recent
        .filter((a) => failureReason(a) !== null)
        .slice(0, 10)
        .map((a) => ({ at: a.endedAt.toISOString(), reason: failureReason(a), jobId: a.jobId })),
    },
    limits: { openLeases, maxLeases: cfg.maxLeasesPerWorker, usedThisHour, maxJobsPerHour: cfg.maxJobsPerHour },
    queue: { open: openJobs, eligibleForYou: eligible },
    // Slots that share your funding wallet or network address. You are never
    // put on a panel with them, so running several earns no extra agreement.
    sameOperatorSlots: sameOperator,
    blocked,
  };
}

// ─── Jobs ───────────────────────────────────────────────────────────────────

// Open jobs are bounded so a board nobody can clear does not grow forever.
const MAX_OPEN_BATCHES = 20;

/**
 * Cut a batch of jobs for the verified wallets checked longest ago. Runs when
 * the board is low, or with `force` when a worker found nothing it may take:
 * the open jobs can all be ones the workers online are barred from (their own
 * wallets, panels they already sit on), and those must not stall the board.
 */
export async function ensureOpenJobs(
  prisma: PrismaClient,
  cfg: WorkConfig,
  now: Date = new Date(),
  force = false,
): Promise<number> {
  const lowWater = force ? cfg.jobBatch * MAX_OPEN_BATCHES : Math.ceil(cfg.jobBatch / 2);
  const open = await prisma.workJob.count({ where: { status: 'open' } });
  if (open >= lowWater) return 0;

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_JOBS})`;
    const stillOpen = await tx.workJob.count({ where: { status: 'open' } });
    if (stillOpen >= lowWater) return 0;

    const recheckBefore = new Date(now.getTime() - cfg.recheckHours * 3600 * 1000);
    const due = await tx.$queryRaw<{ wallet: string }[]>`
      SELECT a.wallet
      FROM "Agent" a
      LEFT JOIN (
        SELECT "subjectWallet", max("createdAt") AS last FROM "WorkJob" GROUP BY "subjectWallet"
      ) j ON j."subjectWallet" = a.wallet
      WHERE a."isVerified" = true
        AND (j.last IS NULL OR j.last < ${recheckBefore})
        AND NOT EXISTS (
          SELECT 1 FROM "WorkJob" o WHERE o."subjectWallet" = a.wallet AND o.status = 'open'
        )
      ORDER BY j.last ASC NULLS FIRST, a."registeredAt" ASC
      LIMIT ${cfg.jobBatch}
    `;
    // Some Agent rows hold placeholder strings instead of real wallets.
    const wallets = due.map((d) => d.wallet).filter(isPubkey);
    if (wallets.length === 0) return 0;

    const toTime = Math.floor((now.getTime() / 1000 - WINDOW_SETTLE_SECONDS) / 60) * 60;
    const fromTime = toTime - cfg.windowDays * 86400;
    const created = await tx.workJob.createMany({
      data: wallets.map((wallet) => ({
        kind: cfg.jobKind,
        subjectWallet: wallet,
        spec: { wallet, fromTime, toTime, maxSignatures: cfg.maxSignatures } satisfies WalletHistorySpec,
        panelSize: cfg.panelSize,
      })),
    });
    return created.count;
  });
}

export interface JobClaimBody {
  workerKey?: unknown;
  timestamp?: unknown;
  signature?: unknown;
}

export async function claimJob(
  prisma: PrismaClient,
  cfg: WorkConfig,
  body: JobClaimBody,
  now: Date = new Date(),
  ipHash: string | null = null,
) {
  if (!cfg.open) throw new WorkError(503, NOT_OPEN);
  const { workerKey, timestamp, signature } = body;
  const slot = await activeSlotForKey(prisma, workerKey);
  if (!isFresh(timestamp)) throw new WorkError(400, 'timestamp must be unix milliseconds within 5 minutes of now');
  if (!verifyMessage(jobClaimMessage(slot.workerKey, timestamp), signature, slot.workerKey)) {
    throw new WorkError(401, 'signature does not match the worker key');
  }

  const agent = await prisma.agent.findUnique({ where: { wallet: slot.wallet }, select: { isVerified: true } });
  if (!agent?.isVerified) throw new WorkError(403, 'Agent is no longer verified');

  await prisma.workSlot.update({ where: { id: slot.id }, data: { lastSeenAt: now, ...(ipHash ? { ipHash } : {}) } });
  await prisma.workAssignment.updateMany({
    where: { status: 'leased', leaseExpiresAt: { lt: now } },
    data: { status: 'expired' },
  });
  // A job whose panel never filled is dropped; its wallet gets a fresh one.
  await prisma.workJob.updateMany({
    where: { status: 'open', createdAt: { lt: new Date(now.getTime() - cfg.jobTtlHours * 3600 * 1000) } },
    data: { status: 'expired', settledAt: now },
  });

  const live = await prisma.workAssignment.count({ where: { workerWallet: slot.wallet, status: 'leased' } });
  if (live >= cfg.maxLeasesPerWorker) {
    throw new WorkError(429, `Finish or let expire your ${live} open jobs before claiming more`);
  }
  const breaker = breakerState(await recentFinished(prisma, slot.wallet, now, BREAKER_FAILURES), now);
  if (breaker.pausedUntil) {
    throw new WorkError(429, `Paused until ${breaker.pausedUntil.toISOString()} after ${BREAKER_FAILURES} failed jobs in a row; see your standing for the reasons`);
  }
  const usedThisHour = await prisma.workAssignment.count({
    where: { workerWallet: slot.wallet, createdAt: { gte: new Date(now.getTime() - 3600 * 1000) } },
  });
  if (usedThisHour >= cfg.maxJobsPerHour) {
    throw new WorkError(429, `Hourly limit of ${cfg.maxJobsPerHour} jobs reached; try again later`);
  }

  await ensureOpenJobs(prisma, cfg, now);
  const related = await relatedWallets(prisma, slot.wallet, cfg);
  const leaseExpiresAt = new Date(now.getTime() + cfg.leaseSeconds * 1000);

  const pickJob = () => prisma.$transaction(async (tx) => {
    // Lock one eligible job so two workers cannot take the same last seat.
    // Part-filled panels go first so jobs settle instead of piling up open;
    // among equals the pick is random, so a worker cannot choose its job.
    const picked = await tx.$queryRaw<{ id: string }[]>`
      SELECT j.id
      FROM "WorkJob" j
      WHERE j.status = 'open'
        AND j."subjectWallet" <> ALL(${related.wallets})
        AND NOT EXISTS (
          SELECT 1 FROM "WorkAssignment" a
          WHERE a."jobId" = j.id AND a."workerWallet" = ${slot.wallet}
        )
        AND (
          SELECT count(*) FROM "WorkAssignment" a
          WHERE a."jobId" = j.id AND a.status <> 'expired'
        ) < j."panelSize"
        AND NOT EXISTS (
          SELECT 1 FROM "WorkAssignment" a
          JOIN "Agent" g ON g.wallet = a."workerWallet"
          WHERE a."jobId" = j.id AND a.status <> 'expired'
            AND (g.owner = ${related.owner} OR a."workerWallet" = ANY(${related.wallets}))
        )
      ORDER BY (
          SELECT count(*) FROM "WorkAssignment" a
          WHERE a."jobId" = j.id AND a.status <> 'expired'
        ) DESC, random()
      LIMIT 1
      FOR UPDATE OF j SKIP LOCKED
    `;
    if (picked.length === 0) return null;
    return tx.workAssignment.create({
      data: { jobId: picked[0].id, workerWallet: slot.wallet, leaseExpiresAt },
      include: { job: { select: { kind: true, spec: true } } },
    });
  });

  let assignment = await pickJob();
  if (!assignment && (await ensureOpenJobs(prisma, cfg, now, true)) > 0) assignment = await pickJob();
  if (!assignment) return { assignment: null, retryAfterSeconds: 30 };
  return {
    assignment: {
      id: assignment.id,
      jobId: assignment.jobId,
      kind: assignment.job.kind,
      spec: assignment.job.spec,
      leaseExpiresAt: assignment.leaseExpiresAt.toISOString(),
    },
  };
}

// ─── Submission and settlement ──────────────────────────────────────────────

export interface SubmitBody {
  workerKey?: unknown;
  result?: unknown;
  timestamp?: unknown;
  signature?: unknown;
}

export async function submitResult(
  prisma: PrismaClient,
  cfg: WorkConfig,
  assignmentId: string,
  body: SubmitBody,
  hooks: SettleHooks,
  now: Date = new Date(),
) {
  const slot = await activeSlotForKey(prisma, body.workerKey);
  const assignment = await prisma.workAssignment.findUnique({ where: { id: assignmentId }, include: { job: true } });
  if (!assignment || assignment.workerWallet !== slot.wallet) throw new WorkError(404, 'No such assignment for this worker');
  if (assignment.status !== 'leased') throw new WorkError(409, `Assignment is already ${assignment.status}`);
  if (assignment.leaseExpiresAt < now) throw new WorkError(409, 'Lease expired');
  const kind = jobKind(assignment.job.kind);
  if (!kind || !kind.isValidSpec(assignment.job.spec)) throw new WorkError(409, 'Job is not readable');

  const result = kind.canonical(body.result, assignment.job.spec);
  if (!result) throw new WorkError(400, 'result is not a well-formed answer to this job');
  // The hash is always ours: a worker cannot claim agreement it did not compute.
  const resultHash = kind.hash(result);

  if (!isFresh(body.timestamp)) throw new WorkError(400, 'timestamp must be unix milliseconds within 5 minutes of now');
  if (!verifyMessage(submitMessage(assignmentId, resultHash, body.timestamp), body.signature, slot.workerKey)) {
    throw new WorkError(401, 'signature does not match the worker key and result');
  }

  // Guarded on status so a double submit cannot overwrite an answer.
  const updated = await prisma.workAssignment.updateMany({
    where: { id: assignmentId, status: 'leased' },
    data: { status: 'submitted', result: result as unknown as Prisma.InputJsonValue, resultHash, submittedAt: now },
  });
  if (updated.count === 0) throw new WorkError(409, 'Assignment is no longer open');
  await prisma.workSlot.update({ where: { id: slot.id }, data: { lastSeenAt: now } });

  const jobStatus = await settleIfComplete(prisma, cfg, assignment.jobId, hooks, now);
  return { resultHash, jobStatus };
}

/** Pure: do all panel answers match? */
export function panelAgrees(hashes: Array<string | null>): boolean {
  return hashes.length > 0 && hashes.every((h) => h !== null && h === hashes[0]);
}

async function settleIfComplete(
  prisma: PrismaClient,
  cfg: WorkConfig,
  jobId: string,
  hooks: SettleHooks,
  now: Date,
): Promise<string> {
  const { reference, onAccepted } = hooks;
  let agreed: { kind: string; result: JobResult } | null = null;
  const status = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ status: string; panelSize: number; kind: string }[]>`
      SELECT status, "panelSize", kind FROM "WorkJob" WHERE id = ${jobId} FOR UPDATE
    `;
    const job = locked[0];
    if (!job || job.status !== 'open') return job?.status ?? 'open';

    const submitted = await tx.workAssignment.findMany({
      where: { jobId, status: 'submitted' },
      select: { id: true, workerWallet: true, resultHash: true, result: true },
    });
    if (submitted.length < job.panelSize) return 'open';

    const wallets = submitted.map((s) => s.workerWallet);
    if (panelAgrees(submitted.map((s) => s.resultHash))) {
      await tx.workJob.update({
        where: { id: jobId },
        data: {
          status: 'accepted',
          resultHash: submitted[0].resultHash,
          result: submitted[0].result as Prisma.InputJsonValue,
          settledAt: now,
        },
      });
      await tx.workAssignment.updateMany({ where: { jobId, status: 'submitted' }, data: { verdict: 'agreed' } });
      await tx.workSlot.updateMany({ where: { wallet: { in: wallets } }, data: { acceptedCount: { increment: 1 } } });
      agreed = { kind: job.kind, result: submitted[0].result as unknown as JobResult };
      return 'accepted';
    }
    await tx.workJob.update({ where: { id: jobId }, data: { status: 'disagreed', settledAt: now } });
    await tx.workAssignment.updateMany({ where: { jobId, status: 'submitted' }, data: { verdict: 'split' } });
    await tx.workSlot.updateMany({ where: { wallet: { in: wallets } }, data: { disagreedCount: { increment: 1 } } });
    return 'disagreed';
  });

  const accepted = agreed as { kind: string; result: JobResult } | null;
  if (accepted && onAccepted) {
    onAccepted({ id: jobId, ...accepted }).catch((err) =>
      console.error(`[work] could not apply accepted job ${jobId}:`, err instanceof Error ? err.message : err),
    );
  }

  const check = status === 'disagreed' || (status === 'accepted' && Math.random() < cfg.spotCheckRate);
  if (reference && check) {
    // Our own run takes RPC time; the worker's response does not wait for it.
    applyReference(prisma, jobId, reference).catch((err) =>
      console.error(`[work] reference check failed for job ${jobId}:`, err instanceof Error ? err.message : err),
    );
  }
  return status;
}

/** Re-run a settled job ourselves and mark each panel answer against it. */
export async function applyReference(prisma: PrismaClient, jobId: string, reference: ReferenceRunner): Promise<void> {
  const job = await prisma.workJob.findUnique({ where: { id: jobId } });
  const kind = job ? jobKind(job.kind) : null;
  if (!job || !kind || job.referenceHash || !kind.isValidSpec(job.spec)) return;
  if (job.status !== 'accepted' && job.status !== 'disagreed') return;
  const referenceHash = kind.hash(await reference(job.kind, job.spec));

  await prisma.$transaction(async (tx) => {
    const claimed = await tx.workJob.updateMany({
      where: { id: jobId, referenceHash: null },
      data: { referenceHash, referenceAt: new Date() },
    });
    if (claimed.count === 0) return;

    const submitted = await tx.workAssignment.findMany({
      where: { jobId, status: 'submitted' },
      select: { id: true, workerWallet: true, resultHash: true },
    });
    const right = submitted.filter((s) => s.resultHash === referenceHash);
    const wrong = submitted.filter((s) => s.resultHash !== referenceHash);
    if (right.length) {
      await tx.workAssignment.updateMany({ where: { id: { in: right.map((s) => s.id) } }, data: { verdict: 'correct' } });
    }
    if (wrong.length) {
      await tx.workAssignment.updateMany({ where: { id: { in: wrong.map((s) => s.id) } }, data: { verdict: 'wrong' } });
      await tx.workSlot.updateMany({
        where: { wallet: { in: wrong.map((s) => s.workerWallet) } },
        data: { wrongCount: { increment: 1 } },
      });
    }
    if (job.status === 'accepted' && job.resultHash !== referenceHash) {
      // The whole panel agreed on something our own run contradicts.
      await tx.workJob.update({ where: { id: jobId }, data: { status: 'overturned' } });
      await tx.workSlot.updateMany({
        where: { wallet: { in: submitted.map((s) => s.workerWallet) } },
        data: { acceptedCount: { decrement: 1 } },
      });
    }
  });
}

// ─── Reputation ─────────────────────────────────────────────────────────────

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Write one reputation row per worker for one UTC day, through the same
 * Feedback table the partner outcome door uses, so the scorer needs no change.
 * A day with any wrong answer is negative; otherwise it is positive once the
 * worker reached the minimum accepted count. Idempotent on sourceKey.
 */
export async function settleDailyEvidence(
  prisma: PrismaClient,
  cfg: WorkConfig,
  day: Date,
): Promise<{ enabled: boolean; day: string; positive: number; negative: number; skipped: number }> {
  const label = utcDay(day);
  const out = { enabled: cfg.evidenceWeight !== null, day: label, positive: 0, negative: 0, skipped: 0 };
  if (cfg.evidenceWeight === null) return out;

  const start = new Date(`${label}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 86400 * 1000);
  const rows = await prisma.workAssignment.groupBy({
    by: ['workerWallet', 'verdict'],
    where: { status: 'submitted', submittedAt: { gte: start, lt: end }, verdict: { not: null } },
    _count: { _all: true },
  });

  const perWorker = new Map<string, { good: number; wrong: number }>();
  for (const r of rows) {
    const w = perWorker.get(r.workerWallet) ?? { good: 0, wrong: 0 };
    if (r.verdict === 'agreed' || r.verdict === 'correct') w.good += r._count._all;
    if (r.verdict === 'wrong') w.wrong += r._count._all;
    perWorker.set(r.workerWallet, w);
  }

  for (const [wallet, counts] of perWorker) {
    const negative = counts.wrong > 0;
    if (!negative && counts.good < cfg.evidenceMinAccepted) {
      out.skipped++;
      continue;
    }
    const outcome = negative ? `${counts.wrong} wrong of ${counts.good + counts.wrong} checked` : `${counts.good} accepted`;
    try {
      await prisma.feedback.create({
        data: {
          fromWallet: SYSTEM_WALLET,
          toWallet: wallet,
          score: negative ? EVIDENCE_SCORE_NEGATIVE : EVIDENCE_SCORE_POSITIVE,
          weight: cfg.evidenceWeight,
          comment: `[${EVIDENCE_SOURCE}] wallet checks ${label}: ${outcome}`,
          signature: `trusted:${EVIDENCE_SOURCE}:${wallet}:${label}`,
          fromIsVerified: true,
          sourceKey: `src:${EVIDENCE_SOURCE}:${wallet}:${label}`,
          createdAt: new Date(end.getTime() - 1),
        },
      });
      if (negative) out.negative++;
      else out.positive++;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') out.skipped++;
      else throw err;
    }
  }
  return out;
}

// ─── Public read side ───────────────────────────────────────────────────────

export async function getStats(prisma: PrismaClient, cfg: WorkConfig, now: Date = new Date()) {
  const dayAgo = new Date(now.getTime() - 86400 * 1000);
  const [slotsClaimed, workersOnline, open, accepted, accepted24h, disagreed24h, overturned, checked] = await Promise.all([
    prisma.workSlot.count({ where: { status: 'active' } }),
    prisma.workSlot.count({ where: { status: 'active', lastSeenAt: { gte: new Date(now.getTime() - ONLINE_WINDOW_MS) } } }),
    prisma.workJob.count({ where: { status: 'open' } }),
    prisma.workJob.count({ where: { status: 'accepted' } }),
    prisma.workJob.count({ where: { status: 'accepted', settledAt: { gte: dayAgo } } }),
    prisma.workJob.count({ where: { status: 'disagreed', settledAt: { gte: dayAgo } } }),
    prisma.workJob.count({ where: { status: 'overturned' } }),
    prisma.workJob.findMany({ where: { status: 'accepted' }, distinct: ['subjectWallet'], select: { subjectWallet: true } }),
  ]);
  return {
    open: cfg.open,
    slots: { claimed: slotsClaimed, cap: cfg.slotCap },
    workersOnline,
    panelSize: cfg.panelSize,
    jobs: { open, accepted, accepted24h, disagreed24h, overturned },
    walletsChecked: checked.length,
    reputationWrites: cfg.evidenceWeight !== null,
    rewardSplit: { workersBps: cfg.workersBps, lockBps: cfg.lockBps },
    computedAt: now.toISOString(),
  };
}

async function namesFor(prisma: PrismaClient, wallets: string[]): Promise<Map<string, string | null>> {
  const agents = await prisma.agent.findMany({ where: { wallet: { in: [...new Set(wallets)] } }, select: { wallet: true, name: true } });
  return new Map(agents.map((a) => [a.wallet, a.name]));
}

export async function getFeed(prisma: PrismaClient, limit: number) {
  const jobs = await prisma.workJob.findMany({
    where: { status: { in: ['accepted', 'disagreed', 'overturned'] } },
    orderBy: { settledAt: 'desc' },
    take: limit,
    include: { assignments: { where: { status: 'submitted' }, select: { workerWallet: true, verdict: true } } },
  });
  const names = await namesFor(prisma, jobs.flatMap((j) => [j.subjectWallet, ...j.assignments.map((a) => a.workerWallet)]));
  return jobs.map((j) => {
    const r = j.status === 'accepted' ? (j.result as Partial<JobResult> | null) : null;
    return {
      jobId: j.id,
      kind: j.kind,
      status: j.status,
      settledAt: j.settledAt?.toISOString() ?? null,
      subject: { wallet: j.subjectWallet, name: names.get(j.subjectWallet) ?? null },
      summary: r ? { txCount: r.txCount, activeDays: r.activeDays, truncated: r.truncated } : null,
      checkedByUs: j.referenceHash !== null,
      panel: j.assignments.map((a) => ({ wallet: a.workerWallet, name: names.get(a.workerWallet) ?? null, verdict: a.verdict })),
    };
  });
}

export async function getWorkers(prisma: PrismaClient, limit: number, now: Date = new Date()) {
  const slots = await prisma.workSlot.findMany({
    where: { status: 'active' },
    orderBy: [{ acceptedCount: 'desc' }, { claimedAt: 'asc' }],
    take: limit,
  });
  const names = await namesFor(prisma, slots.map((s) => s.wallet));
  return slots.map((s) => ({
    number: s.number,
    wallet: s.wallet,
    name: names.get(s.wallet) ?? null,
    accepted: s.acceptedCount,
    disagreed: s.disagreedCount,
    wrong: s.wrongCount,
    online: s.lastSeenAt !== null && now.getTime() - s.lastSeenAt.getTime() <= ONLINE_WINDOW_MS,
    claimedAt: s.claimedAt.toISOString(),
  }));
}

export async function getSlot(prisma: PrismaClient, wallet: string) {
  const slot = await prisma.workSlot.findUnique({ where: { wallet } });
  if (!slot) return null;
  const paid = await prisma.workPayout.aggregate({ where: { workerWallet: wallet, status: 'paid' }, _sum: { lamports: true } });
  return {
    number: slot.number,
    paidLamports: (paid._sum.lamports ?? 0n).toString(),
    wallet: slot.wallet,
    workerKey: slot.workerKey,
    status: slot.status,
    accepted: slot.acceptedCount,
    disagreed: slot.disagreedCount,
    wrong: slot.wrongCount,
    claimedAt: slot.claimedAt.toISOString(),
    lastSeenAt: slot.lastSeenAt?.toISOString() ?? null,
  };
}

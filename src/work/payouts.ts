/**
 * Work loop — reward periods and worker payouts.
 *
 * An operator enters how much the protocol earned in a period. A published
 * share of that is the worker pool, split across workers in proportion to
 * their accepted work in the period; another published share is set aside to
 * buy and lock the token. This file only computes and records. Sending SOL is
 * a separate, deliberate step (scripts/work-payout.ts), never automatic.
 */

import type { PrismaClient } from '@prisma/client';
import { getV8ReputationBatch } from '../reputation-v0.8/read.js';
import { TX_SIGNATURE_RE } from './auth.js';
import { WorkError, rateFor, verdictCounts, type WorkConfig } from './engine.js';

// pg_advisory_xact_lock key: one reward period is recorded at a time.
const LOCK_EPOCHS = 74110003;

// One answer our own check contradicted cancels this many accepted ones.
export const WRONG_PENALTY = 10;

export function unitsFor(good: number, wrong: number): number {
  return Math.max(0, good - wrong * WRONG_PENALTY);
}

export interface Share {
  wallet: string;
  units: number;
  lamports: bigint;
  /** False when the share is below the minimum worth sending. */
  payable: boolean;
}

/** Pure: split `pool` in proportion to units. Rounds down; dust stays in the pool. */
export function computeShares(pool: bigint, units: Map<string, number>, minLamports: bigint): Share[] {
  const total = [...units.values()].reduce((a, b) => a + b, 0);
  const out: Share[] = [];
  for (const [wallet, u] of units) {
    const lamports = total > 0 ? (pool * BigInt(u)) / BigInt(total) : 0n;
    out.push({ wallet, units: u, lamports, payable: lamports > 0n && lamports >= minLamports });
  }
  return out.sort((a, b) => (a.lamports === b.lamports ? a.wallet.localeCompare(b.wallet) : a.lamports > b.lamports ? -1 : 1));
}

export interface EpochInput {
  label?: unknown;
  startsAt?: unknown;
  endsAt?: unknown;
  rewardsLamports?: unknown;
}

function parseDate(v: unknown): Date | null {
  if (typeof v !== 'string') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Record a reward period and each worker's share of it. One period per label. */
export async function createEpoch(prisma: PrismaClient, cfg: WorkConfig, input: EpochInput, now: Date = new Date()) {
  const { label } = input;
  const startsAt = parseDate(input.startsAt);
  const endsAt = parseDate(input.endsAt);
  if (typeof label !== 'string' || !/^[A-Za-z0-9._-]{1,40}$/.test(label)) throw new WorkError(400, 'label must be 1-40 letters, digits, dot, dash or underscore');
  if (!startsAt || !endsAt || startsAt >= endsAt) throw new WorkError(400, 'startsAt and endsAt must be ISO timestamps, start before end');
  if (endsAt > now) throw new WorkError(400, 'the period must have ended: work can still be checked and overturned until it does');
  if (typeof input.rewardsLamports !== 'string' || !/^(0|[1-9]\d{0,17})$/.test(input.rewardsLamports)) {
    throw new WorkError(400, 'rewardsLamports must be a whole number of lamports, as a string');
  }
  const rewards = BigInt(input.rewardsLamports);

  const counts = await verdictCounts(prisma, startsAt, endsAt);

  const workerPool = (rewards * BigInt(cfg.workersBps)) / 10000n;
  const lock = (rewards * BigInt(cfg.lockBps)) / 10000n;
  // Each worker's tier is read now and kept on its payout row, so a later
  // change of tier never rewrites a period that has been recorded.
  const tiers = Object.keys(cfg.tierRates).length ? await tiersFor(prisma, [...counts.keys()]) : new Map<string, string>();
  const tierOf = (w: string) => tiers.get(w) ?? 'unranked';
  const units = new Map([...counts].map(([w, c]) => [w, unitsFor(c.good, c.wrong) * rateFor(cfg, tierOf(w))] as const));
  const shares = computeShares(workerPool, units, BigInt(cfg.minPayoutLamports));

  return prisma.$transaction(async (tx) => {
    // The overlap check and the insert must not interleave with another
    // operator's: two overlapping periods would pay the same work twice.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_EPOCHS})`;
    const overlap = await tx.workEpoch.findFirst({ where: { startsAt: { lt: endsAt }, endsAt: { gt: startsAt } }, select: { label: true } });
    if (overlap) throw new WorkError(409, `this period overlaps ${overlap.label}; work would be paid twice`);
    if (await tx.workEpoch.findUnique({ where: { label } })) throw new WorkError(409, `period ${label} already exists`);
    return tx.workEpoch.create({
    data: {
      label,
      startsAt,
      endsAt,
      rewardsLamports: rewards,
      workersBps: cfg.workersBps,
      lockBps: cfg.lockBps,
      workerPoolLamports: workerPool,
      lockLamports: lock,
      acceptedUnits: BigInt(shares.reduce((a, s) => a + s.units, 0)),
      payouts: {
        create: shares.map((s) => ({
          workerWallet: s.wallet,
          goodCount: counts.get(s.wallet)!.good,
          wrongCount: counts.get(s.wallet)!.wrong,
          tier: tierOf(s.wallet),
          ratePct: rateFor(cfg, tierOf(s.wallet)),
          units: BigInt(s.units),
          lamports: s.lamports,
          status: s.payable ? 'pending' : 'skipped',
        })),
      },
    },
    include: { payouts: true },
    });
  });
}

async function tiersFor(prisma: PrismaClient, wallets: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const batch = await getV8ReputationBatch(prisma, wallets);
  for (const w of wallets) out.set(w, batch.get(w)?.tier ?? 'unranked');
  return out;
}

export async function recordLockTx(prisma: PrismaClient, label: string, tx: unknown) {
  if (typeof tx !== 'string' || !TX_SIGNATURE_RE.test(tx)) throw new WorkError(400, 'tx must be a Solana transaction signature');
  const epoch = await prisma.workEpoch.findUnique({ where: { label } });
  if (!epoch) throw new WorkError(404, 'No such period');
  return prisma.workEpoch.update({ where: { label }, data: { lockTx: tx } });
}

/** Public view: recent periods with every payout, amounts as lamport strings. */
export async function getPayouts(prisma: PrismaClient, limit: number) {
  const epochs = await prisma.workEpoch.findMany({
    orderBy: { endsAt: 'desc' },
    take: limit,
    include: { payouts: { orderBy: { lamports: 'desc' } } },
  });
  const agents = await prisma.agent.findMany({
    where: { wallet: { in: [...new Set(epochs.flatMap((e) => e.payouts.map((p) => p.workerWallet)))] } },
    select: { wallet: true, name: true },
  });
  const names = new Map(agents.map((a) => [a.wallet, a.name]));
  return epochs.map((e) => ({
    label: e.label,
    startsAt: e.startsAt.toISOString(),
    endsAt: e.endsAt.toISOString(),
    rewardsLamports: e.rewardsLamports.toString(),
    split: { workersBps: e.workersBps, lockBps: e.lockBps },
    workerPoolLamports: e.workerPoolLamports.toString(),
    lockLamports: e.lockLamports.toString(),
    lockTx: e.lockTx,
    paidLamports: e.payouts.filter((p) => p.status === 'paid').reduce((a, p) => a + p.lamports, 0n).toString(),
    payouts: e.payouts.map((p) => ({
      wallet: p.workerWallet,
      name: names.get(p.workerWallet) ?? null,
      good: p.goodCount,
      wrong: p.wrongCount,
      tier: p.tier,
      ratePct: p.ratePct,
      lamports: p.lamports.toString(),
      status: p.status,
      tx: p.txSignature,
    })),
  }));
}

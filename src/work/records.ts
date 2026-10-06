/**
 * Work loop — the daily record of accepted work.
 *
 * Each UTC day's accepted jobs are folded into one Merkle root. A leaf is a
 * job id and the hash of its agreed answer, so anyone holding an answer can
 * check it against the root, and the root is small enough to put on chain.
 * The root is frozen the first time it is asked for after the day has ended.
 */

import { createHash } from 'crypto';
import type { PrismaClient } from '@prisma/client';
import { TX_SIGNATURE_RE } from './auth.js';
import { WorkError } from './engine.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function leafHash(jobId: string, resultHash: string): string {
  return sha(`leaf:${jobId}:${resultHash}`);
}

function parent(left: string, right: string): string {
  return sha(`node:${left}:${right}`);
}

/** Pure: Merkle root of the leaves in the order given. An odd node is carried up unchanged. */
export function merkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return sha('empty');
  let level = leaves;
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? parent(level[i], level[i + 1]) : level[i]);
    level = next;
  }
  return level[0];
}

export interface ProofStep {
  hash: string;
  side: 'left' | 'right';
}

/** Pure: the sibling path from leaf `index` to the root. */
export function merkleProof(leaves: string[], index: number): ProofStep[] {
  const path: ProofStep[] = [];
  let level = leaves;
  let i = index;
  while (level.length > 1) {
    const sibling = i % 2 === 0 ? i + 1 : i - 1;
    if (sibling < level.length) path.push({ hash: level[sibling], side: i % 2 === 0 ? 'right' : 'left' });
    const next: string[] = [];
    for (let j = 0; j < level.length; j += 2) next.push(j + 1 < level.length ? parent(level[j], level[j + 1]) : level[j]);
    level = next;
    i = Math.floor(i / 2);
  }
  return path;
}

export function verifyProof(leaf: string, path: ProofStep[], root: string): boolean {
  let h = leaf;
  for (const step of path) h = step.side === 'right' ? parent(h, step.hash) : parent(step.hash, h);
  return h === root;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function dayBounds(day: string): { start: Date; end: Date } {
  if (!DAY.test(day)) throw new WorkError(400, 'day must be YYYY-MM-DD');
  const start = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || start.toISOString().slice(0, 10) !== day) throw new WorkError(400, 'day is not a real date');
  return { start, end: new Date(start.getTime() + 86400 * 1000) };
}

/**
 * The day's accepted jobs, in a fixed order (by job id). A job overturned
 * after the day closed stays in the list, with its status, so the frozen
 * root still matches and every other job's proof still verifies.
 */
async function dayLeaves(prisma: PrismaClient, day: string) {
  const { start, end } = dayBounds(day);
  const jobs = await prisma.workJob.findMany({
    where: { status: { in: ['accepted', 'overturned'] }, settledAt: { gte: start, lt: end }, resultHash: { not: null } },
    orderBy: { id: 'asc' },
    select: { id: true, resultHash: true, subjectWallet: true, kind: true, status: true },
  });
  return jobs.map((j) => ({ jobId: j.id, kind: j.kind, subject: j.subjectWallet, status: j.status, resultHash: j.resultHash as string, leaf: leafHash(j.id, j.resultHash as string) }));
}

/** The record for one UTC day. A day that has ended is frozen on first read. */
export async function getDayRecord(prisma: PrismaClient, day: string, now: Date = new Date()) {
  const { end } = dayBounds(day);
  const leaves = await dayLeaves(prisma, day);
  const ended = end <= now;
  let frozen = await prisma.workDayRoot.findUnique({ where: { day } });
  if (!frozen && ended) {
    const root = merkleRoot(leaves.map((l) => l.leaf));
    frozen = await prisma.workDayRoot.upsert({ where: { day }, update: {}, create: { day, root, count: leaves.length } });
  }
  return {
    day,
    final: Boolean(frozen),
    root: frozen?.root ?? merkleRoot(leaves.map((l) => l.leaf)),
    count: frozen?.count ?? leaves.length,
    anchorTx: frozen?.anchorTx ?? null,
    leaves: leaves.map(({ jobId, kind, subject, status, resultHash }) => ({ jobId, kind, subject, status, resultHash })),
  };
}

/** Proof that one accepted job is in its day's record. */
export async function getJobProof(prisma: PrismaClient, jobId: string) {
  const job = await prisma.workJob.findUnique({ where: { id: jobId }, select: { status: true, settledAt: true, resultHash: true, result: true } });
  if (!job || !job.settledAt || !job.resultHash || (job.status !== 'accepted' && job.status !== 'overturned')) {
    throw new WorkError(404, 'No accepted job with that id');
  }
  const day = job.settledAt.toISOString().slice(0, 10);
  const record = await getDayRecord(prisma, day);
  const leaves = record.leaves.map((l) => leafHash(l.jobId, l.resultHash));
  const index = record.leaves.findIndex((l) => l.jobId === jobId);
  if (index < 0) throw new WorkError(404, 'This job is not in its day record');
  return {
    jobId,
    status: job.status,
    day,
    final: record.final,
    root: record.root,
    anchorTx: record.anchorTx,
    leaf: leaves[index],
    proof: merkleProof(leaves, index),
    result: job.result,
  };
}

export async function recordAnchorTx(prisma: PrismaClient, day: string, tx: unknown) {
  if (typeof tx !== 'string' || !TX_SIGNATURE_RE.test(tx)) throw new WorkError(400, 'tx must be a Solana transaction signature');
  dayBounds(day);
  const row = await prisma.workDayRoot.findUnique({ where: { day } });
  if (!row) throw new WorkError(404, 'That day has no frozen record yet');
  return prisma.workDayRoot.update({ where: { day }, data: { anchorTx: tx } });
}

/** Freeze yesterday's record if nobody has read it yet. Safe to call often. */
export async function freezeYesterday(prisma: PrismaClient, now: Date = new Date()): Promise<void> {
  await getDayRecord(prisma, new Date(now.getTime() - 86400 * 1000).toISOString().slice(0, 10), now);
}

// ─── Announcements ──────────────────────────────────────────────────────────

export async function postUpdate(prisma: PrismaClient, input: { title?: unknown; body?: unknown }) {
  const { title, body } = input;
  if (typeof title !== 'string' || title.trim().length === 0 || title.length > 120) throw new WorkError(400, 'title is required (max 120 characters)');
  if (typeof body !== 'string' || body.trim().length === 0 || body.length > 2000) throw new WorkError(400, 'body is required (max 2000 characters)');
  return prisma.workUpdate.create({ data: { title: title.trim(), body: body.trim() } });
}

export async function getUpdates(prisma: PrismaClient, limit: number) {
  const rows = await prisma.workUpdate.findMany({ orderBy: { createdAt: 'desc' }, take: limit });
  return rows.map((u) => ({ id: u.id, title: u.title, body: u.body, at: u.createdAt.toISOString() }));
}

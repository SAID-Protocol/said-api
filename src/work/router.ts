/**
 * Work loop — HTTP surface.
 *
 *   GET  /api/work/stats                  slots, workers online, job counts
 *   GET  /api/work/feed?limit=50          recently settled jobs, newest first
 *   GET  /api/work/workers?limit=100      slot holders by accepted work
 *   GET  /api/work/slots/:wallet          one agent's slot
 *   GET  /api/work/protocol               message formats, limits and download links for worker authors
 *   POST /api/work/slots/claim            agent wallet binds a worker key to a slot
 *   POST /api/work/jobs/claim             worker takes one job on a lease
 *   POST /api/work/assignments/:id/submit worker returns its answer
 *   GET  /api/work/payouts?limit=12       reward periods and every worker payout
 *   GET  /api/work/updates?limit=10       operator announcements, newest first
 *   GET  /api/work/records/:day           one UTC day's accepted work and its Merkle root
 *   GET  /api/work/jobs/:id/proof         proof that an accepted job is in its day's record
 *   POST /api/work/admin/updates          post an announcement (x-admin-secret)
 *   POST /api/work/admin/records/:day/anchor  attach the on-chain transaction carrying a day's root
 *   POST /api/work/admin/epochs           record a reward period (x-admin-secret)
 *   POST /api/work/admin/epochs/:label/lock  attach the buy-and-lock transaction
 *
 * Reads are public. Writes are signed: the first by the agent wallet, the
 * rest by the worker key (see auth.ts). Admin routes take the API's admin
 * secret and answer 404 without it.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { PrismaClient } from '@prisma/client';
import type { Connection } from '@solana/web3.js';
import {
  WorkError,
  claimJob,
  claimSlot,
  getFeed,
  getSlot,
  getStats,
  getWorkers,
  loadWorkConfig,
  settleDailyEvidence,
  submitResult,
  type SettleHooks,
} from './engine.js';
import { JOB_KINDS, jobKind } from './kinds.js';
import { createEpoch, getPayouts, recordLockTx } from './payouts.js';
import { freezeYesterday, getDayRecord, getJobProof, getUpdates, postUpdate, recordAnchorTx } from './records.js';
import { WALLET_ACTIVITY_KIND, applyActivityResult, type WalletActivityResult } from './wallet-activity-job.js';
import { SIGNATURE_WINDOW_MS } from './auth.js';
import { PUBLIC_API_URL, loadSkill, loadWorkerBundle } from './distribution.js';

const EVIDENCE_INTERVAL_MS = 60 * 60 * 1000;

function clampLimit(raw: string | undefined, fallback: number, max: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
}

async function readJson(c: Context): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    return body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function fail(c: Context, err: unknown) {
  if (err instanceof WorkError) return c.json({ error: err.message }, err.status);
  throw err;
}

export function createWorkRouter(prisma: PrismaClient, connection: Connection): Hono {
  const router = new Hono();
  const cfg = loadWorkConfig(process.env);
  const hooks: SettleHooks = {
    reference: (kind, spec) => {
      const k = jobKind(kind);
      if (!k) throw new Error(`unknown job kind ${kind}`);
      return k.run(connection, spec);
    },
    onAccepted: async (job) => {
      if (cfg.applyActivity && job.kind === WALLET_ACTIVITY_KIND) {
        await applyActivityResult(prisma, job.result as WalletActivityResult, cfg.windowDays);
      }
    },
  };
  const isAdmin = (c: Context) => {
    const secret = process.env.ADMIN_SECRET;
    return Boolean(secret) && c.req.header('x-admin-secret') === secret;
  };

  router.get('/stats', async (c) => c.json(await getStats(prisma, cfg)));

  router.get('/feed', async (c) => c.json({ jobs: await getFeed(prisma, clampLimit(c.req.query('limit'), 50, 200)) }));

  router.get('/workers', async (c) =>
    c.json({ workers: await getWorkers(prisma, clampLimit(c.req.query('limit'), 100, 500)) }),
  );

  router.get('/slots/:wallet', async (c) => {
    const slot = await getSlot(prisma, c.req.param('wallet'));
    return slot ? c.json(slot) : c.json({ error: 'No slot for this wallet' }, 404);
  });

  router.get('/protocol', async (c) => {
    const worker = await loadWorkerBundle();
    return c.json({
      skill: `${PUBLIC_API_URL}/work/skill.md`,
      worker: worker ? { url: `${PUBLIC_API_URL}/work/said-worker.cjs`, sha256: worker.sha256 } : null,
      jobKinds: Object.keys(JOB_KINDS),
      currentJobKind: cfg.jobKind,
      panelSize: cfg.panelSize,
      leaseSeconds: cfg.leaseSeconds,
      maxLeasesPerWorker: cfg.maxLeasesPerWorker,
      signatureWindowMs: SIGNATURE_WINDOW_MS,
      messages: {
        claimSlot: 'SAID:work:claim-slot:<wallet>:<workerKey>:<timestamp>  (signed by the agent wallet)',
        claimJob: 'SAID:work:claim-job:<workerKey>:<timestamp>  (signed by the worker key)',
        submit: 'SAID:work:submit:<assignmentId>:<resultHash>:<timestamp>  (signed by the worker key)',
      },
      notes: 'Signatures are base58 Ed25519. Timestamps are unix milliseconds. Reference worker: worker/said-worker.ts.',
    });
  });

  router.post('/slots/claim', async (c) => {
    try {
      const { slot, created } = await claimSlot(prisma, cfg, await readJson(c));
      return c.json({ wallet: slot.wallet, workerKey: slot.workerKey, claimedAt: slot.claimedAt.toISOString(), created }, created ? 201 : 200);
    } catch (err) {
      return fail(c, err);
    }
  });

  router.post('/jobs/claim', async (c) => {
    try {
      return c.json(await claimJob(prisma, cfg, await readJson(c)));
    } catch (err) {
      return fail(c, err);
    }
  });

  router.post('/assignments/:id/submit', async (c) => {
    try {
      return c.json(await submitResult(prisma, cfg, c.req.param('id'), await readJson(c), hooks));
    } catch (err) {
      return fail(c, err);
    }
  });

  router.get('/payouts', async (c) => c.json({ epochs: await getPayouts(prisma, clampLimit(c.req.query('limit'), 12, 52)) }));

  router.post('/admin/epochs', async (c) => {
    if (!isAdmin(c)) return c.json({ error: 'Not found' }, 404);
    try {
      const epoch = await createEpoch(prisma, cfg, await readJson(c));
      return c.json(
        {
          label: epoch.label,
          workerPoolLamports: epoch.workerPoolLamports.toString(),
          lockLamports: epoch.lockLamports.toString(),
          payouts: epoch.payouts.length,
          pending: epoch.payouts.filter((p) => p.status === 'pending').length,
        },
        201,
      );
    } catch (err) {
      return fail(c, err);
    }
  });

  router.post('/admin/epochs/:label/lock', async (c) => {
    if (!isAdmin(c)) return c.json({ error: 'Not found' }, 404);
    try {
      const epoch = await recordLockTx(prisma, c.req.param('label'), (await readJson(c)).tx);
      return c.json({ label: epoch.label, lockTx: epoch.lockTx });
    } catch (err) {
      return fail(c, err);
    }
  });

  router.get('/updates', async (c) => c.json({ updates: await getUpdates(prisma, clampLimit(c.req.query('limit'), 10, 50)) }));

  router.get('/records/:day', async (c) => {
    try {
      return c.json(await getDayRecord(prisma, c.req.param('day')));
    } catch (err) {
      return fail(c, err);
    }
  });

  router.get('/jobs/:id/proof', async (c) => {
    try {
      return c.json(await getJobProof(prisma, c.req.param('id')));
    } catch (err) {
      return fail(c, err);
    }
  });

  router.post('/admin/updates', async (c) => {
    if (!isAdmin(c)) return c.json({ error: 'Not found' }, 404);
    try {
      const u = await postUpdate(prisma, await readJson(c));
      return c.json({ id: u.id, title: u.title, at: u.createdAt.toISOString() }, 201);
    } catch (err) {
      return fail(c, err);
    }
  });

  router.post('/admin/records/:day/anchor', async (c) => {
    if (!isAdmin(c)) return c.json({ error: 'Not found' }, 404);
    try {
      const row = await recordAnchorTx(prisma, c.req.param('day'), (await readJson(c)).tx);
      return c.json({ day: row.day, root: row.root, anchorTx: row.anchorTx });
    } catch (err) {
      return fail(c, err);
    }
  });

  // Close yesterday's record even if nobody asks for it.
  const freeze = () => freezeYesterday(prisma).catch((err) => console.error('[work] could not freeze the daily record:', err instanceof Error ? err.message : err));
  freeze();
  setInterval(freeze, EVIDENCE_INTERVAL_MS);

  // Daily reputation rows. Hourly so a restart never skips a day; each run
  // re-settles yesterday, and the sourceKey makes repeats a no-op.
  if (cfg.evidenceWeight !== null) {
    const tick = () =>
      settleDailyEvidence(prisma, cfg, new Date(Date.now() - 86400 * 1000))
        .then((r) => {
          if (r.positive || r.negative) console.log(`[work] reputation rows for ${r.day}: +${r.positive} / -${r.negative}`);
        })
        .catch((err) => console.error('[work] daily reputation settle failed:', err instanceof Error ? err.message : err));
    tick();
    setInterval(tick, EVIDENCE_INTERVAL_MS);
  } else {
    console.log('[work] WORK_EVIDENCE_WEIGHT not set — work results are stored but not written to reputation');
  }

  return router;
}

/**
 * Sync FairScale (partner) cross-platform reputation into AgentFairScale.
 *
 * The old score-engine fetched FairScale but kept only {score, max} (lossy).
 * This stores the FULL response so v0.8 can ingest the rich, SAID-INDEPENDENT
 * signals — peer_reputation, red_flags, badges — and deliberately NOT the
 * overall score (FairScale already reads SAID's score, so scoring it back
 * would create a circular loop).
 *
 * Endpoint:  GET {FAIRSCALE_API_URL}/score?wallet=<wallet>   header: fairkey
 *   NOTE: the legacy URL (api.fairscale.xyz/agents) 301-redirects to
 *   agent-api.fairscale.xyz/v1 — update FAIRSCALE_API_URL to the new base to
 *   skip the redirect. We follow redirects + send a browser UA either way
 *   (the endpoint is Cloudflare-protected).
 *
 * Usage:
 *   DATABASE_URL=... FAIRSCALE_API_URL=... FAIRSCALE_API_KEY=... \
 *     npx tsx scripts/sync-fairscale.ts
 * Optional env: LIMIT, CONCURRENCY (default 4).
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const API_URL = (process.env.FAIRSCALE_API_URL ?? '').replace(/\/+$/, '');
const API_KEY = process.env.FAIRSCALE_API_KEY ?? '';
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : null;
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 4);
const UA =
  'Mozilla/5.0 (compatible; SAIDProtocol/1.0; +https://saidprotocol.com)';

/* eslint-disable @typescript-eslint/no-explicit-any */
interface FairScaleResp {
  score?: number;
  pillars?: { peer_reputation?: number; work_history?: number; network_quality?: number };
  badges?: { id?: string }[];
  red_flags?: any[];
}

async function fetchScore(wallet: string): Promise<FairScaleResp | null> {
  try {
    const res = await fetch(`${API_URL}/score?wallet=${wallet}`, {
      headers: { 'Content-Type': 'application/json', fairkey: API_KEY, 'User-Agent': UA, Accept: 'application/json' },
      redirect: 'follow',
    });
    if (!res.ok) return null;
    return (await res.json()) as FairScaleResp;
  } catch {
    return null;
  }
}

async function run() {
  if (!API_URL) {
    console.error('FAIRSCALE_API_URL not set — aborting.');
    process.exit(1);
  }
  const agents = await prisma.agent.findMany({
    where: { isVerified: true, wallet: { not: undefined } },
    select: { wallet: true },
    ...(LIMIT ? { take: LIMIT } : {}),
  });
  console.log(`Syncing FairScale for ${agents.length} agents (concurrency=${CONCURRENCY})`);

  let idx = 0;
  let stored = 0;
  let withPeer = 0;
  let withFlags = 0;
  let errors = 0;
  const startedAt = Date.now();

  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (true) {
        const my = idx++;
        if (my >= agents.length) return;
        const wallet = agents[my].wallet;
        if (!wallet) continue;
        const data = await fetchScore(wallet);
        if (!data) {
          errors++;
        } else {
          const peer = Math.round(data.pillars?.peer_reputation ?? 0);
          const work = Math.round(data.pillars?.work_history ?? 0);
          const net = Math.round(data.pillars?.network_quality ?? 0);
          const badges = (data.badges ?? []).map((b) => b.id).filter((x): x is string => !!x);
          const redFlags = (data.red_flags ?? []).map((f: any) => (typeof f === 'string' ? f : f?.id ?? JSON.stringify(f)));
          const payload = {
            overallScore: Math.round(data.score ?? 0),
            peerReputation: peer,
            workHistory: work,
            networkQuality: net,
            badges,
            redFlags,
            raw: data as any,
            syncedAt: new Date(),
          };
          await prisma.agentFairScale.upsert({ where: { wallet }, create: { wallet, ...payload }, update: payload });
          stored++;
          if (peer > 0) withPeer++;
          if (redFlags.length > 0) withFlags++;
        }
        if ((my + 1) % 200 === 0) {
          const s = Math.round((Date.now() - startedAt) / 1000);
          console.log(`  ${my + 1}/${agents.length} (${s}s, stored=${stored}, peer>0=${withPeer}, flags=${withFlags}, errors=${errors})`);
        }
      }
    }),
  );

  console.log(
    `\nDone. stored=${stored} with_peer_rep=${withPeer} with_red_flags=${withFlags} errors=${errors} in ${Math.round((Date.now() - startedAt) / 1000)}s`,
  );
  await prisma.$disconnect();
}

run().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});

/**
 * SAID's public MCP server: the trust checks, callable from inside Claude,
 * Cursor, Codex or any MCP client at the moment a decision is being made.
 *
 *   check_wallet   who is behind a Solana wallet before you pay it
 *   check_token    is this token what it claims to be, and how did its deployer's past launches end
 *   find_agent     look up registered agents by name, handle or wallet
 *
 * Everything here is read-only and free. The paid x402 screen stays where it
 * is; this surface is metered by the API's per-IP rate limit instead, and the
 * point of it is to be called, so calls from keys we did not create are the
 * number that matters.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { buildScreenResult } from '../trust-screen.js';
import { buildPassport } from '../asset-passport/classify.js';

const SITE = 'https://www.saidprotocol.com';
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const VERDICT_URL = (process.env.VERDICT_URL || '').replace(/\/$/, '');
const VERDICT_WAIT_MS = 75_000;

type Text = { type: 'text'; text: string };
const text = (t: string): Text => ({ type: 'text', text: t });

const walletArg = z.string().regex(BASE58, 'a base58 Solana address');

function short(a: string) {
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

async function agentCard(prisma: PrismaClient, wallet: string) {
  const a = await prisma.agent.findUnique({
    where: { wallet },
    select: {
      wallet: true,
      name: true,
      description: true,
      twitter: true,
      website: true,
      isVerified: true,
      registeredAt: true,
      reputationScore: true,
      registrationSource: true,
      trustScore: { select: { score: true, tier: true, badges: true } },
    },
  });
  if (!a) return null;
  return {
    wallet: a.wallet,
    name: a.name,
    description: a.description,
    twitter: a.twitter,
    website: a.website,
    verified: a.isVerified,
    registeredAt: a.registeredAt.toISOString(),
    trustScore: a.trustScore?.score ?? null,
    trustTier: a.trustScore?.tier ?? null,
    badges: a.trustScore?.badges ?? [],
    registeredVia: a.registrationSource ?? null,
    profileUrl: `${SITE}/agents/${a.wallet}`,
  };
}

interface LaunchVerdict {
  verdict: string | null;
  score: number | null;
  call: string | null;
  flags: unknown;
  devWallet: string | null;
  status: string;
  checkUrl: string;
  scoreboardUrl: string;
}

/** Ask the verdict engine about a mint. Returns null when the engine is not configured. */
async function launchVerdict(mint: string): Promise<LaunchVerdict | null> {
  if (!VERDICT_URL) return null;
  const started = await fetch(`${VERDICT_URL}/api/check`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: mint }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!started.ok) throw new Error(`verdict engine answered ${started.status}`);
  const { id } = (await started.json()) as { id: string };
  const deadline = Date.now() + VERDICT_WAIT_MS;
  let check: any = null;
  while (Date.now() < deadline) {
    const res = await fetch(`${VERDICT_URL}/api/check/${id}`, { signal: AbortSignal.timeout(10_000) });
    if (res.ok) {
      check = await res.json();
      if (check.status === 'done' || check.status === 'error') break;
    }
    await new Promise((r) => setTimeout(r, 2_500));
  }
  return {
    verdict: check?.verdict ?? null,
    score: check?.score ?? null,
    call: check?.call ?? null,
    flags: check?.flags ?? null,
    devWallet: check?.devWallet ?? null,
    status: check?.status ?? 'running',
    checkUrl: `${VERDICT_URL}/api/check/${id}`,
    scoreboardUrl: `${VERDICT_URL}/api/receipts`,
  };
}

export function createMcpServer(prisma: PrismaClient): McpServer {
  const server = new McpServer({ name: 'said-protocol', version: '1.0.0' });

  server.registerTool(
    'check_wallet',
    {
      title: 'Check a wallet before you pay it',
      description:
        'Look up a Solana wallet in SAID Protocol, the identity and reputation registry for AI agents. Returns whether it is a registered and verified agent, its trust score and tier, an allow / review / caution verdict with the reason, and whether the identity has changed hands. Use before sending funds, accepting a job, or trusting a counterparty. Free.',
      inputSchema: { wallet: walletArg.describe('Solana wallet address (base58)') },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ wallet }) => {
      const [agent, screen] = await Promise.all([agentCard(prisma, wallet), buildScreenResult(prisma, wallet)]);
      const label = agent?.name ? `${agent.name} (${short(wallet)})` : short(wallet);
      const headline = agent
        ? `${label}: ${agent.verified ? 'verified' : 'registered, unverified'} SAID agent. Verdict: ${screen.verdict}. ${screen.reason}`
        : `${label} is not a registered SAID agent. Verdict: ${screen.verdict}. ${screen.reason}`;
      const result = {
        wallet,
        registered: screen.registered,
        verified: screen.verified,
        verdict: screen.verdict,
        score: screen.score,
        tier: screen.tier,
        confidence: screen.confidence,
        reason: screen.reason,
        identityContinuity: screen.integrity.continuity,
        integrityFlags: screen.integrity.flags,
        agent,
        profileUrl: `${SITE}/agents/${wallet}`,
      };
      return { content: [text(headline)], structuredContent: result };
    },
  );

  server.registerTool(
    'check_token',
    {
      title: 'Check a token before you buy it',
      description:
        'Two checks on a Solana token mint. (1) Authenticity: if it claims to be a tokenized stock or real-world asset, is it the issuer\'s real token or an impersonator, and is the backing verifiable? (2) Launch trust: who deployed it, how their previous launches ended, bundling and funding-trail flags, with a pass / caution / fail verdict. Every pass/fail verdict is re-graded at 24h and 7d on a public scoreboard. Free.',
      inputSchema: { mint: walletArg.describe('Token mint address (base58)') },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ mint }) => {
      const [passport, launch] = await Promise.all([
        buildPassport(mint).catch((err) => ({ error: err instanceof Error ? err.message : String(err) })),
        launchVerdict(mint).catch((err) => ({ error: err instanceof Error ? err.message : String(err) })),
      ]);
      const lines: string[] = [];
      if ('error' in passport) lines.push(`Authenticity check failed: ${passport.error}.`);
      else {
        const name = passport.symbol ? `${passport.symbol}${passport.name ? ` (${passport.name})` : ''}` : short(mint);
        lines.push(`${name}: ${passport.verdict}. ${passport.reasons[0] ?? ''}`.trim());
      }
      if (launch === null) lines.push('Launch trust engine not configured on this server.');
      else if ('error' in launch) lines.push(`Launch check failed: ${launch.error}.`);
      else if (launch.status !== 'done') lines.push(`Launch check still running; poll ${launch.checkUrl}.`);
      else lines.push(`Launch verdict: ${launch.verdict} (${launch.score}/100). ${launch.call ?? ''}`.trim());
      return {
        content: [text(lines.join(' '))],
        structuredContent: {
          mint,
          authenticity: 'error' in passport ? null : passport,
          launch: launch && 'error' in launch ? null : launch,
          checkPage: `https://api.saidprotocol.com/check?mint=${mint}`,
        },
      };
    },
  );

  server.registerTool(
    'find_agent',
    {
      title: 'Find a registered agent',
      description:
        'Search SAID Protocol\'s registry of AI agents by name, X handle, description or wallet. Returns matching agents with verification status, trust score and profile link. Use to resolve "who is this agent" or to find a counterparty\'s registered wallet.',
      inputSchema: {
        query: z.string().min(2).max(80).describe('Name, @handle, keyword or wallet fragment'),
        verifiedOnly: z.boolean().optional().describe('Only return verified agents'),
        limit: z.number().int().min(1).max(25).optional().describe('Max results, default 10'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ query, verifiedOnly, limit }) => {
      const q = query.trim().replace(/^@/, '');
      const where: any = {
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { twitter: { contains: q, mode: 'insensitive' } },
          { wallet: { contains: q, mode: 'insensitive' } },
          { description: { contains: q, mode: 'insensitive' } },
        ],
      };
      if (verifiedOnly) where.isVerified = true;
      const rows = await prisma.agent.findMany({
        where,
        orderBy: [{ trustScore: { score: 'desc' } }, { reputationScore: 'desc' }, { id: 'asc' }],
        take: limit ?? 10,
        select: {
          wallet: true,
          name: true,
          twitter: true,
          description: true,
          isVerified: true,
          registeredAt: true,
          trustScore: { select: { score: true, tier: true } },
        },
      });
      const agents = rows.map((a) => ({
        wallet: a.wallet,
        name: a.name,
        twitter: a.twitter,
        description: a.description ? a.description.slice(0, 160) : null,
        verified: a.isVerified,
        registeredAt: a.registeredAt.toISOString(),
        trustScore: a.trustScore?.score ?? null,
        trustTier: a.trustScore?.tier ?? null,
        profileUrl: `${SITE}/agents/${a.wallet}`,
      }));
      const summary =
        agents.length === 0
          ? `No registered agent matches "${query}".`
          : agents.map((a) => `${a.name ?? short(a.wallet)} ${a.verified ? '✓' : '(unverified)'} ${a.wallet}`).join('\n');
      return { content: [text(summary)], structuredContent: { query, count: agents.length, agents } };
    },
  );

  return server;
}

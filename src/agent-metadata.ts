/**
 * Agent metadata self-service.
 *
 * Lets a registered agent (or its owner, or the platform that registered it)
 * update the public metadata SAID serves for it — name, description, links,
 * image, skills and service endpoints. The on-chain metadataUri for every
 * platform-registered agent points at /api/cards/:wallet.json, so updating the
 * stored card IS updating what the chain resolves to. No Solana tx needed.
 *
 *   POST  /api/agents/:wallet/metadata/message   { signer, changes } → message to sign
 *   PATCH /api/agents/:wallet                    { signer, signature, timestamp, changes }
 *                                                or X-Platform-Key + { changes }
 *
 * Auth paths:
 *   1. ed25519 signature over `SAID:update:<wallet>:<timestamp>:<changesHash>`
 *      from the agent wallet or the registered owner wallet. The hash binds
 *      the signature to these exact changes, so a captured signature can't be
 *      replayed with different fields inside the 5-minute window.
 *   2. X-Platform-Key matching the key for agent.registrationSource.
 *
 * Never updatable here: wallet, pda, owner, isVerified, layer2Verified,
 * registrationSource, reputationScore, x402Wallet. If the agent moves its
 * endpoint off the URL its Layer-2 verification was earned against, that
 * verification is reset — a verified badge must not point at an unverified
 * server.
 */

import { Hono } from 'hono';
import type { PrismaClient } from '@prisma/client';
import { PublicKey } from '@solana/web3.js';
import { createHash } from 'crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

const REPLAY_WINDOW_MS = 5 * 60 * 1000;

// Fields a caller may change, in the order they are canonicalised for hashing.
const UPDATABLE = [
  'name', 'description', 'twitter', 'website', 'github', 'image',
  'skills', 'serviceTypes', 'mcpEndpoint', 'a2aEndpoint',
] as const;
type Field = typeof UPDATABLE[number];
type Changes = Partial<Record<Field, string | string[] | null>>;

// Same blocklist as POST /api/cards — one rule for identity-bearing names.
const RESERVED_NAME = /\b(support|admin|official|saidprotocol|said\s*protocol|coinbase|binance|metamask|phantom)\b/i;

function verifySignature(message: string, signature: string, walletAddress: string): boolean {
  try {
    return nacl.sign.detached.verify(
      new TextEncoder().encode(message),
      bs58.decode(signature),
      bs58.decode(walletAddress),
    );
  } catch {
    return false;
  }
}

// Canonical JSON: only updatable keys, fixed order, so client and server hash
// the same bytes regardless of key order in the request body.
export function hashChanges(changes: Changes): string {
  const canonical: Record<string, unknown> = {};
  for (const k of UPDATABLE) if (changes[k] !== undefined) canonical[k] = changes[k];
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function getUpdateMessage(wallet: string, timestamp: number, changesHash: string): string {
  return `SAID:update:${wallet}:${timestamp}:${changesHash}`;
}

function isHttpUrl(v: string): boolean {
  try { const u = new URL(v); return u.protocol === 'http:' || u.protocol === 'https:'; }
  catch { return false; }
}

// Returns the sanitised changes or an error string. `null` clears a field
// (except name, which every agent must keep).
function validateChanges(raw: unknown): { changes: Changes } | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'changes must be an object' };
  const input = raw as Record<string, unknown>;
  const unknown = Object.keys(input).filter(k => !(UPDATABLE as readonly string[]).includes(k));
  if (unknown.length) return { error: `Unknown or read-only field(s): ${unknown.join(', ')}. Updatable: ${UPDATABLE.join(', ')}` };

  const out: Changes = {};
  const str = (k: Field, max: number): string | null | undefined => {
    const v = input[k];
    if (v === undefined) return undefined;
    if (v === null) return null;
    if (typeof v !== 'string') throw new Error(`${k} must be a string`);
    const t = v.trim();
    if (t.length > max) throw new Error(`${k} must be at most ${max} characters`);
    if (/[\x00-\x1f\x7f]/.test(t)) throw new Error(`${k} contains control characters`);
    return t;
  };
  const list = (k: Field, maxItems: number, maxLen: number): string[] | null | undefined => {
    const v = input[k];
    if (v === undefined) return undefined;
    if (v === null) return null;
    if (!Array.isArray(v) || !v.every(x => typeof x === 'string')) throw new Error(`${k} must be an array of strings`);
    const items = Array.from(new Set(v.map(x => x.trim()).filter(Boolean)));
    if (items.length > maxItems) throw new Error(`${k} must have at most ${maxItems} items`);
    if (items.some(x => x.length > maxLen)) throw new Error(`each ${k} item must be at most ${maxLen} characters`);
    return items;
  };

  try {
    const name = str('name', 50);
    if (name !== undefined) {
      if (name === null || name.length < 1) throw new Error('name cannot be empty');
      if (/[<>]/.test(name)) throw new Error('name contains invalid characters');
      if (RESERVED_NAME.test(name)) throw new Error('name not allowed (reserved/impersonation)');
      out.name = name;
    }
    const description = str('description', 1000);
    if (description !== undefined) out.description = description || null;

    const twitter = str('twitter', 50);
    if (twitter !== undefined) {
      if (twitter === null || twitter === '') out.twitter = null;
      else {
        const handle = twitter.replace(/^@/, '').replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, '').replace(/\/.*$/, '');
        if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) throw new Error('twitter must be a valid handle');
        out.twitter = handle;
      }
    }
    const github = str('github', 100);
    if (github !== undefined) {
      if (github === null || github === '') out.github = null;
      else {
        const gh = github.replace(/^@/, '').replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/\/.*$/, '');
        if (!/^[A-Za-z0-9-]{1,39}$/.test(gh)) throw new Error('github must be a valid username');
        out.github = gh;
      }
    }
    for (const k of ['website', 'image', 'mcpEndpoint', 'a2aEndpoint'] as const) {
      const v = str(k, 500);
      if (v === undefined) continue;
      if (v === null || v === '') { out[k] = null; continue; }
      if (!isHttpUrl(v)) throw new Error(`${k} must be an http(s) URL`);
      out[k] = v;
    }
    const skills = list('skills', 50, 50);
    if (skills !== undefined) out.skills = skills ?? [];
    const serviceTypes = list('serviceTypes', 20, 50);
    if (serviceTypes !== undefined) out.serviceTypes = serviceTypes ?? [];
  } catch (e: any) {
    return { error: e.message };
  }

  if (Object.keys(out).length === 0) return { error: 'No changes supplied' };
  return { changes: out };
}

// The platform that registered an agent may update it with its own key.
function platformKeyFor(source: string | null): string | undefined {
  const b64 = (name: string) => {
    const raw = process.env[name];
    if (!raw) return undefined;
    try { return Buffer.from(raw, 'base64').toString('utf-8'); } catch { return raw; }
  };
  switch (source) {
    case 'spawnr': return b64('SP_AUTH_CFG');
    case 'clawpump': return process.env.CLAWPUMP_API_KEY;
    case 'xona-orbit': return process.env.XONA_ORBIT_API_KEY;
    case 'kausa': return process.env.KAUSA_API_KEY;
    case 'seekerclaw': return process.env.SEEKERCLAW_API_KEY;
    case 'fairscale': return process.env.FAIRSCALE_API_KEY;
    case 'said-hosting': return process.env.SAID_HOSTING_API_KEY;
    default: return undefined;
  }
}

export function createAgentMetadataRouter(prisma: PrismaClient) {
  const router = new Hono();

  // Helper: server computes the canonical hash so integrators never have to.
  router.post('/api/agents/:wallet/metadata/message', async (c) => {
    const wallet = c.req.param('wallet');
    const body = await c.req.json().catch(() => ({}));
    const signer = typeof body.signer === 'string' ? body.signer : wallet;
    const validated = validateChanges(body.changes);
    if ('error' in validated) return c.json({ error: validated.error }, 400);

    const timestamp = Date.now();
    const changesHash = hashChanges(validated.changes);
    return c.json({
      message: getUpdateMessage(wallet, timestamp, changesHash),
      timestamp,
      changesHash,
      changes: validated.changes,
      expiresAt: timestamp + REPLAY_WINDOW_MS,
      instructions: `Sign this exact message with ${signer} (agent wallet or owner wallet), then PATCH /api/agents/${wallet} with { signer, signature (bs58), timestamp, changes } — send the normalised "changes" returned here so the hash matches.`,
    });
  });

  router.get('/api/agents/:wallet/metadata/message', (c) => c.json({
    error: 'Use POST with { signer?, changes } so the server can hash the changes into the message',
    example: { signer: '<wallet>', changes: { name: 'New name', website: 'https://example.com' } },
  }, 400));

  router.patch('/api/agents/:wallet', async (c) => {
    const wallet = c.req.param('wallet');
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') return c.json({ error: 'JSON body required' }, 400);

    const validated = validateChanges(body.changes);
    if ('error' in validated) return c.json({ error: validated.error }, 400);
    const { changes } = validated;

    const agent = await prisma.agent.findUnique({ where: { wallet } });
    if (!agent) return c.json({ error: 'Agent not found' }, 404);

    // ---- auth: platform key OR wallet signature ----
    let authorisedBy: string;
    const platformKey = c.req.header('X-Platform-Key');
    if (platformKey) {
      const expected = platformKeyFor(agent.registrationSource);
      if (!expected || platformKey !== expected) {
        return c.json({
          error: 'X-Platform-Key does not match the platform this agent was registered through',
          registrationSource: agent.registrationSource,
        }, 403);
      }
      authorisedBy = `platform:${agent.registrationSource}`;
    } else {
      const { signer, signature, timestamp } = body;
      if (!signer || !signature || typeof timestamp !== 'number') {
        return c.json({
          error: 'Missing required fields: signer, signature, timestamp (or send X-Platform-Key)',
          hint: `POST /api/agents/${wallet}/metadata/message with { changes } to get the message to sign`,
        }, 400);
      }
      if (Math.abs(Date.now() - timestamp) > REPLAY_WINDOW_MS) {
        return c.json({ error: 'Timestamp too old. Sign a fresh message.' }, 400);
      }
      try { new PublicKey(signer); } catch { return c.json({ error: 'signer is not a valid Solana address' }, 400); }
      if (signer !== agent.wallet && signer !== agent.owner) {
        return c.json({ error: 'signer must be the agent wallet or its registered owner wallet' }, 403);
      }
      const message = getUpdateMessage(wallet, timestamp, hashChanges(changes));
      if (!verifySignature(message, signature, signer)) {
        return c.json({ error: 'Invalid signature. Make sure you signed the exact message for these exact changes.' }, 401);
      }
      authorisedBy = signer === agent.wallet ? 'agent' : 'owner';
    }

    // ---- L2 guard: moving off the verified endpoint drops the verification ----
    let layer2Reset = false;
    const verifiedUrl = agent.verifiedEndpointUrl;
    if (agent.layer2Verified && verifiedUrl) {
      for (const k of ['mcpEndpoint', 'a2aEndpoint'] as const) {
        if (changes[k] !== undefined && agent[k] === verifiedUrl && changes[k] !== verifiedUrl) layer2Reset = true;
      }
    }

    // ---- apply to Agent + served card atomically ----
    const agentData: Record<string, unknown> = { ...changes, updatedAt: new Date() };
    delete agentData.github; // card-only field
    if (layer2Reset) Object.assign(agentData, {
      layer2Verified: false, layer2VerifiedAt: null, verifiedEndpointUrl: null, l2AttestationMethod: null,
    });

    const updated = await prisma.$transaction(async (tx) => {
      const a = await tx.agent.update({ where: { wallet }, data: agentData });
      const existing = await tx.agentCard.findUnique({ where: { wallet } });
      let card: Record<string, unknown> = { wallet };
      if (existing) { try { card = JSON.parse(existing.cardJson); } catch { /* rebuild below */ } }
      for (const k of UPDATABLE) {
        if (changes[k] === undefined) continue;
        const cardKey = k === 'skills' ? 'capabilities' : k;
        if (changes[k] === null) delete card[cardKey]; else card[cardKey] = changes[k];
      }
      if (!card.name) card.name = a.name;
      card.wallet = wallet;
      card.updated = new Date().toISOString().split('T')[0];
      if (layer2Reset) card.verified = false;
      await tx.agentCard.upsert({
        where: { wallet },
        create: { wallet, cardJson: JSON.stringify(card) },
        update: { cardJson: JSON.stringify(card), updatedAt: new Date() },
      });
      return a;
    });

    console.log(`[agent-metadata] ${wallet} updated by ${authorisedBy}: ${Object.keys(changes).join(',')}${layer2Reset ? ' (L2 reset)' : ''}`);

    return c.json({
      success: true,
      authorisedBy,
      updated: Object.keys(changes),
      ...(layer2Reset ? { layer2Reset: true, warning: 'Endpoint moved off the Layer-2 verified URL; re-verify to restore layer2Verified.' } : {}),
      agent: {
        wallet: updated.wallet,
        owner: updated.owner,
        name: updated.name,
        description: updated.description,
        twitter: updated.twitter,
        website: updated.website,
        image: updated.image,
        skills: updated.skills,
        serviceTypes: updated.serviceTypes,
        mcpEndpoint: updated.mcpEndpoint,
        a2aEndpoint: updated.a2aEndpoint,
        metadataUri: updated.metadataUri,
        isVerified: updated.isVerified,
        layer2Verified: updated.layer2Verified,
        updatedAt: updated.updatedAt,
      },
    });
  });

  return router;
}

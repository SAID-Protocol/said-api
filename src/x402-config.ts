// x402 Payment Gate for SAID Cross-Chain Messaging
// Powered by Coinbase x402 SDK + PayAI Facilitator
// Supports: Solana + EVM chains (Base, Polygon, Avalanche, Sei, IoTeX, Peaq, XLayer)

import { paymentMiddleware, paymentMiddlewareFromHTTPServer, x402ResourceServer, x402HTTPResourceServer } from '@x402/hono';
import { ExactSvmScheme } from '@x402/svm/exact/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { HTTPFacilitatorClient } from '@x402/core/server';
import type { Context, Next } from 'hono';

// ── Config ──────────────────────────────────────────────────────────────────

// SAID Protocol treasury wallet (Solana)
export const SAID_TREASURY = process.env.SAID_X402_TREASURY || 'EK3mP45iwgDEEts2cEDfhAs2i4PrH63NMG7vHg2d6fas';

// EVM treasury wallet (receives USDC on EVM chains)
export const SAID_EVM_TREASURY = process.env.SAID_EVM_TREASURY || '';

// Price per message
export const MESSAGE_PRICE = '$0.01';
const MESSAGE_PRICE_USDC = '0.01';

// Price per trust screen (GET /api/screen). Priced at the x402 floor: the point
// of this endpoint is discovery/exposure on x402scan & the Bazaar, not revenue —
// it just has to be a real (priced) x402 resource to be catalogued. Tune here.
export const SCREEN_PRICE = '$0.001';
const SCREEN_PRICE_USDC = '0.001';

// CAIP-2 network identifiers
const CHAINS = {
  solana: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' as const,
  base: 'eip155:8453' as const,
  polygon: 'eip155:137' as const,
  avalanche: 'eip155:43114' as const,
  sei: 'eip155:1329' as const,
  iotex: 'eip155:4689' as const,
  peaq: 'eip155:3338' as const,
  xlayer: 'eip155:196' as const,
};

// Official USDC addresses from Circle (https://developers.circle.com/stablecoins/usdc-contract-addresses)
const USDC_ADDRESSES: Record<string, { address: string; decimals: number }> = {
  'eip155:8453':  { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 }, // Base
  'eip155:137':   { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 }, // Polygon
  'eip155:43114': { address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', decimals: 6 }, // Avalanche
  'eip155:1329':  { address: '0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392', decimals: 6 }, // Sei
};

// Facilitators (PayAI for wide chain support, Dexter for battle-tested Solana+Base)
const PAYAI_FACILITATOR_URL = 'https://facilitator.payai.network';
const DEXTER_FACILITATOR_URL = 'https://x402.dexter.cash';

// ── Free Tier ───────────────────────────────────────────────────────────────

const FREE_MESSAGES_PER_DAY = 10;

// In-memory rate limit counter: { "address:date" → count }
const freeTierUsage = new Map<string, number>();

// Cleanup daily counters every hour
setInterval(() => {
  const today = new Date().toISOString().slice(0, 10);
  for (const key of freeTierUsage.keys()) {
    if (!key.endsWith(today)) {
      freeTierUsage.delete(key);
    }
  }
}, 3600000);

function getFreeTierKey(address: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return `${address}:${today}`;
}

function hasFreeTierRemaining(address: string): boolean {
  const key = getFreeTierKey(address);
  const used = freeTierUsage.get(key) || 0;
  return used < FREE_MESSAGES_PER_DAY;
}

function consumeFreeTier(address: string): void {
  const key = getFreeTierKey(address);
  freeTierUsage.set(key, (freeTierUsage.get(key) || 0) + 1);
}

function getFreeTierInfo(address: string): { used: number; remaining: number; limit: number } {
  const key = getFreeTierKey(address);
  const used = freeTierUsage.get(key) || 0;
  return { used, remaining: Math.max(0, FREE_MESSAGES_PER_DAY - used), limit: FREE_MESSAGES_PER_DAY };
}

// ── Body Cache (shared with upstream middleware) ─────────────────────────────

// Body cache: populated by upstream middleware BEFORE x402 runs.
// Maps raw Request → parsed body, so the free-tier hook can read
// the body without competing with Hono's single-read c.req.json().
export const bodyCache = new WeakMap<Request, any>();

// ── Custom x402 Middleware with Free Tier ────────────────────────────────────

/**
 * Create x402 payment middleware with integrated free tier.
 * 
 * Flow:
 *   1. Check if sender has free messages remaining → grant access
 *   2. If no free tier left → require x402 USDC payment
 *   3. Supports Solana + EVM chains via PayAI facilitator
 */
export function createX402Middleware() {
  // PayAI first (wider chain support), Dexter as fallback (battle-tested, 3.2M+ settlements)
  const payai = new HTTPFacilitatorClient({ url: PAYAI_FACILITATOR_URL });
  const dexter = new HTTPFacilitatorClient({ url: DEXTER_FACILITATOR_URL });

  // Build payment options
  const solanaOption = {
    scheme: 'exact' as const,
    network: CHAINS.solana,
    price: MESSAGE_PRICE_USDC,
    payTo: SAID_TREASURY,
  };

  const acceptOptions: Array<{ scheme: 'exact'; network: `${string}:${string}`; price: string; payTo: string }> = [solanaOption];

  // Add EVM chains if treasury is configured
  const evmChains = ['base', 'polygon', 'avalanche', 'sei'] as const;
  if (SAID_EVM_TREASURY && !SAID_EVM_TREASURY.startsWith('0x000000000')) {
    for (const chain of evmChains) {
      acceptOptions.push({
        scheme: 'exact' as const,
        network: CHAINS[chain],
        price: MESSAGE_PRICE_USDC,
        payTo: SAID_EVM_TREASURY,
      });
    }
    console.log(`✅ EVM payment enabled: ${evmChains.join(', ')}`);
  } else {
    console.log('ℹ️  EVM payment disabled (set SAID_EVM_TREASURY to enable)');
  }

  // Same chains/treasuries as messaging, just at the trust-screen floor price.
  const screenAcceptOptions = acceptOptions.map((o) => ({ ...o, price: SCREEN_PRICE_USDC }));

  const routes = {
    'POST /xchain/message': {
      accepts: acceptOptions,
      description: 'Cross-chain agent message via SAID Protocol',
    },
    'GET /api/screen': {
      accepts: screenAcceptOptions,
      description:
        'SAID agent trust screen — should your agent pay this counterparty? Returns an allow/review/caution verdict plus SAID\'s computed per-axis reputation (delivery, payments, validation, identity, community) and EigenTrust score for any Solana agent/wallet.',
    },
  };

  // Create the resource server manually so we can add the free tier hook
  const resourceServer = new x402ResourceServer([payai, dexter]);
  resourceServer.register('solana:*' as any, new ExactSvmScheme());

  // EVM scheme with custom USDC addresses for chains the SDK doesn't know about
  const evmScheme = new ExactEvmScheme();
  evmScheme.registerMoneyParser(async (amount: number, network: string) => {
    const usdc = USDC_ADDRESSES[network];
    if (!usdc) return null; // Fall back to SDK default
    const tokenAmount = Math.round(amount * Math.pow(10, usdc.decimals)).toString();
    return { amount: tokenAmount, asset: usdc.address };
  });
  resourceServer.register('eip155:*' as any, evmScheme);

  const httpServer = new x402HTTPResourceServer(resourceServer, routes);

  // Free tier hook: grant access if sender has remaining free messages
  httpServer.onProtectedRequest(async (context) => {
    // If client explicitly sent a payment signature, skip free tier — they want to pay
    const paymentHeader = context.adapter.getHeader?.('payment-signature') || context.adapter.getHeader?.('x-payment');
    if (paymentHeader) {
      console.log('[x402] Payment signature present — skipping free tier, processing payment');
      return undefined; // Continue to x402 payment settlement
    }

    try {
      // Use pre-cached body from upstream middleware (avoids double c.req.json() issue)
      const rawReq = (context.adapter as any)?.c?.req?.raw;
      const body = (rawReq ? bodyCache.get(rawReq) : undefined) ?? await context.adapter.getBody?.() as any;
      const senderAddress = body?.from?.address;

      if (senderAddress && hasFreeTierRemaining(senderAddress)) {
        consumeFreeTier(senderAddress);
        const info = getFreeTierInfo(senderAddress);
        console.log(`🆓 Free tier: ${senderAddress} (${info.remaining} left today)`);
        return { grantAccess: true };
      }
    } catch (e) {
      console.warn('[x402 free tier] Body parse error:', e);
    }
    console.log('[x402] No free tier — requiring payment');
    return undefined; // Continue to x402 payment check
  });

  console.log('[x402] Middleware created, will initialize on first request');

  return paymentMiddlewareFromHTTPServer(httpServer);
}

// ── Exports ─────────────────────────────────────────────────────────────────

export { getFreeTierInfo, hasFreeTierRemaining, consumeFreeTier, CHAINS, FREE_MESSAGES_PER_DAY };

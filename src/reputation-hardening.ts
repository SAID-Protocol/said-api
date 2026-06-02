/**
 * Hardening utilities for the reputation API endpoints.
 *
 * Six defenses, deliberately co-located so they can be reasoned about
 * together and the cost surface is visible at a glance:
 *
 *   1. Wallet format validation — rejects garbage before any DB hit
 *   2. Per-IP / per-partner sliding-window rate limit (in-memory)
 *   3. Per-wallet response cache (Redis if REDIS_URL is set, in-memory fallback)
 *   4. Bulk-endpoint concurrency limiter
 *   5. FairScale circuit breaker — stops hammering an external API
 *      that's known-down
 *   6. (configured by callers in index.ts) Bulk request cap = 25
 *
 * In-memory state is per-instance. For multi-instance deployments the
 * rate limit and circuit breaker should eventually move to Redis; the
 * response cache already uses Redis when available.
 */
import { Context, Next } from 'hono';
import Redis from 'ioredis';
import bs58 from 'bs58';
import type { ReputationResponse } from './reputation-shaping.js';

// ─── 1. Wallet format validation ──────────────────────────────────

/**
 * Solana public keys are 32 raw bytes, base58-encoded. Encoded length
 * is typically 43-44 chars; minimum theoretical is 32. Anything outside
 * that range is garbage and can be rejected before touching the DB.
 */
export function isValidSolanaAddress(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  if (s.length < 32 || s.length > 44) return false;
  try {
    const decoded = bs58.decode(s);
    return decoded.length === 32;
  } catch {
    return false;
  }
}

// ─── 2. Rate limiter (in-memory sliding window) ───────────────────

const ANON_PER_MINUTE = 60;
const PARTNER_PER_MINUTE = 600;
const RATE_WINDOW_MS = 60_000;

interface BucketEntry {
  count: number;
  resetAt: number;
}

const rateBuckets = new Map<string, BucketEntry>();

// Periodically prune expired buckets so the map doesn't grow unbounded
// under a flood of unique IPs.
const pruneInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateBuckets) {
    if (entry.resetAt < now) rateBuckets.delete(key);
  }
}, 60_000);
pruneInterval.unref?.();

function bucketKeyForRequest(c: Context): { key: string; isPartner: boolean } {
  const partner = c.req.header('x-partner');
  if (partner) return { key: `partner:${partner.slice(0, 64)}`, isPartner: true };
  const ip =
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    c.req.header('x-real-ip') ||
    'unknown';
  return { key: `ip:${ip}`, isPartner: false };
}

/**
 * Hono middleware enforcing the rate limit per (IP | x-partner).
 * Partner traffic gets a higher ceiling since partners are accountable
 * by name and have stable load patterns.
 */
export function reputationRateLimit() {
  return async (c: Context, next: Next) => {
    const { key, isPartner } = bucketKeyForRequest(c);
    const limit = isPartner ? PARTNER_PER_MINUTE : ANON_PER_MINUTE;
    const now = Date.now();
    let entry = rateBuckets.get(key);
    if (!entry || entry.resetAt < now) {
      entry = { count: 0, resetAt: now + RATE_WINDOW_MS };
      rateBuckets.set(key, entry);
    }
    entry.count++;
    const remaining = Math.max(0, limit - entry.count);
    c.header('X-RateLimit-Limit', String(limit));
    c.header('X-RateLimit-Remaining', String(remaining));
    c.header('X-RateLimit-Reset', String(Math.floor(entry.resetAt / 1000)));
    if (entry.count > limit) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      c.header('Retry-After', String(retryAfter));
      return c.json(
        { error: 'Rate limit exceeded', retry_after_seconds: retryAfter },
        429,
      );
    }
    await next();
  };
}

// ─── 3. Per-wallet response cache ─────────────────────────────────

const CACHE_TTL_SECONDS = 60;
const CACHE_PREFIX = 'rep:cache:';
const LOCAL_CACHE_MAX = 5000;

interface CachedEntry {
  value: ReputationResponse;
  expiresAt: number;
}

const localCache = new Map<string, CachedEntry>();
let redisClient: Redis | null = null;
let redisDisabled = false;

function getRedisClient(): Redis | null {
  if (redisDisabled) return null;
  if (redisClient) return redisClient;
  const url = process.env.REDIS_URL;
  if (!url) {
    redisDisabled = true;
    return null;
  }
  try {
    redisClient = new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: true });
    redisClient.on('error', (err) =>
      console.warn('[reputation cache Redis]', err.message),
    );
    redisClient.connect().catch(() => {});
    return redisClient;
  } catch {
    redisDisabled = true;
    return null;
  }
}

export async function getCachedReputation(
  wallet: string,
): Promise<ReputationResponse | null> {
  const now = Date.now();
  const local = localCache.get(wallet);
  if (local && local.expiresAt > now) return local.value;
  if (local) localCache.delete(wallet);
  const redis = getRedisClient();
  if (redis) {
    try {
      const cached = await redis.get(CACHE_PREFIX + wallet);
      if (cached) {
        const parsed = JSON.parse(cached) as ReputationResponse;
        localCache.set(wallet, {
          value: parsed,
          expiresAt: now + CACHE_TTL_SECONDS * 1000,
        });
        return parsed;
      }
    } catch {
      // Caching is best-effort; ignore Redis errors.
    }
  }
  return null;
}

export async function setCachedReputation(
  wallet: string,
  value: ReputationResponse,
): Promise<void> {
  const expiresAt = Date.now() + CACHE_TTL_SECONDS * 1000;
  // Bound local cache size — evict ~10% of oldest entries on overflow.
  if (localCache.size >= LOCAL_CACHE_MAX) {
    const target = Math.floor(LOCAL_CACHE_MAX * 0.1);
    let i = 0;
    for (const key of localCache.keys()) {
      if (i++ >= target) break;
      localCache.delete(key);
    }
  }
  localCache.set(wallet, { value, expiresAt });
  const redis = getRedisClient();
  if (redis) {
    try {
      await redis.set(
        CACHE_PREFIX + wallet,
        JSON.stringify(value),
        'EX',
        CACHE_TTL_SECONDS,
      );
    } catch {
      // best-effort
    }
  }
}

// ─── 4. Concurrency limiter ───────────────────────────────────────

/**
 * Tiny inline p-limit. Bounds parallel work fan-out from a single
 * request. Used by the bulk endpoint to stop 100 wallets from spawning
 * 400 concurrent DB+external calls and starving the connection pool.
 */
export function createConcurrencyLimiter(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  function next() {
    if (active >= concurrency) return;
    const runner = queue.shift();
    if (runner) runner();
  }
  return function <T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const runner = () => {
        active++;
        fn().then(
          (val) => {
            active--;
            resolve(val);
            next();
          },
          (err) => {
            active--;
            reject(err);
            next();
          },
        );
      };
      if (active < concurrency) runner();
      else queue.push(runner);
    });
  };
}

// ─── 5. FairScale circuit breaker ─────────────────────────────────

const FAIRSCALE_FAILURE_THRESHOLD = 3;
const FAIRSCALE_OPEN_DURATION_MS = 60_000;

interface CircuitState {
  failures: number;
  openedAt: number | null;
}

const fairscaleCircuit: CircuitState = { failures: 0, openedAt: null };

function isFairScaleCircuitOpen(): boolean {
  if (fairscaleCircuit.openedAt === null) return false;
  if (Date.now() - fairscaleCircuit.openedAt > FAIRSCALE_OPEN_DURATION_MS) {
    fairscaleCircuit.openedAt = null;
    fairscaleCircuit.failures = 0;
    return false;
  }
  return true;
}

function recordFairScaleResult(success: boolean): void {
  if (success) {
    fairscaleCircuit.failures = 0;
    fairscaleCircuit.openedAt = null;
    return;
  }
  fairscaleCircuit.failures++;
  if (fairscaleCircuit.failures >= FAIRSCALE_FAILURE_THRESHOLD) {
    fairscaleCircuit.openedAt = Date.now();
  }
}

/**
 * Wrap a FairScale fetcher. Skips the call if the circuit is open
 * (three consecutive failures within 60s) and returns null. Otherwise
 * calls the fetcher and records success/failure. Treats `null` from
 * the fetcher as a failure for circuit-breaker purposes since the
 * underlying fairscale-not-reachable path returns null too.
 */
export async function fetchFairScaleWithBreaker(
  fetcher: () => Promise<{ score: number; max: number } | null>,
): Promise<{ score: number; max: number } | null> {
  if (isFairScaleCircuitOpen()) return null;
  try {
    const result = await fetcher();
    recordFairScaleResult(result !== null);
    return result;
  } catch {
    recordFairScaleResult(false);
    return null;
  }
}

/**
 * Rate limiter for Next.js API routes.
 *
 * Backed by Upstash Redis when UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
 * are set — a single shared counter across every Vercel instance, which is the
 * only correct behavior in production (each serverless instance otherwise keeps
 * its OWN in-memory Map, so the effective limit was silently multiplied by the
 * instance count and throttling was unpredictable per request).
 *
 * Falls back to a per-process in-memory Map when Redis env is absent (local dev,
 * CI, build) or if a Redis call throws — so a Redis outage degrades to the old
 * behavior instead of hard-failing requests.
 *
 * `rateLimit` is async now. Call it as `await rateLimit(key, max)`.
 */

import { Redis } from "@upstash/redis";

const WINDOW_MS = 60_000; // 1 minute
const WINDOW_SEC = 60;

// ── In-memory fallback ────────────────────────────────────────────────────
interface Bucket {
  count: number;
  resetAt: number;
}
const buckets = new Map<string, Bucket>();

// Periodically evict expired buckets so the Map doesn't grow unbounded.
if (typeof setInterval !== "undefined") {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, val] of buckets) {
      if (now > val.resetAt) buckets.delete(key);
    }
  }, WINDOW_MS);
  // Don't keep the process alive just for the sweeper.
  (timer as { unref?: () => void }).unref?.();
}

function inMemoryRateLimit(key: string, maxPerMinute: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (bucket.count >= maxPerMinute) return false;
  bucket.count++;
  return true;
}

// ── Redis (shared, production) ────────────────────────────────────────────
const redis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      })
    : null;

/**
 * Returns true if the request is within the rate limit, false if it should be
 * blocked. Fixed 60s window per key.
 *
 * @param key           Unique key per client (e.g. IP address, optionally
 *                      namespaced like `pricing:${ip}` so distinct routes don't
 *                      share a bucket).
 * @param maxPerMinute  Max requests allowed per 60-second window (default 60).
 */
export async function rateLimit(
  key: string,
  maxPerMinute = 60,
): Promise<boolean> {
  if (!redis) return inMemoryRateLimit(key, maxPerMinute);
  try {
    const rlKey = `rl:${key}`;
    const count = await redis.incr(rlKey);
    // Set the TTL only on the first hit of a window so the counter resets
    // cleanly after 60s. (Refreshing TTL every hit would let steady traffic
    // keep a blocked key alive forever — too strict.)
    if (count === 1) await redis.expire(rlKey, WINDOW_SEC);
    return count <= maxPerMinute;
  } catch (err) {
    // Redis unreachable — degrade to in-memory rather than failing the request.
    console.warn("[ratelimit] Redis error, falling back to in-memory:", err);
    return inMemoryRateLimit(key, maxPerMinute);
  }
}

/** Extract the real client IP from Next.js request headers. */
export function getClientIp(req: {
  headers: { get(name: string): string | null };
}): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return "unknown";
}

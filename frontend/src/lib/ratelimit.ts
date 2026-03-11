/**
 * Simple in-memory rate limiter for Next.js API routes.
 *
 * Works correctly for single-instance dev/staging servers.
 * For multi-instance production (Vercel), swap to Redis-based limiting
 * (e.g., @upstash/ratelimit) using the same interface.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const WINDOW_MS = 60_000; // 1 minute
const buckets = new Map<string, Bucket>();

// Periodically evict expired buckets so the Map doesn't grow unbounded.
if (typeof setInterval !== "undefined") {
  setInterval(() => {
    const now = Date.now();
    for (const [key, val] of buckets) {
      if (now > val.resetAt) buckets.delete(key);
    }
  }, WINDOW_MS);
}

/**
 * Returns true if the request is within the rate limit, false if it should be blocked.
 * @param key     Unique key per client (e.g. IP address)
 * @param maxPerMinute  Max requests allowed per 60-second window (default 60)
 */
export function rateLimit(key: string, maxPerMinute = 60): boolean {
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

/** Extract the real client IP from Next.js request headers. */
export function getClientIp(req: { headers: { get(name: string): string | null } }): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return "unknown";
}

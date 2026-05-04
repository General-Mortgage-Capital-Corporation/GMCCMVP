/**
 * Redis read/write for the rate-sheet snapshot.
 *
 * The cron writes the latest snapshot under a single key. The resolver reads
 * it on every request (cheap — Upstash REST is fast and the payload is small,
 * <50KB even with all programs).
 *
 * TTL is 36h so the data survives a missed Saturday/Sunday cron run before
 * going stale. The resolver still serves the cached value past TTL since
 * Upstash returns the value until expiry.
 */

import { Redis } from "@upstash/redis";
import type { RateSheetSnapshot } from "./types";

const KEY = "rate_sheets:current";
const TTL_SECONDS = 36 * 60 * 60; // 36 hours

let _redis: Redis | null = null;
let _initAttempted = false;

function getRedis(): Redis | null {
  if (_initAttempted) return _redis;
  _initAttempted = true;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    _redis = new Redis({ url, token });
  } catch {
    _redis = null;
  }
  return _redis;
}

export async function readSnapshot(): Promise<RateSheetSnapshot | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    return (await redis.get<RateSheetSnapshot>(KEY)) ?? null;
  } catch (err) {
    console.error("[rate-sheets] Redis read failed:", err);
    return null;
  }
}

export async function writeSnapshot(snapshot: RateSheetSnapshot): Promise<boolean> {
  const redis = getRedis();
  if (!redis) {
    console.warn("[rate-sheets] Redis not configured; snapshot not persisted.");
    return false;
  }
  try {
    await redis.set(KEY, snapshot, { ex: TTL_SECONDS });
    return true;
  } catch (err) {
    console.error("[rate-sheets] Redis write failed:", err);
    return false;
  }
}

/**
 * Upstash Redis caching layer for Next.js API routes.
 *
 * Gracefully degrades — returns null if Redis is not configured.
 * Uses the same UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN
 * env vars as the Python backend.
 *
 * Key structure:
 *   zillow:photos:{sha256(address)}   — Zillow photo URLs (30-day TTL)
 *   rentcast:search:{sha256(params)}  — RentCast search results (12-hour TTL)
 */

import { Redis } from "@upstash/redis";
import { createHash } from "crypto";

// TTLs in seconds
const ZILLOW_TTL = 30 * 24 * 60 * 60; // 30 days
const RENTCAST_TTL = 12 * 60 * 60;     // 12 hours

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

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Zillow photos cache
// ---------------------------------------------------------------------------

export async function getCachedZillowPhotos(address: string): Promise<string[] | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const key = `zillow:photos:${sha256(address.toLowerCase().trim())}`;
    const data = await redis.get<string[]>(key);
    if (Array.isArray(data) && data.length > 0) return data;
    return null;
  } catch {
    return null;
  }
}

export async function setCachedZillowPhotos(address: string, photos: string[]): Promise<void> {
  if (photos.length === 0) return;
  const redis = getRedis();
  if (!redis) return;
  try {
    const key = `zillow:photos:${sha256(address.toLowerCase().trim())}`;
    await redis.set(key, photos, { ex: ZILLOW_TTL });
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// RentCast search cache
// ---------------------------------------------------------------------------

export async function getCachedRentcastSearch(params: Record<string, string>): Promise<unknown[] | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const sorted = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("&");
    const key = `rentcast:search:${sha256(sorted)}`;
    const data = await redis.get<unknown[]>(key);
    if (Array.isArray(data) && data.length > 0) return data;
    return null;
  } catch {
    return null;
  }
}

export async function setCachedRentcastSearch(params: Record<string, string>, results: unknown[]): Promise<void> {
  if (results.length === 0) return;
  const redis = getRedis();
  if (!redis) return;
  try {
    const sorted = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("&");
    const key = `rentcast:search:${sha256(sorted)}`;
    await redis.set(key, results, { ex: RENTCAST_TTL });
  } catch { /* ignore */ }
}

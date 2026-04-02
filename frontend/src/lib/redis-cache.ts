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

// ---------------------------------------------------------------------------
// Realtor research cache (7-day TTL)
// ---------------------------------------------------------------------------

const REALTOR_TTL = 7 * 24 * 60 * 60; // 7 days

export interface AgentResearch {
  summary: string;
  specialties: string[];
  yearsActive: number | null;
  recentActivity: string;
  designations: string[];
  reviews: string | null;
  linkedinSnippet: string | null;
  personalHooks: string[];
  sources: string[];
  confidence: "high" | "medium" | "low";
}

function realtorCacheKey(name: string, email: string, company: string): string {
  const input = [name, email, company].map((s) => s.toLowerCase().trim()).join("|");
  return `realtor:research:${sha256(input)}`;
}

export async function getCachedRealtorResearch(name: string, email: string, company: string): Promise<AgentResearch | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const data = await redis.get<AgentResearch>(realtorCacheKey(name, email, company));
    return data && data.summary ? data : null;
  } catch {
    return null;
  }
}

export async function setCachedRealtorResearch(name: string, email: string, company: string, research: AgentResearch): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set(realtorCacheKey(name, email, company), research, { ex: REALTOR_TTL });
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Chat conversation persistence
// ---------------------------------------------------------------------------

const CHAT_TTL = 48 * 60 * 60; // 48 hours

function chatKey(userId: string, convId: string): string {
  return `chat:conv:${sha256(userId)}:${convId}`;
}

function chatIndexKey(userId: string): string {
  return `chat:index:${sha256(userId)}`;
}

export interface ConversationMeta {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
}

export async function getChatMessages(userId: string, convId: string): Promise<unknown[] | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const data = await redis.get(chatKey(userId, convId));
    return Array.isArray(data) ? data : null;
  } catch { return null; }
}

export async function setChatMessages(
  userId: string,
  convId: string,
  messages: unknown[],
  title: string,
): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set(chatKey(userId, convId), messages, { ex: CHAT_TTL });
    // Update conversation index
    const index = await getChatIndex(userId);
    const existing = index.findIndex((c) => c.id === convId);
    const meta: ConversationMeta = {
      id: convId,
      title,
      updatedAt: Date.now(),
      messageCount: messages.length,
    };
    if (existing >= 0) {
      index[existing] = meta;
    } else {
      index.unshift(meta);
    }
    // Keep max 20 conversations
    const trimmed = index.slice(0, 20);
    await redis.set(chatIndexKey(userId), trimmed, { ex: CHAT_TTL });
  } catch { /* ignore */ }
}

export async function getChatIndex(userId: string): Promise<ConversationMeta[]> {
  const redis = getRedis();
  if (!redis) return [];
  try {
    const data = await redis.get(chatIndexKey(userId));
    return Array.isArray(data) ? (data as ConversationMeta[]) : [];
  } catch { return []; }
}

export async function clearChatMessages(userId: string, convId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.del(chatKey(userId, convId));
    // Remove from index
    const index = await getChatIndex(userId);
    const filtered = index.filter((c) => c.id !== convId);
    await redis.set(chatIndexKey(userId), filtered, { ex: CHAT_TTL });
  } catch { /* ignore */ }
}

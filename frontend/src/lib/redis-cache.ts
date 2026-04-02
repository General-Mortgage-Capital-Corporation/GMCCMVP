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
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { createHash } from "crypto";

// TTLs in seconds
const ZILLOW_TTL = 30 * 24 * 60 * 60; // 30 days
const RENTCAST_TTL = 12 * 60 * 60;     // 12 hours
const LOCAL_CACHE_FILE = join(process.cwd(), ".next", "cache", "gmcc-dev-cache.json");

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

function shouldUseLocalCache(): boolean {
  return process.env.NODE_ENV !== "production";
}

interface LocalCacheEntry {
  value: unknown;
  expiresAt: number | null;
}

interface LocalCacheStore {
  entries: Record<string, LocalCacheEntry>;
}

async function readLocalCacheStore(): Promise<LocalCacheStore> {
  try {
    const raw = await readFile(LOCAL_CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<LocalCacheStore>;
    return {
      entries: parsed.entries ?? {},
    };
  } catch {
    return { entries: {} };
  }
}

async function writeLocalCacheStore(store: LocalCacheStore): Promise<void> {
  await mkdir(dirname(LOCAL_CACHE_FILE), { recursive: true });
  await writeFile(LOCAL_CACHE_FILE, JSON.stringify(store, null, 2), "utf8");
}

async function getLocalCacheValue<T>(key: string): Promise<T | null> {
  const store = await readLocalCacheStore();
  const entry = store.entries[key];
  if (!entry) return null;
  if (entry.expiresAt != null && entry.expiresAt <= Date.now()) {
    delete store.entries[key];
    await writeLocalCacheStore(store);
    return null;
  }
  return entry.value as T;
}

async function setLocalCacheValue(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
  const store = await readLocalCacheStore();
  store.entries[key] = {
    value,
    expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
  };
  await writeLocalCacheStore(store);
}

async function deleteLocalCacheValue(key: string): Promise<void> {
  const store = await readLocalCacheStore();
  if (!(key in store.entries)) return;
  delete store.entries[key];
  await writeLocalCacheStore(store);
}

async function getCacheValue<T>(key: string): Promise<T | null> {
  const redis = getRedis();
  if (redis) {
    try {
      const data = await redis.get<T>(key);
      return data ?? null;
    } catch {
      return null;
    }
  }

  if (!shouldUseLocalCache()) return null;
  return getLocalCacheValue<T>(key);
}

async function setCacheValue(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
  const redis = getRedis();
  if (redis) {
    try {
      await redis.set(key, value, ttlSeconds ? { ex: ttlSeconds } : undefined);
    } catch {
      /* ignore */
    }
    return;
  }

  if (!shouldUseLocalCache()) return;
  await setLocalCacheValue(key, value, ttlSeconds);
}

async function deleteCacheValue(key: string): Promise<void> {
  const redis = getRedis();
  if (redis) {
    try {
      await redis.del(key);
    } catch {
      /* ignore */
    }
    return;
  }

  if (!shouldUseLocalCache()) return;
  await deleteLocalCacheValue(key);
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Zillow photos cache
// ---------------------------------------------------------------------------

export async function getCachedZillowPhotos(address: string): Promise<string[] | null> {
  try {
    const key = `zillow:photos:${sha256(address.toLowerCase().trim())}`;
    const data = await getCacheValue<string[]>(key);
    if (Array.isArray(data) && data.length > 0) return data;
    return null;
  } catch {
    return null;
  }
}

export async function setCachedZillowPhotos(address: string, photos: string[]): Promise<void> {
  if (photos.length === 0) return;
  try {
    const key = `zillow:photos:${sha256(address.toLowerCase().trim())}`;
    await setCacheValue(key, photos, ZILLOW_TTL);
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// RentCast search cache
// ---------------------------------------------------------------------------

export async function getCachedRentcastSearch(params: Record<string, string>): Promise<unknown[] | null> {
  try {
    const sorted = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("&");
    const key = `rentcast:search:${sha256(sorted)}`;
    const data = await getCacheValue<unknown[]>(key);
    if (Array.isArray(data) && data.length > 0) return data;
    return null;
  } catch {
    return null;
  }
}

export async function setCachedRentcastSearch(params: Record<string, string>, results: unknown[]): Promise<void> {
  if (results.length === 0) return;
  try {
    const sorted = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("&");
    const key = `rentcast:search:${sha256(sorted)}`;
    await setCacheValue(key, results, RENTCAST_TTL);
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
  try {
    const data = await getCacheValue<AgentResearch>(realtorCacheKey(name, email, company));
    return data && data.summary ? data : null;
  } catch {
    return null;
  }
}

export async function setCachedRealtorResearch(name: string, email: string, company: string, research: AgentResearch): Promise<void> {
  try {
    await setCacheValue(realtorCacheKey(name, email, company), research, REALTOR_TTL);
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Chat conversation persistence
// ---------------------------------------------------------------------------

const DEFAULT_CHAT_TTL_DAYS = 4;

function getChatTtlSeconds(): number {
  const raw = process.env.CHAT_TTL_DAYS;
  const parsedDays = raw ? Number(raw) : DEFAULT_CHAT_TTL_DAYS;
  if (!Number.isFinite(parsedDays) || parsedDays <= 0) {
    return DEFAULT_CHAT_TTL_DAYS * 24 * 60 * 60;
  }
  return Math.floor(parsedDays * 24 * 60 * 60);
}

const CHAT_TTL = getChatTtlSeconds();

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
  try {
    const data = await getCacheValue<unknown[]>(chatKey(userId, convId));
    return Array.isArray(data) ? data : null;
  } catch { return null; }
}

export async function setChatMessages(
  userId: string,
  convId: string,
  messages: unknown[],
  title: string,
): Promise<void> {
  try {
    await setCacheValue(chatKey(userId, convId), messages, CHAT_TTL);
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
    await setCacheValue(chatIndexKey(userId), trimmed, CHAT_TTL);
  } catch { /* ignore */ }
}

export async function getChatIndex(userId: string): Promise<ConversationMeta[]> {
  try {
    const data = await getCacheValue<ConversationMeta[]>(chatIndexKey(userId));
    return Array.isArray(data) ? (data as ConversationMeta[]) : [];
  } catch { return []; }
}

export async function clearChatMessages(userId: string, convId: string): Promise<void> {
  try {
    await deleteCacheValue(chatKey(userId, convId));
    // Remove from index
    const index = await getChatIndex(userId);
    const filtered = index.filter((c) => c.id !== convId);
    await setCacheValue(chatIndexKey(userId), filtered, CHAT_TTL);
  } catch { /* ignore */ }
}

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

// ── Local cache serialization ────────────────────────────────────────────
//
// The local file cache is a read-modify-write store: every mutation reads
// the whole JSON, edits it, and writes it back. Multiple concurrent writes
// would race — each reads the same initial state, then the last write
// wins and clobbers the others. This bit us when searchProperties fired
// a fire-and-forget rentcast cache write in parallel with an awaited
// storeDataset write — the rentcast write consistently overwrote the
// dataset entry, causing the immediately-following matchPrograms to
// report "Dataset … not found".
//
// Fix: funnel every mutation through a single promise chain. Reads are
// also routed through the chain so they see the post-write state of any
// pending mutation (critical for the searchProperties → matchPrograms
// handoff that happens within the same request).

let _localCacheChain: Promise<unknown> = Promise.resolve();

function runLocalCacheOp<T>(op: () => Promise<T>): Promise<T> {
  const next = _localCacheChain.then(op, op);
  // Keep the chain alive even if this op throws, and don't hold refs to
  // old results in memory.
  _localCacheChain = next.catch(() => undefined);
  return next;
}

async function getLocalCacheValue<T>(key: string): Promise<T | null> {
  return runLocalCacheOp(async () => {
    const store = await readLocalCacheStore();
    const entry = store.entries[key];
    if (!entry) return null;
    if (entry.expiresAt != null && entry.expiresAt <= Date.now()) {
      delete store.entries[key];
      await writeLocalCacheStore(store);
      return null;
    }
    return entry.value as T;
  });
}

async function setLocalCacheValue(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
  return runLocalCacheOp(async () => {
    const store = await readLocalCacheStore();
    store.entries[key] = {
      value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
    };
    await writeLocalCacheStore(store);
  });
}

async function deleteLocalCacheValue(key: string): Promise<void> {
  return runLocalCacheOp(async () => {
    const store = await readLocalCacheStore();
    if (!(key in store.entries)) return;
    delete store.entries[key];
    await writeLocalCacheStore(store);
  });
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

import { normalizeAddress } from "./rentcast";

/**
 * Derive a stable Zillow cache key. We normalize the address (collapses
 * "South" ↔ "S", "Avenue" ↔ "Ave", strips zip codes, etc.) so cosmetic
 * spelling variants hit the same cache entry instead of re-scraping
 * Apify every time and potentially resolving to a different listing.
 */
function zillowCacheKey(address: string): string {
  return `zillow:photos:${sha256(normalizeAddress(address))}`;
}

export async function getCachedZillowPhotos(address: string): Promise<string[] | null> {
  try {
    const data = await getCacheValue<string[]>(zillowCacheKey(address));
    if (Array.isArray(data) && data.length > 0) return data;
    return null;
  } catch {
    return null;
  }
}

export async function setCachedZillowPhotos(address: string, photos: string[]): Promise<void> {
  if (photos.length === 0) return;
  try {
    await setCacheValue(zillowCacheKey(address), photos, ZILLOW_TTL);
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
// Agent binary artifacts (PDFs, CSVs) — 30-minute TTL
// ---------------------------------------------------------------------------
//
// These replace the old in-memory Maps in lib/tools/flyer-store.ts and
// lib/tools/dataset-store.ts. The Maps broke in two scenarios:
//   1. Next.js dev HMR reloads the module → Map reinitialized empty → the
//      download button 404s on the csvRef that was valid moments earlier.
//   2. Vercel Fluid Compute: the download request can land on a different
//      warm instance from the one that generated the artifact, with an
//      empty Map.
// Moving to the shared Redis/local-cache layer fixes both.

const AGENT_ARTIFACT_TTL = 30 * 60; // 30 minutes
const AGENT_DATASET_TTL = 30 * 60;  // 30 minutes

interface AgentArtifactEntry {
  kind: "pdf" | "csv";
  base64: string;
  filename?: string;
}

export async function getAgentArtifact(ref: string): Promise<AgentArtifactEntry | null> {
  try {
    return await getCacheValue<AgentArtifactEntry>(`agent:artifact:${ref}`);
  } catch {
    return null;
  }
}

export async function setAgentArtifact(ref: string, entry: AgentArtifactEntry): Promise<void> {
  try {
    await setCacheValue(`agent:artifact:${ref}`, entry, AGENT_ARTIFACT_TTL);
  } catch { /* ignore */ }
}

export async function getAgentDataset(ref: string): Promise<unknown[] | null> {
  try {
    const data = await getCacheValue<unknown[]>(`agent:dataset:${ref}`);
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

export async function setAgentDataset(ref: string, rows: unknown[]): Promise<void> {
  try {
    await setCacheValue(`agent:dataset:${ref}`, rows, AGENT_DATASET_TTL);
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
  const key = chatKey(userId, convId);
  try {
    const redis = getRedis();
    if (!redis) {
      console.warn("[chat-cache] Redis not configured — cannot load messages");
      return null;
    }
    const data = await redis.get<unknown[]>(key);
    if (data == null) {
      console.log(`[chat-cache] GET ${key} → null (key missing or expired)`);
      return null;
    }
    if (!Array.isArray(data)) {
      console.error(`[chat-cache] GET ${key} → unexpected type: ${typeof data}`);
      return null;
    }
    console.log(`[chat-cache] GET ${key} → ${data.length} messages`);
    return data;
  } catch (err) {
    console.error(`[chat-cache] GET ${key} FAILED:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/** Returns null on success, or an error string on failure. */
export async function setChatMessages(
  userId: string,
  convId: string,
  messages: unknown[],
  title: string,
): Promise<string | null> {
  const key = chatKey(userId, convId);
  try {
    // Check payload size — Upstash has a 1MB per-request limit
    const payload = JSON.stringify(messages);
    const sizeKB = Math.round(payload.length / 1024);
    if (payload.length > 950_000) {
      console.error(`[chat-cache] SET ${key} SKIPPED — payload too large: ${sizeKB}KB`);
      return `Conversation too large to save (${sizeKB}KB). Upstash limit is ~1MB.`;
    }

    const redis = getRedis();
    if (!redis) {
      console.warn("[chat-cache] Redis not configured — cannot save messages");
      return "Redis not configured";
    }

    await redis.set(key, messages, { ex: CHAT_TTL });
    console.log(`[chat-cache] SET ${key} → ${messages.length} messages, ${sizeKB}KB, TTL=${CHAT_TTL}s`);

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
    console.log(`[chat-cache] INDEX updated — ${trimmed.length} conversations`);
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[chat-cache] SET ${key} FAILED:`, msg);
    return `Save failed: ${msg}`;
  }
}

export async function getChatIndex(userId: string): Promise<ConversationMeta[]> {
  const key = chatIndexKey(userId);
  try {
    const redis = getRedis();
    if (!redis) {
      console.warn("[chat-cache] Redis not configured — cannot load index");
      return [];
    }
    const data = await redis.get<ConversationMeta[]>(key);
    if (!Array.isArray(data)) return [];
    console.log(`[chat-cache] INDEX ${key} → ${data.length} conversations`);
    return data;
  } catch (err) {
    console.error(`[chat-cache] INDEX ${key} FAILED:`, err instanceof Error ? err.message : err);
    return [];
  }
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

/** Remove a single stale entry from the conversation index (when messages have expired). */
export async function removeStaleIndexEntry(userId: string, convId: string): Promise<void> {
  try {
    const index = await getChatIndex(userId);
    const filtered = index.filter((c) => c.id !== convId);
    if (filtered.length !== index.length) {
      await setCacheValue(chatIndexKey(userId), filtered, CHAT_TTL);
    }
  } catch { /* ignore */ }
}

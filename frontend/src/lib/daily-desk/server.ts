/**
 * Daily Desk — server side: build an LO's daily batch, send / skip / edit
 * items, and settings. Pure choices live in ./select.ts.
 *
 * Cost rules (why it's cheap):
 *   - A batch is built only when the LO opens the Today tab that day. No
 *     background work for LOs who don't show up.
 *   - One RentCast request per area (≤3), through the shared 12h search cache,
 *     with a monthly Daily Desk budget (DESK_RENTCAST_MONTHLY_BUDGET); over it
 *     we use cached results only.
 *   - Email checks (Bouncer) only for the realtors that make the batch; most
 *     are already in the shared 90-day cache. Flyer PDFs are made at send time,
 *     so skipped cards cost nothing.
 *
 * Reputation rules (why a realtor never hears from five GMCC LOs):
 *   - Company-wide cooldown: a realtor emailed by ANY GMCC LO in the last 30
 *     days (any property-search send, read from sentEmails) is never offered.
 *   - Holds: a realtor placed in one LO's batch is held for that LO for 36h
 *     (realtorOutreach/{hash}); other LOs' batches skip them. Skipping releases
 *     the hold; sending turns it into the 30-day cooldown.
 *   - Both are re-checked right before each send.
 *
 * Storage (gmcc-66e1e):
 *   dailyDesk/{email}                 settings
 *   dailyDesk/{email}/days/{YYYY-MM-DD}  that day's batch
 *   realtorOutreach/{sha1(email)}     company-wide realtor hold / last contact
 *   dailyDeskStats/{YYYY-MM-DD}       company counters (built, sent, skipped, edited…)
 *   sentEmails (source "daily-desk")  every send, so replies + cooldowns work as today
 */
import "server-only";

import { createHash, randomBytes } from "crypto";
import { FieldValue } from "firebase-admin/firestore";
import { getDb } from "@/lib/firestore-admin";
import { rentcastFetch, RentCastError } from "@/lib/rentcast";
import { getCachedRentcastSearch, setCachedRentcastSearch, getCachedJson, setCachedJson, incrementCounter } from "@/lib/redis-cache";
import { pyPost } from "@/lib/python-client";
import { verifyDeliverability, describeReason } from "@/lib/email-deliverability";
import { generateEmailDraft } from "@/lib/services/email-draft";
import { resolveProductId, generateProgramFlyerBase64 } from "@/lib/tools/generate-flyer";
import { renderFlyerImage } from "@/lib/email/flyer-image";
import { flyerImagesHtml, inlineFlyerAttachment, type EmbeddedFlyer } from "@/lib/email/flyer-embed";
import { MAX_INLINE_ATTACHMENT_BASE64, appendFlyerLink, portalFlyerUrl } from "@/lib/email/attachment-policy";
import { buildHtmlBodyWithSignature, findSignaturePlaceholder, isSignatureContentEmpty } from "@/lib/signature-store";
import { getStoredSignature } from "@/lib/signature-server";
import { sendMailAs, type GraphMessage } from "@/lib/graph-client";
import { fetchAlreadyEmailed } from "@/lib/campaigns/engine";
import type { MatchBatchResponse } from "@/types";
import {
  CLAIM_HOLD_MS,
  COMPANY_REALTOR_COOLDOWN_MS,
  DEFAULT_BATCH_SIZE,
  MAX_BATCH_SIZE,
  chooseProgram,
  clampBatchSize,
  DEFAULT_PRICE_MIN,
  DEFAULT_PRICE_MAX,
  DEFAULT_PROPERTY_TYPES,
  dayKey,
  normalizeAreas,
  pickCandidates,
  popularByState,
  seedAreas,
  toDeskListing,
  draftInstructions,
  DESK_LANGUAGES,
  type DeskArea,
  type DeskFlyerMode,
  type DeskListing,
  type DeskTone,
} from "./select";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DeskSettings {
  areas: DeskArea[];
  batchSize: number;
  priceMin: number | null;
  priceMax: number | null;
  /** Programs the LO wants to push; empty = desk decides. */
  preferredPrograms: string[];
  /** "only" = never feature a program outside preferredPrograms. */
  programMode: "prefer" | "only";
  /** Days-on-market window (null = no limit). */
  domMin: number | null;
  domMax: number | null;
  /** RentCast property types (empty = all). */
  propertyTypes: string[];
  bedsMin: number | null;
  tone: DeskTone;
  language: string;
  flyerMode: DeskFlyerMode;
  /** Remind the LO to follow up after N days if there's no reply (null = off). */
  followUpDays: number | null;
  /** CC the LO on every email the desk sends (default on). */
  ccSelf: boolean;
  /** Extra drafting instructions ("" = none). */
  instructions: string;
  /** True while the areas are the auto-picked ones (LO hasn't edited them). */
  autoSeeded: boolean;
  updatedAt: number;
}

export type DeskItemStatus = "ready" | "sent" | "skipped" | "failed";

export interface DeskItem {
  id: string;
  listing: DeskListing;
  program: string;
  reason: string;
  /** Other eligible programs the LO can switch this card to. */
  alternatives?: string[];
  productId: string | null;
  subject: string;
  body: string;
  status: DeskItemStatus;
  edited?: boolean;
  skipReason?: string;
  error?: string;
  sentAt?: number;
  flyer?: "embedded" | "attached" | "linked" | "none";
}

export interface DeskDay {
  day: string;
  userEmail: string;
  status: "building" | "ready" | "needs_setup";
  startedAt: number;
  builtAt?: number;
  items: DeskItem[];
  /** Why the batch is short/empty, in plain English. */
  note?: string;
}

export interface DeskCaller {
  uid: string;
  email: string;
  /** Firebase ID token (needed to render flyers). */
  idToken: string;
  loName?: string;
  loTitle?: string;
  loNmls?: string;
}

const SETTINGS = "dailyDesk";
export const PROPERTY_TYPES = ["Single Family", "Condo", "Townhouse", "Multi-Family"];
const OUTREACH = "realtorOutreach";
const STATS = "dailyDeskStats";
/** Daily Desk's share of the 5,000/month RentCast plan. */
const DESK_RENTCAST_MONTHLY_BUDGET = Number(process.env.DESK_RENTCAST_MONTHLY_BUDGET || 2500);
const RENTCAST_KEY = process.env.RENTCAST_API_KEY ?? "";
const BUILD_STALE_MS = 4 * 60 * 1000;

function db() {
  const d = getDb();
  if (!d) throw new Error("Firestore is not configured.");
  return d;
}
const realtorDocId = (email: string) => createHash("sha1").update(email.trim().toLowerCase()).digest("hex");
const strip = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

async function bumpStats(day: string, fields: Record<string, number>) {
  const inc: Record<string, FieldValue> = {};
  for (const [k, v] of Object.entries(fields)) inc[k] = FieldValue.increment(v);
  await db().collection(STATS).doc(day).set({ ...inc, day }, { merge: true }).catch(() => {});
}

// ─── Settings ────────────────────────────────────────────────────────────────

export const SETTINGS_DEFAULTS = {
  batchSize: DEFAULT_BATCH_SIZE,
  priceMin: DEFAULT_PRICE_MIN as number | null,
  priceMax: DEFAULT_PRICE_MAX as number | null,
  preferredPrograms: [] as string[],
  programMode: "prefer" as const,
  domMin: null,
  domMax: null,
  propertyTypes: [...DEFAULT_PROPERTY_TYPES] as string[],
  bedsMin: null,
  tone: "friendly" as DeskTone,
  language: "English",
  flyerMode: "embed" as DeskFlyerMode,
  followUpDays: null,
  ccSelf: true,
  instructions: "",
};

/** Older settings docs predate some fields: fill them with defaults. */
function withDefaults(s: Partial<DeskSettings>): DeskSettings {
  return { ...SETTINGS_DEFAULTS, areas: [], autoSeeded: false, updatedAt: 0, ...s } as DeskSettings;
}

/** Settings, creating them (auto-picked areas) on first use. */
export async function getSettings(caller: Pick<DeskCaller, "uid" | "email">, recentSearches: string[] = []): Promise<DeskSettings> {
  const ref = db().collection(SETTINGS).doc(caller.email);
  const snap = await ref.get();
  if (snap.exists) return withDefaults(snap.data() as Partial<DeskSettings>);

  let pastAddresses: string[] = [];
  try {
    const sent = await db().collection("sentEmails").where("userId", "==", caller.uid).orderBy("sentAt", "desc").limit(300).get();
    pastAddresses = sent.docs.map((d) => String(d.data().propertyAddress ?? "")).filter(Boolean);
  } catch {
    /* no history is fine */
  }
  const settings: DeskSettings = withDefaults({ areas: seedAreas(pastAddresses, recentSearches), autoSeeded: true, updatedAt: Date.now() });
  // Only persist once we found something; otherwise the LO is asked for an area.
  if (settings.areas.length) await ref.set(settings);
  return settings;
}

export async function saveSettings(caller: Pick<DeskCaller, "email">, input: Partial<DeskSettings> & { areaInputs?: (string | DeskArea)[] }): Promise<DeskSettings> {
  const ref = db().collection(SETTINGS).doc(caller.email);
  const raw = (await ref.get()).data() as Partial<DeskSettings> | undefined;
  const cur = raw ? withDefaults(raw) : null;
  const areas = input.areaInputs ? normalizeAreas(input.areaInputs) : cur?.areas ?? [];
  const money = (v: unknown) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const days = (v: unknown) => {
    if (v === null || v === "" || v === undefined) return null;
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= 0 ? Math.min(n, 365) : null;
  };
  const pick = <K extends keyof DeskSettings>(k: K): DeskSettings[K] | undefined => (input[k] !== undefined ? (input[k] as DeskSettings[K]) : cur?.[k]);
  const tone = pick("tone");
  const flyerMode = pick("flyerMode");
  const language = String(pick("language") ?? "English");
  const followUp = pick("followUpDays");
  const next: DeskSettings = {
    areas,
    batchSize: clampBatchSize(input.batchSize ?? cur?.batchSize),
    priceMin: input.priceMin !== undefined ? money(input.priceMin) : cur ? cur.priceMin : DEFAULT_PRICE_MIN,
    priceMax: input.priceMax !== undefined ? money(input.priceMax) : cur ? cur.priceMax : DEFAULT_PRICE_MAX,
    preferredPrograms: (input.preferredPrograms ?? cur?.preferredPrograms ?? []).map(String).slice(0, 10),
    programMode: pick("programMode") === "only" ? "only" : "prefer",
    domMin: input.domMin !== undefined ? days(input.domMin) : cur?.domMin ?? null,
    domMax: input.domMax !== undefined ? days(input.domMax) : cur?.domMax ?? null,
    propertyTypes: (input.propertyTypes ?? cur?.propertyTypes ?? DEFAULT_PROPERTY_TYPES).map(String).filter((t) => PROPERTY_TYPES.includes(t)).slice(0, 6),
    bedsMin: input.bedsMin !== undefined ? days(input.bedsMin) : cur?.bedsMin ?? null,
    tone: tone === "professional" || tone === "brief" ? tone : "friendly",
    language: (DESK_LANGUAGES as readonly string[]).includes(language) ? language : "English",
    flyerMode: flyerMode === "attach" || flyerMode === "link" || flyerMode === "none" ? flyerMode : "embed",
    followUpDays: followUp && [3, 5, 7, 14].includes(Number(followUp)) ? Number(followUp) : null,
    ccSelf: pick("ccSelf") !== false,
    instructions: String(input.instructions ?? cur?.instructions ?? "").slice(0, 600),
    autoSeeded: input.areaInputs ? false : cur?.autoSeeded ?? false,
    updatedAt: Date.now(),
  };
  await ref.set(strip(next));
  return next;
}

// ─── Company-wide realtor guard ──────────────────────────────────────────────

/**
 * Realtors no one at GMCC may email right now: anyone emailed by any LO in the
 * last 30 days, plus anyone held in ANOTHER LO's batch.
 */
export async function blockedRealtors(emails: string[], callerEmail: string, now = Date.now()): Promise<{ blocked: Set<string>; reasons: Map<string, string> }> {
  const blocked = new Set<string>();
  const reasons = new Map<string, string>();
  const uniq = [...new Set(emails.map((e) => e.toLowerCase()))];
  if (!uniq.length) return { blocked, reasons };

  // 1) Holds + last contact recorded by the desk.
  const refs = uniq.map((e) => db().collection(OUTREACH).doc(realtorDocId(e)));
  const snaps = await db().getAll(...refs);
  snaps.forEach((s, i) => {
    if (!s.exists) return;
    const d = s.data() as { lastContactAt?: number; holdBy?: string; holdUntil?: number };
    if (d.lastContactAt && now - d.lastContactAt < COMPANY_REALTOR_COOLDOWN_MS) {
      blocked.add(uniq[i]);
      reasons.set(uniq[i], "emailed by a GMCC LO in the last 30 days");
    } else if (d.holdBy && d.holdBy !== callerEmail && (d.holdUntil ?? 0) > now) {
      blocked.add(uniq[i]);
      reasons.set(uniq[i], "in another GMCC LO's list today");
    }
  });

  // 2) Every property-search send (campaigns, agent, manual) — equality/`in`
  //    on recipientEmail only, so no composite index is needed.
  for (let i = 0; i < uniq.length; i += 30) {
    const chunk = uniq.slice(i, i + 30);
    const snap = await db().collection("sentEmails").where("recipientEmail", "in", chunk).select("recipientEmail", "sentAt").get();
    for (const d of snap.docs) {
      const e = String(d.get("recipientEmail") ?? "").toLowerCase();
      const at = Number(d.get("sentAt") ?? 0);
      if (e && now - at < COMPANY_REALTOR_COOLDOWN_MS) {
        blocked.add(e);
        reasons.set(e, "emailed by a GMCC LO in the last 30 days");
      }
    }
  }
  return { blocked, reasons };
}

/** Hold a realtor for this LO. False when someone else got there first. */
async function holdRealtor(email: string, callerEmail: string, now = Date.now()): Promise<boolean> {
  const ref = db().collection(OUTREACH).doc(realtorDocId(email));
  return db().runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const d = (s.data() ?? {}) as { lastContactAt?: number; holdBy?: string; holdUntil?: number };
    if (d.lastContactAt && now - d.lastContactAt < COMPANY_REALTOR_COOLDOWN_MS) return false;
    if (d.holdBy && d.holdBy !== callerEmail && (d.holdUntil ?? 0) > now) return false;
    tx.set(ref, { email: email.toLowerCase(), holdBy: callerEmail, holdUntil: now + CLAIM_HOLD_MS }, { merge: true });
    return true;
  });
}

async function releaseHold(email: string, callerEmail: string) {
  const ref = db().collection(OUTREACH).doc(realtorDocId(email));
  await db()
    .runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (s.exists && s.data()?.holdBy === callerEmail) tx.update(ref, { holdBy: null, holdUntil: 0 });
    })
    .catch(() => {});
}

// ─── Listings ────────────────────────────────────────────────────────────────

/** Per-LO daily cap on fresh (uncached) RentCast calls from the desk. */
const DESK_RENTCAST_PER_LO_PER_DAY = 9;
/** Per-LO daily cap on builds (first build, rebuilds after settings, top-ups). */
const DESK_BUILDS_PER_LO_PER_DAY = 8;

export class DeskLimitError extends Error {}

async function listingsForArea(area: DeskArea, callerEmail: string): Promise<{ listings: Record<string, unknown>[]; fromCache: boolean; budgetHit: boolean }> {
  const params = new URLSearchParams({ status: "Active", limit: "500" });
  if (area.lat != null && area.lng != null) {
    // Snapped to a ~1 km grid so nearby LOs share the 12h cache and random
    // coordinates can't be used to force fresh (paid) searches.
    params.set("latitude", area.lat.toFixed(2));
    params.set("longitude", area.lng.toFixed(2));
    params.set("radius", String(area.radiusMi ?? 5));
  } else if (area.zip) params.set("zipCode", area.zip);
  else {
    params.set("city", area.city ?? "");
    params.set("state", area.state ?? "");
  }
  const key = Object.fromEntries(params.entries());
  const cached = await getCachedRentcastSearch(key);
  if (cached) return { listings: cached as Record<string, unknown>[], fromCache: true, budgetHit: false };

  // Fail closed: if the counters can't be read, don't spend.
  const month = new Date().toISOString().slice(0, 7);
  const used = await incrementCounter(`dailydesk:rentcast:${month}`, 40 * 24 * 3600);
  const mine = await incrementCounter(`dailydesk:rentcast:${callerEmail}:${dayKey()}`, 2 * 24 * 3600);
  if (used === null || mine === null || used > DESK_RENTCAST_MONTHLY_BUDGET || mine > DESK_RENTCAST_PER_LO_PER_DAY) {
    return { listings: [], fromCache: false, budgetHit: true };
  }

  const listings = (await rentcastFetch(params, RENTCAST_KEY)) as Record<string, unknown>[];
  if (listings.length) setCachedRentcastSearch(key, listings).catch(() => {});
  return { listings, fromCache: false, budgetHit: false };
}

/** state → most-sent programs over the last 14 days, cached 12h. */
async function popularPrograms(): Promise<Record<string, string[]>> {
  const key = "dailydesk:popular:v1";
  const hit = await getCachedJson<Record<string, string[]>>(key);
  if (hit) return hit;
  try {
    const since = Date.now() - 14 * 24 * 3600 * 1000;
    const snap = await db().collection("sentEmails").where("sentAt", ">=", since).select("propertyAddress", "programNames").get();
    const out = popularByState(snap.docs.map((d) => d.data() as { propertyAddress?: string; programNames?: string[] }), 3);
    await setCachedJson(key, out, 12 * 3600);
    return out;
  } catch {
    return {};
  }
}

export async function popularForStates(states: string[]): Promise<Record<string, string[]>> {
  const all = await popularPrograms();
  return Object.fromEntries(states.filter((s) => all[s]?.length).map((s) => [s, all[s]]));
}

// ─── Build ───────────────────────────────────────────────────────────────────

function dayRef(email: string, day: string) {
  return db().collection(SETTINGS).doc(email).collection("days").doc(day);
}

export async function getDay(email: string, day = dayKey()): Promise<DeskDay | null> {
  const s = await dayRef(email, day).get();
  return s.exists ? (s.data() as DeskDay) : null;
}

/**
 * Today's batch for this LO — built on the first call of the day, returned
 * as-is afterwards. Safe to call from two tabs at once (one builds, the other
 * gets the "building" doc and polls).
 */
export async function buildToday(caller: DeskCaller, recentSearches: string[] = []): Promise<DeskDay> {
  const day = dayKey();
  const ref = dayRef(caller.email, day);
  const now = Date.now();

  // Claim the build.
  const claimed = await db().runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const d = s.data() as DeskDay | undefined;
    if (d && (d.status !== "building" || now - d.startedAt < BUILD_STALE_MS)) return d;
    const fresh: DeskDay = { day, userEmail: caller.email, status: "building", startedAt: now, items: [] };
    tx.set(ref, fresh);
    return null;
  });
  if (claimed && claimed.status !== "needs_setup") return claimed;
  try {
    await countBuild(caller.email);
  } catch (err) {
    await ref.delete().catch(() => {});
    throw err;
  }

  try {
    const settings = await getSettings(caller, recentSearches);
    if (!settings.areas.length) {
      const d: DeskDay = { day, userEmail: caller.email, status: "needs_setup", startedAt: now, items: [], note: "Pick the ZIP codes or cities you farm and we'll take it from there." };
      await ref.set(d);
      return d;
    }
    const result = await buildItems(caller, settings, day);
    const d: DeskDay = { day, userEmail: caller.email, status: "ready", startedAt: now, builtAt: Date.now(), items: result.items, ...(result.note ? { note: result.note } : {}) };
    await ref.set(strip(d));
    await bumpStats(day, { built: 1, items: result.items.length });
    return d;
  } catch (err) {
    // Don't leave a stuck "building" doc: drop it so the next open retries.
    await ref.delete().catch(() => {});
    throw err;
  }
}

async function buildItems(
  caller: DeskCaller,
  settings: DeskSettings,
  day: string,
  exclude: Set<string> = new Set(),
  want = settings.batchSize,
  dryRun = false,
): Promise<{ items: DeskItem[]; note?: string }> {
  const target = Math.min(MAX_BATCH_SIZE, want);
  const notes: string[] = [];

  // 1) Listings from every area (cache first).
  const all: DeskListing[] = [];
  let budgetHit = false;
  for (const area of settings.areas) {
    try {
      const r = await listingsForArea(area, caller.email);
      budgetHit ||= r.budgetHit;
      for (const raw of r.listings) {
        const l = toDeskListing(raw);
        if (l) all.push({ ...l, area: area.label });
      }
    } catch (err) {
      notes.push(err instanceof RentCastError ? `Listings for ${area.label} are unavailable right now.` : `Couldn't load ${area.label}.`);
    }
  }
  if (budgetHit) notes.push("Today's listing-search limit was reached, so only recently searched areas were used.");
  if (!all.length) return { items: [], note: notes.join(" ") || "No active listings with an agent email in your areas right now." };

  // 2) Who we may not email: this LO's own 30-day history + company-wide guard.
  const pre = pickCandidates(all, {
    blockedEmails: exclude,
    priceMin: settings.priceMin,
    priceMax: settings.priceMax,
    domMin: settings.domMin,
    domMax: settings.domMax,
    propertyTypes: settings.propertyTypes,
    bedsMin: settings.bedsMin,
    limit: 80,
  });
  if (!pre.length) return { items: [], note: "No listings in your areas match your filters (days on market, home type, beds, price). Loosen them in Settings." };
  const own = await fetchAlreadyEmailed(caller.uid);
  const { blocked } = await blockedRealtors(pre.map((l) => l.agentEmail), caller.email);
  for (const [e, at] of own) if (Date.now() - at < COMPANY_REALTOR_COOLDOWN_MS) blocked.add(e);
  for (const e of exclude) blocked.add(e);
  const candidates = pickCandidates(pre, { blockedEmails: blocked, limit: Math.min(40, target * 5) });
  if (!candidates.length) return { items: [], note: "Every realtor with a new listing in your areas was recently contacted by GMCC. Try adding another area in Settings." };

  // 3) Match programs (local matcher, free).
  const matched = await pyPost<MatchBatchResponse>(
    "/api/match-batch",
    candidates.map((l) => ({
      formattedAddress: l.address,
      addressLine1: l.address.split(",")[0]?.trim(),
      city: l.city,
      state: l.state,
      zipCode: l.zip,
      price: l.price,
      propertyType: l.propertyType,
      bedrooms: l.beds,
      bathrooms: l.baths,
      latitude: l.latitude,
      longitude: l.longitude,
      county: l.county,
      countyFips: l.countyFips,
      stateFips: l.stateFips,
    })),
  ).catch(() => null);
  if (!matched?.success) return { items: [], note: "Program matching is unavailable right now — try again in a few minutes." };

  // 4) Pick in order: program (varied across the day), deliverable, hold the
  //    realtor (first come, first served across LOs).
  const popular = await popularPrograms();
  const usedToday = new Map<string, number>();
  const picked: { listing: DeskListing; program: string; reason: string; alternatives?: string[] }[] = [];
  let checks = 0;
  for (let i = 0; i < candidates.length; i++) {
    if (picked.length >= target || checks >= target * 3) break;
    const l = candidates[i];
    const m = matched.results[i];
    if (!m) continue;
    const choice = chooseProgram(m.programs, m.census_data as { tract_income_level?: string } | null, {
      preferred: settings.preferredPrograms,
      mode: settings.programMode,
      hasFlyer: (p) => !!resolveProductId(p),
      popularInState: popular[l.state] ?? [],
      usedToday,
    });
    if (!choice) continue;
    const census = (m.census_data ?? {}) as { tract_income_level?: string; msa_name?: string };
    const c = { listing: { ...l, tractIncome: census.tract_income_level ?? null, msaName: census.msa_name ?? null }, ...choice };
    checks++;
    const v = await verifyDeliverability(c.listing.agentEmail, caller.email).catch(() => null);
    if (v?.status !== "deliverable") continue;
    if (!dryRun && !(await holdRealtor(c.listing.agentEmail, caller.email))) continue;
    picked.push(c);
    usedToday.set(c.program, (usedToday.get(c.program) ?? 0) + 1);
  }
  if (picked.length < target) notes.push(picked.length ? `Found ${picked.length} good match${picked.length === 1 ? "" : "es"} today.` : "No new listings matched a GMCC program with a reachable agent today.");

  // 5) Drafts.
  const items = await Promise.all(
    picked.map(async (c): Promise<DeskItem> => {
      const productId = resolveProductId(c.program);
      const d = await draftFor(caller, settings, c.listing, c.program, productId);
      return {
        id: `it-${randomBytes(5).toString("hex")}`,
        listing: c.listing,
        program: c.program,
        reason: c.reason,
        ...(c.alternatives?.length ? { alternatives: c.alternatives } : {}),
        productId,
        subject: d.subject,
        body: d.body,
        status: "ready",
      };
    }),
  );
  return { items, note: notes.join(" ") || undefined };
}

/** What the draft may say about the flyer, given the LO's flyer setting. */
function draftFlyerDelivery(mode: DeskFlyerMode, productId: string | null): "embedded" | "attached" | "linked" | "none" {
  if (!productId || mode === "none") return "none";
  return mode === "attach" ? "attached" : mode === "link" ? "linked" : "embedded";
}

async function draftFor(caller: DeskCaller, settings: DeskSettings, listing: DeskListing, program: string, productId: string | null): Promise<{ subject: string; body: string }> {
  const fallback = {
    subject: `${program} for buyers of ${listing.address.split(",")[0]}`,
    body: `Hi ${listing.agentName?.split(" ")[0] || "there"},\n\nI saw your listing at ${listing.address.split(",")[0]}. Buyers for it may qualify for ${program}, and I'd be glad to help them get pre-approved quickly.\n\nWould it be helpful if I sent over the details?`,
  };
  try {
    const d = await generateEmailDraft({
      recipientType: "realtor",
      recipientName: listing.agentName || undefined,
      recipientEmail: listing.agentEmail,
      programName: program,
      propertyAddress: listing.address,
      listingPrice: listing.price != null ? String(listing.price) : undefined,
      loName: caller.loName,
      userPrompt: draftInstructions(settings),
      hasSignature: true,
      flyerDelivery: draftFlyerDelivery(settings.flyerMode, productId),
    });
    return { subject: d.subject || fallback.subject, body: d.body || fallback.body };
  } catch {
    return fallback;
  }
}

/** Switch a ready card to another eligible program and rewrite its email. */
export async function reprogramItem(caller: DeskCaller, itemId: string, program: string): Promise<DeskDay> {
  const cur = await getDay(caller.email);
  const it = cur?.items.find((i) => i.id === itemId);
  if (!cur || !it) throw new Error("That email isn't in today's list.");
  if (it.status !== "ready") throw new Error("Only unsent emails can be edited.");
  if (program !== it.program && !(it.alternatives ?? []).includes(program)) throw new Error("That program isn't eligible for this listing.");
  const settings = await getSettings(caller);
  const productId = resolveProductId(program);
  const d = await draftFor(caller, settings, it.listing, program, productId);
  return mutateItem(caller.email, itemId, (x) => {
    if (x.status !== "ready") throw new Error("Only unsent emails can be edited.");
    x.alternatives = [x.program, ...(x.alternatives ?? []).filter((p) => p !== program)].slice(0, 6);
    x.program = program;
    x.productId = productId;
    x.subject = d.subject;
    x.body = d.body;
    x.edited = false;
  });
}

/** Build a batch without saving it or holding any realtor (scripts / QA only). */
export async function previewBatch(caller: DeskCaller, settings: DeskSettings) {
  return buildItems(caller, settings, dayKey(), new Set(), settings.batchSize, true);
}

/** Swap skipped cards for fresh ones, up to the batch size. */
async function countBuild(email: string) {
  const n = await incrementCounter(`dailydesk:builds:${email}:${dayKey()}`, 2 * 24 * 3600);
  if (n === null || n > DESK_BUILDS_PER_LO_PER_DAY) {
    throw new DeskLimitError("You've rebuilt today's list a lot today — it'll refresh tomorrow. (Your saved settings are kept.)");
  }
}

export async function topUp(caller: DeskCaller): Promise<DeskDay> {
  const day = dayKey();
  const ref = dayRef(caller.email, day);
  const cur = (await ref.get()).data() as DeskDay | undefined;
  if (!cur || cur.status !== "ready") return buildToday(caller);
  const settings = await getSettings(caller);
  const active = cur.items.filter((i) => i.status !== "skipped").length;
  const want = Math.max(0, settings.batchSize - active);
  if (!want) return cur;
  await countBuild(caller.email);
  const exclude = new Set(cur.items.map((i) => i.listing.agentEmail));
  const more = await buildItems(caller, settings, day, exclude, want);
  const next: DeskDay = { ...cur, items: [...cur.items, ...more.items], note: more.items.length ? undefined : more.note };
  await ref.set(strip(next));
  return next;
}

/** Throw today's unsent batch away (after settings change) — the next open rebuilds. */
export async function resetToday(caller: Pick<DeskCaller, "email">): Promise<void> {
  const ref = dayRef(caller.email, dayKey());
  const cur = (await ref.get()).data() as DeskDay | undefined;
  if (!cur) return;
  if (cur.items.some((i) => i.status === "sent")) {
    // Keep what was sent; drop only the unsent cards.
    for (const i of cur.items.filter((x) => x.status === "ready")) await releaseHold(i.listing.agentEmail, caller.email);
    await ref.set(strip({ ...cur, items: cur.items.filter((i) => i.status !== "ready") }));
    return;
  }
  for (const i of cur.items) if (i.status === "ready") await releaseHold(i.listing.agentEmail, caller.email);
  await ref.delete();
}

// ─── Edit / skip ─────────────────────────────────────────────────────────────

async function mutateItem(email: string, itemId: string, fn: (it: DeskItem) => void): Promise<DeskDay> {
  const ref = dayRef(email, dayKey());
  return db().runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const d = s.data() as DeskDay | undefined;
    if (!d) throw new Error("Today's list wasn't found — refresh the page.");
    const it = d.items.find((i) => i.id === itemId);
    if (!it) throw new Error("That email isn't in today's list.");
    fn(it);
    tx.set(ref, strip(d));
    return d;
  });
}

export async function editItem(caller: Pick<DeskCaller, "email">, itemId: string, subject: string, body: string): Promise<DeskDay> {
  const d = await mutateItem(caller.email, itemId, (it) => {
    if (it.status !== "ready") throw new Error("Only unsent emails can be edited.");
    it.subject = subject.trim().slice(0, 200) || it.subject;
    it.body = body.trim().slice(0, 5000) || it.body;
    it.edited = true;
  });
  await bumpStats(dayKey(), { edited: 1 });
  return d;
}

export async function skipItem(caller: Pick<DeskCaller, "email">, itemId: string, reason: string): Promise<DeskDay> {
  let agent = "";
  const d = await mutateItem(caller.email, itemId, (it) => {
    if (it.status !== "ready") throw new Error("This email was already handled.");
    it.status = "skipped";
    it.skipReason = reason.slice(0, 80) || "skipped";
    agent = it.listing.agentEmail;
  });
  if (agent) await releaseHold(agent, caller.email);
  await bumpStats(dayKey(), { skipped: 1, [`skip_${(reason || "other").replace(/[^a-z]/gi, "").slice(0, 20).toLowerCase() || "other"}`]: 1 });
  return d;
}

// ─── Send ────────────────────────────────────────────────────────────────────

export class DeskSendError extends Error {}

/**
 * Send the given ready items (or all ready items). Each one is re-checked
 * against the company-wide guard right before sending.
 */
export async function sendItems(caller: DeskCaller, itemIds: string[] | "all"): Promise<{ day: DeskDay; sent: number; skipped: number; failed: number }> {
  const signatureHtml = (await getStoredSignature(caller.email)) ?? "";
  if (!signatureHtml || isSignatureContentEmpty(signatureHtml) || findSignaturePlaceholder(signatureHtml)) {
    throw new DeskSendError("Add your email signature first (gear icon → Signature), then send.");
  }
  const day = dayKey();
  const ref = dayRef(caller.email, day);
  const cur = (await ref.get()).data() as DeskDay | undefined;
  if (!cur) throw new DeskSendError("Today's list wasn't found — refresh the page.");
  const targets = cur.items.filter((i) => i.status === "ready" && (itemIds === "all" || itemIds.includes(i.id)));

  const settings = await getSettings(caller);
  const pdfs = new Map<string, string | null>();
  const images = new Map<string, EmbeddedFlyer | null>();
  /** The flyer PDF (base64, already shrunk to fit when possible), once per program. */
  const pdfFor = async (program: string, productId: string): Promise<string | null> => {
    if (!pdfs.has(productId)) {
      const r = await generateProgramFlyerBase64(program, { firebaseToken: caller.idToken, userEmail: caller.email, loTitle: caller.loTitle }).catch(() => ({ error: "failed" }));
      pdfs.set(productId, "error" in r ? null : r.base64);
    }
    return pdfs.get(productId) ?? null;
  };
  const imageFor = async (program: string, productId: string): Promise<EmbeddedFlyer | null> => {
    if (!images.has(productId)) {
      let f: EmbeddedFlyer | null = null;
      const pdf = await pdfFor(program, productId);
      if (pdf) {
        try {
          const img = await renderFlyerImage(Buffer.from(pdf, "base64"));
          f = { ...img, id: productId, title: program, pdfUrl: portalFlyerUrl(productId, caller.loNmls) };
        } catch {
          f = null;
        }
      }
      images.set(productId, f);
    }
    return images.get(productId) ?? null;
  };

  const results = new Map<string, Partial<DeskItem>>();
  let sent = 0, skipped = 0, failed = 0;
  for (const it of targets) {
    const agent = it.listing.agentEmail;
    try {
      // Re-check the company guard (someone else may have just emailed them).
      const { blocked, reasons } = await blockedRealtors([agent], caller.email);
      if (blocked.has(agent)) {
        results.set(it.id, { status: "skipped", skipReason: `Not sent — ${reasons.get(agent) ?? "recently contacted"}.` });
        skipped++;
        continue;
      }
      const v = await verifyDeliverability(agent, caller.email);
      if (v.status !== "deliverable") {
        results.set(it.id, { status: "skipped", skipReason: `Not sent — ${describeReason(v.status, v.reason)}` });
        await releaseHold(agent, caller.email);
        skipped++;
        continue;
      }

      // Flyer per the LO's setting; anything that can't be made falls back to a link.
      let delivery: "embedded" | "attached" | "linked" | "none" = "none";
      let embedded: EmbeddedFlyer | null = null;
      let attachment: string | null = null;
      let body = it.body;
      if (it.productId && settings.flyerMode !== "none") {
        if (settings.flyerMode === "embed") {
          embedded = await imageFor(it.program, it.productId);
          if (embedded) delivery = "embedded";
        } else if (settings.flyerMode === "attach") {
          const pdf = await pdfFor(it.program, it.productId);
          if (pdf && pdf.length <= MAX_INLINE_ATTACHMENT_BASE64) {
            attachment = pdf;
            delivery = "attached";
          }
        }
        if (delivery === "none") {
          delivery = "linked";
          body = appendFlyerLink(body, portalFlyerUrl(it.productId, caller.loNmls));
        }
      }
      const message: GraphMessage = {
        subject: it.subject,
        body: { contentType: "HTML", content: buildHtmlBodyWithSignature(body, signatureHtml, embedded ? flyerImagesHtml([embedded]) : "") },
        toRecipients: [{ emailAddress: { address: agent, ...(it.listing.agentName ? { name: it.listing.agentName } : {}) } }],
        ...(settings.ccSelf ? { ccRecipients: [{ emailAddress: { address: caller.email } }] } : {}),
        ...(embedded
          ? { attachments: [inlineFlyerAttachment(embedded)] }
          : attachment
            ? {
                attachments: [
                  {
                    "@odata.type": "#microsoft.graph.fileAttachment" as const,
                    name: `GMCC-${it.program.replace(/[^a-zA-Z0-9]+/g, "-")}.pdf`,
                    contentType: "application/pdf",
                    contentBytes: attachment,
                  },
                ],
              }
            : {}),
      };
      const r = await sendMailAs(caller.email, message);
      if (!r.ok) throw new Error(r.error ?? "Outlook refused the message.");

      const now = Date.now();
      await db().collection("sentEmails").add(
        strip({
          userId: caller.uid,
          userEmail: caller.email,
          recipientEmail: agent,
          recipientName: it.listing.agentName || "",
          recipientType: "realtor",
          subject: it.subject,
          bodyPreview: body.slice(0, 500),
          propertyAddress: it.listing.address,
          programNames: [it.program],
          sentAt: now,
          source: "daily-desk",
          deskItemId: it.id,
          deskEdited: !!it.edited,
          flyer: { delivery, productId: it.productId ?? undefined },
          // Optional reminder to the LO (the existing follow-up cron sends it; a reply cancels it).
          followUp: settings.followUpDays
            ? { mode: "remind", scheduledAt: now + settings.followUpDays * 86_400_000, status: "pending", reminderCount: 0, lastReminderAt: null, draftSubject: null, draftBody: null }
            : null,
        }),
      );
      await db().collection(OUTREACH).doc(realtorDocId(agent)).set({ email: agent, lastContactAt: now, lastLoEmail: caller.email, holdBy: null, holdUntil: 0 }, { merge: true });
      results.set(it.id, { status: "sent", sentAt: now, flyer: delivery, error: undefined });
      sent++;
    } catch (err) {
      results.set(it.id, { status: "failed", error: err instanceof Error ? err.message.slice(0, 200) : "Send failed." });
      failed++;
    }
  }

  // Apply results in one transaction so a parallel edit/skip isn't clobbered.
  const next = await db().runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const d = s.data() as DeskDay;
    for (const i of d.items) {
      const r = results.get(i.id);
      if (r) Object.assign(i, r);
    }
    tx.set(ref, strip(d));
    return d;
  });
  await bumpStats(day, { sent, sendSkipped: skipped, failed, ...(itemIds === "all" ? { sendAll: 1 } : {}) });
  return { day: next, sent, skipped, failed };
}

/** Retry a failed item: put it back to ready. */
export async function retryItem(caller: Pick<DeskCaller, "email">, itemId: string): Promise<DeskDay> {
  return mutateItem(caller.email, itemId, (it) => {
    if (it.status !== "failed") throw new Error("Only failed emails can be retried.");
    it.status = "ready";
    it.error = undefined;
  });
}

// ─── Results ─────────────────────────────────────────────────────────────────

/** This LO's Daily Desk results for the last 7 days. */
export async function weekStats(caller: Pick<DeskCaller, "uid">): Promise<{ sent: number; replies: number }> {
  try {
    const since = Date.now() - 7 * 24 * 3600 * 1000;
    const snap = await db().collection("sentEmails").where("userId", "==", caller.uid).orderBy("sentAt", "desc").limit(300).get();
    const rows = snap.docs.map((d) => d.data()).filter((d) => d.source === "daily-desk" && Number(d.sentAt) >= since);
    return { sent: rows.length, replies: rows.filter((d) => d.hasReply || d.followUp?.status === "replied").length };
  } catch {
    return { sent: 0, replies: 0 };
  }
}

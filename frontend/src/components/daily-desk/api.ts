"use client";

import { authedFetch } from "@/lib/authed-fetch";
import { getAuthToken } from "@/lib/auth-token";
import { getLOInfo } from "@/lib/lo-info-store";
import { getRecentSearches } from "@/lib/recent-searches";

/** Mirrors lib/daily-desk/server.ts (client-safe copy of the shapes). */
export interface DeskArea { zip?: string; city?: string; state?: string; lat?: number; lng?: number; radiusMi?: number; place?: string; label: string }
/** What the settings call accepts per area: typed text, or a "near me" point. */
export type AreaInput = string | { lat: number; lng: number; radiusMi: number; place?: string };
export interface DeskListing {
  id: string; address: string; city: string; state: string; zip: string;
  price: number | null; beds: number | null; baths: number | null; sqft: number | null;
  propertyType: string | null; daysOnMarket: number | null;
  agentName: string; agentEmail: string; agentPhone: string | null; officeName: string | null; area?: string;
  county?: string; latitude?: number; longitude?: number; addressLine1?: string;
  yearBuilt?: number | null; lotSize?: number | null; hoaFee?: number | null; listedDate?: string | null; mlsNumber?: string | null;
  lastSalePrice?: number | null; lastSaleDate?: string | null; officePhone?: string | null; tractIncome?: string | null; msaName?: string | null;
}
export interface DeskItem {
  id: string; listing: DeskListing; program: string; reason: string; alternatives?: string[]; productId: string | null;
  subject: string; body: string; status: "ready" | "sent" | "skipped" | "failed";
  edited?: boolean; skipReason?: string; error?: string; sentAt?: number; flyer?: "embedded" | "attached" | "linked" | "none";
}
export interface DeskDay { day: string; status: "building" | "ready" | "needs_setup"; startedAt: number; builtAt?: number; items: DeskItem[]; note?: string }
export interface DeskSettings {
  areas: DeskArea[]; batchSize: number; priceMin: number | null; priceMax: number | null;
  preferredPrograms: string[]; instructions: string; autoSeeded: boolean;
  programMode: "prefer" | "only";
  domMin: number | null; domMax: number | null;
  propertyTypes: string[]; bedsMin: number | null;
  tone: "friendly" | "professional" | "brief";
  language: string;
  flyerMode: "embed" | "attach" | "link" | "none";
  followUpDays: number | null;
}
export interface DeskState {
  settings: DeskSettings;
  day: DeskDay | null;
  stats: { sent: number; replies: number };
  popular: Record<string, string[]>;
  signatureOk: boolean;
  limits: { defaultBatch: number; maxBatch: number; maxAreas: number; radiusOptions: number[]; languages: string[]; propertyTypes: string[] };
}

function headers(): HeadersInit {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  const lo = getLOInfo();
  if (lo.name || lo.title || lo.nmls) h["X-LO-Info"] = btoa(unescape(encodeURIComponent(JSON.stringify(lo))));
  return h;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The Firebase ID token, waiting briefly for it: right after page load the
 * Today tab can ask before sign-in has finished restoring, which used to
 * send the request without a token ("Authentication required").
 */
async function waitForToken(maxMs = 10_000): Promise<string | null> {
  const until = Date.now() + maxMs;
  for (;;) {
    const t = await getAuthToken();
    if (t || Date.now() > until) return t;
    await sleep(300);
  }
}

async function call<T>(init?: { method?: string; body?: unknown }): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const token = await waitForToken();
    const h = new Headers(headers());
    if (token) h.set("Authorization", `Bearer ${token}`);
    const res = await fetch("/api/daily-desk", {
      method: init?.method ?? "GET",
      headers: h,
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    // One retry on 401: the token may have been mid-refresh.
    if (res.status === 401 && attempt === 0) {
      await sleep(1200);
      continue;
    }
    const j = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Error("Your sign-in didn't come through — refresh the page, or sign out and back in.");
    if (!res.ok) throw new Error((j as { error?: string }).error || `Request failed (${res.status})`);
    return j as T;
  }
}

/** Recent property searches on this browser → hints for auto-picking areas. */
function recentSearchHints(): string[] {
  try {
    return getRecentSearches()
      .map((s) => s.query || (s.city && s.state ? `${s.city}, ${s.state}` : ""))
      .filter(Boolean)
      .slice(0, 10);
  } catch {
    return [];
  }
}

export const deskApi = {
  load: () => call<DeskState>(),
  build: () => call<{ day: DeskDay }>({ method: "POST", body: { action: "build", recentSearches: recentSearchHints() } }),
  more: () => call<{ day: DeskDay }>({ method: "POST", body: { action: "more" } }),
  send: (itemIds: string[] | "all") => call<{ day: DeskDay; sent: number; skipped: number; failed: number }>({ method: "POST", body: { action: "send", itemIds } }),
  skip: (itemId: string, reason: string) => call<{ day: DeskDay }>({ method: "POST", body: { action: "skip", itemId, reason } }),
  edit: (itemId: string, subject: string, body: string) => call<{ day: DeskDay }>({ method: "POST", body: { action: "edit", itemId, subject, body } }),
  program: (itemId: string, program: string) => call<{ day: DeskDay }>({ method: "POST", body: { action: "program", itemId, program } }),
  retry: (itemId: string) => call<{ day: DeskDay }>({ method: "POST", body: { action: "retry", itemId } }),
  saveSettings: (s: Partial<Omit<DeskSettings, "areas">> & { areaInputs?: AreaInput[]; rebuild?: boolean }) =>
    call<{ settings: DeskSettings; day: DeskDay | null }>({ method: "POST", body: { action: "settings", ...s } }),
};

/** Stored area → the input shape the settings call takes (keeps "near me" points). */
export function toAreaInput(a: DeskArea): AreaInput {
  return a.lat != null && a.lng != null ? { lat: a.lat, lng: a.lng, radiusMi: a.radiusMi ?? 5, place: a.place } : a.label;
}

/**
 * The browser's current location as a "near me" area. Only the city, state and
 * ZIP are kept (the street from reverse-geocoding is dropped).
 */
export async function locateMe(radiusMi: number): Promise<{ lat: number; lng: number; radiusMi: number; place?: string }> {
  if (typeof navigator === "undefined" || !navigator.geolocation) throw new Error("Your browser can't share your location — type a ZIP or city instead.");
  const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
    navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: false, timeout: 15000, maximumAge: 10 * 60 * 1000 }),
  ).catch((e: GeolocationPositionError) => {
    throw new Error(e?.code === 1 ? "Location is blocked for this site — allow it in your browser, or type a ZIP or city." : "Couldn't get your location — type a ZIP or city instead.");
  });
  const { latitude: lat, longitude: lng } = pos.coords;
  let place: string | undefined;
  try {
    const r = await authedFetch(`/api/reverse-geocode?lat=${lat}&lng=${lng}`);
    const j = (await r.json()) as { address?: string | null };
    const parts = String(j.address ?? "").split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) place = parts.slice(-2).join(", ");
  } catch {
    /* label falls back to "my location" */
  }
  return { lat, lng, radiusMi, place };
}

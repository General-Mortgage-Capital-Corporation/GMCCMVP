"use client";

import { authedFetch } from "@/lib/authed-fetch";
import { getLOInfo } from "@/lib/lo-info-store";
import { getRecentSearches } from "@/lib/recent-searches";

/** Mirrors lib/daily-desk/server.ts (client-safe copy of the shapes). */
export interface DeskArea { zip?: string; city?: string; state?: string; label: string }
export interface DeskListing {
  id: string; address: string; city: string; state: string; zip: string;
  price: number | null; beds: number | null; baths: number | null; sqft: number | null;
  propertyType: string | null; daysOnMarket: number | null;
  agentName: string; agentEmail: string; agentPhone: string | null; officeName: string | null; area?: string;
}
export interface DeskItem {
  id: string; listing: DeskListing; program: string; reason: string; productId: string | null;
  subject: string; body: string; status: "ready" | "sent" | "skipped" | "failed";
  edited?: boolean; skipReason?: string; error?: string; sentAt?: number; flyer?: "embedded" | "linked" | "none";
}
export interface DeskDay { day: string; status: "building" | "ready" | "needs_setup"; startedAt: number; builtAt?: number; items: DeskItem[]; note?: string }
export interface DeskSettings {
  areas: DeskArea[]; batchSize: number; priceMin: number | null; priceMax: number | null;
  preferredPrograms: string[]; instructions: string; autoSeeded: boolean;
}
export interface DeskState {
  settings: DeskSettings;
  day: DeskDay | null;
  stats: { sent: number; replies: number };
  popular: Record<string, string[]>;
  signatureOk: boolean;
  limits: { defaultBatch: number; maxBatch: number; maxAreas: number };
}

function headers(): HeadersInit {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  const lo = getLOInfo();
  if (lo.name || lo.title || lo.nmls) h["X-LO-Info"] = btoa(unescape(encodeURIComponent(JSON.stringify(lo))));
  return h;
}

async function call<T>(init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await authedFetch("/api/daily-desk", {
    method: init?.method ?? "GET",
    headers: headers(),
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((j as { error?: string }).error || `Request failed (${res.status})`);
  return j as T;
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
  retry: (itemId: string) => call<{ day: DeskDay }>({ method: "POST", body: { action: "retry", itemId } }),
  saveSettings: (s: Partial<Omit<DeskSettings, "areas">> & { areaInputs?: string[]; rebuild?: boolean }) =>
    call<{ settings: DeskSettings; day: DeskDay | null }>({ method: "POST", body: { action: "settings", ...s } }),
};

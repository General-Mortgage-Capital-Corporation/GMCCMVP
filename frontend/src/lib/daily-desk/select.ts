/**
 * Daily Desk — pure selection logic (no I/O, runs under `node --test`).
 *
 * The Daily Desk gives every LO a short, ready-to-send list of realtor emails
 * each day: new listings in their areas, each matched to a GMCC program, with
 * a drafted email and flyer. This module decides WHICH listings and programs;
 * lib/daily-desk/server.ts does the fetching, drafting, claiming and sending.
 */

export const DEFAULT_BATCH_SIZE = 5;
export const MAX_BATCH_SIZE = 10;
export const MAX_AREAS = 3;
/** Company-wide: no GMCC LO emails the same realtor more than once in this window. */
export const COMPANY_REALTOR_COOLDOWN_DAYS = 30;
export const COMPANY_REALTOR_COOLDOWN_MS = COMPANY_REALTOR_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
/** A realtor placed in one LO's batch is held for that LO this long (then released if unsent). */
export const CLAIM_HOLD_MS = 36 * 60 * 60 * 1000;

export interface DeskArea {
  /** 5-digit ZIP, or empty when this is a city area. */
  zip?: string;
  city?: string;
  state?: string;
  /** "Near me" areas: a point and a radius in miles. */
  lat?: number;
  lng?: number;
  radiusMi?: number;
  /** "Near me" areas: "San Jose, CA 95112" (no street). */
  place?: string;
  /** Display label, e.g. "95112", "San Jose, CA" or "Within 5 mi of San Jose, CA 95112". */
  label: string;
}

/** Distances offered for "Use my current location". */
export const RADIUS_OPTIONS = [2, 5, 10, 25] as const;
export const DEFAULT_RADIUS_MI = 5;

/**
 * A "near me" area from the browser's location. `place` is the reverse-geocoded
 * address ("123 Main St, San Jose, CA 95112"); only the city/state/ZIP are kept
 * in the label, never the street.
 */
export function geoArea(lat: unknown, lng: unknown, radiusMi: unknown, place = ""): DeskArea | null {
  const la = Number(lat), lo = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) return null;
  const r = Math.round(Number(radiusMi));
  const radius = Number.isFinite(r) && r >= 1 ? Math.min(25, r) : DEFAULT_RADIUS_MI;
  const parts = String(place).split(",").map((p) => p.trim()).filter(Boolean);
  // "street, city, ST 12345" → "city, ST 12345"
  const where = parts.length >= 2 ? parts.slice(-2).join(", ") : parts[0] ?? "";
  const label = where ? `Within ${radius} mi of ${where}` : `Within ${radius} mi of my location`;
  const st = extractState(place) ?? undefined;
  return {
    lat: Math.round(la * 1e4) / 1e4,
    lng: Math.round(lo * 1e4) / 1e4,
    radiusMi: radius,
    ...(st ? { state: st } : {}),
    ...(where ? { place: where.slice(0, 60) } : {}),
    label: label.slice(0, 80),
  };
}

export interface DeskListing {
  id: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  county?: string;
  countyFips?: string;
  stateFips?: string;
  latitude?: number;
  longitude?: number;
  price: number | null;
  beds: number | null;
  baths: number | null;
  sqft: number | null;
  propertyType: string | null;
  daysOnMarket: number | null;
  agentName: string;
  agentEmail: string;
  agentPhone: string | null;
  officeName: string | null;
  /** Which of the LO's areas it came from (areas take turns in the batch). */
  area?: string;
  // Extra detail for the card's "Details" panel / full property view.
  addressLine1?: string;
  yearBuilt?: number | null;
  lotSize?: number | null;
  hoaFee?: number | null;
  listedDate?: string | null;
  mlsNumber?: string | null;
  lastSalePrice?: number | null;
  lastSaleDate?: string | null;
  officePhone?: string | null;
  /** From the program matcher. */
  tractIncome?: string | null;
  msaName?: string | null;
}

export interface MatchedProgram {
  program_name: string;
  status: string;
  is_secondary?: boolean;
}

export interface ProgramChoice {
  program: string;
  /** Short plain-English "why this listing" line for the card. */
  reason: string;
  /** Other eligible programs the LO can switch the card to. */
  alternatives?: string[];
}

/** Calendar day in Pacific time — the desk "day" for everyone. */
export function dayKey(now = Date.now()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
}

export function clampBatchSize(n: unknown): number {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v) || v < 1) return DEFAULT_BATCH_SIZE;
  return Math.min(MAX_BATCH_SIZE, v);
}

const US_STATES = new Set(
  "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR".split(" "),
);

/** Validate one area from user input. Accepts "95112", "San Jose, CA", "San Jose CA". */
export function parseArea(input: string): DeskArea | null {
  const s = String(input ?? "").trim();
  if (/^\d{5}$/.test(s)) return { zip: s, label: s };
  const m = s.match(/^(.+?)[,\s]+([A-Za-z]{2})$/);
  if (m) {
    const city = m[1].trim().replace(/\s+/g, " ");
    const state = m[2].toUpperCase();
    if (city.length >= 2 && US_STATES.has(state)) {
      const nice = city.replace(/\b\w/g, (c) => c.toUpperCase());
      return { city: nice, state, label: `${nice}, ${state}` };
    }
  }
  return null;
}

export function areaKey(a: DeskArea): string {
  if (a.lat != null && a.lng != null) return `geo|${a.lat.toFixed(3)}|${a.lng.toFixed(3)}|${a.radiusMi ?? DEFAULT_RADIUS_MI}`;
  return a.zip ? a.zip : `${(a.city ?? "").toLowerCase()}|${(a.state ?? "").toUpperCase()}`;
}

export function normalizeAreas(inputs: (string | DeskArea)[]): DeskArea[] {
  const out: DeskArea[] = [];
  const seen = new Set<string>();
  for (const i of inputs) {
    const a =
      typeof i === "string"
        ? parseArea(i)
        : i?.lat != null && i?.lng != null
          ? geoArea(i.lat, i.lng, i.radiusMi, i.place ? `x, ${i.place}` : "")
          : i?.zip || (i?.city && i?.state)
            ? parseArea(i.zip ?? `${i.city}, ${i.state}`)
            : null;
    if (!a) continue;
    const k = areaKey(a);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(a);
    if (out.length >= MAX_AREAS) break;
  }
  return out;
}

/** "123 Main St, San Jose, CA 95112" → "95112". */
export function extractZip(address: string): string | null {
  const m = String(address ?? "").match(/\b([A-Z]{2})\s+(\d{5})(?:-\d{4})?\s*$/i) ?? String(address ?? "").match(/\b(\d{5})(?:-\d{4})?\s*$/);
  if (!m) return null;
  return m[2] ?? m[1];
}

/** "…, San Jose, CA 95112" → "CA". */
export function extractState(address: string): string | null {
  const m = String(address ?? "").match(/,\s*([A-Z]{2})\s+\d{5}/i);
  return m ? m[1].toUpperCase() : null;
}

/**
 * Starting areas for an LO who never set any: their most-emailed ZIPs from
 * past property-search sends, then ZIPs/cities from their recent searches.
 */
export function seedAreas(pastAddresses: string[], recentSearches: string[] = []): DeskArea[] {
  const counts = new Map<string, number>();
  for (const a of pastAddresses) {
    const z = extractZip(a);
    if (z) counts.set(z, (counts.get(z) ?? 0) + 1);
  }
  const fromSends = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([z]) => z);
  const fromSearches = recentSearches.flatMap((q) => {
    const z = extractZip(q) ?? (/^\d{5}$/.test(q.trim()) ? q.trim() : null);
    if (z) return [z];
    const parts = q.split(",").map((p) => p.trim()).filter(Boolean);
    // "San Jose, CA, USA" / "San Jose, CA"
    if (parts.length >= 2 && /^[A-Z]{2}$/i.test(parts[1].split(" ")[0])) return [`${parts[0]}, ${parts[1].split(" ")[0]}`];
    return [];
  });
  return normalizeAreas([...fromSends, ...fromSearches]);
}

const EXCLUDED_TYPES = new Set(["Land", "Apartment", "Manufactured"]);

/** RentCast record → DeskListing, or null when it can't be emailed (no agent email etc.). */
export function toDeskListing(raw: Record<string, unknown>): DeskListing | null {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const agent = (raw.listingAgent ?? {}) as Record<string, unknown>;
  const office = (raw.listingOffice ?? {}) as Record<string, unknown>;
  const email = str(agent.email)?.toLowerCase() ?? null;
  const address = str(raw.formattedAddress);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !address) return null;
  const type = str(raw.propertyType);
  if (type && EXCLUDED_TYPES.has(type)) return null;
  return {
    id: str(raw.id) ?? address,
    address,
    city: str(raw.city) ?? "",
    state: str(raw.state) ?? "",
    zip: str(raw.zipCode) ?? "",
    county: str(raw.county) ?? undefined,
    countyFips: str(raw.countyFips) ?? undefined,
    stateFips: str(raw.stateFips) ?? undefined,
    latitude: num(raw.latitude) ?? undefined,
    longitude: num(raw.longitude) ?? undefined,
    price: num(raw.price),
    beds: num(raw.bedrooms),
    baths: num(raw.bathrooms),
    sqft: num(raw.squareFootage),
    propertyType: type,
    daysOnMarket: num(raw.daysOnMarket),
    agentName: str(agent.name) ?? "",
    agentEmail: email,
    agentPhone: str(agent.phone),
    officeName: str(office.name),
    addressLine1: str(raw.addressLine1) ?? undefined,
    yearBuilt: num(raw.yearBuilt),
    lotSize: num(raw.lotSize),
    hoaFee: num((raw.hoa as Record<string, unknown> | undefined)?.fee),
    listedDate: str(raw.listedDate),
    mlsNumber: str(raw.mlsNumber),
    lastSalePrice: num(raw.lastSalePrice),
    lastSaleDate: str(raw.lastSaleDate),
    officePhone: str(office.phone),
  };
}

export interface CandidateOptions {
  /** Realtor emails no one at GMCC may email right now (company cooldown + other LOs' holds). */
  blockedEmails: Set<string>;
  priceMin?: number | null;
  priceMax?: number | null;
  /** Days on market window (null = no limit). */
  domMin?: number | null;
  domMax?: number | null;
  /** RentCast property types to keep (empty = all). */
  propertyTypes?: string[];
  bedsMin?: number | null;
  /** How many to return (we match more than we need: some won't fit a program). */
  limit: number;
}

/**
 * Freshest listings first, one per realtor, skipping blocked realtors and
 * listings outside the price band.
 */
export function pickCandidates(listings: DeskListing[], opts: CandidateOptions): DeskListing[] {
  const seenAgents = new Set<string>();
  const seenIds = new Set<string>();
  const ok = listings.filter((l) => {
    if (opts.blockedEmails.has(l.agentEmail)) return false;
    if (opts.priceMin && (l.price ?? 0) < opts.priceMin) return false;
    if (opts.priceMax && (l.price ?? Infinity) > opts.priceMax) return false;
    if (opts.domMin != null && (l.daysOnMarket ?? 0) < opts.domMin) return false;
    if (opts.domMax != null && (l.daysOnMarket ?? Infinity) > opts.domMax) return false;
    if (opts.propertyTypes?.length && !opts.propertyTypes.includes(l.propertyType ?? "")) return false;
    if (opts.bedsMin && (l.beds ?? 0) < opts.bedsMin) return false;
    return true;
  });
  ok.sort((a, b) => (a.daysOnMarket ?? 999) - (b.daysOnMarket ?? 999) || (b.price ?? 0) - (a.price ?? 0));
  // Areas take turns (freshest of each area first), so one busy ZIP can't fill the whole day.
  const byArea = new Map<string, DeskListing[]>();
  for (const l of ok) {
    const k = l.area ?? "";
    byArea.set(k, [...(byArea.get(k) ?? []), l]);
  }
  const queues = [...byArea.values()];
  const ordered: DeskListing[] = [];
  for (let i = 0; ordered.length < ok.length; i++) for (const q of queues) if (q[i]) ordered.push(q[i]);
  const out: DeskListing[] = [];
  for (const l of ordered) {
    if (seenAgents.has(l.agentEmail) || seenIds.has(l.id)) continue;
    seenAgents.add(l.agentEmail);
    seenIds.add(l.id);
    out.push(l);
    if (out.length >= opts.limit) break;
  }
  return out;
}

/** Location-gated community/CRA programs — the strongest "why this listing" angle when eligible. */
const COMMUNITY_RE = /\b(CRA|Celebrity|Grand Slam|Community)\b/i;

export interface ProgramPrefs {
  /** Programs the LO wants to push (empty = let the desk decide). */
  preferred: string[];
  /** "only": never pick a program outside `preferred` (when it's non-empty). */
  mode?: "prefer" | "only";
  /** Programs that have a flyer template. */
  hasFlyer: (program: string) => boolean;
  /** Most-sent programs in this listing's state, best first. */
  popularInState: string[];
  /** Programs already used in today's batch → count (keeps the day varied). */
  usedToday?: Map<string, number>;
}

export function chooseProgram(programs: MatchedProgram[], census: { tract_income_level?: string } | null, prefs: ProgramPrefs): ProgramChoice | null {
  const preferred = new Set(prefs.preferred.map((p) => p.toLowerCase()));
  const eligible = programs.filter(
    (p) => p.status === "Eligible" && (prefs.mode !== "only" || !preferred.size || preferred.has(p.program_name.toLowerCase())),
  );
  if (!eligible.length) return null;
  const score = (p: MatchedProgram) => {
    let s = 0;
    if (preferred.has(p.program_name.toLowerCase())) s += 100;
    if (prefs.hasFlyer(p.program_name)) s += 40;
    // Community/CRA programs are the strongest angle only where the tract qualifies.
    if (COMMUNITY_RE.test(p.program_name) && /low|moderate/i.test(census?.tract_income_level ?? "")) s += 25;
    const pop = prefs.popularInState.findIndex((x) => x.toLowerCase() === p.program_name.toLowerCase());
    if (pop >= 0) s += 15 - Math.min(pop, 10);
    if (p.is_secondary) s -= 5;
    s -= 30 * (prefs.usedToday?.get(p.program_name) ?? 0);
    return s;
  };
  const ranked = [...eligible].sort((a, b) => score(b) - score(a));
  const best = ranked[0];
  return {
    program: best.program_name,
    reason: programReason(best.program_name, census, eligible.length),
    alternatives: ranked.slice(1, 7).map((p) => p.program_name),
  };
}

export function programReason(program: string, census: { tract_income_level?: string } | null, eligibleCount: number): string {
  const tract = census?.tract_income_level;
  const parts: string[] = [];
  if (tract && /low|moderate/i.test(tract)) parts.push(`${tract}-income census tract`);
  parts.push(eligibleCount > 1 ? `eligible for ${eligibleCount} GMCC programs` : "eligible for this program");
  return parts.join(" · ");
}

/** sentEmails rows → state → programs by send count (James's "popular flyers per state"). */
export function popularByState(rows: { propertyAddress?: string; programNames?: string[] }[], topN = 3): Record<string, string[]> {
  const counts = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const st = extractState(r.propertyAddress ?? "");
    if (!st) continue;
    const m = counts.get(st) ?? new Map<string, number>();
    for (const p of r.programNames ?? []) if (p) m.set(p, (m.get(p) ?? 0) + 1);
    counts.set(st, m);
  }
  const out: Record<string, string[]> = {};
  for (const [st, m] of counts) out[st] = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN).map(([p]) => p);
  return out;
}

export type DeskTone = "friendly" | "professional" | "brief";
export type DeskFlyerMode = "embed" | "attach" | "link" | "none";
export const DESK_LANGUAGES = ["English", "Spanish", "Chinese (Simplified)", "Chinese (Traditional)", "Korean", "Vietnamese", "Tagalog", "Hindi", "Russian", "Arabic"] as const;

const TONE_TEXT: Record<DeskTone, string> = {
  friendly: "Warm and conversational.",
  professional: "Polished and professional.",
  brief: "Very brief: 3-4 short sentences, under 70 words.",
};

/** Full drafting instruction from the LO's style settings. */
export function draftInstructions(opts: { tone?: DeskTone; language?: string; instructions?: string }): string {
  const parts = [DEFAULT_DESK_INSTRUCTIONS, TONE_TEXT[opts.tone ?? "friendly"]];
  const lang = opts.language && opts.language !== "English" && (DESK_LANGUAGES as readonly string[]).includes(opts.language) ? opts.language : null;
  if (lang) parts.push(`Write the subject and the whole email in ${lang}.`);
  if (opts.instructions?.trim()) parts.push(`The loan officer's own instructions (follow them): ${opts.instructions.trim()}`);
  return parts.join(" ");
}

/** Default drafting instruction; the LO can replace it in Settings. */
export const DEFAULT_DESK_INSTRUCTIONS =
  "Short, warm first-touch email to the listing agent. Mention their listing by street, say why the GMCC program fits buyers for it in one or two sentences, and offer to help their buyers get pre-approved. No more than 110 words. No hype, no rate promises.";

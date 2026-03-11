/**
 * Shared utilities for RentCast API calls and address/distance helpers.
 * Used by Next.js API routes (search, program-search, marketing-search).
 */

export const RENTCAST_BASE = "https://api.rentcast.io/v1/listings/sale";
export const MAX_LIMIT = 500;

// ---------------------------------------------------------------------------
// Distance
// ---------------------------------------------------------------------------

/** Haversine great-circle distance in miles. */
export function haversine(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 3959;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---------------------------------------------------------------------------
// Address normalization
// ---------------------------------------------------------------------------

const SUFFIXES: Record<string, string> = {
  avenue: "ave",
  street: "st",
  drive: "dr",
  boulevard: "blvd",
  road: "rd",
  lane: "ln",
  court: "ct",
  place: "pl",
  circle: "cir",
  terrace: "ter",
  parkway: "pkwy",
  highway: "hwy",
  trail: "trl",
  square: "sq",
};

export function normalizeAddress(addr: string): string {
  let s = addr
    .toLowerCase()
    .trim()
    .replace(/,?\s*usa$/i, "")
    .replace(/\b\d{5}(-\d{4})?\b/g, "")
    .replace(/[,.]/g, "");
  for (const [full, abbr] of Object.entries(SUFFIXES)) {
    s = s.replace(new RegExp(`\\b${full}\\b`, "g"), abbr);
  }
  return s.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// RentCast fetch helper
// ---------------------------------------------------------------------------

export class RentCastError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "RentCastError";
    this.status = status;
  }
}

export type Listing = Record<string, unknown> & {
  latitude?: number;
  longitude?: number;
  formattedAddress?: string;
  stateFips?: string;
  countyFips?: string;
  distance?: number;
};

export async function rentcastFetch(
  params: URLSearchParams,
  apiKey: string,
): Promise<Listing[]> {
  const res = await fetch(`${RENTCAST_BASE}?${params}`, {
    headers: { accept: "application/json", "X-Api-Key": apiKey },
    signal: AbortSignal.timeout(30_000),
    cache: "no-store",
  });

  if (!res.ok) {
    if (res.status === 401) throw new RentCastError("Invalid API key.", 401);
    if (res.status === 429)
      throw new RentCastError("API rate limit exceeded.", 429);
    throw new RentCastError("Search service error. Please try again.", 502);
  }

  const data = await res.json();
  return Array.isArray(data) ? (data as Listing[]) : [];
}

// ---------------------------------------------------------------------------
// Filter listings to a specific 5-digit county FIPS
// ---------------------------------------------------------------------------

export function filterByCountyFips(
  listings: Listing[],
  targetFips: string,
): Listing[] {
  return listings.filter((l) => {
    const sf = String(l.stateFips ?? "").trim().padStart(2, "0");
    const cf = String(l.countyFips ?? "").trim().padStart(3, "0");
    return sf && cf ? `${sf}${cf}` === targetFips : false;
  });
}

// ---------------------------------------------------------------------------
// Attach distances and sort by proximity
// ---------------------------------------------------------------------------

export function attachDistancesAndSort(
  listings: Listing[],
  centerLat: number,
  centerLon: number,
): void {
  for (const l of listings) {
    l.distance =
      l.latitude && l.longitude
        ? haversine(centerLat, centerLon, l.latitude, l.longitude)
        : 999;
  }
  listings.sort((a, b) => (a.distance ?? 999) - (b.distance ?? 999));
}

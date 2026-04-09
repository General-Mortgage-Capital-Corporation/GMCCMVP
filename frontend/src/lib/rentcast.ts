/**
 * Shared utilities for RentCast API calls and address/distance helpers.
 * Used by Next.js API routes (search, program-search, marketing-search).
 */

import type { CountyInfo } from "@/types";

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

// Address abbreviations applied by normalizeAddress(). Covers both street-type
// suffixes (avenue → ave) and directional prefixes (south → s, northeast → ne).
// Directionals were missing before, which meant "955 South Normandie Ave" and
// "955 S Normandie Ave" normalized to different strings — causing the
// /api/search exact-match heuristic to miss and fall back to the whole radius
// list. The sort order in the replace loop matters: longer forms must run
// first so "northeast" doesn't get partially rewritten to "neast" by a "north"
// replacement. See the ADDRESS_ABBREVIATIONS_SORTED array below.
const ADDRESS_ABBREVIATIONS: Record<string, string> = {
  // Street-type suffixes
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
  // Directional prefixes — ordered intentionally in descending length so
  // compound directions are matched before their component cardinals.
  northeast: "ne",
  northwest: "nw",
  southeast: "se",
  southwest: "sw",
  north: "n",
  south: "s",
  east: "e",
  west: "w",
};

// Sort once by descending full-form length so longer tokens replace first.
const ADDRESS_ABBREVIATIONS_SORTED = Object.entries(ADDRESS_ABBREVIATIONS).sort(
  (a, b) => b[0].length - a[0].length,
);

export function normalizeAddress(addr: string): string {
  let s = addr
    .toLowerCase()
    .trim()
    .replace(/,?\s*usa$/i, "")
    .replace(/\b\d{5}(-\d{4})?\b/g, "")
    .replace(/[,.]/g, "");
  for (const [full, abbr] of ADDRESS_ABBREVIATIONS_SORTED) {
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

async function rentcastPage(
  params: URLSearchParams,
  apiKey: string,
): Promise<{ listings: Listing[]; res: Response }> {
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
  return { listings: Array.isArray(data) ? (data as Listing[]) : [], res };
}

/** Single-page fetch (up to MAX_LIMIT). Used by the address-search route. */
export async function rentcastFetch(
  params: URLSearchParams,
  apiKey: string,
): Promise<Listing[]> {
  const { listings } = await rentcastPage(params, apiKey);
  return listings;
}

const MAX_PAGES = 20; // safety cap: 10,000 listings per county sweep

/**
 * Paginated fetch — collects ALL matching listings using offset pagination.
 * First request uses `includeTotalCount=true` to get the total, then all
 * remaining pages are fetched in parallel for maximum speed.
 * Safe for county-wide sweeps (marketing-search, program-search).
 */
export async function rentcastFetchAll(
  params: URLSearchParams,
  apiKey: string,
): Promise<Listing[]> {
  // Page 0: establish total count
  const firstParams = new URLSearchParams(params);
  firstParams.set("limit", "500");
  firstParams.set("offset", "0");
  firstParams.set("includeTotalCount", "true");

  const { listings: first, res: firstRes } = await rentcastPage(firstParams, apiKey);

  const tc = firstRes.headers.get("X-Total-Count");
  const totalCount = tc ? parseInt(tc, 10) : null;

  // Nothing more to fetch
  if (!totalCount || totalCount <= 500 || first.length < 500) return first;

  // How many additional pages do we need?
  const extraPages = Math.min(Math.ceil((totalCount - 500) / 500), MAX_PAGES - 1);
  if (extraPages === 0) return first;

  // Fetch all remaining pages in parallel
  const pagePromises = Array.from({ length: extraPages }, (_, i) => {
    const pageParams = new URLSearchParams(params);
    pageParams.set("limit", "500");
    pageParams.set("offset", String((i + 1) * 500));
    return rentcastPage(pageParams, apiKey).then(({ listings }) => listings);
  });

  const pages = await Promise.all(pagePromises);
  return [first, ...pages].flat();
}

// ---------------------------------------------------------------------------
// Build county-wide RentCast search params
// ---------------------------------------------------------------------------

/** Builds URLSearchParams for a county-wide active-listing sweep. */
export function buildCountySearchParams(countyInfo: CountyInfo, city?: string): URLSearchParams {
  const params = new URLSearchParams({ status: "Active" });
  if (city) {
    params.set("city", city);
    params.set("state", countyInfo.state);
  } else {
    params.set("latitude", String(countyInfo.lat));
    params.set("longitude", String(countyInfo.lng));
    params.set("radius", String(countyInfo.radius ?? 25));
  }
  return params;
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

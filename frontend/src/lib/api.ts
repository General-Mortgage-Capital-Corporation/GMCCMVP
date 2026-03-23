/**
 * Typed API client for the Flask backend.
 *
 * All fetch calls check response.ok and support AbortSignal for cancellation.
 * In development the Next.js rewrites proxy /api/* to the Flask server.
 */

import type {
  SearchResponse,
  MatchBatchResponse,
  MatchSingleResponse,
  ExplainResponse,
  ProgramLocationsResponse,
  AutocompleteResponse,
  HealthResponse,
  RentCastListing,
  MarketingStreamEvent,
  ProgramStreamEvent,
} from "@/types";

class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function fetchJson<T>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(
      (body as { error?: string }).error ?? `Request failed (${res.status})`,
      res.status,
    );
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export async function searchListings(
  params: {
    query: string;
    searchType?: string;
    radius?: number;
    programs?: string[];
    lat?: number;
    lng?: number;
  },
  signal?: AbortSignal,
): Promise<SearchResponse> {
  const sp = new URLSearchParams();
  sp.set("query", params.query);
  if (params.searchType) sp.set("search_type", params.searchType);
  if (params.radius != null) sp.set("radius", String(params.radius));
  if (params.programs?.length) sp.set("programs", params.programs.join(","));
  if (params.lat != null) sp.set("lat", String(params.lat));
  if (params.lng != null) sp.set("lng", String(params.lng));
  return fetchJson<SearchResponse>(`/api/search?${sp}`, { signal });
}

export async function matchSingle(
  listing: RentCastListing,
  signal?: AbortSignal,
): Promise<MatchSingleResponse> {
  return fetchJson<MatchSingleResponse>("/api/match", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(listing),
    signal,
  });
}

export async function matchBatch(
  listings: RentCastListing[],
  signal?: AbortSignal,
): Promise<MatchBatchResponse> {
  return fetchJson<MatchBatchResponse>("/api/match-batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(listings),
    signal,
  });
}

export async function getExplanation(
  programName: string,
  listing: RentCastListing,
  tierName: string,
  signal?: AbortSignal,
): Promise<ExplainResponse> {
  return fetchJson<ExplainResponse>("/api/explain", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      program_name: programName,
      listing,
      tier_name: tierName,
    }),
    signal,
  });
}

const PROG_LOC_CACHE_KEY = "gmcc_program_locations";
const PROG_LOC_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

export async function fetchProgramLocations(
  signal?: AbortSignal,
): Promise<ProgramLocationsResponse> {
  // Check localStorage cache first
  try {
    const raw = localStorage.getItem(PROG_LOC_CACHE_KEY);
    if (raw) {
      const { data, ts } = JSON.parse(raw) as { data: ProgramLocationsResponse; ts: number };
      if (Date.now() - ts < PROG_LOC_TTL) return data;
    }
  } catch { /* ignore */ }

  const result = await fetchJson<ProgramLocationsResponse>("/api/program-locations", {
    signal,
  });

  // Cache in localStorage
  try {
    localStorage.setItem(PROG_LOC_CACHE_KEY, JSON.stringify({ data: result, ts: Date.now() }));
  } catch { /* quota exceeded */ }

  return result;
}

/** Reads a Response body as newline-delimited JSON, yielding each parsed object. */
async function* readNdjson<T>(res: Response, signal?: AbortSignal): AsyncGenerator<T> {
  const reader = res.body!.getReader();
  const onAbort = () => reader.cancel().catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done || signal?.aborted) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) yield JSON.parse(line) as T;
      }
    }
    if (!signal?.aborted && buffer.trim()) yield JSON.parse(buffer) as T;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

export async function* programSearchStream(
  params: { program: string; countyFips: string; city?: string },
  signal?: AbortSignal,
): AsyncGenerator<ProgramStreamEvent> {
  const sp = new URLSearchParams();
  sp.set("program", params.program);
  sp.set("county_fips", params.countyFips);
  if (params.city) sp.set("city", params.city);
  const res = await fetch(`/api/program-search?${sp}`, { signal });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(
      (body as { error?: string }).error ?? `Request failed (${res.status})`,
      res.status,
    );
  }
  yield* readNdjson<ProgramStreamEvent>(res, signal);
}

export async function* marketingSearchStream(
  params: { countyFips: string; city?: string },
  signal?: AbortSignal,
): AsyncGenerator<MarketingStreamEvent> {
  const sp = new URLSearchParams();
  sp.set("county_fips", params.countyFips);
  if (params.city) sp.set("city", params.city);
  const res = await fetch(`/api/marketing-search?${sp}`, { signal });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(
      (body as { error?: string }).error ?? `Request failed (${res.status})`,
      res.status,
    );
  }
  yield* readNdjson<MarketingStreamEvent>(res, signal);
}

export async function fetchAutocomplete(
  input: string,
  signal?: AbortSignal,
): Promise<AutocompleteResponse> {
  const sp = new URLSearchParams({ input });
  return fetchJson<AutocompleteResponse>(`/api/autocomplete?${sp}`, {
    signal,
  });
}

export async function fetchMapsKey(
  signal?: AbortSignal,
): Promise<{ key: string }> {
  return fetchJson<{ key: string }>("/api/maps-key", { signal });
}

export async function fetchHealth(
  signal?: AbortSignal,
): Promise<HealthResponse> {
  return fetchJson<HealthResponse>("/api/health", { signal });
}

export async function fetchPrograms(
  signal?: AbortSignal,
): Promise<{ programs: string[] }> {
  return fetchJson<{ programs: string[] }>("/api/programs", { signal });
}

export { ApiError };

import { type NextRequest, NextResponse } from "next/server";
import { rateLimit, getClientIp } from "@/lib/ratelimit";
import { resolveCountyInfo, CountyLookupError } from "@/lib/python-client";
import {
  rentcastFetchAll,
  filterByCountyFips,
  buildCountySearchParams,
  RentCastError,
  type Listing,
} from "@/lib/rentcast";
import { runMatchWaves } from "@/lib/match-stream";

export const runtime = "nodejs";

const API_KEY = process.env.RENTCAST_API_KEY ?? "";

/**
 * Search ALL listings in a county and match against ALL programs.
 * Streams NDJSON events: start → batch… → done (or error).
 * Designed for MLO mass-marketing workflows.
 */
export async function GET(req: NextRequest) {
  const ip = getClientIp(req);
  if (!rateLimit(ip, 10)) {
    return NextResponse.json(
      { success: false, error: "Rate limit exceeded." },
      { status: 429 },
    );
  }

  const sp = req.nextUrl.searchParams;
  const countyFips = sp.get("county_fips")?.trim() ?? "";
  const city = sp.get("city")?.trim() ?? "";

  if (!countyFips) {
    return NextResponse.json(
      { success: false, error: "county_fips is required." },
      { status: 400 },
    );
  }

  if (!API_KEY) {
    return NextResponse.json(
      { success: false, error: "RentCast API key not configured." },
      { status: 400 },
    );
  }

  // Resolve county info (fast, before streaming starts)
  let countyInfo: Awaited<ReturnType<typeof resolveCountyInfo>>;
  try {
    countyInfo = await resolveCountyInfo(countyFips);
  } catch (err) {
    const e = err instanceof CountyLookupError ? err : new CountyLookupError("Failed to resolve county information.", 502);
    return NextResponse.json({ success: false, error: e.message }, { status: e.status });
  }

  const rentcastParams = buildCountySearchParams(countyInfo, city || undefined);
  const clientSignal = req.signal;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const emit = (data: object) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(data) + "\n"));
        } catch { closed = true; }
      };

      try {
        let allListings: Listing[];
        try {
          allListings = await rentcastFetchAll(rentcastParams, API_KEY);
        } catch (err) {
          emit({ type: "error", error: err instanceof RentCastError ? err.message : "Connection error." });
          return;
        }

        if (clientSignal.aborted) return;

        const filtered = filterByCountyFips(allListings, countyFips);
        emit({ type: "start", total_fetched: allListings.length, total_in_county: filtered.length });

        if (filtered.length === 0) {
          emit({ type: "done" });
          return;
        }

        const { aborted } = await runMatchWaves(filtered, clientSignal, (chunk, batchResult, processed) => {
          const listings: Listing[] = chunk.map((listing, k) => {
            const r = batchResult?.results[k];
            if (r) return { ...listing, matchData: { programs: r.programs }, censusData: r.census_data };
            return { ...listing, matchData: { programs: [] }, censusData: null };
          });
          emit({ type: "batch", listings, processed });
        });

        if (!aborted) emit({ type: "done" });
      } catch {
        emit({ type: "error", error: "Matching service unavailable." });
      } finally {
        closed = true;
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

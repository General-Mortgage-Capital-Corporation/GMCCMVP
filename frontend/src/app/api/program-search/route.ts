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
 * Search listings in a county and match against a specific program.
 * Streams NDJSON events: start → batch… → done (or error).
 * Only eligible / potentially eligible listings are included in batch events.
 */
export async function GET(req: NextRequest) {
  const ip = getClientIp(req);
  if (!rateLimit(ip, 20)) {
    return NextResponse.json(
      { success: false, error: "Rate limit exceeded." },
      { status: 429 },
    );
  }

  const sp = req.nextUrl.searchParams;
  const programName = sp.get("program")?.trim() ?? "";
  const countyFips = sp.get("county_fips")?.trim() ?? "";
  const city = sp.get("city")?.trim() ?? "";

  if (!programName || !countyFips) {
    return NextResponse.json(
      { success: false, error: "program and county_fips are required." },
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
        emit({ type: "start", total_in_county: filtered.length });

        if (filtered.length === 0) {
          emit({ type: "done", total_matched: 0 });
          return;
        }

        let totalMatched = 0;
        const { aborted } = await runMatchWaves(filtered, clientSignal, (chunk, batchResult, processed) => {
          // Only emit eligible / potentially eligible for this program
          const matched: Listing[] = [];
          for (let k = 0; k < chunk.length; k++) {
            const r = batchResult?.results[k];
            if (!r) continue;
            const progResult = r.programs.find((p) => p.program_name === programName);
            if (!progResult || progResult.status === "Ineligible") continue;
            matched.push({ ...chunk[k], matchData: { programs: [progResult] }, censusData: r.census_data });
          }
          totalMatched += matched.length;
          emit({ type: "batch", listings: matched, processed });
        });

        if (!aborted) emit({ type: "done", total_matched: totalMatched });
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

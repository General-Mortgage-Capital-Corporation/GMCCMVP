import { type NextRequest, NextResponse } from "next/server";
import { rateLimit, getClientIp } from "@/lib/ratelimit";
import { pyGet, pyPost, PythonServiceError } from "@/lib/python-client";
import {
  rentcastFetch,
  filterByCountyFips,
  RentCastError,
  MAX_LIMIT,
  type Listing,
} from "@/lib/rentcast";
import type { CountyInfo, MatchBatchResponse } from "@/types";

export const runtime = "nodejs";

const API_KEY = process.env.RENTCAST_API_KEY ?? "";
const BATCH_CHUNK_SIZE = 50;

/**
 * Search ALL listings in a county and match against ALL programs.
 * Designed for MLO mass-marketing workflows.
 * RentCast key stays in Next.js env; matching is delegated to Python service.
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

  // Resolve county info from Python service
  let countyInfo: CountyInfo;
  try {
    const result = await pyGet<{
      success: boolean;
      info: CountyInfo;
      error?: string;
    }>(`/api/county-info?fips=${encodeURIComponent(countyFips)}`);
    if (!result.success) {
      return NextResponse.json(
        {
          success: false,
          error: result.error ?? `Unknown county FIPS: ${countyFips}`,
        },
        { status: 400 },
      );
    }
    countyInfo = result.info;
  } catch (err) {
    if (err instanceof PythonServiceError) {
      return NextResponse.json(
        { success: false, error: err.message },
        { status: err.status },
      );
    }
    return NextResponse.json(
      { success: false, error: "Failed to resolve county information." },
      { status: 502 },
    );
  }

  // Fetch listings from RentCast
  const params = new URLSearchParams({
    status: "Active",
    limit: String(MAX_LIMIT),
  });
  if (city) {
    params.set("city", city);
    params.set("state", countyInfo.state);
  } else {
    params.set("latitude", String(countyInfo.lat));
    params.set("longitude", String(countyInfo.lng));
    params.set("radius", String(countyInfo.radius ?? 25));
  }

  let allListings: Listing[];
  try {
    allListings = await rentcastFetch(params, API_KEY);
  } catch (err) {
    if (err instanceof RentCastError) {
      return NextResponse.json(
        { success: false, error: err.message },
        { status: err.status },
      );
    }
    return NextResponse.json(
      { success: false, error: "Connection error. Please try again." },
      { status: 500 },
    );
  }

  const totalFound = allListings.length;
  const filtered = filterByCountyFips(allListings, countyFips);

  if (filtered.length === 0) {
    return NextResponse.json({
      success: true,
      listings: [],
      total_found: totalFound,
      total_in_county: 0,
    });
  }

  // Match ALL listings against ALL programs, chunking at BATCH_CHUNK_SIZE
  const allResults: MatchBatchResponse["results"] = [];
  try {
    for (let i = 0; i < filtered.length; i += BATCH_CHUNK_SIZE) {
      const chunk = filtered.slice(i, i + BATCH_CHUNK_SIZE);
      const chunkResult = await pyPost<MatchBatchResponse>(
        "/api/match-batch",
        chunk,
      );
      allResults.push(...chunkResult.results);
    }
  } catch (err) {
    if (err instanceof PythonServiceError) {
      return NextResponse.json(
        { success: false, error: err.message },
        { status: err.status },
      );
    }
    return NextResponse.json(
      { success: false, error: "Matching service unavailable." },
      { status: 502 },
    );
  }

  // Merge match data back into listings
  const results: Listing[] = filtered.map((listing, i) => {
    const r = allResults[i];
    if (r) {
      return {
        ...listing,
        matchData: { programs: r.programs },
        censusData: r.census_data,
      };
    }
    return { ...listing, matchData: { programs: [] }, censusData: null };
  });

  return NextResponse.json({
    success: true,
    listings: results,
    total_found: totalFound,
    total_in_county: filtered.length,
  });
}

import { type NextRequest, NextResponse } from "next/server";
import { fetchZillowPhotos } from "@/lib/services/zillow-photos";

export const runtime = "nodejs";
export const maxDuration = 120; // Two sequential Apify calls can take up to ~90s total

/**
 * GET /api/zillow-photos?address=123+Main+St,+City,+ST+12345
 *
 * Thin HTTP wrapper around the shared fetchZillowPhotos service. The same
 * service is used by the agent's fetchPropertyPhoto tool so the tool does
 * not need to self-HTTP back into this route.
 *
 * Returns { photos: string[], primaryPhoto: string | null }.
 */
export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get("address") ?? "";

  if (!address) {
    return NextResponse.json(
      { photos: [], primaryPhoto: null, error: "address is required" },
      { status: 400 },
    );
  }

  const result = await fetchZillowPhotos(address);

  // Map specific errors back to their HTTP status codes.
  if (result.error === "Apify not configured") {
    return NextResponse.json(result, { status: 503 });
  }
  if (result.error === "Address lookup failed" || result.error === "Detail fetch failed") {
    return NextResponse.json(result, { status: 502 });
  }
  if (result.error === "Failed to fetch photos") {
    return NextResponse.json(result, { status: 500 });
  }

  return NextResponse.json(
    { photos: result.photos, primaryPhoto: result.primaryPhoto },
    { headers: { "Cache-Control": "private, max-age=86400" } },
  );
}

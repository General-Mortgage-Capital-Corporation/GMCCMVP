import { type NextRequest, NextResponse } from "next/server";
import { requireAuth, unauthorized } from "@/lib/require-auth";

export const runtime = "nodejs";

const PLACES_KEY = process.env.GOOGLE_PLACES_API_KEY ?? "";

/** Reverse-geocode lat/lng → formatted street address via Google Geocoding API. */
export async function GET(req: NextRequest) {
  if (!(await requireAuth(req))) return unauthorized();

  const lat = Number(req.nextUrl.searchParams.get("lat"));
  const lng = Number(req.nextUrl.searchParams.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !PLACES_KEY) {
    return NextResponse.json({ address: null }, { status: 400 });
  }

  try {
    const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    url.searchParams.set("latlng", `${lat},${lng}`);
    url.searchParams.set("key", PLACES_KEY);
    url.searchParams.set("result_type", "street_address|premise|subpremise");

    const res = await fetch(url, {
      signal: AbortSignal.timeout(5_000),
      cache: "no-store",
    });
    if (!res.ok) return NextResponse.json({ address: null });

    const data = (await res.json()) as {
      status?: string;
      results?: Array<{ formatted_address?: string }>;
    };
    const address =
      data.results?.[0]?.formatted_address?.replace(/, USA$/, "") ?? null;
    return NextResponse.json({ address });
  } catch {
    return NextResponse.json({ address: null });
  }
}

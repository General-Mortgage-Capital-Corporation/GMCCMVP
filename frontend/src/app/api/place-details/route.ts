import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const PLACES_KEY = process.env.GOOGLE_PLACES_API_KEY ?? "";

/** Resolve a Google Places place_id to lat/lng coordinates. */
export async function GET(req: NextRequest) {
  const placeId = req.nextUrl.searchParams.get("place_id")?.trim() ?? "";
  if (!placeId || !PLACES_KEY) {
    return NextResponse.json({ lat: null, lng: null });
  }

  try {
    const res = await fetch(
      `https://places.googleapis.com/v1/places/${placeId}`,
      {
        headers: {
          "X-Goog-Api-Key": PLACES_KEY,
          "X-Goog-FieldMask": "location",
        },
        signal: AbortSignal.timeout(5_000),
        cache: "no-store",
      },
    );

    if (!res.ok) return NextResponse.json({ lat: null, lng: null });

    const data = (await res.json()) as {
      location?: { latitude?: number; longitude?: number };
    };
    return NextResponse.json({
      lat: data.location?.latitude ?? null,
      lng: data.location?.longitude ?? null,
    });
  } catch {
    return NextResponse.json({ lat: null, lng: null });
  }
}

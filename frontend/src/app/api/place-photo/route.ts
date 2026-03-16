import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const PLACES_KEY = process.env.GOOGLE_PLACES_API_KEY ?? "";

/**
 * Returns a property photo as an image binary.
 * Tries Google Places (New) Text Search first — picks up building/exterior photos
 * contributed to Google Maps. Falls back to Street View Static API.
 *
 * Query params:
 *   address  – full formatted address (used for Places Text Search + SV fallback)
 *   lat, lng – coordinates (used for Street View fallback when address is absent)
 */
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const address = searchParams.get("address") ?? "";
  const lat = searchParams.get("lat") ?? "";
  const lng = searchParams.get("lng") ?? "";

  if (!PLACES_KEY) {
    return new NextResponse(null, { status: 503 });
  }

  // ── Step 1: Google Places (New) Text Search → photo ──────────────────────
  if (address) {
    try {
      const searchRes = await fetch(
        "https://places.googleapis.com/v1/places:searchText",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": PLACES_KEY,
            "X-Goog-FieldMask": "places.photos",
          },
          body: JSON.stringify({ textQuery: address }),
          signal: AbortSignal.timeout(6_000),
          cache: "no-store",
        },
      );

      if (searchRes.ok) {
        const data = (await searchRes.json()) as {
          places?: { photos?: { name: string }[] }[];
        };
        const photoName = data.places?.[0]?.photos?.[0]?.name;

        if (photoName) {
          // fetch() follows the 302 redirect to the CDN image automatically
          const imgRes = await fetch(
            `https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=800&key=${PLACES_KEY}`,
            { signal: AbortSignal.timeout(8_000), cache: "no-store" },
          );
          if (imgRes.ok) {
            const buf = await imgRes.arrayBuffer();
            return new NextResponse(buf, {
              headers: {
                "Content-Type": imgRes.headers.get("Content-Type") ?? "image/jpeg",
                "Cache-Control": "private, max-age=3600",
              },
            });
          }
        }
      }
    } catch {
      // fall through to Street View
    }
  }

  // ── Fallback: Street View Static API ─────────────────────────────────────
  // Prefer lat/lng for accuracy; fall back to address string.
  const location = lat && lng ? `${lat},${lng}` : address;
  if (!location) return new NextResponse(null, { status: 404 });

  try {
    const svRes = await fetch(
      `https://maps.googleapis.com/maps/api/streetview?size=800x450&location=${encodeURIComponent(location)}&fov=80&key=${PLACES_KEY}`,
      { signal: AbortSignal.timeout(8_000), cache: "no-store" },
    );
    if (svRes.ok) {
      const buf = await svRes.arrayBuffer();
      return new NextResponse(buf, {
        headers: {
          "Content-Type": "image/jpeg",
          "Cache-Control": "private, max-age=86400",
        },
      });
    }
  } catch {
    // nothing to do
  }

  return new NextResponse(null, { status: 404 });
}

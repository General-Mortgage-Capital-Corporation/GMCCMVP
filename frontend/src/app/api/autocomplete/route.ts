import { type NextRequest, NextResponse } from "next/server";
import { rateLimit, getClientIp } from "@/lib/ratelimit";

export const runtime = "nodejs";

const PLACES_KEY = process.env.GOOGLE_PLACES_API_KEY ?? "";

/** Proxy Google Places Autocomplete — keeps API key server-side. */
export async function GET(req: NextRequest) {
  const ip = getClientIp(req);
  if (!rateLimit(ip, 120)) {
    return NextResponse.json({ suggestions: [] }, { status: 429 });
  }

  const input = req.nextUrl.searchParams.get("input")?.trim() ?? "";
  if (!input || !PLACES_KEY) {
    return NextResponse.json({ suggestions: [] });
  }

  try {
    const res = await fetch(
      "https://places.googleapis.com/v1/places:autocomplete",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": PLACES_KEY,
        },
        body: JSON.stringify({
          input,
          includedRegionCodes: ["us"],
          includedPrimaryTypes: ["street_address", "subpremise", "premise"],
        }),
        signal: AbortSignal.timeout(5_000),
        cache: "no-store",
      },
    );

    if (!res.ok) return NextResponse.json({ suggestions: [] });

    const data = (await res.json()) as {
      suggestions?: Array<{
        placePrediction?: { text?: { text?: string }; placeId?: string };
      }>;
    };

    const suggestions = (data.suggestions ?? [])
      .map((s) => ({
        text: s.placePrediction?.text?.text ?? "",
        place_id: s.placePrediction?.placeId ?? "",
      }))
      .filter((s) => s.text);

    return NextResponse.json({ suggestions });
  } catch {
    return NextResponse.json({ suggestions: [] });
  }
}

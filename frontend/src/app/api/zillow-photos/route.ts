import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 120; // Two sequential Apify calls can take up to ~90s total

const APIFY_TOKEN = process.env.APIFY_API_TOKEN ?? "";

// Step 1: Address → Zillow URL/ZPID
const ADDRESS_ACTOR = "one-api~zillow-scrape-address-url-zpid";
// Step 2: Zillow URL → Full property details with photos
const DETAIL_ACTOR = "maxcopell~zillow-detail-scraper";

const APIFY_BASE = "https://api.apify.com/v2/acts";

/**
 * GET /api/zillow-photos?address=123+Main+St,+City,+ST+12345
 *
 * Two-step Apify pipeline:
 *   1. Address lookup → gets PropertyZillowURL
 *   2. Detail scraper → gets responsivePhotos array
 *
 * Returns { photos: string[], primaryPhoto: string | null }.
 */
export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get("address") ?? "";

  if (!address) {
    return NextResponse.json({ photos: [], primaryPhoto: null, error: "address is required" }, { status: 400 });
  }

  if (!APIFY_TOKEN) {
    return NextResponse.json({ photos: [], primaryPhoto: null, error: "Apify not configured" }, { status: 503 });
  }

  try {
    // ── Step 1: Address → Zillow URL ──────────────────────────────────────
    console.log("[zillow-photos] Step 1: Looking up Zillow URL for:", address);

    const lookupRes = await fetch(
      `${APIFY_BASE}/${ADDRESS_ACTOR}/run-sync-get-dataset-items?token=${APIFY_TOKEN}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scrape_type: "property_addresses",
          multiple_input_box: address,
        }),
        signal: AbortSignal.timeout(45_000),
      },
    );

    if (!lookupRes.ok) {
      const text = await lookupRes.text().catch(() => "");
      console.error("[zillow-photos] Step 1 Apify error:", lookupRes.status, text);
      return NextResponse.json({ photos: [], primaryPhoto: null, error: "Address lookup failed" }, { status: 502 });
    }

    const lookupRaw = await lookupRes.text();
    let lookupItems: Record<string, unknown>[];
    try {
      const parsed = JSON.parse(lookupRaw);
      if (!Array.isArray(parsed)) {
        console.error("[zillow-photos] Step 1 non-array response:", lookupRaw.slice(0, 300));
        return NextResponse.json({ photos: [], primaryPhoto: null });
      }
      lookupItems = parsed;
    } catch {
      console.error("[zillow-photos] Step 1 parse error:", lookupRaw.slice(0, 300));
      return NextResponse.json({ photos: [], primaryPhoto: null });
    }

    if (lookupItems.length === 0) {
      console.log("[zillow-photos] Step 1: No Zillow match for:", address);
      return NextResponse.json({ photos: [], primaryPhoto: null });
    }

    const rawUrl = lookupItems[0].PropertyZillowURL as string | undefined;
    const zpid = lookupItems[0].PropertyZPID as string | undefined;

    if (!rawUrl && !zpid) {
      console.error("[zillow-photos] Step 1: No URL or ZPID. Keys:", Object.keys(lookupItems[0]));
      return NextResponse.json({ photos: [], primaryPhoto: null });
    }

    // Construct a proper Zillow URL with address slug + ZPID
    // The detail scraper needs the full URL format: /homedetails/ADDRESS-SLUG/ZPID_zpid/
    let zillowUrl = rawUrl ?? "";

    // If the URL is just /homedetails/ZPID_zpid/ (missing slug), reconstruct it
    if (zpid && (!zillowUrl || !zillowUrl.includes("-"))) {
      // Build slug from address: "3553 Meyer Pl, Santa Clara, CA 95051" → "3553-Meyer-Pl-Santa-Clara-CA-95051"
      const slug = address
        .replace(/[,#]/g, "")
        .replace(/\s+/g, "-")
        .replace(/[^a-zA-Z0-9-]/g, "");
      zillowUrl = `https://www.zillow.com/homedetails/${slug}/${zpid}_zpid/`;
    }

    console.log("[zillow-photos] Step 2: Fetching details from:", zillowUrl);

    // ── Step 2: Zillow URL → Full details with photos ─────────────────────
    const detailRes = await fetch(
      `${APIFY_BASE}/${DETAIL_ACTOR}/run-sync-get-dataset-items?token=${APIFY_TOKEN}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startUrls: [{ url: zillowUrl }],
        }),
        signal: AbortSignal.timeout(55_000),
      },
    );

    if (!detailRes.ok) {
      const text = await detailRes.text().catch(() => "");
      console.error("[zillow-photos] Step 2 Apify error:", detailRes.status, text);
      return NextResponse.json({ photos: [], primaryPhoto: null, error: "Detail fetch failed" }, { status: 502 });
    }

    const detailRaw = await detailRes.text();
    let detailItems: Record<string, unknown>[];
    try {
      const parsed = JSON.parse(detailRaw);
      if (!Array.isArray(parsed)) {
        console.error("[zillow-photos] Step 2 non-array:", detailRaw.slice(0, 300));
        return NextResponse.json({ photos: [], primaryPhoto: null });
      }
      detailItems = parsed;
    } catch {
      console.error("[zillow-photos] Step 2 parse error:", detailRaw.slice(0, 300));
      return NextResponse.json({ photos: [], primaryPhoto: null });
    }

    if (detailItems.length === 0) {
      console.log("[zillow-photos] Step 2: No detail result for:", zillowUrl);
      return NextResponse.json({ photos: [], primaryPhoto: null });
    }

    const detail = detailItems[0];
    const photos = extractPhotos(detail);

    console.log("[zillow-photos] Extracted", photos.length, "photos for:", address);

    return NextResponse.json(
      { photos, primaryPhoto: photos[0] ?? null },
      { headers: { "Cache-Control": "private, max-age=86400" } },
    );
  } catch (err) {
    console.error("[zillow-photos] Error:", err);
    return NextResponse.json({ photos: [], primaryPhoto: null, error: "Failed to fetch photos" }, { status: 500 });
  }
}

/** Extract the best photo URLs from a Zillow detail scraper result. */
function extractPhotos(item: Record<string, unknown>): string[] {
  // Primary source: responsivePhotos — array of { mixedSources: { jpeg: [{ url, width }] } }
  const responsive = item.responsivePhotos;
  if (Array.isArray(responsive) && responsive.length > 0) {
    const urls = responsive.flatMap((rp) => {
      if (!rp || typeof rp !== "object") return [];
      const mixed = (rp as Record<string, unknown>).mixedSources;
      if (!mixed || typeof mixed !== "object") {
        // Sometimes it's just { url: "..." }
        const directUrl = (rp as Record<string, unknown>).url;
        if (typeof directUrl === "string") return [directUrl];
        return [];
      }
      const jpeg = (mixed as Record<string, unknown[]>).jpeg;
      if (!Array.isArray(jpeg) || jpeg.length === 0) return [];
      // Pick the largest resolution (last entry)
      const best = jpeg[jpeg.length - 1] as Record<string, unknown> | undefined;
      if (best && typeof best.url === "string") return [best.url];
      return [];
    });
    if (urls.length > 0) return urls;
  }

  // Fallback: originalPhotos — same structure
  const original = item.originalPhotos;
  if (Array.isArray(original) && original.length > 0) {
    const urls = original.flatMap((rp) => {
      if (!rp || typeof rp !== "object") return [];
      const mixed = (rp as Record<string, unknown>).mixedSources;
      if (!mixed || typeof mixed !== "object") return [];
      const jpeg = (mixed as Record<string, unknown[]>).jpeg;
      if (!Array.isArray(jpeg) || jpeg.length === 0) return [];
      const best = jpeg[jpeg.length - 1] as Record<string, unknown> | undefined;
      if (best && typeof best.url === "string") return [best.url];
      return [];
    });
    if (urls.length > 0) return urls;
  }

  // Fallback: simple photo fields
  if (Array.isArray(item.photos)) {
    const urls = (item.photos as unknown[])
      .map((p) => (typeof p === "string" ? p : null))
      .filter((u): u is string => !!u);
    if (urls.length > 0) return urls;
  }

  if (typeof item.imgSrc === "string") return [item.imgSrc];

  return [];
}

/**
 * Zillow photo lookup via two-step Apify pipeline.
 *
 * Shared between the /api/zillow-photos route (consumed by the UI) and the
 * agent's fetchPropertyPhoto tool. Extracted as a library function so the
 * agent tool does not self-HTTP back into the deployment — the previous
 * Vercel fix ("eliminate self-HTTP calls that break on Vercel") made clear
 * tools must avoid that pattern.
 *
 * Pipeline:
 *   1. Address → PropertyZillowURL/ZPID via one-api~zillow-scrape-address-url-zpid
 *   2. Zillow URL → responsivePhotos via maxcopell~zillow-detail-scraper
 *
 * Results are cached in Redis (getCachedZillowPhotos / setCachedZillowPhotos).
 */

import { getCachedZillowPhotos, setCachedZillowPhotos } from "@/lib/redis-cache";

const APIFY_TOKEN = process.env.APIFY_API_TOKEN ?? "";
const APIFY_BASE = "https://api.apify.com/v2/acts";
const ADDRESS_ACTOR = "one-api~zillow-scrape-address-url-zpid";
const DETAIL_ACTOR = "maxcopell~zillow-detail-scraper";

export interface ZillowPhotoResult {
  photos: string[];
  primaryPhoto: string | null;
  error?: string;
}

/** Fetch property photos for an address. Returns empty array on any failure. */
export async function fetchZillowPhotos(address: string): Promise<ZillowPhotoResult> {
  if (!address) {
    return { photos: [], primaryPhoto: null, error: "address is required" };
  }

  if (!APIFY_TOKEN) {
    return { photos: [], primaryPhoto: null, error: "Apify not configured" };
  }

  try {
    // ── Check Redis cache first ──────────────────────────────────────────
    const cached = await getCachedZillowPhotos(address);
    if (cached) {
      console.log("[zillow-photos] Redis cache hit:", cached.length, "photos for:", address);
      return { photos: cached, primaryPhoto: cached[0] ?? null };
    }

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
      return { photos: [], primaryPhoto: null, error: "Address lookup failed" };
    }

    const lookupRaw = await lookupRes.text();
    let lookupItems: Record<string, unknown>[];
    try {
      const parsed = JSON.parse(lookupRaw);
      if (!Array.isArray(parsed)) {
        console.error("[zillow-photos] Step 1 non-array response:", lookupRaw.slice(0, 300));
        return { photos: [], primaryPhoto: null };
      }
      lookupItems = parsed;
    } catch {
      console.error("[zillow-photos] Step 1 parse error:", lookupRaw.slice(0, 300));
      return { photos: [], primaryPhoto: null };
    }

    if (lookupItems.length === 0) {
      console.log("[zillow-photos] Step 1: No Zillow match for:", address);
      return { photos: [], primaryPhoto: null };
    }

    const rawUrl = lookupItems[0].PropertyZillowURL as string | undefined;
    const zpid = lookupItems[0].PropertyZPID as string | undefined;

    if (!rawUrl && !zpid) {
      console.error("[zillow-photos] Step 1: No URL or ZPID. Keys:", Object.keys(lookupItems[0]));
      return { photos: [], primaryPhoto: null };
    }

    // Construct a proper Zillow URL with address slug + ZPID.
    // The detail scraper needs /homedetails/ADDRESS-SLUG/ZPID_zpid/
    let zillowUrl = rawUrl ?? "";
    if (zpid && (!zillowUrl || !zillowUrl.includes("-"))) {
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
        body: JSON.stringify({ startUrls: [{ url: zillowUrl }] }),
        signal: AbortSignal.timeout(55_000),
      },
    );

    if (!detailRes.ok) {
      const text = await detailRes.text().catch(() => "");
      console.error("[zillow-photos] Step 2 Apify error:", detailRes.status, text);
      return { photos: [], primaryPhoto: null, error: "Detail fetch failed" };
    }

    const detailRaw = await detailRes.text();
    let detailItems: Record<string, unknown>[];
    try {
      const parsed = JSON.parse(detailRaw);
      if (!Array.isArray(parsed)) {
        console.error("[zillow-photos] Step 2 non-array:", detailRaw.slice(0, 300));
        return { photos: [], primaryPhoto: null };
      }
      detailItems = parsed;
    } catch {
      console.error("[zillow-photos] Step 2 parse error:", detailRaw.slice(0, 300));
      return { photos: [], primaryPhoto: null };
    }

    if (detailItems.length === 0) {
      console.log("[zillow-photos] Step 2: No detail result for:", zillowUrl);
      return { photos: [], primaryPhoto: null };
    }

    const photos = extractPhotos(detailItems[0]);
    console.log("[zillow-photos] Extracted", photos.length, "photos for:", address);

    // Cache in Redis (non-blocking)
    setCachedZillowPhotos(address, photos).catch(() => {});

    return { photos, primaryPhoto: photos[0] ?? null };
  } catch (err) {
    console.error("[zillow-photos] Error:", err);
    return { photos: [], primaryPhoto: null, error: "Failed to fetch photos" };
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

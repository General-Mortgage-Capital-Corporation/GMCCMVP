import { type NextRequest, NextResponse } from "next/server";
import { rateLimit, getClientIp } from "@/lib/ratelimit";
import {
  rentcastFetch,
  normalizeAddress,
  attachDistancesAndSort,
  RentCastError,
  MAX_LIMIT,
  type Listing,
} from "@/lib/rentcast";
import { getCachedRentcastSearch, setCachedRentcastSearch } from "@/lib/redis-cache";

export const runtime = "nodejs";

const API_KEY = process.env.RENTCAST_API_KEY ?? "";

/** Search active listings via RentCast. API key stays server-side. */
export async function GET(req: NextRequest) {
  const ip = getClientIp(req);
  if (!rateLimit(ip, 30)) {
    return NextResponse.json(
      { success: false, error: "Rate limit exceeded." },
      { status: 429 },
    );
  }

  if (!API_KEY) {
    return NextResponse.json(
      {
        success: false,
        error:
          "API key not configured. Add RENTCAST_API_KEY to your .env.local file.",
      },
      { status: 400 },
    );
  }

  const sp = req.nextUrl.searchParams;
  const query = sp.get("query")?.trim() ?? "";
  const searchType = sp.get("search_type") ?? "area";
  const radius = Math.max(
    1,
    Math.min(50, parseFloat(sp.get("radius") ?? "5") || 5),
  );
  const searchLat = sp.get("lat") ? parseFloat(sp.get("lat")!) : null;
  const searchLng = sp.get("lng") ? parseFloat(sp.get("lng")!) : null;

  if (!query) {
    return NextResponse.json(
      { success: false, error: "Please enter a search location." },
      { status: 400 },
    );
  }

  const isZip = /^\d{5}$/.test(query);

  try {
    // Cached RentCast fetch — checks Redis before hitting API
    async function cachedRentcastFetch(params: URLSearchParams): Promise<Listing[]> {
      const cacheKey = Object.fromEntries(params.entries());
      const cached = await getCachedRentcastSearch(cacheKey);
      if (cached) {
        console.log("[search] Redis cache hit for:", cacheKey.address ?? cacheKey.zipCode ?? `${cacheKey.latitude},${cacheKey.longitude}`);
        return cached as Listing[];
      }
      const data = await rentcastFetch(params, API_KEY);
      if (data.length > 0) {
        setCachedRentcastSearch(cacheKey, data).catch(() => {});
      }
      return data;
    }

    if (searchType === "specific") {
      // Build params for a radius search — use precise lat/lng when available
      // (avoids RentCast re-geocoding the address string, which can differ from Google)
      const buildSpecificParams = (radiusMiles: number): URLSearchParams => {
        const p = new URLSearchParams({
          status: "Active",
          limit: String(MAX_LIMIT),
          radius: String(radiusMiles),
        });
        if (searchLat != null && searchLng != null) {
          p.set("latitude", String(searchLat));
          p.set("longitude", String(searchLng));
        } else {
          p.set("address", query);
        }
        return p;
      };

      // Try 1-mile first; widen to 5 miles if nothing found
      let nearbyData = await cachedRentcastFetch(buildSpecificParams(1));
      if (nearbyData.length === 0) {
        nearbyData = await cachedRentcastFetch(buildSpecificParams(5));
      }

      if (nearbyData.length === 0) {
        return NextResponse.json({
          success: true,
          listings: [],
          total: 0,
          exact_match: false,
          message: `No active listings found near "${query}".`,
        });
      }

      // Sort by distance from search center
      const centerLat = searchLat ?? nearbyData[0].latitude ?? null;
      const centerLon = searchLng ?? nearbyData[0].longitude ?? null;
      if (centerLat != null && centerLon != null) {
        attachDistancesAndSort(nearbyData, centerLat, centerLon);
      }

      // Check if any result is an address match (exact listing found)
      const searchNorm = normalizeAddress(query);
      const exactMatch = nearbyData.find((l) => {
        const addrNorm = normalizeAddress(l.formattedAddress ?? "");
        return (
          searchNorm.includes(addrNorm) ||
          addrNorm.includes(searchNorm) ||
          addrNorm === searchNorm
        );
      });

      if (exactMatch) {
        return NextResponse.json({
          success: true,
          listings: [exactMatch],
          total: 1,
          exact_match: true,
          message: null,
        });
      }

      return NextResponse.json({
        success: true,
        listings: nearbyData,
        total: nearbyData.length,
        exact_match: false,
        message: `"${query}" is not an active listing. Showing ${nearbyData.length} nearby properties.`,
      });
    } else {
      // Area / zip search
      const areaParams = new URLSearchParams({
        status: "Active",
        limit: String(MAX_LIMIT),
      });
      if (isZip) {
        areaParams.set("zipCode", query);
      } else {
        areaParams.set("address", query);
        areaParams.set("radius", String(radius));
      }

      const data = await cachedRentcastFetch(areaParams);

      if (!isZip && data.length > 0) {
        const centerLat = searchLat ?? data[0].latitude ?? null;
        const centerLon = searchLng ?? data[0].longitude ?? null;
        if (centerLat != null && centerLon != null) {
          attachDistancesAndSort(data, centerLat, centerLon);
        }
      }

      return NextResponse.json({
        success: true,
        listings: data,
        total: data.length,
        exact_match: false,
        message: null,
      });
    }
  } catch (err) {
    if (err instanceof RentCastError) {
      return NextResponse.json(
        { success: false, error: err.message },
        { status: err.status },
      );
    }
    if (err instanceof Error && err.message.toLowerCase().includes("timeout")) {
      return NextResponse.json(
        { success: false, error: "Request timed out." },
        { status: 504 },
      );
    }
    return NextResponse.json(
      { success: false, error: "Connection error. Please try again." },
      { status: 500 },
    );
  }
}

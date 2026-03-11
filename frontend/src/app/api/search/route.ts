import { type NextRequest, NextResponse } from "next/server";
import { rateLimit, getClientIp } from "@/lib/ratelimit";
import {
  rentcastFetch,
  normalizeAddress,
  attachDistancesAndSort,
  RentCastError,
  MAX_LIMIT,
} from "@/lib/rentcast";

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
    if (searchType === "specific") {
      // Attempt exact address match first
      const exactParams = new URLSearchParams({
        status: "Active",
        limit: String(MAX_LIMIT),
        address: query,
      });
      const exactData = await rentcastFetch(exactParams, API_KEY);

      if (exactData.length > 0) {
        const searchNorm = normalizeAddress(query);
        for (const listing of exactData) {
          const addrNorm = normalizeAddress(listing.formattedAddress ?? "");
          if (
            searchNorm.includes(addrNorm) ||
            addrNorm.includes(searchNorm) ||
            addrNorm === searchNorm
          ) {
            return NextResponse.json({
              success: true,
              listings: [listing],
              total: 1,
              exact_match: true,
              message: null,
            });
          }
        }
      }

      // Fallback: 1-mile radius around the query address
      const nearbyParams = new URLSearchParams({
        status: "Active",
        limit: String(MAX_LIMIT),
        address: query,
        radius: "1",
      });
      const nearbyData = await rentcastFetch(nearbyParams, API_KEY);

      if (nearbyData.length > 0) {
        const centerLat = searchLat ?? nearbyData[0].latitude ?? null;
        const centerLon = searchLng ?? nearbyData[0].longitude ?? null;
        if (centerLat != null && centerLon != null) {
          attachDistancesAndSort(nearbyData, centerLat, centerLon);
        }
        return NextResponse.json({
          success: true,
          listings: nearbyData,
          total: nearbyData.length,
          exact_match: false,
          message: `No exact match found for "${query}". Showing ${nearbyData.length} properties within 1 mile.`,
        });
      }

      return NextResponse.json({
        success: true,
        listings: [],
        total: 0,
        exact_match: false,
        message: `No properties found at or near "${query}".`,
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

      const data = await rentcastFetch(areaParams, API_KEY);

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

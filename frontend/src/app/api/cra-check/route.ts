import { type NextRequest, NextResponse } from "next/server";
import { rateLimit, getClientIp } from "@/lib/ratelimit";
import { pyPost } from "@/lib/python-client";
import type { CensusData } from "@/types";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  if (!rateLimit(ip, 30)) {
    return NextResponse.json({ success: false, error: "Rate limit exceeded." }, { status: 429 });
  }

  const body = await req.json().catch(() => null);
  if (!body?.formattedAddress) {
    return NextResponse.json({ success: false, error: "formattedAddress is required." }, { status: 400 });
  }

  try {
    const payload: Record<string, unknown> = { formattedAddress: body.formattedAddress };
    const lat = typeof body.latitude === "number" ? body.latitude : null;
    const lng = typeof body.longitude === "number" ? body.longitude : null;
    if (lat != null) payload.latitude = lat;
    if (lng != null) payload.longitude = lng;

    const result = await pyPost<{ success: boolean; census_data: CensusData | null; error?: string }>(
      "/api/match",
      payload,
    );
    if (!result.success || !result.census_data) {
      return NextResponse.json(
        { success: false, error: result.error ?? "Census data unavailable for this address." },
        { status: 502 },
      );
    }
    return NextResponse.json({ success: true, census_data: result.census_data });
  } catch {
    return NextResponse.json({ success: false, error: "Census lookup failed. Please try again." }, { status: 502 });
  }
}

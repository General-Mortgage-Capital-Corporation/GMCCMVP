import { NextResponse } from "next/server";

export const runtime = "nodejs";

/** Return the Google Maps JS API key for the map widget (server-side only). */
export function GET() {
  return NextResponse.json({ key: process.env.GOOGLE_PLACES_API_KEY ?? "" });
}

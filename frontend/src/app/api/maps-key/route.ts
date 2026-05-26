import { NextResponse } from "next/server";
import { requireAuth, unauthorized } from "@/lib/require-auth";

export const runtime = "nodejs";

/** Return the Google Maps JS API key for the map widget (server-side only). */
export async function GET(req: Request) {
  if (!(await requireAuth(req))) return unauthorized();
  return NextResponse.json({ key: process.env.GOOGLE_PLACES_API_KEY ?? "" });
}

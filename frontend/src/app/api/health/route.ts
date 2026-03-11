import { NextResponse } from "next/server";
import { pyGet } from "@/lib/python-client";

export const runtime = "nodejs";

/** Combined health: checks Next.js env keys + Python matching service. */
export async function GET() {
  const apiConfigured = !!process.env.RENTCAST_API_KEY;
  const placesConfigured = !!process.env.GOOGLE_PLACES_API_KEY;

  let pythonHealthy = false;
  try {
    await pyGet("/api/health");
    pythonHealthy = true;
  } catch {
    // Python service unavailable — report degraded, don't throw
  }

  return NextResponse.json({
    status: apiConfigured && pythonHealthy ? "healthy" : "degraded",
    api_configured: apiConfigured,
    places_configured: placesConfigured,
    python_service: pythonHealthy ? "healthy" : "unavailable",
  });
}

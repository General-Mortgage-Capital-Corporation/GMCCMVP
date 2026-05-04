/**
 * Public resolver — returns the latest rate-sheet snapshot from Redis.
 *
 * Falls back to a 404 if no snapshot is cached. Frontend code should use the
 * `useRateSheets` hook which merges this response over a hardcoded fallback
 * inside `PROGRAM_CONFIG`, so the UI works regardless.
 *
 * Cached for 5 minutes via the Cache-Control header — refreshing inside the
 * cron-write window is unnecessary.
 */

import { type NextRequest, NextResponse } from "next/server";
import { readSnapshot } from "@/lib/rate-sheets/cache";
import { rateLimit, getClientIp } from "@/lib/ratelimit";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const ip = getClientIp(req);
  if (!rateLimit(`rate-sheets:${ip}`, 60)) {
    return NextResponse.json({ error: "Rate limit exceeded." }, { status: 429 });
  }

  const snapshot = await readSnapshot();
  if (!snapshot) {
    return NextResponse.json(
      { ok: false, error: "No rate-sheet snapshot available yet." },
      {
        status: 404,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }

  return NextResponse.json(
    { ok: true, snapshot },
    {
      headers: {
        "Cache-Control": "public, max-age=300, s-maxage=300, stale-while-revalidate=600",
      },
    },
  );
}

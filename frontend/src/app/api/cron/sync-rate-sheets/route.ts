/**
 * Daily cron: sync rate-sheet links from SharePoint.
 *
 * Schedule: Vercel cron (see frontend/vercel.json).
 *
 * Auth:
 *   - Preferred: CRON_SECRET env var. When set, require
 *     `Authorization: Bearer <secret>`. Vercel auto-injects this.
 *   - Fallback: when CRON_SECRET is not set, allow the call but rate-limit
 *     per-IP. The operation is non-destructive (read SharePoint, write
 *     Redis) so worst-case abuse is wasted Graph API quota — bounded by
 *     the rate limiter.
 *
 * On partial failure (one folder errors), keeps the previous Redis snapshot
 * intact rather than overwriting with incomplete data.
 */

import { type NextRequest, NextResponse } from "next/server";
import { syncRateSheets } from "@/lib/rate-sheets/sync";
import { readSnapshot, writeSnapshot } from "@/lib/rate-sheets/cache";
import { rateLimit, getClientIp } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    // Strict mode — production-safe auth.
    const authHeader = req.headers.get("Authorization");
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  } else {
    // Open mode — rate-limited (5/min per IP). Set CRON_SECRET to lock down.
    const ip = getClientIp(req);
    if (!rateLimit(`cron-sync-rate-sheets:${ip}`, 5)) {
      return NextResponse.json({ error: "Rate limit exceeded." }, { status: 429 });
    }
    console.warn(
      "[cron/sync-rate-sheets] CRON_SECRET not configured — accepting unauthenticated trigger from",
      ip,
    );
  }

  const startedAt = Date.now();
  const result = await syncRateSheets();

  // If any folder failed AND we have a previous snapshot, keep the previous one.
  // Only overwrite when the run is fully successful (all folders listed).
  if (!result.ok || !result.snapshot) {
    const prev = await readSnapshot();
    return NextResponse.json(
      {
        ok: false,
        kept_previous_snapshot: !!prev,
        previous_synced_at: prev?.synced_at ?? null,
        errors: result.errors,
        elapsed_ms: Date.now() - startedAt,
      },
      { status: 207 }, // multi-status — partial failure
    );
  }

  const wrote = await writeSnapshot(result.snapshot);

  // Summary for Vercel cron logs.
  const summary = {
    ok: true,
    wrote_to_redis: wrote,
    synced_at: result.snapshot.synced_at,
    program_counts: Object.fromEntries(
      Object.entries(result.snapshot.programs).map(([k, v]) => [k, v.length]),
    ),
    missing_programs: result.snapshot.missing_programs,
    unmatched_count: result.snapshot.unmatched.length,
    unmatched_sample: result.snapshot.unmatched.slice(0, 5).map((u) => u.filename),
    elapsed_ms: Date.now() - startedAt,
  };
  console.log("[cron/sync-rate-sheets]", JSON.stringify(summary));
  return NextResponse.json(summary);
}

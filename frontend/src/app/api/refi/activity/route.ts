/**
 * GET /api/refi/activity?cursor=<doc-id>&pageSize=<n>
 *
 * Paginated read of the caller's Refi Finder activity log. Returns 50 entries
 * by default (clamped 1-100). nextCursor is the last doc id when more pages
 * exist; pass it back on the next call.
 */

import { type NextRequest, NextResponse } from "next/server";
import { verifyIdTokenWithEmail } from "@/lib/firestore-admin";
import { listActivity } from "@/lib/refi-credits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return NextResponse.json({ error: "missing_bearer" }, { status: 401 });
  }
  const verified = await verifyIdTokenWithEmail(auth.slice(7));
  if (!verified) {
    return NextResponse.json({ error: "invalid_token" }, { status: 401 });
  }

  const cursor = req.nextUrl.searchParams.get("cursor");
  const pageSizeRaw = req.nextUrl.searchParams.get("pageSize");
  const pageSize = pageSizeRaw ? Number(pageSizeRaw) : undefined;

  try {
    const result = await listActivity({
      email: verified.email,
      pageSize,
      cursor,
    });
    // Serialize Timestamps in entries for JSON.
    const entries = result.entries.map((e) => ({
      ...e,
      ts:
        e.ts && typeof (e.ts as { toMillis?: () => number }).toMillis === "function"
          ? (e.ts as unknown as { toMillis: () => number }).toMillis()
          : null,
    }));
    return NextResponse.json({ entries, nextCursor: result.nextCursor });
  } catch (e) {
    console.error("[refi/activity] error:", e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

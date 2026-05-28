/**
 * GET /api/refi/access — legacy two-tier check kept for RefiFinderTab's
 * existing access-gate UI. Phase 4 retired the env-var allowlist; this
 * endpoint now reports has_access for any signed-in user. The outer
 * RefiFinderGate decides whether the tab actually renders by reading
 * subscription/bufferAllowlist state via /api/refi-subscription/status.
 */

import { NextResponse, type NextRequest } from "next/server";
import { verifyIdTokenWithEmail } from "@/lib/firestore-admin";
import { pyGet, PythonServiceError } from "@/lib/python-client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return NextResponse.json({ tier: "anonymous" });
  }
  let email: string | null = null;
  try {
    const v = await verifyIdTokenWithEmail(authHeader.replace("Bearer ", ""));
    email = v?.email ?? null;
  } catch {
    return NextResponse.json({ tier: "anonymous" });
  }
  if (!email) {
    return NextResponse.json({ tier: "anonymous" });
  }

  // Fetch the company-level PR quota for back-compat with the existing
  // RefiFinderTab useEffect that reads quota. We no longer surface this to
  // end users (the header pill + Refi-tab card show per-user balance), but
  // the field is still returned for legacy callers.
  let quota: Record<string, unknown> | null = null;
  try {
    quota = await pyGet<Record<string, unknown>>("/api/refi/quota?check_remaining=1");
  } catch (err) {
    if (!(err instanceof PythonServiceError)) {
      console.error("refi access: quota fetch failed", err);
    }
  }

  return NextResponse.json({ tier: "has_access", email, quota });
}

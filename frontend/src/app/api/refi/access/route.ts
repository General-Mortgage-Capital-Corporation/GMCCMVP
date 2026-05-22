/**
 * GET /api/refi/access — three-tier access check for the Refi Finder.
 *
 * Returns the caller's tier + (when allowed) live monthly credit balance
 * so the UI can render the right state and show "X credits remaining"
 * without burning a record on a separate quota call.
 *
 *   { tier: "anonymous" }                           → not signed in
 *   { tier: "no_access", email }                    → signed in, not allowlisted
 *   { tier: "has_access", email, quota: {...} }     → signed in + allowlisted
 *
 * Never throws — always returns 200 with the tier the UI should render.
 */

import { NextResponse, type NextRequest } from "next/server";
import { verifyIdTokenWithEmail } from "@/lib/firestore-admin";
import { emailHasRefiAccess } from "@/lib/refi-access";
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
  if (!(await emailHasRefiAccess(email))) {
    return NextResponse.json({ tier: "no_access", email });
  }

  // Fetch live credit balance for the header. This makes one free preview
  // call on the backend (Purchase=0) so the LO sees real remaining credits.
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

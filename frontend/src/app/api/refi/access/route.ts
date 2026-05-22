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
import { emailHasRefiAccess, emailMatchesStaticAllowlist } from "@/lib/refi-access";
import { debugGroupCheck } from "@/lib/graph-groups";
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
  const hasAccess = await emailHasRefiAccess(email);

  // Debug mode — only available to static-allowlist callers so non-team
  // members can't probe group membership. Pass ?debug=1 (checks self) or
  // ?debug=1&for=other@email to inspect why a teammate isn't getting access.
  if (req.nextUrl.searchParams.get("debug") === "1") {
    if (!emailMatchesStaticAllowlist(email)) {
      return NextResponse.json({
        tier: hasAccess ? "has_access" : "no_access",
        email,
        debug_error: "debug mode requires the caller to be on REFI_FINDER_ALLOWED_EMAILS",
      });
    }
    const target = (req.nextUrl.searchParams.get("for") || email).toLowerCase().trim();
    const debugInfo = await debugGroupCheck(target);
    return NextResponse.json({
      caller_email: email,
      env: {
        REFI_FINDER_GROUP_ID: !!process.env.REFI_FINDER_GROUP_ID,
        REFI_FINDER_GROUP_MAIL: process.env.REFI_FINDER_GROUP_MAIL ?? null,
        REFI_FINDER_ALLOWED_EMAILS: (process.env.REFI_FINDER_ALLOWED_EMAILS ?? "")
          .split(",").map((s) => s.trim()).filter(Boolean).length,
        REFI_FINDER_ALLOWED_DOMAINS: (process.env.REFI_FINDER_ALLOWED_DOMAINS ?? "")
          .split(",").map((s) => s.trim()).filter(Boolean),
        AZURE_CLIENT_ID: !!process.env.NEXT_PUBLIC_AZURE_CLIENT_ID,
        AZURE_CLIENT_SECRET: !!(process.env.AZURE_CLIENT_SECRET_VALUE ?? process.env.AZURE_CLIENT_SECRET),
        AZURE_TENANT_ID: !!process.env.NEXT_PUBLIC_AZURE_TENANT_ID,
      },
      target_email: target,
      static_allowlist_match: emailMatchesStaticAllowlist(target),
      graph: debugInfo,
      final_has_access: emailMatchesStaticAllowlist(target) || debugInfo.final_inGroup,
    });
  }

  if (!hasAccess) {
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

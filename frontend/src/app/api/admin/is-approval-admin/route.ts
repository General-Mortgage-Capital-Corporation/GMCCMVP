/**
 * GET /api/admin/is-approval-admin — tiny check so the client can decide
 * whether to show admin-only UI (the email-approvals link in Settings). Keeps
 * the admin list server-side (EMAIL_APPROVAL_ADMINS) — never shipped to the
 * browser. Returns { isAdmin: false } for signed-out or non-admin callers
 * rather than erroring, so the UI just hides the link.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";
import { isApprovalAdmin } from "@/lib/email-approvals";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  return NextResponse.json({ isAdmin: !!auth && isApprovalAdmin(auth.email) });
}

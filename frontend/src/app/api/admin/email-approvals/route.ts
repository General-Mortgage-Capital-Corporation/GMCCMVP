/**
 * Admin-only email allowlist management.
 *
 * GET    — list approved addresses + recently-flagged addresses (from the
 *          deliverability cache) so the admin can approve from a list.
 * POST   — approve (allowlist) an address: { email, note? }.
 * DELETE — revoke an address: { email }.
 *
 * Gated by isApprovalAdmin (EMAIL_APPROVAL_ADMINS env allowlist). A flagged
 * address, once approved, verifies as `deliverable` for everyone — no LO
 * self-override exists anymore.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth, unauthorized } from "@/lib/require-auth";
import { getDb } from "@/lib/firestore-admin";
import {
  isApprovalAdmin,
  approveEmail,
  revokeEmail,
  listApprovedEmails,
} from "@/lib/email-approvals";

export const runtime = "nodejs";

async function requireAdmin(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth) return { ok: false as const, res: unauthorized() };
  if (!isApprovalAdmin(auth.email)) {
    return { ok: false as const, res: NextResponse.json({ error: "Admin access required." }, { status: 403 }) };
  }
  return { ok: true as const, auth };
}

export async function GET(req: NextRequest) {
  const gate = await requireAdmin(req);
  if (!gate.ok) return gate.res;

  const approved = await listApprovedEmails();
  const approvedSet = new Set(approved.map((a) => a.email.toLowerCase()));

  // Recently-flagged addresses from the deliverability cache, so the admin can
  // approve straight from the list of what's actually been blocked.
  let flagged: {
    email: string;
    status: string;
    reason: string | null;
    checkedBy: string | null;
    checkedAt: number | null;
    approved: boolean;
  }[] = [];
  const db = getDb();
  if (db) {
    const snap = await db.collection("emailValidations").get();
    flagged = snap.docs
      .map((d) => d.data() as Record<string, unknown>)
      .filter((x) => typeof x.status === "string" && x.status !== "deliverable" && typeof x.email === "string")
      .map((x) => {
        const checkedAt = x.checkedAt as { toMillis?: () => number } | undefined;
        const email = String(x.email);
        return {
          email,
          status: String(x.status),
          reason: (x.reason as string) ?? null,
          checkedBy: (x.checkedBy as string) ?? null,
          checkedAt: checkedAt?.toMillis ? checkedAt.toMillis() : null,
          approved: approvedSet.has(email.toLowerCase()),
        };
      })
      .sort((a, b) => (b.checkedAt ?? 0) - (a.checkedAt ?? 0))
      .slice(0, 300);
  }

  return NextResponse.json({ isAdmin: true, approved, flagged });
}

export async function POST(req: NextRequest) {
  const gate = await requireAdmin(req);
  if (!gate.ok) return gate.res;

  const body = (await req.json().catch(() => ({}))) as {
    email?: unknown;
    note?: unknown;
    originalStatus?: unknown;
  };
  const email = typeof body.email === "string" ? body.email : "";
  if (!email) return NextResponse.json({ error: "email required" }, { status: 400 });

  const r = await approveEmail(email, gate.auth.email, {
    note: typeof body.note === "string" ? body.note : null,
    originalStatus: typeof body.originalStatus === "string" ? body.originalStatus : null,
  });
  if (!r.ok) return NextResponse.json({ error: "approve failed" }, { status: 500 });
  return NextResponse.json({ ok: true, email: r.email });
}

export async function DELETE(req: NextRequest) {
  const gate = await requireAdmin(req);
  if (!gate.ok) return gate.res;

  const body = (await req.json().catch(() => ({}))) as { email?: unknown };
  const email = typeof body.email === "string" ? body.email : "";
  if (!email) return NextResponse.json({ error: "email required" }, { status: 400 });

  const r = await revokeEmail(email);
  return NextResponse.json({ ok: r.ok });
}

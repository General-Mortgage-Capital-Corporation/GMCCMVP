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
import {
  forceReverifyDeliverability,
  readBouncerHealth,
} from "@/lib/email-deliverability";

export const runtime = "nodejs";

const EMAIL_SYNTAX_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
    // Query only flagged docs — the collection also holds every deliverable
    // verification ever made, and a full scan grows unboundedly over time.
    const snap = await db
      .collection("emailValidations")
      .where("status", "in", ["risky", "unknown", "undeliverable"])
      .get();
    flagged = snap.docs
      .map((d) => d.data() as Record<string, unknown>)
      .filter((x) => typeof x.status === "string" && typeof x.email === "string")
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

  // Bouncer integration health — drives the outage banner on the admin page
  // (e.g. credits exhausted → HTTP 402 → all uncached sends blocked).
  const bouncerHealth = await readBouncerHealth();

  return NextResponse.json({ isAdmin: true, approved, flagged, bouncerHealth });
}

export async function POST(req: NextRequest) {
  const gate = await requireAdmin(req);
  if (!gate.ok) return gate.res;

  const body = (await req.json().catch(() => ({}))) as {
    email?: unknown;
    note?: unknown;
    originalStatus?: unknown;
  };
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email) return NextResponse.json({ error: "email required" }, { status: 400 });
  if (!EMAIL_SYNTAX_RE.test(email)) {
    return NextResponse.json({ error: "Not a valid email address." }, { status: 422 });
  }

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

/**
 * PUT — force a fresh Bouncer re-check for an address (bypasses the 90-day
 * cache; spends one credit). Lets an admin clear a flagged address whose
 * mailbox has since been fixed, instead of allowlisting it blind or waiting
 * out the cache TTL.
 */
export async function PUT(req: NextRequest) {
  const gate = await requireAdmin(req);
  if (!gate.ok) return gate.res;

  const body = (await req.json().catch(() => ({}))) as { email?: unknown };
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email) return NextResponse.json({ error: "email required" }, { status: 400 });
  if (!EMAIL_SYNTAX_RE.test(email)) {
    return NextResponse.json({ error: "Not a valid email address." }, { status: 422 });
  }

  const result = await forceReverifyDeliverability(email, gate.auth.email);
  return NextResponse.json({ ok: true, result });
}

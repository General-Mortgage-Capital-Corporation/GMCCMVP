/**
 * POST /api/refi/unlock-contact-paid
 *
 * Credit-gated wrapper around the Python /api/refi/unlock-contact endpoint.
 *
 *   1. Verify Firebase ID token → email.
 *   2. Resolve subscription — must be active or buffer; else 402.
 *   3. Compute credit cost: 1 contact per email reveal + 1 contact per text reveal.
 *      A row with both flags costs 2 contact credits. A row with neither is rejected.
 *   4. Atomic deduction via performUnlock orchestrator.
 *   5. PR call via Python.
 *   6. One activity entry per discrete action (unlock_email AND/OR unlock_text per row).
 *   7. Refund + unlock_failed log on PR failure.
 *
 * Body shape:
 *   {
 *     rows: [
 *       { radar_id, address, email: boolean, text: boolean },
 *       ...
 *     ]
 *   }
 *
 * Replaces /api/refi/unlock-contact for users on the new subscription/buffer
 * system. Legacy free-tier users keep hitting the old route until Phase 4.
 */

import { type NextRequest, NextResponse } from "next/server";
import { verifyIdTokenWithEmail } from "@/lib/firestore-admin";
import { rateLimit, getClientIp } from "@/lib/ratelimit";
import { pyPost, PythonServiceError } from "@/lib/python-client";
import {
  resolveSubscription,
  resolvePool,
  performUnlock,
  InsufficientCreditsError,
  type ActivityAction,
} from "@/lib/refi-credits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface UnlockRow {
  radar_id: string;
  address?: string;
  email?: boolean;
  text?: boolean;
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return NextResponse.json({ error: "missing_bearer" }, { status: 401 });
  }
  const verified = await verifyIdTokenWithEmail(auth.slice(7));
  if (!verified) {
    return NextResponse.json({ error: "invalid_token" }, { status: 401 });
  }

  const ip = getClientIp(req);
  if (!rateLimit(ip, 10)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const body = (await req.json().catch(() => null)) as
    | { rows?: UnlockRow[] }
    | null;
  if (!body || !Array.isArray(body.rows) || body.rows.length === 0) {
    return NextResponse.json({ error: "rows required" }, { status: 400 });
  }
  const MAX = 25;
  if (body.rows.length > MAX) {
    return NextResponse.json(
      { error: `max_${MAX}_rows`, detail: `submitted ${body.rows.length}` },
      { status: 400 },
    );
  }

  // Build the activity entries + amount in one pass. Reject rows that don't
  // request anything — we don't want silent no-op deductions.
  const rowActions: Array<{
    action: ActivityAction;
    propertyId: string;
    propertyAddress: string;
    creditsUsed: { contact?: number; property?: number };
  }> = [];
  let contactNeeded = 0;
  for (const row of body.rows) {
    if (!row.radar_id) {
      return NextResponse.json(
        { error: "row_missing_radar_id" },
        { status: 400 },
      );
    }
    const wantEmail = !!row.email;
    const wantText = !!row.text;
    if (!wantEmail && !wantText) {
      return NextResponse.json(
        { error: "row_must_request_email_or_text", radar_id: row.radar_id },
        { status: 400 },
      );
    }
    const addr = row.address ?? "unknown";
    if (wantEmail) {
      rowActions.push({
        action: "unlock_email",
        propertyId: String(row.radar_id),
        propertyAddress: addr,
        creditsUsed: { contact: 1 },
      });
      contactNeeded++;
    }
    if (wantText) {
      rowActions.push({
        action: "unlock_text",
        propertyId: String(row.radar_id),
        propertyAddress: addr,
        creditsUsed: { contact: 1 },
      });
      contactNeeded++;
    }
  }

  // Gating
  const sub = await resolveSubscription(verified.email);
  if (sub.state !== "active" && sub.state !== "buffer") {
    return NextResponse.json(
      { error: "no_subscription", state: sub.state },
      { status: 402 },
    );
  }
  const pool = await resolvePool(verified.email);

  // PR currently accepts a single phone+email flag per request — we group
  // rows by which channels they want. Two PR calls maximum: one for
  // email-only rows, one for text-only rows, OR one combined call for rows
  // that want both. To keep this simple AND match PR's bulk semantics, do
  // ONE call with phone=anyText, email=anyEmail, sending the union of
  // radar_ids. PR returns contacts for each row; the channels not requested
  // for a row are filtered out client-side. That over-fetches contacts the
  // user didn't pay for — bad.
  //
  // Cleaner: split into up to 3 calls — email-only, text-only, both. Each
  // group only requests what was paid for. Cost match is exact.
  const emailOnly = body.rows.filter((r) => r.email && !r.text);
  const textOnly = body.rows.filter((r) => r.text && !r.email);
  const both = body.rows.filter((r) => r.email && r.text);

  try {
    const { result, balanceAfter } = await performUnlock({
      email: verified.email,
      pool,
      amount: { contact: contactNeeded, property: 0 },
      rowActions,
      call: async () => {
        const combined: Record<string, unknown> = {};
        await Promise.all([
          callPython(emailOnly, { phone: false, email: true }, combined, "emailOnly"),
          callPython(textOnly, { phone: true, email: false }, combined, "textOnly"),
          callPython(both, { phone: true, email: true }, combined, "both"),
        ]);
        return {
          propertyRadarRef: `batch-${Date.now()}`,
          result: combined,
        };
      },
    });
    return NextResponse.json({ success: true, ...(result as object), balanceAfter });
  } catch (e) {
    if (e instanceof InsufficientCreditsError) {
      return NextResponse.json(
        { error: "insufficient_credits", needed: e.needed, have: e.have },
        { status: 402 },
      );
    }
    const status = e instanceof PythonServiceError ? e.status : 502;
    const msg = e instanceof PythonServiceError ? e.message : "unlock_failed";
    return NextResponse.json(
      { error: msg, refunded: true },
      { status: status === 200 ? 502 : status },
    );
  }
}

async function callPython(
  rows: UnlockRow[],
  flags: { phone: boolean; email: boolean },
  out: Record<string, unknown>,
  key: string,
): Promise<void> {
  if (rows.length === 0) return;
  const data = await pyPost<Record<string, unknown>>(
    "/api/refi/unlock-contact",
    {
      radar_ids: rows.map((r) => r.radar_id),
      phone: flags.phone,
      email: flags.email,
    },
  );
  out[key] = data;
}

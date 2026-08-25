/**
 * POST /api/refi-subscription/recharge
 *
 * Creates a $20 / +200-contact-credit recharge invoice. Mid-cycle top-up
 * for users running low on contact credits. Only available to active
 * subscribers — the cloud function enforces that.
 *
 * Idempotency (P1-4 from the 2026-06-03 review):
 *
 *   1. Pre-flight check on `users/{email}/creditPacks/refi_finder.pendingRecharge`.
 *      If a previous recharge call wrote a paymentUrl within the last 24h,
 *      return that URL with `reused: true` instead of creating a second
 *      $20 invoice. (Old code: double-click → two open invoices → user
 *      paid $40 expecting +200 but got +400, or had to deal with refunds.)
 *
 *   2. After the cloud function returns, persist pendingRecharge from
 *      our side — defensive in case the cloud function doesn't write it
 *      itself. Cleared by the Bill.com webhook on successful payment.
 */

import { type NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { verifyIdTokenWithEmail, getDb } from "@/lib/firestore-admin";
import { refiFinderRecharge, CloudFunctionError } from "@/lib/cloud-functions";
import type { RefiCreditPack } from "@/lib/refi-credits/types";
import { resolveSubscription } from "@/lib/refi-credits/subscription";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PENDING_RECHARGE_TTL_MS = 24 * 60 * 60 * 1000;
const RECHARGE_AMOUNT = 20;

export async function POST(req: NextRequest) {
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return NextResponse.json({ error: "missing_bearer" }, { status: 401 });
  }
  const idToken = auth.slice(7);
  const verified = await verifyIdTokenWithEmail(idToken);
  if (!verified) {
    return NextResponse.json({ error: "invalid_token" }, { status: 401 });
  }

  if (process.env.REFI_FINDER_PAYMENTS_DISABLED === "true") {
    return NextResponse.json(
      { error: "payments_disabled" },
      { status: 503 },
    );
  }

  const email = verified.email.toLowerCase();

  // A top-up outside a live cycle buys nothing: the pack is gated on
  // cycleEndsAt and the next subscription payment hard-resets it to 200.
  // The cloud function enforces this too; failing here keeps the user from
  // opening a Bill.com tab for an invoice that can't help them.
  try {
    const status = await resolveSubscription(email);
    if (status.state !== "active") {
      return NextResponse.json({ error: "not_active", state: status.state }, { status: 409 });
    }
  } catch (e) {
    console.error("[refi-subscription/recharge] resolve failed:", e);
  }

  const db = getDb();
  const packRef = db ? db.doc(`users/${email}/creditPacks/refi_finder`) : null;

  // Guard: in-flight recharge reuse.
  if (packRef) {
    try {
      const snap = await packRef.get();
      const pack = (snap.data() ?? {}) as RefiCreditPack;
      const pending = pack.pendingRecharge;
      if (pending?.paymentUrl && pending.createdAt) {
        const ageMs = Date.now() - pending.createdAt.toMillis();
        if (ageMs < PENDING_RECHARGE_TTL_MS) {
          return NextResponse.json({
            paymentUrl: pending.paymentUrl,
            invoiceId: pending.billcomInvoiceId,
            reused: true,
          });
        }
      }
    } catch (e) {
      console.error("[refi-subscription/recharge] pending read failed:", e);
    }
  }

  try {
    const result = await refiFinderRecharge(idToken);

    if (packRef) {
      try {
        await packRef.set(
          {
            pendingRecharge: {
              billcomInvoiceId: result.invoiceId,
              paymentUrl: result.paymentUrl,
              createdAt: FieldValue.serverTimestamp(),
              amount: RECHARGE_AMOUNT,
            },
          },
          { merge: true },
        );
      } catch (writeErr) {
        console.error(
          "[refi-subscription/recharge] pending write failed:",
          writeErr,
        );
      }
    }

    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof CloudFunctionError) {
      return NextResponse.json(
        { error: "cloud_function_error", status: e.status, body: e.body },
        { status: 502 },
      );
    }
    console.error("[refi-subscription/recharge] error:", e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

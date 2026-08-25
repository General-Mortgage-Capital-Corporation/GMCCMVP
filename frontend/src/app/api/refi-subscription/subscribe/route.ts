/**
 * POST /api/refi-subscription/subscribe
 *
 * Creates a $100/month Refi Finder subscription invoice via Bill.com.
 * Returns the paymentUrl which the client opens in a new tab. After payment,
 * the billcomWebhook cloud function grants 200/5000 credits.
 *
 * The caller MUST have hit /acknowledge first; the cloud function rejects
 * non-acknowledged invoice requests.
 *
 * Idempotency (P1-5 from the 2026-06-03 review):
 *
 *   1. Pre-flight state check. If `resolveSubscription` reports the user
 *      is already active / buffer / renewing, refuse with 409 — they
 *      don't need a new invoice and we shouldn't create one. (Old code
 *      would forward unconditionally → second recurring template → user
 *      double-billed monthly forever.)
 *
 *   2. In-flight invoice reuse. If a previous subscribe call wrote a
 *      `pendingSubscribe` entry on the subscriptions doc within the
 *      last 24h, return that URL with `reused: true` instead of asking
 *      Bill.com for another one. The webhook clears `pendingSubscribe`
 *      on successful payment so the next legitimate subscribe (after
 *      expiry) starts fresh.
 */

import { type NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { verifyIdTokenWithEmail } from "@/lib/firestore-admin";
import { getDb } from "@/lib/firestore-admin";
import { addonCreateInvoice, CloudFunctionError } from "@/lib/cloud-functions";
import { resolveSubscription } from "@/lib/refi-credits/subscription";
import type { RefiSubscription } from "@/lib/refi-credits/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PENDING_SUBSCRIBE_TTL_MS = 24 * 60 * 60 * 1000;

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

  // Guard 1: already-subscribed states.
  try {
    const status = await resolveSubscription(email);
    if (
      status.state === "active" ||
      status.state === "buffer" ||
      status.state === "renewing"
    ) {
      return NextResponse.json(
        { error: "already_subscribed", state: status.state },
        { status: 409 },
      );
    }
  } catch (e) {
    // resolveSubscription failure shouldn't block subscribe — fail open and
    // let the cloud function handle it. Log so we notice.
    console.error("[refi-subscription/subscribe] resolve failed:", e);
  }

  const db = getDb();
  // Same doc the cloud functions write; the top-level collection is retired.
  const subRef = db ? db.doc(`users/${email}/subscriptions/current`) : null;

  // Guard 2: in-flight invoice reuse.
  if (subRef) {
    try {
      const snap = await subRef.get();
      const sub = (snap.data()?.refi_finder ?? {}) as RefiSubscription;
      const pending = sub.pendingSubscribe;
      if (pending?.paymentUrl && pending.createdAt) {
        const ageMs = Date.now() - pending.createdAt.toMillis();
        if (ageMs < PENDING_SUBSCRIBE_TTL_MS) {
          return NextResponse.json({
            paymentUrl: pending.paymentUrl,
            invoiceId: pending.invoiceId,
            reused: true,
          });
        }
      }
    } catch (e) {
      console.error("[refi-subscription/subscribe] pending read failed:", e);
    }
  }

  try {
    const result = await addonCreateInvoice(idToken, { type: "refi_finder" });

    // Persist pendingSubscribe so the next subscribe call reuses this URL.
    // Defensive: the cloud function may or may not write here; ours is
    // independent. Webhook clears it on payment.
    if (subRef) {
      try {
        await subRef.set(
          {
            refi_finder: {
              pendingSubscribe: {
                paymentUrl: result.paymentUrl,
                invoiceId: result.invoiceId,
                createdAt: FieldValue.serverTimestamp(),
              },
            },
          },
          { merge: true },
        );
      } catch (writeErr) {
        // Don't fail the request — user has the paymentUrl, idempotency
        // best-effort. Log and continue.
        console.error(
          "[refi-subscription/subscribe] pending write failed:",
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
    console.error("[refi-subscription/subscribe] error:", e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

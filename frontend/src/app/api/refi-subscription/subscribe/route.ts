/**
 * POST /api/refi-subscription/subscribe
 *
 * Creates a $100/month Refi Finder subscription invoice via Bill.com.
 * Returns the paymentUrl which the client opens in a new tab. After payment,
 * the billcomWebhook cloud function grants 200/5000 credits.
 *
 * The caller MUST have hit /acknowledge first; the cloud function rejects
 * non-acknowledged invoice requests.
 */

import { type NextRequest, NextResponse } from "next/server";
import { verifyIdTokenWithEmail } from "@/lib/firestore-admin";
import { addonCreateInvoice, CloudFunctionError } from "@/lib/cloud-functions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  try {
    const result = await addonCreateInvoice(idToken, { type: "refi_finder" });
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

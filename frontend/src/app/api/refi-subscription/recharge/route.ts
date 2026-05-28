/**
 * POST /api/refi-subscription/recharge
 *
 * Creates a $20 / +200-contact-credit recharge invoice. Mid-cycle top-up
 * for users running low on contact credits. Only available to active
 * subscribers — the cloud function enforces that.
 */

import { type NextRequest, NextResponse } from "next/server";
import { verifyIdTokenWithEmail } from "@/lib/firestore-admin";
import { refiFinderRecharge, CloudFunctionError } from "@/lib/cloud-functions";

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

  if (process.env.REFI_FINDER_PAYMENTS_DISABLED === "true") {
    return NextResponse.json(
      { error: "payments_disabled" },
      { status: 503 },
    );
  }

  try {
    const result = await refiFinderRecharge(idToken);
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

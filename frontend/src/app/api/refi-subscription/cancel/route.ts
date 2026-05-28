/**
 * POST /api/refi-subscription/cancel
 *
 * Cancels Bill.com auto-renewal for this user. Does NOT refund their current
 * cycle — they keep their balance until cycleEndsAt, after which no new
 * webhook fires and they fall back to the "expired" gate.
 *
 * To resume, the user goes through the normal subscribe flow again (which
 * creates a fresh recurring template).
 */

import { type NextRequest, NextResponse } from "next/server";
import { verifyIdTokenWithEmail } from "@/lib/firestore-admin";
import { cancelRefiFinder, CloudFunctionError } from "@/lib/cloud-functions";

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
    const result = await cancelRefiFinder(idToken);
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof CloudFunctionError) {
      return NextResponse.json(
        { error: "cloud_function_error", status: e.status, body: e.body },
        { status: 502 },
      );
    }
    console.error("[refi-subscription/cancel] error:", e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

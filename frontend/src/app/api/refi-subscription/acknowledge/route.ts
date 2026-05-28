/**
 * POST /api/refi-subscription/acknowledge
 *
 * Records the user's SLA acknowledgement before invoice creation. Required
 * by the MLO portal's Bill.com flow.
 */

import { type NextRequest, NextResponse } from "next/server";
import { verifyIdTokenWithEmail } from "@/lib/firestore-admin";
import { addonAcknowledge, CloudFunctionError } from "@/lib/cloud-functions";

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
    const result = await addonAcknowledge(idToken, {
      type: "refi_finder",
      autoPayEnabled: false,
    });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof CloudFunctionError) {
      return NextResponse.json(
        { error: "cloud_function_error", status: e.status, body: e.body },
        { status: 502 },
      );
    }
    console.error("[refi-subscription/acknowledge] error:", e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

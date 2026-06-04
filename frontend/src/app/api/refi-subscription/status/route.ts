/**
 * GET /api/refi-subscription/status
 *
 * Returns the caller's Refi Finder subscription status by reading Firestore
 * directly (Admin SDK). Does NOT call Bill.com cloud functions — those only
 * matter during the subscribe/payment-poll flow. Polled by the client every
 * few seconds while a payment is in flight; otherwise consulted on mount.
 */

import { type NextRequest, NextResponse } from "next/server";
import { verifyIdTokenWithEmail } from "@/lib/firestore-admin";
import { resolveSubscription } from "@/lib/refi-credits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return NextResponse.json({ error: "missing_bearer" }, { status: 401 });
  }
  const verified = await verifyIdTokenWithEmail(auth.slice(7));
  if (!verified) {
    return NextResponse.json({ error: "invalid_token" }, { status: 401 });
  }

  try {
    const status = await resolveSubscription(verified.email);
    return NextResponse.json({
      ...serializeStatus(status),
      // Surface the payments-disabled flag so the client can hide
      // Subscribe / Recharge CTAs while preserving existing access. Mirrors
      // the MLO portal's REFI_FINDER_PAYMENTS_DISABLED — keep both flipped
      // together so the two sites don't diverge.
      paymentsEnabled: process.env.REFI_FINDER_PAYMENTS_DISABLED !== "true",
    });
  } catch (e) {
    console.error("[refi-subscription/status] error:", e);
    return NextResponse.json(
      { error: "internal_error", detail: String(e) },
      { status: 500 },
    );
  }
}

function serializeStatus(
  s: Awaited<ReturnType<typeof resolveSubscription>>,
): Record<string, unknown> {
  if (s.state === "active") {
    return { ...s, cycleEndsAt: s.cycleEndsAt.toISOString() };
  }
  if (s.state === "renewing") {
    return { ...s, lastCycleEndedAt: s.lastCycleEndedAt.toISOString() };
  }
  if (s.state === "expired") {
    return { ...s, cycleEndsAt: s.cycleEndsAt?.toISOString() ?? null };
  }
  return s;
}

/**
 * POST /api/email/validate
 *
 * Server-side Bouncer call with Firestore cache. Called by the email modals
 * at the moment the user clicks Send — NOT debounced on typing. See
 * `lib/email-deliverability.ts` for the cache + Bouncer wrapper.
 *
 * Fails open at the server (returns `unknown` if Bouncer is down) — the
 * client policy is what enforces "only deliverable allows send".
 */

import { NextRequest, NextResponse } from "next/server";

import { requireAuth, unauthorized } from "@/lib/require-auth";
import {
  verifyDeliverability,
  type DeliverabilityResult,
} from "@/lib/email-deliverability";

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth) return unauthorized();

  const body = (await req.json().catch(() => ({}))) as { email?: unknown };
  const rawEmail = typeof body.email === "string" ? body.email : "";

  const result: DeliverabilityResult = await verifyDeliverability(
    rawEmail,
    auth.email,
  );
  return NextResponse.json(result);
}

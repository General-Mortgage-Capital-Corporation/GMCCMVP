/**
 * Refi Finder auth helper.
 *
 * The env-var allowlist (REFI_FINDER_ALLOWED_EMAILS / REFI_FINDER_GROUP_ID)
 * was retired in Phase 4 of the credit-system migration. Access is now
 * gated by subscription state + bufferAllowlist (see
 * lib/refi-credits/subscription.ts). This file only does auth: it verifies
 * the Firebase ID token and returns the caller's email.
 *
 * Kept the `requireRefiAccess` + `withRefiAccess` API for the read-only
 * routes under /api/refi/{preview,presets,quota,unlock-preview} which
 * return non-billable metadata (no PR contact reveals). The legacy
 * /api/refi/search + /api/refi/unlock-contact routes were deleted —
 * they wrapped paid PropertyRadar calls without charging credits, which
 * was a paywall bypass. Credit-deducting routes (/api/refi/unlock-search,
 * /unlock-contact-paid) call resolveSubscription directly and don't go
 * through this file.
 */

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { verifyIdTokenWithEmail } from "@/lib/firestore-admin";

export type RefiAccessTier = "anonymous" | "has_access";

export class AccessError extends Error {
  status: number;
  tier: RefiAccessTier;
  constructor(message: string, status: number, tier: RefiAccessTier) {
    super(message);
    this.name = "AccessError";
    this.status = status;
    this.tier = tier;
  }
}

/** Verify the request's bearer token and return the caller's email. */
export async function requireRefiAccess(req: NextRequest): Promise<string> {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    throw new AccessError("Not signed in.", 401, "anonymous");
  }
  const token = authHeader.replace("Bearer ", "");
  let verified: { email: string } | null = null;
  try {
    verified = await verifyIdTokenWithEmail(token);
  } catch {
    throw new AccessError("Invalid token.", 401, "anonymous");
  }
  if (!verified?.email) {
    throw new AccessError("Token missing email claim.", 401, "anonymous");
  }
  return verified.email;
}

/** Convenience: wrap a route handler so it returns the proper HTTP error
 *  when auth fails, otherwise hands the verified email to `handler`. */
export async function withRefiAccess<T>(
  req: NextRequest,
  handler: (email: string) => Promise<NextResponse<T> | NextResponse>,
): Promise<NextResponse> {
  try {
    const email = await requireRefiAccess(req);
    return await handler(email);
  } catch (err) {
    if (err instanceof AccessError) {
      return NextResponse.json(
        { success: false, error: err.message, tier: err.tier },
        { status: err.status },
      );
    }
    throw err;
  }
}

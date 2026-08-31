/**
 * Server-side auth guard for API routes.
 *
 * Usage:
 *   export async function POST(req: NextRequest) {
 *     const auth = await requireAuth(req);
 *     if (!auth) return unauthorized();
 *     // ... auth.email is available here
 *   }
 *
 * Routes that already use `withRefiAccess` (refi/*) or other specialized
 * wrappers don't need this — those wrappers do their own verification.
 */

import { NextResponse } from "next/server";
import { verifyIdTokenWithEmail, type VerifiedCaller } from "@/lib/firestore-admin";

export type AuthedCaller = VerifiedCaller;

/**
 * Returns the authenticated caller, or null if the request is
 * unauthenticated. LO-only by default: partner accounts (provisioned by the
 * MLO portal for realtors/CPAs) are rejected unless the route passes
 * `{ allowPartner: true }` — the partner surface is a deliberate allowlist.
 */
export async function requireAuth(
  req: Request,
  opts?: { allowPartner?: boolean },
): Promise<AuthedCaller | null> {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) return null;
  return await verifyIdTokenWithEmail(token, opts);
}

/** Standard 401 response for routes that fail requireAuth. */
export function unauthorized(): NextResponse {
  return NextResponse.json(
    { error: "Authentication required" },
    { status: 401 },
  );
}

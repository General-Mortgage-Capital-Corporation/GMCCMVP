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
import { verifyIdTokenWithEmail } from "@/lib/firestore-admin";

export type AuthedCaller = { uid: string; email: string };

/** Returns the authenticated caller, or null if the request is unauthenticated. */
export async function requireAuth(req: Request): Promise<AuthedCaller | null> {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) return null;
  return await verifyIdTokenWithEmail(token);
}

/** Standard 401 response for routes that fail requireAuth. */
export function unauthorized(): NextResponse {
  return NextResponse.json(
    { error: "Authentication required" },
    { status: 401 },
  );
}

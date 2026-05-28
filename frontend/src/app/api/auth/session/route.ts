/**
 * POST   /api/auth/session — verify the caller's Firebase ID token and set
 *                            the `gmcc_session` cookie that middleware checks.
 * DELETE /api/auth/session — clear the cookie (called on sign-out).
 *
 * The cookie is just a session-presence marker — middleware uses it to decide
 * "render the page or redirect to /login". Real authentication still happens
 * per-API-route via the Authorization header + verifyIdToken, so spoofing the
 * cookie only buys you a blank page, not access to any data.
 */

import { NextResponse, type NextRequest } from "next/server";
import { verifyIdTokenWithEmail } from "@/lib/firestore-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COOKIE_NAME = "gmcc_session";
// Match the typical Azure AD refresh-token sliding window (90 days). Past
// this, MSAL silent refresh will fail anyway. The cookie is only a UX
// marker — AuthContext clears it if it outlives the real session, so a
// longer lifetime can't strand users in a zombie state.
const SESSION_COOKIE_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return NextResponse.json({ ok: false, error: "missing bearer token" }, { status: 401 });
  }
  const idToken = authHeader.replace("Bearer ", "");
  const verified = await verifyIdTokenWithEmail(idToken);
  if (!verified) {
    return NextResponse.json({ ok: false, error: "invalid token" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true, email: verified.email });
  res.cookies.set({
    name: COOKIE_NAME,
    value: "1",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
  });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set({
    name: COOKIE_NAME,
    value: "",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return res;
}

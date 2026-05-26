/**
 * SSO handoff endpoint for the MLO portal.
 *
 * Flow (when wired):
 *   1. MLO portal redirects user to `/login?sso_token=<short-lived JWT>&next=/`
 *   2. /login page POSTs the token here.
 *   3. This route verifies the token, mints a Firebase custom token for the
 *      user's email (via the existing Cloud Function exchange or admin SDK),
 *      sets the `gmcc_session` cookie, and returns { ok: true, idToken? } so
 *      the client can also hydrate its in-memory auth state.
 *
 * Until the portal's exact contract is known, this stub returns 501 so the
 * client surfaces a clear error rather than silently doing nothing.
 *
 * Implementation TODO (after the MLO portal team confirms):
 *   - Decide token format: signed JWT (HS256/RS256) with shared secret/public
 *     key, OR Firebase custom token, OR opaque token + verification endpoint.
 *   - Add env var(s): MLO_PORTAL_SSO_PUBLIC_KEY / MLO_PORTAL_SSO_SECRET, plus
 *     issuer/audience claims to verify against.
 *   - Inside the handler, verify the token's signature + exp + iss + aud,
 *     extract the user's email, then either:
 *       (a) Call the existing Cloud Function (exchangeMsalToken pattern) with
 *           a portal-issued credential to get a Firebase ID token, or
 *       (b) Mint a Firebase custom token via admin SDK and have the client
 *           exchange it for an ID token via the Firebase REST endpoint.
 *   - Set the session cookie (Max-Age = 30 days, same shape as /api/auth/session).
 *   - Return { ok: true, idToken } so the client AuthContext can hydrate.
 */

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  return NextResponse.json(
    {
      ok: false,
      error: "MLO portal SSO handoff not yet configured. Sign in with Outlook instead.",
    },
    { status: 501 },
  );
}

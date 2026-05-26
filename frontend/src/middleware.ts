/**
 * Auth gate — redirects unauthenticated page requests to /login.
 *
 * Only checks for the presence of the `gmcc_session` cookie (set by
 * /api/auth/session after Firebase verifyIdToken). Real per-request auth
 * still happens inside API routes via Authorization: Bearer; the cookie is
 * purely a UX marker that decides "render page vs redirect to login".
 *
 * The matcher below excludes:
 *   /login        — the login page itself
 *   /api/*        — handled by per-route auth checks, not the gate
 *                   (also: middleware on Vercel adds latency to API calls)
 *   /_next/*      — Next internals + static chunks
 *   favicon, image extensions — static assets
 */

import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE = "gmcc_session";

export function middleware(req: NextRequest) {
  const hasSession = req.cookies.get(SESSION_COOKIE)?.value;
  if (hasSession) return NextResponse.next();

  const url = req.nextUrl.clone();
  const next = url.pathname + (url.search || "");
  url.pathname = "/login";
  url.search = `?next=${encodeURIComponent(next)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    // Run on every path EXCEPT:
    //   - /login (avoid redirect loop)
    //   - /api/* (own auth; also cron jobs that use CRON_SECRET)
    //   - /_next/static, /_next/image (Next.js internals)
    //   - common static-file extensions
    "/((?!login|api/|_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|woff|woff2|ttf|css|js|map)$).*)",
  ],
};

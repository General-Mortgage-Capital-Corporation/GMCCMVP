"use client";

import { useState, useEffect, useMemo, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import LoadingSpinner from "@/components/LoadingSpinner";

// Only allow `next` paths that point back into our own app — prevents
// open-redirect to `/login?next=https://evil.example.com`.
function sanitizeNextPath(next: string | null): string {
  if (!next) return "/";
  if (!next.startsWith("/") || next.startsWith("//")) return "/";
  return next;
}

/** Pull sso_hint from either the top-level query or from inside ?next=…. The
 *  MLO portal currently links to `/?sso_hint=…` which middleware encodes into
 *  the `next` param when redirecting unauthenticated requests to /login. */
function extractSsoHint(searchParams: URLSearchParams): string | undefined {
  const direct = searchParams.get("sso_hint");
  if (direct) return direct;
  const nextRaw = searchParams.get("next");
  if (nextRaw && nextRaw.includes("sso_hint=")) {
    try {
      const u = new URL(nextRaw, "http://x");
      return u.searchParams.get("sso_hint") ?? undefined;
    } catch { /* ignore parse errors */ }
  }
  return undefined;
}

/** Strip sso_hint from `next` so it doesn't end up in the final URL bar. */
function cleanNextDestination(next: string): string {
  if (!next.includes("sso_hint")) return next;
  try {
    const u = new URL(next, "http://x");
    u.searchParams.delete("sso_hint");
    const search = u.searchParams.toString();
    return u.pathname + (search ? `?${search}` : "");
  } catch { return next; }
}

function LoginInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, signIn, signInSilent, getIdToken, loading } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const next = useMemo(
    () => cleanNextDestination(sanitizeNextPath(searchParams.get("next"))),
    [searchParams],
  );
  const ssoToken = searchParams.get("sso_token");
  const ssoHint = useMemo(() => extractSsoHint(searchParams), [searchParams]);
  // Only auto-attempt Microsoft silent SSO when the request looks like it
  // came from the MLO portal (sso_hint present). Direct visits show the
  // sign-in button immediately — no misleading "Signing you in…" flash.
  const shouldAttemptSso = !!ssoHint;
  const [silentAttempting, setSilentAttempting] = useState(shouldAttemptSso);
  const [silentFailed, setSilentFailed] = useState(false);

  // MLO portal handoff: if we arrive with ?sso_token=..., try to exchange it
  // server-side for a session cookie + Firebase ID token. On success, jump
  // straight through; on failure, fall back to the normal sign-in button.
  // (The /api/auth/sso-exchange endpoint is a stub today; see that file for
  // the implementation contract.)
  const [ssoError, setSsoError] = useState<string | null>(null);
  useEffect(() => {
    if (!ssoToken) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/auth/sso-exchange", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: ssoToken }),
        });
        if (cancelled) return;
        if (res.ok) {
          // Cookie is set server-side; redirect lands on a normal page render.
          router.replace(next);
        } else {
          const data = await res.json().catch(() => ({}));
          setSsoError(data?.error ?? "Portal sign-in failed. Try Outlook below.");
        }
      } catch {
        if (!cancelled) setSsoError("Portal sign-in failed. Try Outlook below.");
      }
    })();
    return () => { cancelled = true; };
  }, [ssoToken, next, router]);

  // Already signed in (or auto-restored via MSAL silent refresh)? Make sure
  // the session cookie is set before we redirect — otherwise middleware will
  // bounce us right back here, creating a loop. POST is idempotent, so it's
  // safe even if signIn() already set the cookie.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const token = await getIdToken();
        if (cancelled) return;
        if (token) {
          await fetch("/api/auth/session", {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
          });
        }
      } catch { /* fall through — try to redirect anyway */ }
      if (!cancelled) router.replace(next);
    })();
    return () => { cancelled = true; };
  }, [user, getIdToken, next, router]);

  // MLO portal handoff via shared Azure AD tenant: when we arrive with a
  // ?sso_hint=, ask MSAL to silently grab a token using the user's existing
  // login.microsoftonline.com session. If they're signed in to the portal,
  // this returns a token without a popup and the user-effect above redirects
  // them through. If MSAL needs interaction (no MS session, 3rd-party cookies
  // blocked, etc.) signInSilent returns null and we surface the button.
  useEffect(() => {
    if (!shouldAttemptSso || ssoToken || user) {
      setSilentAttempting(false);
      return;
    }
    let cancelled = false;
    (async () => {
      const result = await signInSilent(ssoHint);
      if (cancelled) return;
      if (!result) setSilentFailed(true);
      setSilentAttempting(false);
    })();
    return () => { cancelled = true; };
    // Intentionally run once on mount only — re-running on every searchParams
    // change would re-attempt silent SSO during the redirect window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSignIn() {
    setError(null);
    setSubmitting(true);
    try {
      await signIn();
      // The user-effect above will set the session cookie and redirect once
      // `user` state propagates from AuthContext.
    } catch {
      setError("Sign-in failed. Make sure pop-ups are allowed for this site, then try again.");
    } finally {
      setSubmitting(false);
    }
  }

  // Show the spinner only while something is actually in flight: a real
  // sign-in attempt, the legacy ?sso_token= exchange, the portal silent SSO,
  // or the redirect-after-success window. Direct visits show the button
  // immediately because shouldAttemptSso is false → silentAttempting is false.
  const showSpinner = silentAttempting || !!user || submitting || loading || !!ssoToken;

  return (
    <main className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 to-slate-100 px-4">
      <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-semibold text-gray-900">GMCC Property Search</h1>
          <p className="mt-2 text-sm text-gray-600">
            {showSpinner ? "Signing you in…" : "Sign in with your GMCC Outlook account to continue."}
          </p>
        </div>

        {showSpinner ? (
          <div className="flex items-center justify-center py-3">
            <LoadingSpinner size="md" />
          </div>
        ) : (
          <button
            onClick={handleSignIn}
            className="flex w-full items-center justify-center gap-3 rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-sm font-medium text-gray-800 transition hover:bg-gray-50 hover:border-gray-400"
          >
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="0" y="0" width="7.5" height="7.5" fill="#F25022"/>
              <rect x="8.5" y="0" width="7.5" height="7.5" fill="#7FBA00"/>
              <rect x="0" y="8.5" width="7.5" height="7.5" fill="#00A4EF"/>
              <rect x="8.5" y="8.5" width="7.5" height="7.5" fill="#FFB900"/>
            </svg>
            <span>Sign in with Outlook</span>
          </button>
        )}

        {silentFailed && !user && !submitting && (
          <p className="mt-3 text-center text-xs text-amber-700">
            Couldn&apos;t auto-sign you in from the portal — sign in with Outlook to continue.
          </p>
        )}
        {error && (
          <p className="mt-4 text-center text-sm text-red-600">{error}</p>
        )}
        {ssoError && (
          <p className="mt-3 text-center text-sm text-amber-700">{ssoError}</p>
        )}

        <p className="mt-6 text-center text-xs text-gray-500">
          Access is restricted to GMCC loan officers. Contact your admin if you need access.
        </p>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={
      <main className="min-h-screen flex items-center justify-center bg-slate-50">
        <LoadingSpinner size="md" />
      </main>
    }>
      <LoginInner />
    </Suspense>
  );
}

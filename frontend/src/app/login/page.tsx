"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import LoadingSpinner from "@/components/LoadingSpinner";

// Only allow `next` paths that point back into our own app — prevents
// open-redirect to `/login?next=https://evil.example.com`.
function sanitizeNext(next: string | null): string {
  if (!next) return "/";
  if (!next.startsWith("/") || next.startsWith("//")) return "/";
  return next;
}

function LoginInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, signIn, signInSilent, getIdToken, loading } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // True while we're attempting Microsoft silent SSO on first mount. We
  // hide the sign-in button during this window so users who came from the
  // MLO portal don't see a flash of "Sign in with Outlook" before the
  // auto-redirect kicks in.
  const [silentAttempting, setSilentAttempting] = useState(true);

  const next = sanitizeNext(searchParams.get("next"));
  const ssoToken = searchParams.get("sso_token");
  // Optional hint the MLO portal can pass to make ssoSilent more reliable
  // when the user has multiple Microsoft accounts in the browser.
  const ssoHint = searchParams.get("sso_hint") ?? undefined;

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

  // MLO portal handoff via shared Azure AD tenant: on first mount, ask MSAL
  // to silently grab a token using the user's Microsoft session cookie. If
  // they're already signed in to the MLO portal (same tenant), this returns
  // a token without a popup and the user-effect above redirects them straight
  // through. If interaction is required (no MS session, third-party cookies
  // blocked, etc.) we fall back to showing the Sign-in button.
  useEffect(() => {
    // Skip silent attempt if we're handling the legacy ?sso_token= path,
    // or if the user is already signed in from a prior session.
    if (ssoToken || user) {
      setSilentAttempting(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        await signInSilent(ssoHint);
      } finally {
        if (!cancelled) setSilentAttempting(false);
      }
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

  // While silent SSO is in flight OR we have a user (about to redirect),
  // show only a spinner — no point flashing the button.
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

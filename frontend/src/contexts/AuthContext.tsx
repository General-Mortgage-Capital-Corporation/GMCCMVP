"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { exchangeMsalForFirebase, type FirebaseUser } from "@/lib/firebase-auth";
import { msalConfig, loginRequest, msalErrorCode } from "@/lib/msal-config";
import { trackEvent } from "@/lib/posthog";
import { registerAuthTokenGetter } from "@/lib/auth-token";

interface AuthContextValue {
  user: FirebaseUser | null;
  loading: boolean;
  signIn: () => Promise<FirebaseUser>;
  /**
   * Try to sign in WITHOUT a popup. Tries the cached MSAL account first
   * (acquireTokenSilent), then — when a loginHint is provided — Microsoft's
   * session cookie via ssoSilent. Used by /login on first mount so users
   * coming from the MLO portal (same Azure tenant) and returning users with
   * a local MSAL cache don't have to click "Sign in" again.
   * Returns null if interaction is required (no MS session, blocked iframe,
   * etc.) — caller should fall back to the regular sign-in button.
   */
  signInSilent: (loginHint?: string) => Promise<FirebaseUser | null>;
  signOut: () => void;
  /** Returns a valid (non-expired) Firebase ID token, refreshing silently if needed. */
  getIdToken: () => Promise<string | null>;
  /** Returns an MSAL access token for the given Graph scopes (e.g. ["Mail.Send"]). */
  getMsalAccessToken: (scopes: string[]) => Promise<string | null>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const STORAGE_KEY = "gmcc_auth_user";
// 5-minute buffer before expiry to trigger refresh early
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/**
 * Zombie-cookie cleanup. The gmcc_session cookie has a long fixed lifetime
 * (independent of the underlying MSAL/Firebase session), so it can outlive
 * a real sign-in. When we can't restore a real user, clear the cookie and
 * bounce to /login — without this the middleware lets the user through to
 * a signed-out dashboard where every API call 401s.
 *
 * Skips the bounce if we're already on /login (to avoid loops) or if the
 * URL carries sso_hint (let the login page run silent SSO instead).
 */
function clearSessionAndBounce(): void {
  if (typeof window === "undefined") return;
  // /login handles its own auth flow (silent SSO, button, sso_token exchange).
  // Don't race it with a DELETE — signIn()'s POST might land first and we'd
  // wipe the cookie immediately after it gets set.
  if (window.location.pathname === "/login") return;
  fetch("/api/auth/session", { method: "DELETE" }).catch(() => {});
  const next = window.location.pathname + window.location.search;
  window.location.replace(`/login?next=${encodeURIComponent(next)}`);
}

// Lazily created MSAL instance (browser-only)
let _msalInstance: import("@azure/msal-browser").PublicClientApplication | null = null;

async function getMsal() {
  if (!_msalInstance) {
    const { PublicClientApplication } = await import("@azure/msal-browser");
    _msalInstance = new PublicClientApplication(msalConfig);
    await _msalInstance.initialize();
  }
  return _msalInstance;
}

/**
 * Pick the cached MSAL account matching the given email, falling back to the
 * first cached account. Users signed in to several Microsoft accounts can
 * have multiple entries cached — blindly using accounts[0] silently renews
 * tokens for the wrong one.
 */
function pickAccount(
  accounts: import("@azure/msal-browser").AccountInfo[],
  email?: string | null,
): import("@azure/msal-browser").AccountInfo {
  if (email) {
    const match = accounts.find(
      (a) => a.username?.toLowerCase() === email.toLowerCase(),
    );
    if (match) return match;
  }
  return accounts[0];
}

// Single-flight guard for the MSAL-refresh → Firebase-exchange chain. When a
// page loads with an expired token, every on-mount API call hits getIdToken
// at once; without this they each ran their own refresh — a dozen parallel
// exchangeMsalToken calls for one user. The Cloud Function then races
// setCustomUserClaims against itself and Firebase's per-account write limit
// (~1/sec) rejects the losers with auth/quota-exceeded ("Operation too
// fast"), randomly failing sign-ins. Concurrent callers now share one
// in-flight refresh.
let _refreshInFlight: Promise<FirebaseUser> | null = null;

function refreshFirebaseUser(email?: string | null): Promise<FirebaseUser> {
  if (!_refreshInFlight) {
    _refreshInFlight = (async () => {
      const msal = await getMsal();
      const accounts = msal.getAllAccounts();
      if (accounts.length === 0) throw new Error("No cached MSAL account");
      const tokenResponse = await msal.acquireTokenSilent({
        ...loginRequest,
        account: pickAccount(accounts, email),
      });
      return await exchangeMsalForFirebase(tokenResponse.accessToken);
    })().finally(() => {
      _refreshInFlight = null;
    });
  }
  return _refreshInFlight;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [loading, setLoading] = useState(false);
  // Becomes true after the synchronous localStorage check completes. We
  // delay rendering children until then so on-mount API calls (rate-sheets,
  // program-locations, etc.) see a populated `user` and attach the auth
  // header. Without this, child useEffects fire before AuthProvider's
  // restoration runs and 401 against the gated APIs.
  const [initialized, setInitialized] = useState(false);

  // Restore cached session on mount — silently refresh if expired
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as FirebaseUser;
        if (parsed.expiresAt > Date.now() + EXPIRY_BUFFER_MS) {
          // Token still valid
          setUser(parsed);
        } else {
          // Token expired — kick off silent refresh in background (don't
          // block render on it; MSAL silent refresh can take 500-2000ms).
          getMsal().then(async (msal) => {
            const accounts = msal.getAllAccounts();
            if (accounts.length === 0) {
              localStorage.removeItem(STORAGE_KEY);
              clearSessionAndBounce();
              return;
            }
            try {
              const refreshed = await refreshFirebaseUser(parsed.email);
              setUser(refreshed);
              localStorage.setItem(STORAGE_KEY, JSON.stringify(refreshed));
            } catch {
              // Silent refresh failed — clear the zombie cookie and bounce.
              localStorage.removeItem(STORAGE_KEY);
              clearSessionAndBounce();
            }
          }).catch(() => {
            localStorage.removeItem(STORAGE_KEY);
            clearSessionAndBounce();
          });
        }
      } else {
        // No localStorage entry but middleware let us through — that means
        // the cookie outlived the real session. Clear it and bounce.
        clearSessionAndBounce();
      }
    } catch {
      // Parse failure — treat as no session.
      clearSessionAndBounce();
    } finally {
      setInitialized(true);
    }
  }, []);

  const signIn = useCallback(async (): Promise<FirebaseUser> => {
    setLoading(true);
    try {
      const msal = await getMsal();
      // Go STRAIGHT to the popup — no acquireTokenSilent here. A silent
      // attempt between the click and window.open can take seconds (token
      // redemption, hidden-iframe renewal), which consumes the browser's
      // transient user activation (~5s in Chrome, stricter in Safari); the
      // fallback popup then gets blocked even when pop-ups are allowed.
      // Silent restoration happens on /login mount via signInSilent instead,
      // so by the time anyone clicks this, silent has already been tried.
      const tokenResponse = await msal.loginPopup(loginRequest);

      const firebaseUser = await exchangeMsalForFirebase(tokenResponse.accessToken);
      setUser(firebaseUser);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(firebaseUser));
      // Set the session cookie that middleware checks. 30-day fixed window —
      // after that, the user is bounced to /login (where silent MSAL refresh
      // will usually re-set the cookie automatically).
      await fetch("/api/auth/session", {
        method: "POST",
        headers: { Authorization: `Bearer ${firebaseUser.idToken}` },
      }).catch(() => { /* non-fatal — login page will retry */ });
      trackEvent("user_signed_in", { email: firebaseUser.email, name: firebaseUser.displayName });
      return firebaseUser;
    } catch (err) {
      console.error("Sign-in failed:", err);
      // Surface real failure causes in PostHog — before this, every failure
      // (popup blocked, Firebase exchange 4xx/5xx, network) looked identical
      // from the outside and got blamed on pop-up blockers.
      trackEvent("sign_in_failed", {
        code: msalErrorCode(err),
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const signInSilent = useCallback(async (loginHint?: string): Promise<FirebaseUser | null> => {
    try {
      const msal = await getMsal();

      // 1) Cached MSAL account (returning user on this browser): renew via
      //    acquireTokenSilent + exchange (single-flighted). Cheap when the
      //    cache is warm; falls back to a hidden iframe against /blank.html
      //    when the SPA refresh token has expired (Azure caps those at 24h).
      let firebaseUser: FirebaseUser | null = null;
      const accounts = msal.getAllAccounts();
      if (accounts.length > 0) {
        firebaseUser = await refreshFirebaseUser(loginHint).catch(() => null);
      }

      // 2) MLO-portal handoff: ssoSilent uses an iframe to the Microsoft
      //    authorize endpoint — works when the browser has a valid
      //    login.microsoftonline.com session cookie (which it will if the
      //    user is signed in to any other app on the same Azure tenant,
      //    e.g. the MLO portal). Fails fast with
      //    InteractionRequiredAuthError if not — caller falls back to popup.
      //    Only attempted with a loginHint so direct visits stay fast.
      //    (The /blank.html redirect URI now comes from msalConfig — the
      //    site root is middleware-gated + X-Frame-Options: DENY, which
      //    would stall MSAL's iframe until monitor_window_timeout.)
      if (!firebaseUser && loginHint) {
        const tokenResponse = await msal.ssoSilent({ ...loginRequest, loginHint });
        firebaseUser = await exchangeMsalForFirebase(tokenResponse.accessToken);
      }
      if (!firebaseUser) return null;
      setUser(firebaseUser);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(firebaseUser));
      await fetch("/api/auth/session", {
        method: "POST",
        headers: { Authorization: `Bearer ${firebaseUser.idToken}` },
      }).catch(() => { /* non-fatal — login page will retry */ });
      trackEvent("user_signed_in", {
        email: firebaseUser.email,
        name: firebaseUser.displayName,
        method: "ssoSilent",
      });
      return firebaseUser;
    } catch (err) {
      // Log so we can diagnose silent-SSO failures from the browser console.
      // Common causes: InteractionRequiredAuthError (no MS session / 3rd-party
      // cookies blocked), wrong client ID, user not assigned to the app, etc.
      console.warn("[auth] ssoSilent failed:", err);
      return null;
    }
  }, []);

  const signOut = useCallback(() => {
    setUser(null);
    localStorage.removeItem(STORAGE_KEY);
    // Clear the middleware-gate cookie so the next navigation lands on /login.
    fetch("/api/auth/session", { method: "DELETE" }).catch(() => {});
    // Clear local MSAL cache only — do NOT call logoutPopup/logoutRedirect.
    // Those endpoints hit login.microsoftonline.com/logout and sign the user
    // out of Microsoft *globally* (Outlook, Teams, MLO portal, everything).
    // We only want to sign out of this app. Killing the global MS session
    // also breaks the MLO-portal handoff afterwards: ssoSilent fails with
    // AADSTS50058 because no AAD session exists for the iframe to attach
    // to — especially under Chrome's third-party cookie restrictions.
    getMsal().then((msal) => {
      msal.clearCache().catch(() => {});
    }).catch(() => {});
  }, []);

  const getMsalAccessToken = useCallback(async (scopes: string[]): Promise<string | null> => {
    try {
      const msal = await getMsal();
      const accounts = msal.getAllAccounts();
      if (accounts.length === 0) return null;
      try {
        const result = await msal.acquireTokenSilent({ scopes, account: accounts[0] });
        return result.accessToken;
      } catch {
        // New scope not yet consented — fall back to popup
        const result = await msal.acquireTokenPopup({ scopes });
        return result.accessToken;
      }
    } catch {
      return null;
    }
  }, []);

  const getIdToken = useCallback(async (): Promise<string | null> => {
    if (!user) return null;
    if (user.expiresAt > Date.now() + EXPIRY_BUFFER_MS) return user.idToken;

    // Token near/past expiry — refresh silently via MSAL. Single-flighted:
    // concurrent getIdToken callers (every API call on a page load) await
    // the same refresh instead of each running their own.
    try {
      const refreshed = await refreshFirebaseUser(user.email);
      setUser(refreshed);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(refreshed));
      return refreshed.idToken;
    } catch {
      setUser(null);
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
  }, [user]);

  // Expose getIdToken to non-React modules (api.ts, authedFetch, etc.) so
  // they can attach Authorization headers without prop-drilling the token.
  useEffect(() => {
    registerAuthTokenGetter(getIdToken);
  }, [getIdToken]);

  // Block render until localStorage has been checked. Server renders null
  // (matches the initial client render — no hydration mismatch). The whole
  // app pauses for one paint frame on cold start; trivial cost for not
  // racing API calls against auth restoration.
  if (!initialized) return null;

  return (
    <AuthContext.Provider value={{ user, loading, signIn, signInSilent, signOut, getIdToken, getMsalAccessToken }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

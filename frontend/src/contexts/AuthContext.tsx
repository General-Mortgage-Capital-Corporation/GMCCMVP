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
import { msalConfig, loginRequest } from "@/lib/msal-config";
import { trackEvent } from "@/lib/posthog";
import { registerAuthTokenGetter } from "@/lib/auth-token";

interface AuthContextValue {
  user: FirebaseUser | null;
  loading: boolean;
  signIn: () => Promise<FirebaseUser>;
  /**
   * Try to sign in WITHOUT a popup using Microsoft's session cookie via
   * MSAL ssoSilent. Used by /login on first mount so users coming from the
   * MLO portal (same Azure tenant) don't have to click "Sign in" again.
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
              return;
            }
            try {
              const tokenResponse = await msal.acquireTokenSilent({
                ...loginRequest,
                account: accounts[0],
              });
              const refreshed = await exchangeMsalForFirebase(tokenResponse.accessToken);
              setUser(refreshed);
              localStorage.setItem(STORAGE_KEY, JSON.stringify(refreshed));
            } catch {
              // Silent refresh failed — user will need to sign in manually
              localStorage.removeItem(STORAGE_KEY);
            }
          }).catch(() => {
            localStorage.removeItem(STORAGE_KEY);
          });
        }
      }
    } catch {
      // ignore parse errors
    } finally {
      setInitialized(true);
    }
  }, []);

  const signIn = useCallback(async (): Promise<FirebaseUser> => {
    setLoading(true);
    try {
      const msal = await getMsal();
      const accounts = msal.getAllAccounts();

      let tokenResponse;
      if (accounts.length > 0) {
        // Try silent first
        tokenResponse = await msal
          .acquireTokenSilent({ ...loginRequest, account: accounts[0] })
          .catch(() => msal.loginPopup(loginRequest));
      } else {
        tokenResponse = await msal.loginPopup(loginRequest);
      }

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
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const signInSilent = useCallback(async (loginHint?: string): Promise<FirebaseUser | null> => {
    try {
      const msal = await getMsal();
      // ssoSilent uses an iframe to the Microsoft authorize endpoint — works
      // when the browser has a valid login.microsoftonline.com session cookie
      // (which it will if the user is signed in to any other app on the
      // same Azure tenant, e.g. the MLO portal). Fails fast with
      // InteractionRequiredAuthError if not — caller falls back to popup.
      const tokenResponse = await msal.ssoSilent({
        ...loginRequest,
        ...(loginHint ? { loginHint } : {}),
      });
      const firebaseUser = await exchangeMsalForFirebase(tokenResponse.accessToken);
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
    getMsal().then((msal) => {
      const accounts = msal.getAllAccounts();
      if (accounts.length > 0) {
        msal.logoutPopup({ account: accounts[0] }).catch(() => {});
      }
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

    // Token near/past expiry — refresh silently via MSAL
    try {
      const msal = await getMsal();
      const accounts = msal.getAllAccounts();
      if (accounts.length === 0) { setUser(null); return null; }
      const tokenResponse = await msal.acquireTokenSilent({
        ...loginRequest,
        account: accounts[0],
      });
      const refreshed = await exchangeMsalForFirebase(tokenResponse.accessToken);
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

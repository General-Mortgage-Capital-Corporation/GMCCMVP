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

interface AuthContextValue {
  user: FirebaseUser | null;
  loading: boolean;
  signIn: () => Promise<void>;
  signOut: () => void;
  /** Returns a valid (non-expired) Firebase ID token, refreshing silently if needed. */
  getIdToken: () => Promise<string | null>;
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

  // Restore cached session on mount
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as FirebaseUser;
        if (parsed.expiresAt > Date.now() + EXPIRY_BUFFER_MS) {
          setUser(parsed);
        } else {
          sessionStorage.removeItem(STORAGE_KEY);
        }
      }
    } catch {
      // ignore parse errors
    }
  }, []);

  const signIn = useCallback(async () => {
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
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(firebaseUser));
    } catch (err) {
      console.error("Sign-in failed:", err);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const signOut = useCallback(() => {
    setUser(null);
    sessionStorage.removeItem(STORAGE_KEY);
    getMsal().then((msal) => {
      const accounts = msal.getAllAccounts();
      if (accounts.length > 0) {
        msal.logoutPopup({ account: accounts[0] }).catch(() => {});
      }
    }).catch(() => {});
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
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(refreshed));
      return refreshed.idToken;
    } catch {
      setUser(null);
      sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
  }, [user]);

  return (
    <AuthContext.Provider value={{ user, loading, signIn, signOut, getIdToken }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

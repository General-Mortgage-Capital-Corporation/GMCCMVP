/**
 * Firebase Admin SDK — server-side only.
 * Used for Firestore access in API routes (email tracking, follow-ups).
 *
 * Requires env vars:
 *   FIREBASE_PROJECT_ID
 *   FIREBASE_CLIENT_EMAIL
 *   FIREBASE_PRIVATE_KEY (with literal \n — will be converted)
 */

import { initializeApp, cert, getApps, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { getAuth, type Auth } from "firebase-admin/auth";

let _app: App | null = null;

function getApp(): App | null {
  if (_app) return _app;
  if (getApps().length > 0) {
    _app = getApps()[0];
    return _app;
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const rawKey = process.env.FIREBASE_PRIVATE_KEY ?? "";
  // Handle both: literal \n in env and extra wrapping quotes
  const privateKey = rawKey.replace(/^["']|["']$/g, "").replace(/\\n/g, "\n") || undefined;

  if (!projectId || !clientEmail || !privateKey) {
    return null;
  }

  _app = initializeApp({
    credential: cert({ projectId, clientEmail, privateKey }),
  });
  return _app;
}

export function getDb(): Firestore | null {
  const app = getApp();
  return app ? getFirestore(app) : null;
}

export function getAdminAuth(): Auth | null {
  const app = getApp();
  return app ? getAuth(app) : null;
}

/** Verify a Firebase ID token and return the uid. Returns null on failure. */
export async function verifyIdToken(idToken: string): Promise<string | null> {
  const auth = getAdminAuth();
  if (!auth) return null;
  try {
    const decoded = await auth.verifyIdToken(idToken);
    return decoded.uid;
  } catch {
    return null;
  }
}

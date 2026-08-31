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

/**
 * Who a verified token belongs to.
 *
 * Two kinds of principal exist in this Auth project:
 *   - "mlo": company users minted through exchangeMsalToken. Their tokens
 *     carry sign_in_provider "custom" — nothing else can produce that.
 *   - "partner": email/password accounts the MLO portal provisions for an
 *     LO's realtor/CPA partners, stamped with custom claims
 *     { role: "partner", mloEmail, partnerId }.
 *
 * A password user WITHOUT the partner claims is neither (e.g. a
 * hypothetical self-signup against the public API key) and is rejected —
 * before roles existed, any Firebase user with an email passed these
 * checks.
 */
export type CallerRole = "mlo" | "partner";
export type VerifiedCaller = {
  uid: string;
  email: string;
  role: CallerRole;
  /** The LO who owns this partner account. Null for MLOs. */
  mloEmail: string | null;
  /** Id of the partner record on the LO's list. Null for MLOs. */
  partnerId: string | null;
};

/** Verify a Firebase ID token and return the uid. MLO tokens only. */
export async function verifyIdToken(idToken: string): Promise<string | null> {
  const auth = getAdminAuth();
  if (!auth) return null;
  try {
    const decoded = await auth.verifyIdToken(idToken);
    if (decoded.firebase?.sign_in_provider !== "custom") return null;
    return decoded.uid;
  } catch {
    return null;
  }
}

/**
 * Verify a Firebase ID token and classify the caller.
 *
 * Partners are DENIED unless the route opts in with `allowPartner` — the
 * partner surface is a small allowlist (address checks, radius search,
 * flyers) and every other route is LO-only by default.
 */
export async function verifyIdTokenWithEmail(
  idToken: string,
  opts?: { allowPartner?: boolean },
): Promise<VerifiedCaller | null> {
  const auth = getAdminAuth();
  if (!auth) return null;
  try {
    const decoded = await auth.verifyIdToken(idToken);
    if (!decoded.email) return null;
    const email = decoded.email.toLowerCase();

    if (decoded.firebase?.sign_in_provider === "custom") {
      return { uid: decoded.uid, email, role: "mlo", mloEmail: null, partnerId: null };
    }

    if (
      decoded.role === "partner" &&
      typeof decoded.mloEmail === "string" &&
      decoded.mloEmail
    ) {
      if (!opts?.allowPartner) return null;
      return {
        uid: decoded.uid,
        email,
        role: "partner",
        mloEmail: decoded.mloEmail.toLowerCase(),
        partnerId: typeof decoded.partnerId === "string" ? decoded.partnerId : null,
      };
    }

    // Authenticated but neither kind of principal we trust.
    return null;
  } catch {
    return null;
  }
}

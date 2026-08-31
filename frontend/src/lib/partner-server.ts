/**
 * Server-side helpers for partner sessions.
 *
 * A partner is a realtor/CPA the MLO portal provisioned with a limited
 * login (see lib/firestore-admin.ts VerifiedCaller). Their record lives on
 * the owning LO's user doc: users/{mloEmail}.realtorPartners[] — an array
 * field written by the portal; this app only reads it.
 *
 * fillPdfFlier authorizes strictly: `loanOfficer.userId` must equal the
 * authenticated email. A partner token can therefore never render a flyer
 * carrying the LO panel — so for partner calls we mint a short-lived ID
 * token FOR THE OWNING LO server-side (custom token → REST exchange, the
 * same pattern the portal's CRM flyer route uses) after verifying the
 * partner's own token. The minted token never leaves the server.
 */

import { getAdminAuth, getDb } from "@/lib/firestore-admin";

const FIREBASE_API_KEY = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;

export type PartnerRecord = {
  id: string;
  name: string;
  email: string;
  phone: string;
  title: string;
  license: string;
  imageUrl: string | null;
};

export type PartnerContext = {
  partner: PartnerRecord;
  mlo: { email: string; name: string };
};

/**
 * Load the partner's record off the owning LO's user doc, plus enough LO
 * identity for co-branding. Null when the record no longer exists (partner
 * deleted after the token was minted) — callers should treat that as 403.
 */
export async function getPartnerContext(
  mloEmail: string,
  partnerId: string | null,
): Promise<PartnerContext | null> {
  if (!partnerId) return null;
  const db = getDb();
  if (!db) return null;
  const snap = await db.collection("users").doc(mloEmail).get();
  if (!snap.exists) return null;
  const data = snap.data() as {
    realtorPartners?: unknown;
    name?: string;
    displayName?: string;
  };
  if (!Array.isArray(data.realtorPartners)) return null;
  const raw = (data.realtorPartners as Record<string, unknown>[]).find(
    (p) => p.id === partnerId,
  );
  if (!raw) return null;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    partner: {
      id: partnerId,
      name: str(raw.name),
      email: str(raw.email),
      phone: str(raw.phone),
      title: str(raw.title),
      license: str(raw.license),
      imageUrl: str(raw.imageUrl) || null,
    },
    mlo: { email: mloEmail, name: str(data.name) || str(data.displayName) || mloEmail },
  };
}

/**
 * Mint a Firebase ID token for the given email. Server-only, short-lived
 * (1h), used solely to call fillPdfFlier on the LO's behalf.
 */
export async function mintIdTokenForEmail(email: string): Promise<string> {
  const auth = getAdminAuth();
  if (!auth) throw new Error("Firebase Admin not configured");
  if (!FIREBASE_API_KEY) throw new Error("Missing NEXT_PUBLIC_FIREBASE_API_KEY");

  const user = await auth.getUserByEmail(email);
  const customToken = await auth.createCustomToken(user.uid);
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${FIREBASE_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!res.ok) throw new Error(`Custom-token exchange failed (${res.status})`);
  const data = (await res.json()) as { idToken: string };
  return data.idToken;
}

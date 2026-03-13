const CLOUD_FUNCTIONS_BASE = "https://us-central1-gmcc-66e1e.cloudfunctions.net";
const FIREBASE_API_KEY = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;

export interface FirebaseUser {
  idToken: string;
  email: string;
  displayName: string;
  expiresAt: number; // Unix ms
}

/** Exchange an MSAL access token for a Firebase ID token (two-step). */
export async function exchangeMsalForFirebase(msalAccessToken: string): Promise<FirebaseUser> {
  // Step 1: MSAL token → Firebase custom token
  const exchangeRes = await fetch(`${CLOUD_FUNCTIONS_BASE}/exchangeMsalToken`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ msalAccessToken }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!exchangeRes.ok) {
    const err = await exchangeRes.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error ?? "Company account authentication failed");
  }
  const { firebaseToken, email, displayName } = await exchangeRes.json() as {
    firebaseToken: string;
    email: string;
    displayName: string;
  };

  // Step 2: Firebase custom token → ID token (REST, no SDK needed)
  const signInRes = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${FIREBASE_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: firebaseToken, returnSecureToken: true }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!signInRes.ok) {
    throw new Error("Firebase sign-in failed");
  }
  const { idToken, expiresIn } = await signInRes.json() as {
    idToken: string;
    expiresIn: string;
  };

  return {
    idToken,
    email,
    displayName: displayName || email,
    expiresAt: Date.now() + parseInt(expiresIn, 10) * 1000,
  };
}

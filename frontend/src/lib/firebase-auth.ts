const CLOUD_FUNCTIONS_BASE = process.env.NEXT_PUBLIC_CLOUD_FUNCTIONS_URL ?? "https://us-central1-gmcc-66e1e.cloudfunctions.net";
const FIREBASE_API_KEY = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;

export interface FirebaseUser {
  idToken: string;
  email: string;
  displayName: string;
  expiresAt: number; // Unix ms
  /** "partner" for provisioned partner logins; absent for company (MSAL) users. */
  role?: "partner";
  /** The LO who owns this partner account (partner sessions only). */
  mloEmail?: string;
  /** Id of the partner record on that LO's list (partner sessions only). */
  partnerId?: string;
  /** Firebase refresh token — partner sessions renew with this instead of MSAL. */
  refreshToken?: string;
}

/** Decode a JWT payload without verifying — fine client-side, the server
 *  re-verifies every request. Used to read the partner custom claims. */
function decodeTokenClaims(idToken: string): Record<string, unknown> {
  try {
    const payload = idToken.split(".")[1];
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function partnerFieldsFromToken(idToken: string): Pick<FirebaseUser, "role" | "mloEmail" | "partnerId"> {
  const claims = decodeTokenClaims(idToken);
  if (claims.role !== "partner" || typeof claims.mloEmail !== "string") {
    // Password sign-in without partner claims: nothing on this site is
    // authorized for such an account, so fail at the door with a clear
    // message instead of letting every API call 401.
    throw new Error("This account isn't set up for partner access. Ask your loan officer to re-send your invite.");
  }
  return {
    role: "partner",
    mloEmail: claims.mloEmail.toLowerCase(),
    partnerId: typeof claims.partnerId === "string" ? claims.partnerId : undefined,
  };
}

/** Sign in a provisioned partner account with email + password. */
export async function signInPartnerWithPassword(
  email: string,
  password: string,
): Promise<FirebaseUser> {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    const code = err.error?.message ?? "";
    if (code.includes("USER_DISABLED")) {
      throw new Error("This account has been disabled. Contact your loan officer.");
    }
    if (
      code.includes("INVALID_LOGIN_CREDENTIALS") ||
      code.includes("INVALID_PASSWORD") ||
      code.includes("EMAIL_NOT_FOUND")
    ) {
      throw new Error("Incorrect email or password.");
    }
    if (code.includes("TOO_MANY_ATTEMPTS")) {
      throw new Error("Too many attempts — wait a few minutes and try again.");
    }
    throw new Error("Sign-in failed. Please try again.");
  }
  const data = (await res.json()) as {
    idToken: string;
    refreshToken: string;
    expiresIn: string;
    email: string;
    displayName?: string;
  };
  return {
    idToken: data.idToken,
    email: data.email.toLowerCase(),
    displayName: data.displayName || data.email,
    expiresAt: Date.now() + parseInt(data.expiresIn, 10) * 1000,
    refreshToken: data.refreshToken,
    ...partnerFieldsFromToken(data.idToken),
  };
}

/** Renew a partner session from its Firebase refresh token. */
export async function refreshPartnerSession(user: FirebaseUser): Promise<FirebaseUser> {
  if (!user.refreshToken) throw new Error("No refresh token");
  const res = await fetch(
    `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: user.refreshToken,
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  // A disabled/deleted account fails here — callers treat it as signed out.
  if (!res.ok) throw new Error("Partner session refresh failed");
  const data = (await res.json()) as {
    id_token: string;
    refresh_token: string;
    expires_in: string;
  };
  return {
    ...user,
    idToken: data.id_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + parseInt(data.expires_in, 10) * 1000,
    ...partnerFieldsFromToken(data.id_token),
  };
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

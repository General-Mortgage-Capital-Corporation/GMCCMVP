import type { Configuration } from "@azure/msal-browser";

// NOTE: The redirect URI must be registered in Azure AD as a
// Single-page application redirect URI. Add both:
//   https://gmccmvp-two.vercel.app/blank.html
//   http://localhost:3000/blank.html
//
// /blank.html (not the site root) because MSAL loads the redirect URI inside
// its hidden iframe (silent renewal) and its popup to read the auth response
// from the URL hash. The site root is gated by middleware (302 → /login) and
// served with X-Frame-Options: DENY, which blanks the iframe and makes MSAL
// hang until monitor_window_timeout (~6-10s) — after which a fallback
// loginPopup sits outside the browser's user-activation window and gets
// blocked even when pop-ups are allowed. /blank.html is static, excluded
// from middleware, and served with X-Frame-Options: SAMEORIGIN (vercel.json).

export const msalConfig: Configuration = {
  auth: {
    clientId: process.env.NEXT_PUBLIC_AZURE_CLIENT_ID!,
    authority: `https://login.microsoftonline.com/${process.env.NEXT_PUBLIC_AZURE_TENANT_ID}`,
    redirectUri:
      typeof window !== "undefined"
        ? `${window.location.origin}/blank.html`
        : "http://localhost:3000/blank.html",
  },
  cache: {
    cacheLocation: "localStorage",
    storeAuthStateInCookie: false,
  },
};

// Scopes needed to call Microsoft Graph /me (used by the Cloud Function to verify identity)
export const loginRequest = {
  scopes: ["User.Read"],
};

// Scopes needed to send email via Microsoft Graph
export const emailRequest = {
  scopes: ["Mail.Send"],
};

/** Stable error code from an MSAL BrowserAuthError/AuthError, or "" if none. */
export function msalErrorCode(err: unknown): string {
  return (err as { errorCode?: string })?.errorCode ?? "";
}

/**
 * Map a sign-in failure to a user-facing message. Only actual popup-window
 * failures get the "allow pop-ups" advice — every other error (token
 * exchange, network, cancelled window) shows its real cause so we stop
 * telling users with working pop-ups to enable pop-ups.
 */
export function signInErrorMessage(err: unknown): string {
  switch (msalErrorCode(err)) {
    case "popup_window_error":
    case "empty_window_error":
      return "The browser blocked the sign-in pop-up. Allow pop-ups for this site, then try again.";
    case "user_cancelled":
      return "The sign-in window was closed before finishing. Please try again.";
    case "interaction_in_progress":
      return "Another sign-in attempt is still in progress. Close other tabs of this site or reload the page, then try again.";
    default: {
      const message = err instanceof Error ? err.message : "";
      const detail = message.length > 160 ? `${message.slice(0, 157)}…` : message;
      return detail
        ? `Sign-in failed: ${detail}`
        : "Sign-in failed. Please try again or contact your admin.";
    }
  }
}

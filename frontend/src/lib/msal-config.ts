import type { Configuration } from "@azure/msal-browser";

// NOTE: The redirect URI must be registered in Azure AD as a
// Single-page application redirect URI. Add both:
//   https://gmccmvp-two.vercel.app
//   http://localhost:3000

export const msalConfig: Configuration = {
  auth: {
    clientId: process.env.NEXT_PUBLIC_AZURE_CLIENT_ID!,
    authority: `https://login.microsoftonline.com/${process.env.NEXT_PUBLIC_AZURE_TENANT_ID}`,
    redirectUri: typeof window !== "undefined" ? window.location.origin : "http://localhost:3000",
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

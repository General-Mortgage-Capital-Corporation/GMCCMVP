/**
 * fetch() drop-in that attaches `Authorization: Bearer <firebaseIdToken>`
 * when the user is signed in. Caller-supplied Authorization header wins
 * (so anything already explicit is preserved).
 */

import { getAuthToken } from "@/lib/auth-token";

export async function authedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (!headers.has("Authorization")) {
    const token = await getAuthToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
  }
  return fetch(input, { ...init, headers });
}

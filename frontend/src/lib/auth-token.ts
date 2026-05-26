/**
 * Module-level Firebase ID token getter. Lets non-React code (api.ts,
 * tts-engine.ts, etc.) attach `Authorization: Bearer <token>` to fetch
 * calls without having to thread the token through every callsite.
 *
 * AuthContext registers its `getIdToken` callback on mount via
 * `registerAuthTokenGetter`. Any caller can then `await getAuthToken()`
 * and get back either a valid (silently-refreshed) ID token or null.
 */

type TokenGetter = () => Promise<string | null>;

let _getter: TokenGetter | null = null;

export function registerAuthTokenGetter(getter: TokenGetter): void {
  _getter = getter;
}

export async function getAuthToken(): Promise<string | null> {
  if (!_getter) return null;
  try {
    return await _getter();
  } catch {
    return null;
  }
}

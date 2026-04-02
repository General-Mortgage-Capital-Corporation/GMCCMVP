/**
 * Returns the base URL for internal API calls.
 * On Vercel: uses VERCEL_URL (auto-provided).
 * Locally: falls back to localhost:3000.
 */
export function getBaseUrl(): string {
  if (process.env.NEXT_PUBLIC_BASE_URL) return process.env.NEXT_PUBLIC_BASE_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

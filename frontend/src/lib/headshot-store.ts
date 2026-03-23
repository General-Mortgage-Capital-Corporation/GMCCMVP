/**
 * localStorage persistence for LO headshot photo.
 * Stores a base64-encoded image that persists across sessions.
 */

const STORAGE_KEY = "gmcc_lo_headshot";

export function getHeadshot(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setHeadshot(dataUrl: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, dataUrl);
  } catch { /* quota exceeded */ }
}

export function clearHeadshot(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch { /* ignore */ }
}

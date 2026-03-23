/**
 * localStorage persistence for Loan Officer contact info.
 * Used on the Home Financing Options flyer.
 */

export interface LOInfo {
  name: string;
  nmls: string;
  phone: string;
  email: string;
  title: string;
}

const STORAGE_KEY = "gmcc_lo_info";

const EMPTY: LOInfo = { name: "", nmls: "", phone: "", email: "", title: "Mortgage Loan Officer" };

export function getLOInfo(): LOInfo {
  if (typeof window === "undefined") return EMPTY;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    return { ...EMPTY, ...JSON.parse(raw) };
  } catch {
    return EMPTY;
  }
}

export function setLOInfo(info: LOInfo): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(info));
  } catch { /* ignore */ }
}

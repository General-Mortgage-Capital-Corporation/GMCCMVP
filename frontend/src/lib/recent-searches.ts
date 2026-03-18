/**
 * Recent searches persistence layer using localStorage.
 * Stores at most 10 recent searches, deduplicated by county_fips+tab+city+program_name.
 */

const STORAGE_KEY = "gmcc_recent_searches";
const MAX_ENTRIES = 10;

export interface RecentSearch {
  county_fips: string;
  county_name: string;
  state: string;
  city?: string;
  timestamp: number;
  tab: "marketing" | "program" | "find";
  program_name?: string;
  /** Find tab: the address/zip query */
  query?: string;
  /** Find tab: search radius in miles */
  radius?: number;
}

function dedupeKey(s: RecentSearch): string {
  if (s.tab === "find") return `find|${s.query ?? ""}`;
  return `${s.county_fips}|${s.tab}|${s.city ?? ""}|${s.program_name ?? ""}`;
}

export function getRecentSearches(tab?: string): RecentSearch[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: RecentSearch[] = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const filtered = tab ? parsed.filter((s) => s.tab === tab) : parsed;
    return filtered.slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

export function saveRecentSearch(search: RecentSearch): void {
  try {
    const existing = getRecentSearches();
    const key = dedupeKey(search);
    const deduped = existing.filter((s) => dedupeKey(s) !== key);
    const updated = [search, ...deduped].slice(0, MAX_ENTRIES);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  } catch {
    // localStorage unavailable — silently ignore
  }
}

export function clearRecentSearches(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage unavailable — silently ignore
  }
}

/**
 * Returns a human-readable relative time string.
 */
export function relativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

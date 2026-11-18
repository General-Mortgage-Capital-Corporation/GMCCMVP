/**
 * Diamond Community Lending ("GMCC Celebrity CRA: $15k DPA") property
 * eligibility is checked on the investor's own map — Chase Homestory's
 * Community Lending Program search (replaced the old Collateral Analytics
 * correspondent search, 2026-11-12). The search page needs a city in the path,
 * so we open it on the property's city when we know it, and on San Jose
 * otherwise. clp_tier=1,2,3 shows every eligible tier.
 */
export const DIAMOND_ELIGIBILITY_DEFAULT_URL =
  "https://chase.homestory.co/clp/homestoryca/search-results/san_jose,ca?clp_tier=1,2,3&map_bounds=-122.01499311287945_37.40952721695075,-121.74178351799844_37.40952721695075,-121.74178351799844_37.278859609844815,-122.01499311287945_37.278859609844815,-122.01499311287945_37.40952721695075&bmsZip=95112&page=1";

export function diamondEligibilityUrl(city?: string | null, state?: string | null): string {
  const c = (city ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const s = (state ?? "").trim().toLowerCase();
  if (!c || !/^[a-z]{2}$/.test(s)) return DIAMOND_ELIGIBILITY_DEFAULT_URL;
  return `https://chase.homestory.co/clp/homestoryca/search-results/${c},${s}?clp_tier=1,2,3&page=1`;
}

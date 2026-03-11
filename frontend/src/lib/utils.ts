/**
 * Shared utility functions migrated from static/script.js.
 *
 * React handles XSS via JSX (no innerHTML), so escapeHtml is only needed
 * for the rare dangerouslySetInnerHTML cases (e.g. rendering markdown).
 */

import type { CensusData, RentCastListing } from "@/types";

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatPrice(price: number | null | undefined): string {
  if (price == null) return "Price N/A";
  return "$" + Number(price).toLocaleString();
}

export function formatDistance(distance: number | null | undefined): string {
  if (!distance || distance === 999) return "";
  return distance < 1
    ? `${(distance * 5280).toFixed(0)} ft away`
    : `${distance.toFixed(1)} mi away`;
}

export function formatNumber(n: number | null | undefined): string {
  if (n == null) return "N/A";
  return Number(n).toLocaleString();
}

export function formatCurrency(n: number | null | undefined): string {
  if (n == null) return "N/A";
  return "$" + Number(n).toLocaleString();
}

export function formatPct(n: number | null | undefined): string {
  if (n == null) return "N/A";
  return parseFloat(String(n)).toFixed(1) + "%";
}

export function formatPhone(phone: string | null | undefined): string {
  if (!phone) return "N/A";
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10)
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  return phone;
}

// ---------------------------------------------------------------------------
// Simple markdown → HTML (for Gemini explanations)
// ---------------------------------------------------------------------------

export function renderSimpleMarkdown(text: string): string {
  if (!text) return "";
  let escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  escaped = escaped.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

  const lines = escaped.split("\n");
  let html = "";
  let inList = false;
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      if (!inList) {
        html += "<ul>";
        inList = true;
      }
      html += "<li>" + trimmed.slice(2) + "</li>";
    } else {
      if (inList) {
        html += "</ul>";
        inList = false;
      }
      if (html.length > 0) html += "<br>";
      html += line;
    }
  }
  if (inList) html += "</ul>";
  return html;
}

// ---------------------------------------------------------------------------
// Chip filter logic (ported from script.js)
// ---------------------------------------------------------------------------

export type ChipFilter =
  | "mmct"
  | "lmi"
  | "aahp"
  | "under500k"
  | "500kto1m"
  | "1mto3m"
  | "over3m";

export function listingPassesChipFilters(
  listing: RentCastListing,
  filters: Set<ChipFilter>,
  mode: "and" | "or" = "and",
): boolean {
  if (filters.size === 0) return true;

  const census: CensusData = listing.censusData ?? {};
  const price = listing.price ?? 0;
  const incomeLevel = (census.tract_income_level ?? "").toLowerCase();
  const minorityPct = census.tract_minority_pct;

  const checks: Record<ChipFilter, () => boolean> = {
    mmct: () => minorityPct != null && minorityPct > 50,
    lmi: () => incomeLevel === "low" || incomeLevel === "moderate",
    aahp: () => {
      const black = census.black_population ?? 0;
      const hispanic = census.hispanic_population ?? 0;
      const total = census.total_population ?? 0;
      if (total === 0) return false;
      return (black + hispanic) / total > 0.5;
    },
    under500k: () => price > 0 && price < 500000,
    "500kto1m": () => price >= 500000 && price <= 1000000,
    "1mto3m": () => price > 1000000 && price <= 3000000,
    over3m: () => price > 3000000,
  };

  const activeChecks = [...filters].filter((f) => f in checks);
  if (activeChecks.length === 0) return true;

  return mode === "and"
    ? activeChecks.every((f) => checks[f]())
    : activeChecks.some((f) => checks[f]());
}

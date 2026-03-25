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

/** Formats a phone number as the user types, producing (xxx) xxx-xxxx. */
export function formatPhoneInput(raw: string): string {
  const d = raw.replace(/\D/g, "").slice(0, 10);
  if (d.length > 6) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length > 3) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return d;
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

  // Inline formatting
  escaped = escaped.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  escaped = escaped.replace(/\*(.+?)\*/g, "<em>$1</em>");

  const lines = escaped.split("\n");
  let html = "";
  let inList = false;
  let inOl = false;

  for (const line of lines) {
    const trimmed = line.trimStart();

    // Horizontal rule: --- or ***
    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      if (inList) { html += "</ul>"; inList = false; }
      if (inOl) { html += "</ol>"; inOl = false; }
      html += '<hr style="border:none;border-top:1px solid #e5e7eb;margin:0.75rem 0">';
      continue;
    }

    // Headers: # ## ### ####
    const headerMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (headerMatch) {
      if (inList) { html += "</ul>"; inList = false; }
      if (inOl) { html += "</ol>"; inOl = false; }
      const level = headerMatch[1].length;
      const style =
        level === 1 ? "font-size:1rem;font-weight:700;color:#111827;margin:1rem 0 0.5rem" :
        level === 2 ? "font-size:0.875rem;font-weight:700;color:#1f2937;margin:0.75rem 0 0.375rem" :
        "font-size:0.875rem;font-weight:600;color:#374151;margin:0.5rem 0 0.25rem";
      html += `<div style="${style}">${headerMatch[2]}</div>`;
      continue;
    }

    // Unordered list: - or *
    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      if (inOl) { html += "</ol>"; inOl = false; }
      if (!inList) { html += '<ul style="list-style:disc;padding-left:1.25rem;margin:0.375rem 0">'; inList = true; }
      html += "<li>" + trimmed.slice(2) + "</li>";
      continue;
    }

    // Ordered list: 1. 2. etc.
    const olMatch = trimmed.match(/^\d+\.\s+(.+)$/);
    if (olMatch) {
      if (inList) { html += "</ul>"; inList = false; }
      if (!inOl) { html += '<ol style="list-style:decimal;padding-left:1.25rem;margin:0.375rem 0">'; inOl = true; }
      html += "<li>" + olMatch[1] + "</li>";
      continue;
    }

    // Regular line
    if (inList) { html += "</ul>"; inList = false; }
    if (inOl) { html += "</ol>"; inOl = false; }

    // Empty lines become spacing
    if (!trimmed) {
      html += '<div style="height:0.5rem"></div>';
    } else {
      html += "<p>" + line + "</p>";
    }
  }
  if (inList) html += "</ul>";
  if (inOl) html += "</ol>";
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

/** Property types excluded from all search results */
export const EXCLUDED_PROPERTY_TYPES = new Set(["Land", "Manufactured"]);

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

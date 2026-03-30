"use client";

import { useState, useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { formatPrice, formatPhone } from "@/lib/utils";
import ScrollFadeWrapper from "@/components/shared/ScrollFadeWrapper";
import type { RentCastListing } from "@/types";

// ---------------------------------------------------------------------------
// Mobile detection hook using useSyncExternalStore for SSR safety
// ---------------------------------------------------------------------------
const MOBILE_QUERY = "(max-width: 768px)";

function subscribeMobile(cb: () => void) {
  const mql = window.matchMedia(MOBILE_QUERY);
  mql.addEventListener("change", cb);
  return () => mql.removeEventListener("change", cb);
}

function getSnapshotMobile() {
  return window.matchMedia(MOBILE_QUERY).matches;
}

function getServerSnapshotMobile() {
  return false; // assume desktop on server
}

function useIsMobile() {
  return useSyncExternalStore(subscribeMobile, getSnapshotMobile, getServerSnapshotMobile);
}

export type MkSortColumn =
  | "msa"
  | "price"
  | "address"
  | "programs"
  | "mmct"
  | "lmi"
  | "days"
  | "agentName"
  | "agentEmail"
  | "agentPhone"
  | "state"
  | "county"
  | "city"
  | "zip"
  | "type";

export type MkSortDir = "asc" | "desc";

interface MarketingTableProps {
  listings: RentCastListing[];
  sortColumn: MkSortColumn;
  sortDir: MkSortDir;
  onSort: (col: MkSortColumn) => void;
  onRowClick: (listing: RentCastListing) => void;
}

const PER_PAGE = 20;

const FLYER_URL = "https://mlo.joingmcc.com/marketing/flyers";
const DIAMOND_DISCLAIMER =
  "IMPORTANT: GMCC Diamond CRA eligibility shown is preliminary. Census tract and property eligibility must be verified. Verify at: https://hub.collateralanalytics.com/correspondentsearch";

function escCsv(val: string): string {
  if (val.includes(",") || val.includes('"') || val.includes("\n")) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

function buildCsv(listings: RentCastListing[]): string {
  const headers = [
    "Address",
    "City",
    "State",
    "Zip",
    "County",
    "Property Type",
    "Price",
    "Days on Market",
    "MSA Code",
    "Income Level",
    "MMCT (>50% Minority)",
    "Matched Programs",
    "Program Statuses",
    "Agent Name",
    "Agent Email",
    "Agent Phone",
    "Agent Website",
    "Listing Office",
    "Office Phone",
    "Builder Name",
    "Builder Phone",
    "Bedrooms",
    "Bathrooms",
    "Sq Ft",
    "Year Built",
    "Listed Date",
  ];

  const rows = listings.map((l) => {
    const census = l.censusData ?? {};
    const agent = l.listingAgent ?? {};
    const office = l.listingOffice ?? {};
    const builder = l.builder ?? {};
    const progs = l.matchData?.programs ?? [];
    const matched = progs.filter((p) => p.status !== "Ineligible");
    const programNames = matched.map((p) => p.program_name).join("; ");
    const programStatuses = matched.map((p) => `${p.program_name}: ${p.status}`).join("; ");
    const isMMCT = (census.tract_minority_pct ?? 0) > 50;

    return [
      l.formattedAddress ?? "",
      l.city ?? "",
      l.state ?? "",
      l.zipCode ?? "",
      l.county ?? "",
      l.propertyType ?? "",
      l.price != null ? `$${l.price.toLocaleString()}` : "",
      l.daysOnMarket != null ? String(l.daysOnMarket) : "",
      census.msa_code ?? "",
      census.tract_income_level ?? "",
      isMMCT ? "Yes" : "No",
      programNames,
      programStatuses,
      agent.name ?? "",
      agent.email ?? "",
      agent.phone ?? "",
      agent.website ?? "",
      office.name ?? "",
      office.phone ?? "",
      builder.name ?? "",
      builder.phone ?? "",
      l.bedrooms != null ? String(l.bedrooms) : "",
      l.bathrooms != null ? String(l.bathrooms) : "",
      l.squareFootage != null ? String(l.squareFootage) : "",
      l.yearBuilt != null ? String(l.yearBuilt) : "",
      l.listedDate ?? "",
    ].map(escCsv);
  });

  const lines = [
    headers.map(escCsv).join(","),
    ...rows.map((r) => r.join(",")),
    "", // blank line before footer notes
    escCsv(DIAMOND_DISCLAIMER),
    escCsv(`Generate flyers at: ${FLYER_URL}`),
    escCsv(`Generated on ${new Date().toLocaleDateString()} via GMCC Property Search`),
  ];

  return lines.join("\n");
}

function downloadCsv(listings: RentCastListing[]) {
  const csv = buildCsv(listings);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `gmcc-marketing-export-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Resolve effective contact info: listing agent → listing office → builder → N/A */
function getContact(listing: RentCastListing) {
  const agent = listing.listingAgent ?? {};
  const office = listing.listingOffice ?? {};
  const builder = listing.builder ?? {};
  return {
    name:  agent.name?.trim() || office.name?.trim() || builder.name?.trim() || "N/A",
    email: agent.email?.trim() || office.email?.trim() || "N/A",
    phone: agent.phone?.trim() || office.phone?.trim() || builder.phone?.trim() || "N/A",
  };
}

function getSortValue(listing: RentCastListing, col: MkSortColumn): string | number {
  const census = listing.censusData ?? {};
  const contact = getContact(listing);
  switch (col) {
    case "msa":       return census.msa_code ?? "";
    case "price":     return listing.price ?? 0;
    case "address":   return listing.formattedAddress ?? "";
    case "programs":  return (listing.matchData?.programs ?? []).filter((p) => p.status !== "Ineligible").length;
    case "mmct":      return (census.tract_minority_pct ?? 0) > 50 ? 1 : 0;
    case "lmi": {
      const lvl = (census.tract_income_level ?? "").toLowerCase();
      return ({ low: 0, moderate: 1, middle: 2, upper: 3 } as Record<string, number>)[lvl] ?? 4;
    }
    case "days":      return listing.daysOnMarket ?? 9999;
    case "agentName": return contact.name === "N/A" ? "" : contact.name.toLowerCase();
    case "agentEmail":return contact.email === "N/A" ? "" : contact.email.toLowerCase();
    case "agentPhone":return contact.phone === "N/A" ? "" : contact.phone;
    case "state":     return listing.state ?? "";
    case "county":    return listing.county ?? "";
    case "city":      return listing.city ?? "";
    case "zip":       return listing.zipCode ?? "";
    case "type":      return listing.propertyType ?? "";
    default:          return "";
  }
}

function sortListings(listings: RentCastListing[], col: MkSortColumn, dir: MkSortDir): RentCastListing[] {
  // For agent name sort: group by most listings (popularity) then alphabetically within same count
  if (col === "agentName") {
    const counts = new Map<string, number>();
    for (const l of listings) {
      const name = getContact(l).name.toLowerCase();
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...listings].sort((a, b) => {
      const na = getContact(a).name.toLowerCase();
      const nb = getContact(b).name.toLowerCase();
      // N/A always sorts last
      if (na === "n/a" && nb !== "n/a") return 1;
      if (nb === "n/a" && na !== "n/a") return -1;
      const ca = counts.get(na) ?? 0;
      const cb = counts.get(nb) ?? 0;
      // Primary: listing count (desc = most listings first when dir=desc)
      let cmp = ca - cb;
      // Tie-break: alphabetical
      if (cmp === 0) cmp = na.localeCompare(nb);
      return dir === "asc" ? cmp : -cmp;
    });
  }

  return [...listings].sort((a, b) => {
    const va = getSortValue(a, col);
    const vb = getSortValue(b, col);
    let cmp: number;
    if (typeof va === "number" && typeof vb === "number") {
      cmp = va - vb;
    } else {
      cmp = String(va).localeCompare(String(vb));
    }
    return dir === "asc" ? cmp : -cmp;
  });
}

function SortHeader({
  col, label, sortColumn, sortDir, onSort,
}: {
  col: MkSortColumn; label: string; sortColumn: MkSortColumn; sortDir: MkSortDir; onSort: (c: MkSortColumn) => void;
}) {
  const active = sortColumn === col;
  return (
    <th
      className={`cursor-pointer select-none whitespace-nowrap px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide transition-colors hover:text-gray-900 ${
        active ? "text-red-600" : "text-gray-500"
      }`}
      onClick={() => onSort(col)}
    >
      {label}
      <span className="ml-1 opacity-60">
        {active ? (sortDir === "asc" ? "▲" : "▼") : "⇅"}
      </span>
    </th>
  );
}

function listingKey(listing: RentCastListing): string {
  // Use address-based key for stability across re-sorts (id may be missing)
  if (listing.id) return listing.id;
  const addr = listing.formattedAddress ?? listing.addressLine1 ?? "";
  const zip = listing.zipCode ?? "";
  return `mk-${addr}-${zip}`;
}

export default function MarketingTable({
  listings,
  sortColumn,
  sortDir,
  onSort,
  onRowClick,
}: MarketingTableProps) {
  const isMobile = useIsMobile();
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Reset selection and page when listings change (new search)
  const prevListingsRef = useRef(listings);
  useEffect(() => {
    if (prevListingsRef.current !== listings) {
      prevListingsRef.current = listings;
      setSelected(new Set());
      setPage(1);
    }
  }, [listings]);

  const toggleOne = useCallback((key: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  if (listings.length === 0) {
    return <div className="py-16 text-center text-gray-400">No properties found.</div>;
  }

  const sorted = sortListings(listings, sortColumn, sortDir);

  // Build a stable key map for sorted listings
  const sortedKeys = sorted.map((l) => listingKey(l));

  const eligibleCount = listings.filter((l) =>
    (l.matchData?.programs ?? []).some((p) => p.status === "Eligible"),
  ).length;
  const potentialCount = listings.filter((l) => {
    const progs = l.matchData?.programs ?? [];
    return !progs.some((p) => p.status === "Eligible") && progs.some((p) => p.status === "Potentially Eligible");
  }).length;
  const noMatchCount = listings.length - eligibleCount - potentialCount;

  const totalPages = Math.max(1, Math.ceil(sorted.length / PER_PAGE));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * PER_PAGE;
  const pageListings = sorted.slice(start, start + PER_PAGE);
  const pageKeys = sortedKeys.slice(start, start + PER_PAGE);

  // Select-all logic: toggle all on current page
  const allPageSelected = pageKeys.length > 0 && pageKeys.every((k) => selected.has(k));
  const somePageSelected = pageKeys.some((k) => selected.has(k));

  function togglePage() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allPageSelected) {
        pageKeys.forEach((k) => next.delete(k));
      } else {
        pageKeys.forEach((k) => next.add(k));
      }
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(sortedKeys));
  }

  function clearSelection() {
    setSelected(new Set());
  }

  function handleExport() {
    const toExport = sorted.filter((_, i) => selected.has(sortedKeys[i]));
    if (toExport.length === 0) return;
    downloadCsv(toExport);
  }

  // Page range for pagination display
  const pages: (number | "...")[] = [];
  const maxVisible = 5;
  let pStart = Math.max(1, safePage - Math.floor(maxVisible / 2));
  const pEnd = Math.min(totalPages, pStart + maxVisible - 1);
  if (pEnd - pStart + 1 < maxVisible) pStart = Math.max(1, pEnd - maxVisible + 1);
  if (pStart > 1) { pages.push(1); if (pStart > 2) pages.push("..."); }
  for (let i = pStart; i <= pEnd; i++) pages.push(i);
  if (pEnd < totalPages) { if (pEnd < totalPages - 1) pages.push("..."); pages.push(totalPages); }

  const cols: { key: MkSortColumn; label: string }[] = [
    { key: "msa",       label: "MSA #" },
    { key: "days",      label: "Days on Market" },
    { key: "address",   label: "Active Listing Address" },
    { key: "programs",  label: "Matched Programs" },
    { key: "mmct",      label: "MMCT" },
    { key: "lmi",       label: "Income Level" },
    { key: "price",     label: "Price" },
    { key: "agentName", label: "Agent" },
    { key: "agentEmail",label: "Email" },
    { key: "agentPhone",label: "Phone" },
    { key: "state",     label: "State" },
    { key: "county",    label: "County" },
    { key: "city",      label: "City" },
    { key: "zip",       label: "Zip" },
    { key: "type",      label: "Type" },
  ];

  return (
    <div className="space-y-3">
      {/* Summary bar */}
      <div className="flex flex-col gap-3 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm shadow-sm md:flex-row md:flex-wrap md:items-center md:gap-4">
        <div className="flex flex-wrap items-center gap-3 md:gap-4">
          <span className="text-gray-600">
            <strong>{sorted.length}</strong>{" "}
            {sorted.length !== listings.length && (
              <span className="text-gray-400">of {listings.length} </span>
            )}
            properties
          </span>
          <span className="text-emerald-700">
            <strong>{eligibleCount}</strong> eligible
          </span>
          <span className="text-amber-700">
            <strong>{potentialCount}</strong> potentially eligible
          </span>
          <span className="text-gray-500">
            <strong>{noMatchCount}</strong> no match
          </span>
        </div>

        {/* Selection actions */}
        <div className="flex flex-col gap-2 md:ml-auto md:flex-row md:items-center">
          {selected.size > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500">
                <strong>{selected.size}</strong> selected
              </span>
              <button
                onClick={clearSelection}
                className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
              >
                Clear
              </button>
              {selected.size < sorted.length && (
                <button
                  onClick={selectAll}
                  className="text-xs text-red-600 hover:text-red-700 transition-colors"
                >
                  Select all {sorted.length}
                </button>
              )}
            </div>
          )}
          <button
            onClick={handleExport}
            disabled={selected.size === 0}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed md:w-auto"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <path d="M2 11v2a1 1 0 001 1h10a1 1 0 001-1v-2M8 2v9M5 8l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Export CSV{selected.size > 0 ? ` (${selected.size})` : ""}
          </button>
        </div>
      </div>

      {/* Mobile sort dropdown */}
      {isMobile && (
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-gray-500">Sort by</label>
          <select
            value={sortColumn}
            onChange={(e) => { onSort(e.target.value as MkSortColumn); setPage(1); }}
            className="flex-1 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs text-gray-700 focus:outline-none focus:ring-2 focus:ring-red-500"
          >
            {cols.map((c) => (
              <option key={c.key} value={c.key}>{c.label}</option>
            ))}
          </select>
          <button
            onClick={() => onSort(sortColumn)}
            className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs text-gray-600"
          >
            {sortDir === "asc" ? "▲ Asc" : "▼ Desc"}
          </button>
        </div>
      )}

      {/* Pagination (top) */}
      {totalPages > 1 && (
        <nav className="flex items-center justify-center gap-1 py-2" aria-label="Marketing table pagination top">
          <button
            className="inline-flex h-8 items-center justify-center rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={safePage === 1}
            onClick={() => setPage((p) => p - 1)}
          >
            ← Prev
          </button>
          {pages.map((p, idx) =>
            p === "..." ? (
              <span key={`elt-${idx}`} className="inline-flex h-8 w-8 items-center justify-center text-xs text-slate-400">…</span>
            ) : (
              <button
                key={`t-${p}`}
                onClick={() => setPage(p as number)}
                className={`inline-flex h-8 w-8 items-center justify-center rounded-lg text-xs font-medium transition-colors ${
                  p === safePage ? "bg-slate-900 text-white" : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                }`}
              >
                {p}
              </button>
            ),
          )}
          <button
            className="inline-flex h-8 items-center justify-center rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={safePage === totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next →
          </button>
        </nav>
      )}

      {/* Mobile: card list / Desktop: table */}
      {isMobile ? (
        /* ── Mobile Card List ── */
        <div className="space-y-2">
          {pageListings.map((listing, i) => {
            const key = pageKeys[i];
            const isSelected = selected.has(key);
            const census = listing.censusData ?? {};
            const progs = listing.matchData?.programs ?? [];
            const eligibleProgs = progs.filter((p) => p.status !== "Ineligible" && !p.is_secondary);
            const secondaryMatchCount = progs.filter((p) => p.is_secondary && p.status !== "Ineligible").length;
            const isMMCT = (census.tract_minority_pct ?? 0) > 50;
            const incomeLevel = census.tract_income_level ?? "N/A";
            const isLmi = ["low", "moderate"].includes(incomeLevel.toLowerCase());

            return (
              <div
                key={key}
                onClick={() => onRowClick(listing)}
                className={`relative cursor-pointer rounded-xl border bg-white p-4 shadow-sm transition-colors ${
                  isSelected ? "border-red-300 bg-red-50/60" : "border-gray-200"
                }`}
              >
                {/* Checkbox top-right */}
                <div
                  className="absolute right-3 top-3"
                  onClick={(e) => toggleOne(key, e)}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    readOnly
                    className="h-4 w-4 rounded accent-red-600 cursor-pointer"
                  />
                </div>

                {/* Address */}
                <div className="pr-8 text-sm font-semibold text-gray-900">
                  {listing.formattedAddress ?? "N/A"}
                </div>

                {/* Price + Type + DOM */}
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                  <span className="font-medium text-gray-900">{formatPrice(listing.price)}</span>
                  <span className="text-gray-500">{listing.propertyType ?? "N/A"}</span>
                  {listing.daysOnMarket != null && (
                    <span className="font-semibold text-amber-700">{listing.daysOnMarket}d</span>
                  )}
                </div>

                {/* Program badges */}
                {listing._matchFailed ? (
                  <div className="mt-2">
                    <span className="inline-flex items-center rounded-full bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-700">
                      Match unavailable
                    </span>
                  </div>
                ) : (eligibleProgs.length > 0 || secondaryMatchCount > 0) ? (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {eligibleProgs.map((p) => (
                      <span
                        key={p.program_name}
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                          p.status === "Eligible"
                            ? "bg-emerald-100 text-emerald-800"
                            : "bg-amber-100 text-amber-700"
                        }`}
                      >
                        {p.program_name}
                      </span>
                    ))}
                    {secondaryMatchCount > 0 && (
                      <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
                        +{secondaryMatchCount} secondary
                      </span>
                    )}
                  </div>
                ) : null}

                {/* Income Level + MMCT badges */}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                      isLmi ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-700"
                    }`}
                  >
                    {incomeLevel}
                  </span>
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${
                      isMMCT ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-700"
                    }`}
                  >
                    {isMMCT ? "MMCT" : "Not MMCT"}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        /* ── Desktop Table ── */
        <ScrollFadeWrapper className="rounded-xl border border-gray-200 bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50">
              <tr>
                {/* Checkbox header */}
                <th className="w-10 px-3 py-2.5">
                  <input
                    type="checkbox"
                    checked={allPageSelected}
                    ref={(el) => { if (el) el.indeterminate = somePageSelected && !allPageSelected; }}
                    onChange={togglePage}
                    className="h-4 w-4 rounded accent-red-600 cursor-pointer"
                    title={allPageSelected ? "Deselect page" : "Select page"}
                  />
                </th>
                {cols.map((c) => (
                  <SortHeader
                    key={c.key}
                    col={c.key}
                    label={c.label}
                    sortColumn={sortColumn}
                    sortDir={sortDir}
                    onSort={(col) => { onSort(col); setPage(1); }}
                  />
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {pageListings.map((listing, i) => {
                const key = pageKeys[i];
                const isSelected = selected.has(key);
                const census = listing.censusData ?? {};
                const contact = getContact(listing);
                const progs = listing.matchData?.programs ?? [];
                const eligible = progs.filter((p) => p.status !== "Ineligible" && !p.is_secondary);
                const secondaryMatchCount = progs.filter((p) => p.is_secondary && p.status !== "Ineligible").length;

                const isMMCT = (census.tract_minority_pct ?? 0) > 50;
                const incomeLevel = census.tract_income_level ?? "N/A";
                const isLmi = ["low", "moderate"].includes(incomeLevel.toLowerCase());

                return (
                  <tr
                    key={key}
                    onClick={() => onRowClick(listing)}
                    className={`cursor-pointer transition-colors ${
                      isSelected ? "bg-red-50/60" : "hover:bg-red-50"
                    }`}
                  >
                    {/* Checkbox */}
                    <td className="px-3 py-2.5" onClick={(e) => toggleOne(key, e)}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        readOnly
                        className="h-4 w-4 rounded accent-red-600 cursor-pointer"
                      />
                    </td>

                    {/* MSA # */}
                    <td className="whitespace-nowrap px-3 py-2.5 text-gray-600">
                      {census.msa_code ?? "Rural"}
                    </td>

                    {/* Days on Market */}
                    <td className="whitespace-nowrap px-3 py-2.5 font-semibold text-amber-700">
                      {listing.daysOnMarket != null ? listing.daysOnMarket : "N/A"}
                    </td>

                    {/* Address */}
                    <td className="min-w-[180px] px-3 py-2.5 text-gray-800">
                      {listing.formattedAddress ?? "N/A"}
                    </td>

                    {/* Programs */}
                    <td className="px-3 py-2.5">
                      {listing._matchFailed ? (
                        <span className="inline-flex items-center rounded-full bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-700">
                          Match unavailable
                        </span>
                      ) : eligible.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {eligible.map((p) => (
                            <span
                              key={p.program_name}
                              className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                                p.status === "Eligible"
                                  ? "bg-emerald-100 text-emerald-800"
                                  : "bg-amber-100 text-amber-700"
                              }`}
                            >
                              {p.program_name}
                            </span>
                          ))}
                          {secondaryMatchCount > 0 && (
                            <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
                              +{secondaryMatchCount} secondary
                            </span>
                          )}
                        </div>
                      ) : secondaryMatchCount > 0 ? (
                        <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
                          {secondaryMatchCount} secondary
                        </span>
                      ) : (
                        <span className="text-gray-400">None</span>
                      )}
                    </td>

                    {/* MMCT */}
                    <td className="whitespace-nowrap px-3 py-2.5">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${
                          isMMCT ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-700"
                        }`}
                      >
                        {isMMCT ? "Yes" : "No"}
                      </span>
                    </td>

                    {/* Income Level */}
                    <td className="whitespace-nowrap px-3 py-2.5">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                          isLmi ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-700"
                        }`}
                      >
                        {incomeLevel}
                      </span>
                    </td>

                    {/* Price */}
                    <td className="whitespace-nowrap px-3 py-2.5 font-medium text-gray-900">
                      {formatPrice(listing.price)}
                    </td>

                    {/* Agent */}
                    <td className="whitespace-nowrap px-3 py-2.5 text-gray-700">
                      {contact.name}
                    </td>

                    {/* Email */}
                    <td className="max-w-[160px] truncate px-3 py-2.5 text-gray-600" title={contact.email !== "N/A" ? contact.email : undefined}>
                      {contact.email}
                    </td>

                    {/* Phone */}
                    <td className="whitespace-nowrap px-3 py-2.5 text-gray-600">
                      {contact.phone !== "N/A" ? formatPhone(contact.phone) : "N/A"}
                    </td>

                    {/* State */}
                    <td className="whitespace-nowrap px-3 py-2.5 text-gray-600">
                      {listing.state ?? "N/A"}
                    </td>

                    {/* County */}
                    <td className="whitespace-nowrap px-3 py-2.5 text-gray-600">
                      {listing.county ?? "N/A"}
                    </td>

                    {/* City */}
                    <td className="whitespace-nowrap px-3 py-2.5 text-gray-600">
                      {listing.city ?? "N/A"}
                    </td>

                    {/* Zip */}
                    <td className="whitespace-nowrap px-3 py-2.5 text-gray-600">
                      {listing.zipCode ?? "N/A"}
                    </td>

                    {/* Type */}
                    <td className="whitespace-nowrap px-3 py-2.5 text-gray-500">
                      {listing.propertyType ?? "N/A"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollFadeWrapper>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <nav className="flex items-center justify-center gap-1 py-2" aria-label="Marketing table pagination">
          <button
            className="inline-flex h-8 items-center justify-center rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={safePage === 1}
            onClick={() => setPage((p) => p - 1)}
          >
            ← Prev
          </button>
          {pages.map((p, idx) =>
            p === "..." ? (
              <span key={`el-${idx}`} className="inline-flex h-8 w-8 items-center justify-center text-xs text-slate-400">…</span>
            ) : (
              <button
                key={p}
                onClick={() => setPage(p as number)}
                className={`inline-flex h-8 w-8 items-center justify-center rounded-lg text-xs font-medium transition-colors ${
                  p === safePage ? "bg-slate-900 text-white" : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                }`}
              >
                {p}
              </button>
            ),
          )}
          <button
            className="inline-flex h-8 items-center justify-center rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={safePage === totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next →
          </button>
        </nav>
      )}
    </div>
  );
}

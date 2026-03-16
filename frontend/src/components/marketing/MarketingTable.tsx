"use client";

import { useState } from "react";
import { formatPrice, formatPhone } from "@/lib/utils";
import type { RentCastListing } from "@/types";

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

const PER_PAGE = 50;

function getSortValue(listing: RentCastListing, col: MkSortColumn): string | number {
  const census = listing.censusData ?? {};
  const agent = listing.listingAgent ?? {};
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
    case "agentName": return (agent.name ?? "").toLowerCase();
    case "agentEmail":return (agent.email ?? "").toLowerCase();
    case "agentPhone":return agent.phone ?? "";
    case "state":     return listing.state ?? "";
    case "county":    return listing.county ?? "";
    case "city":      return listing.city ?? "";
    case "zip":       return listing.zipCode ?? "";
    case "type":      return listing.propertyType ?? "";
    default:          return "";
  }
}

function sortListings(listings: RentCastListing[], col: MkSortColumn, dir: MkSortDir): RentCastListing[] {
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
        active ? "text-blue-600" : "text-gray-500"
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

export default function MarketingTable({
  listings,
  sortColumn,
  sortDir,
  onSort,
  onRowClick,
}: MarketingTableProps) {
  const [page, setPage] = useState(1);

  if (listings.length === 0) {
    return <div className="py-16 text-center text-gray-400">No properties found.</div>;
  }

  const sorted = sortListings(listings, sortColumn, sortDir);

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
      <div className="flex flex-wrap items-center gap-4 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm shadow-sm">
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

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-200 bg-gray-50">
            <tr>
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
              const census = listing.censusData ?? {};
              const agent = listing.listingAgent ?? {};
              const progs = listing.matchData?.programs ?? [];
              const eligible = progs.filter((p) => p.status !== "Ineligible" && !p.is_secondary);
              const secondaryMatchCount = progs.filter((p) => p.is_secondary && p.status !== "Ineligible").length;

              const isMMCT = (census.tract_minority_pct ?? 0) > 50;
              const incomeLevel = census.tract_income_level ?? "N/A";
              const isLmi = ["low", "moderate"].includes(incomeLevel.toLowerCase());

              return (
                <tr
                  key={listing.id ?? `mk-${start + i}`}
                  onClick={() => onRowClick(listing)}
                  className="cursor-pointer transition-colors hover:bg-blue-50"
                >
                  {/* MSA # */}
                  <td className="whitespace-nowrap px-3 py-2.5 text-gray-600">
                    {census.msa_code ?? "N/A"}
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
                    {eligible.length > 0 ? (
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
                    {agent.name ?? "N/A"}
                  </td>

                  {/* Email */}
                  <td className="max-w-[160px] truncate px-3 py-2.5 text-gray-600" title={agent.email}>
                    {agent.email ?? "N/A"}
                  </td>

                  {/* Phone */}
                  <td className="whitespace-nowrap px-3 py-2.5 text-gray-600">
                    {agent.phone ? formatPhone(agent.phone) : "N/A"}
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
      </div>

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

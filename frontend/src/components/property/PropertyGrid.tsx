"use client";

import { useState } from "react";
import PropertyCard from "@/components/PropertyCard";
import ProgBadge from "@/components/ProgBadge";
import type { RentCastListing } from "@/types";
import { formatPrice, formatDistance } from "@/lib/utils";

export type SortBy =
  | "distance"
  | "price-asc"
  | "price-desc"
  | "days-asc"
  | "days-desc"
  | "best-match";

type ViewMode = "list" | "card";

interface PropertyGridProps {
  listings: RentCastListing[];
  loading: boolean;
  onCardClick: (listing: RentCastListing) => void;
  sortBy: SortBy;
  onSortChange?: (sortBy: SortBy) => void;
}

export function sortListings(listings: RentCastListing[], sortBy: SortBy): RentCastListing[] {
  const s = [...listings];
  switch (sortBy) {
    case "price-asc":  return s.sort((a, b) => (a.price ?? 0) - (b.price ?? 0));
    case "price-desc": return s.sort((a, b) => (b.price ?? 0) - (a.price ?? 0));
    case "days-asc":   return s.sort((a, b) => (a.daysOnMarket ?? 0) - (b.daysOnMarket ?? 0));
    case "days-desc":  return s.sort((a, b) => (b.daysOnMarket ?? 0) - (a.daysOnMarket ?? 0));
    case "best-match":
      return s.sort((a, b) => {
        const score = (l: RentCastListing) => {
          if (!l.matchData) return -1; // still loading — sort last
          return l.matchData.programs.reduce((acc, p) => {
            if (p.is_secondary) return acc;
            if (p.status === "Eligible") return acc + 10;
            if (p.status === "Potentially Eligible") return acc + 1;
            return acc;
          }, 0);
        };
        return score(b) - score(a);
      });
    default: return s.sort((a, b) => (a.distance ?? 999) - (b.distance ?? 999));
  }
}

// Columns: Days | Address | Programs | Price | Dist
const LIST_COLS = "90px 280px auto 130px 72px";

function PropertyListRow({ listing, onClick }: { listing: RentCastListing; onClick: () => void }) {
  const eligible = (listing.matchData?.programs ?? []).filter(
    (p) => p.status !== "Ineligible" && !p.is_secondary,
  );
  const hasMatchData = listing.matchData !== undefined;
  const distanceStr = formatDistance(listing.distance);

  const details = [
    listing.bedrooms != null ? `${listing.bedrooms} bd` : null,
    listing.bathrooms != null ? `${listing.bathrooms} ba` : null,
    listing.squareFootage != null ? `${listing.squareFootage.toLocaleString()} sqft` : null,
  ].filter(Boolean).join(" · ");

  return (
    <div
      onClick={onClick}
      className="grid cursor-pointer items-center gap-x-4 border-b border-slate-100 px-4 py-3 transition-colors hover:bg-slate-50"
      style={{ gridTemplateColumns: LIST_COLS }}
    >
      {/* Days on market */}
      <span className="whitespace-nowrap text-sm font-semibold tabular-nums text-amber-700">
        {listing.daysOnMarket != null ? `${listing.daysOnMarket}d` : "—"}
      </span>

      {/* Address + details */}
      <div>
        <p className="text-sm font-medium text-slate-800">
          {listing.formattedAddress ?? "Address unavailable"}
        </p>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
          {listing.propertyType && (
            <span className="rounded-full bg-red-50 px-2 py-0.5 text-[0.68rem] font-medium text-red-700">
              {listing.propertyType}
            </span>
          )}
          {details && (
            <span className="text-[0.68rem] text-slate-500">{details}</span>
          )}
        </div>
      </div>

      {/* Programs */}
      <div className="flex flex-wrap gap-1">
        {!hasMatchData ? (
          <span className="h-4 w-20 animate-pulse rounded-full bg-slate-200" />
        ) : eligible.length > 0 ? (
          eligible.map((p) => <ProgBadge key={p.program_name} prog={p} compact />)
        ) : (
          <span className="text-[0.68rem] italic text-slate-400">No match</span>
        )}
      </div>

      {/* Price */}
      <span className="text-sm font-bold text-slate-900 tabular-nums">
        {formatPrice(listing.price)}
      </span>

      {/* Distance */}
      <span className="whitespace-nowrap text-[0.68rem] text-slate-400">
        {distanceStr}
      </span>
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="p-5">
        <div className="h-6 w-32 animate-pulse rounded bg-slate-200" />
        <div className="mt-2 h-4 w-full animate-pulse rounded bg-slate-100 [animation-delay:75ms]" />
        <div className="mt-1 h-4 w-3/4 animate-pulse rounded bg-slate-100 [animation-delay:150ms]" />
        <div className="mt-4 flex gap-2">
          <div className="h-5 w-20 animate-pulse rounded-full bg-slate-200 [animation-delay:225ms]" />
          <div className="h-5 w-16 animate-pulse rounded-full bg-slate-200 [animation-delay:300ms]" />
        </div>
        <div className="mt-4 border-t border-slate-100 pt-3">
          <div className="mb-2 h-3 w-28 animate-pulse rounded bg-slate-200" />
          <div className="flex gap-2">
            <div className="h-5 w-24 animate-pulse rounded-full bg-slate-200 [animation-delay:375ms]" />
            <div className="h-5 w-20 animate-pulse rounded-full bg-slate-200 [animation-delay:450ms]" />
          </div>
        </div>
      </div>
    </div>
  );
}

function SkeletonRow() {
  return (
    <div className="grid items-center gap-x-4 border-b border-slate-100 px-4 py-3"
      style={{ gridTemplateColumns: LIST_COLS }}>
      <div className="h-4 w-8 animate-pulse rounded bg-slate-200" />
      <div className="space-y-1.5">
        <div className="h-4 w-3/4 animate-pulse rounded bg-slate-100" />
        <div className="h-3 w-1/2 animate-pulse rounded bg-slate-100 [animation-delay:75ms]" />
      </div>
      <div className="h-4 w-20 animate-pulse rounded-full bg-slate-200" />
      <div className="h-4 w-16 animate-pulse rounded bg-slate-100" />
      <div className="h-3 w-10 animate-pulse rounded bg-slate-100" />
    </div>
  );
}

function ViewToggle({ view, onChange }: { view: ViewMode; onChange: (v: ViewMode) => void }) {
  return (
    <div className="flex items-center rounded-md border border-slate-200 bg-white p-0.5">
      <button
        onClick={() => onChange("list")}
        className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors ${
          view === "list" ? "bg-slate-900 text-white" : "text-slate-500 hover:text-slate-700"
        }`}
        title="List view"
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
          <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        List
      </button>
      <button
        onClick={() => onChange("card")}
        className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors ${
          view === "card" ? "bg-slate-900 text-white" : "text-slate-500 hover:text-slate-700"
        }`}
        title="Card view"
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
          <rect x="1" y="1" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.5" />
          <rect x="9" y="1" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.5" />
          <rect x="1" y="9" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.5" />
          <rect x="9" y="9" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.5" />
        </svg>
        Cards
      </button>
    </div>
  );
}

function SortArrow({ active, dir }: { active: boolean; dir: "asc" | "desc" | null }) {
  if (!active) return <span className="ml-1 opacity-30">⇅</span>;
  return <span className="ml-1 opacity-70">{dir === "asc" ? "▲" : "▼"}</span>;
}

export default function PropertyGrid({ listings, loading, onCardClick, sortBy, onSortChange }: PropertyGridProps) {
  const [view, setView] = useState<ViewMode>("list");
  // listings are pre-sorted by page.tsx before pagination; no need to re-sort here
  const sorted = listings;

  function handleColSort(col: "days" | "price" | "programs" | "distance") {
    if (!onSortChange) return;
    if (col === "days") {
      onSortChange(sortBy === "days-asc" ? "days-desc" : "days-asc");
    } else if (col === "price") {
      onSortChange(sortBy === "price-asc" ? "price-desc" : "price-asc");
    } else if (col === "programs") {
      onSortChange("best-match");
    } else {
      onSortChange("distance");
    }
  }

  const daysDir = sortBy === "days-asc" ? "asc" : sortBy === "days-desc" ? "desc" : null;
  const priceDir = sortBy === "price-asc" ? "asc" : sortBy === "price-desc" ? "desc" : null;

  const colHeaderClass = (active: boolean) =>
    `text-[0.65rem] font-semibold uppercase tracking-wider text-slate-400 ${
      onSortChange ? "cursor-pointer select-none hover:text-slate-600" : ""
    } ${active ? "text-red-500" : ""}`;

  // Show skeletons only when loading with no results yet
  if (loading && listings.length === 0) {
    return (
      <div>
        <div className="mb-3 flex justify-end">
          <ViewToggle view={view} onChange={setView} />
        </div>
        {view === "card" ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} />)}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <div style={{ minWidth: 680 }}>
              <div className="grid border-b border-slate-200 bg-slate-50 px-4 py-2 text-[0.65rem] font-semibold uppercase tracking-wider text-slate-400"
                style={{ gridTemplateColumns: LIST_COLS }}>
                <span>Days on Market</span><span>Address</span><span>Programs</span><span>Price</span><span>Dist</span>
              </div>
              {Array.from({ length: 6 }).map((_, i) => <SkeletonRow key={i} />)}
            </div>
          </div>
        )}
      </div>
    );
  }

  if (listings.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-slate-400">
        <svg className="mb-3 h-12 w-12 opacity-40" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12l8.954-8.955a1.5 1.5 0 012.092 0L22.25 12M4.5 9.75v10.125A1.125 1.125 0 005.625 21h3.75a1.125 1.125 0 001.125-1.125V15.75a1.125 1.125 0 011.125-1.125h1.5a1.125 1.125 0 011.125 1.125v4.125A1.125 1.125 0 0015.375 21h3.75a1.125 1.125 0 001.125-1.125V9.75" />
        </svg>
        <p className="text-base font-medium text-slate-600">No Properties Found</p>
        <p className="mt-1 text-sm">Try adjusting your search criteria or expanding the radius.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <span className="text-xs text-slate-500">{listings.length} propert{listings.length === 1 ? "y" : "ies"}</span>
        <ViewToggle view={view} onChange={setView} />
      </div>

      {view === "card" ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {sorted.map((listing, i) => (
            <PropertyCard
              key={listing.id ?? `${listing.formattedAddress}-${i}`}
              listing={listing}
              onClick={() => onCardClick(listing)}
            />
          ))}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <div style={{ minWidth: 680 }}>
            {/* Column headers */}
            <div
              className="grid border-b border-slate-200 bg-slate-50 px-4 py-2"
              style={{ gridTemplateColumns: LIST_COLS }}
            >
              <span className={colHeaderClass(daysDir !== null)} onClick={() => handleColSort("days")}>
                Days on Market<SortArrow active={daysDir !== null} dir={daysDir} />
              </span>
              <span className={colHeaderClass(false)}>Address / Details</span>
              <span className={colHeaderClass(sortBy === "best-match")} onClick={() => handleColSort("programs")}>
                Programs<SortArrow active={sortBy === "best-match"} dir={sortBy === "best-match" ? "desc" : null} />
              </span>
              <span className={colHeaderClass(priceDir !== null)} onClick={() => handleColSort("price")}>
                Price<SortArrow active={priceDir !== null} dir={priceDir} />
              </span>
              <span className={colHeaderClass(sortBy === "distance")} onClick={() => handleColSort("distance")}>
                Dist<SortArrow active={sortBy === "distance"} dir={sortBy === "distance" ? "asc" : null} />
              </span>
            </div>
            {sorted.map((listing, i) => (
              <PropertyListRow
                key={listing.id ?? `${listing.formattedAddress}-${i}`}
                listing={listing}
                onClick={() => onCardClick(listing)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

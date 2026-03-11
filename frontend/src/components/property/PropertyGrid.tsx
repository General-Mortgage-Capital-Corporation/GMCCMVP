"use client";

import PropertyCard from "@/components/PropertyCard";
import type { RentCastListing } from "@/types";

export type SortBy =
  | "distance"
  | "price-asc"
  | "price-desc"
  | "days-asc"
  | "days-desc"
  | "best-match";

interface PropertyGridProps {
  listings: RentCastListing[];
  loading: boolean;
  onCardClick: (listing: RentCastListing) => void;
  sortBy: SortBy;
}

function sortListings(listings: RentCastListing[], sortBy: SortBy): RentCastListing[] {
  const s = [...listings];
  switch (sortBy) {
    case "price-asc":  return s.sort((a, b) => (a.price ?? 0) - (b.price ?? 0));
    case "price-desc": return s.sort((a, b) => (b.price ?? 0) - (a.price ?? 0));
    case "days-asc":   return s.sort((a, b) => (a.daysOnMarket ?? 0) - (b.daysOnMarket ?? 0));
    case "days-desc":  return s.sort((a, b) => (b.daysOnMarket ?? 0) - (a.daysOnMarket ?? 0));
    case "best-match":
      return s.sort((a, b) => {
        const score = (l: RentCastListing) =>
          (l.matchData?.programs ?? []).reduce(
            (acc, p) => acc + (p.status === "Eligible" ? 2 : p.status === "Potentially Eligible" ? 1 : 0),
            0,
          );
        return score(b) - score(a);
      });
    default: return s.sort((a, b) => (a.distance ?? 999) - (b.distance ?? 999));
  }
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

export default function PropertyGrid({ listings, loading, onCardClick, sortBy }: PropertyGridProps) {
  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} />)}
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

  const sorted = sortListings(listings, sortBy);

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {sorted.map((listing, i) => (
        <PropertyCard
          key={listing.id ?? `${listing.formattedAddress}-${i}`}
          listing={listing}
          onClick={() => onCardClick(listing)}
        />
      ))}
    </div>
  );
}

"use client";

import type { RentCastListing } from "@/types";
import { formatPrice, formatDistance } from "@/lib/utils";
import ProgBadge from "@/components/ProgBadge";

interface PropertyCardProps {
  listing: RentCastListing;
  onClick?: () => void;
}

function getEligiblePrograms(listing: RentCastListing) {
  if (!listing.matchData?.programs) return [];
  return listing.matchData.programs.filter(
    (p) => p.status !== "Ineligible" && !p.is_secondary,
  );
}

export default function PropertyCard({ listing, onClick }: PropertyCardProps) {
  const eligiblePrograms = getEligiblePrograms(listing);
  const hasMatchData = listing.matchData !== undefined;
  const distanceStr = formatDistance(listing.distance);

  const details = [
    listing.bedrooms != null ? `${listing.bedrooms} bd` : null,
    listing.bathrooms != null ? `${listing.bathrooms} ba` : null,
    listing.squareFootage != null
      ? `${listing.squareFootage.toLocaleString()} sqft`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      onClick={onClick}
      className="flex cursor-pointer flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm transition-all duration-150 hover:border-slate-300 hover:shadow-md active:scale-[0.99] active:shadow-sm"
    >
      <div className="flex-1 p-5">
        <p className="text-[1.375rem] font-bold tracking-tight text-slate-900">
          {formatPrice(listing.price)}
        </p>

        <p className="mt-0.5 text-[0.9375rem] leading-snug text-slate-500">
          {listing.formattedAddress ?? "Address unavailable"}
        </p>

        {/* Property meta */}
        <div className="mt-3 flex flex-wrap gap-1.5">
          {listing.propertyType && (
            <span className="rounded-full bg-red-50 px-2.5 py-0.5 text-xs font-medium text-red-700">
              {listing.propertyType}
            </span>
          )}
          {details && (
            <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
              {details}
            </span>
          )}
          {listing.daysOnMarket != null && (
            <span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700">
              {listing.daysOnMarket}d on market
            </span>
          )}
        </div>

        {/* Programs section */}
        <div className="mt-4 border-t border-slate-100 pt-3">
          <p className="mb-2 text-[0.6875rem] font-semibold uppercase tracking-widest text-slate-400">
            Matching Programs
          </p>

          {!hasMatchData ? (
            <div className="flex gap-1.5">
              <span className="h-5 w-24 animate-pulse rounded-full bg-slate-200" />
              <span className="h-5 w-20 animate-pulse rounded-full bg-slate-200 [animation-delay:150ms]" />
            </div>
          ) : eligiblePrograms.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {eligiblePrograms.map((p) => (
                <ProgBadge key={p.program_name} prog={p} />
              ))}
            </div>
          ) : (
            <p className="text-xs italic text-slate-400">No matching programs</p>
          )}
        </div>
      </div>

      {distanceStr && (
        <div className="border-t border-slate-100 bg-slate-50 px-5 py-2 text-xs text-slate-500">
          {distanceStr}
        </div>
      )}
    </div>
  );
}

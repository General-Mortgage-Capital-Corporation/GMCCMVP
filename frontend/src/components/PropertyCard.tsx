"use client";

import type { RentCastListing, ProgramResult } from "@/types";
import { formatPrice, formatDistance } from "@/lib/utils";
import ProgramBadge from "./ProgramBadge";

interface PropertyCardProps {
  listing: RentCastListing;
  onClick?: () => void;
}

function getEligiblePrograms(listing: RentCastListing): ProgramResult[] {
  if (!listing.matchData?.programs) return [];
  return listing.matchData.programs.filter(
    (p) => p.status !== "Ineligible",
  );
}

export default function PropertyCard({ listing, onClick }: PropertyCardProps) {
  const eligiblePrograms = getEligiblePrograms(listing);
  const hasPrograms = eligiblePrograms.length > 0;

  const details = [
    listing.bedrooms != null ? `${listing.bedrooms} bd` : null,
    listing.bathrooms != null ? `${listing.bathrooms} ba` : null,
    listing.squareFootage != null
      ? `${listing.squareFootage.toLocaleString()} sqft`
      : null,
  ]
    .filter(Boolean)
    .join(" | ");

  const distanceStr = formatDistance(listing.distance);

  return (
    <button
      type="button"
      onClick={onClick}
      className={`group relative flex w-full flex-col rounded-xl border bg-white p-4 text-left shadow-sm transition-all hover:shadow-md ${
        hasPrograms
          ? "border-emerald-200 ring-1 ring-emerald-100"
          : "border-gray-200"
      }`}
    >
      {/* Price & distance */}
      <div className="flex items-start justify-between">
        <span className="text-lg font-bold text-gray-900">
          {formatPrice(listing.price)}
        </span>
        {distanceStr && (
          <span className="text-xs text-gray-500">{distanceStr}</span>
        )}
      </div>

      {/* Address */}
      <p className="mt-1 text-sm text-gray-600 leading-snug">
        {listing.formattedAddress ?? "Address unavailable"}
      </p>

      {/* Property details */}
      {details && (
        <p className="mt-1 text-xs text-gray-500">{details}</p>
      )}

      {/* Property type & days on market */}
      <div className="mt-2 flex items-center gap-2 text-xs text-gray-500">
        {listing.propertyType && (
          <span className="rounded bg-gray-100 px-1.5 py-0.5">
            {listing.propertyType}
          </span>
        )}
        {listing.daysOnMarket != null && (
          <span>{listing.daysOnMarket} days on market</span>
        )}
      </div>

      {/* Program badges */}
      {hasPrograms && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {eligiblePrograms.map((p) => (
            <ProgramBadge
              key={p.program_name}
              programName={p.program_name}
              status={p.status}
              compact
            />
          ))}
        </div>
      )}

      {/* Matching status indicator */}
      {listing.matchData === undefined && (
        <div className="mt-2 text-xs text-gray-400 italic">
          Checking eligibility...
        </div>
      )}
    </button>
  );
}

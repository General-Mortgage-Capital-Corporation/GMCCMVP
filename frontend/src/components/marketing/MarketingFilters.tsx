"use client";

import FilterChips from "@/components/search/FilterChips";
import type { RentCastListing } from "@/types";
import type { ChipFilter } from "@/lib/utils";

interface MarketingFiltersProps {
  listings: RentCastListing[];
  programFilter: string;
  typeFilter: string;
  chipFilters: Set<ChipFilter>;
  onProgramFilter: (p: string) => void;
  onTypeFilter: (t: string) => void;
  onChipFilter: (c: Set<ChipFilter>) => void;
}

export default function MarketingFilters({
  listings,
  programFilter,
  typeFilter,
  chipFilters,
  onProgramFilter,
  onTypeFilter,
  onChipFilter,
}: MarketingFiltersProps) {
  const allPrograms = Array.from(
    new Set(
      listings
        .flatMap((l) => l.matchData?.programs ?? [])
        .filter((p) => p.status !== "Ineligible")
        .map((p) => p.program_name),
    ),
  );

  const allTypes = Array.from(
    new Set(listings.map((l) => l.propertyType).filter(Boolean)),
  ) as string[];

  return (
    <div className="flex flex-wrap items-center gap-3">
      {allPrograms.length > 0 && (
        <select
          value={programFilter}
          onChange={(e) => onProgramFilter(e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">All Programs</option>
          {allPrograms.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      )}

      {allTypes.length > 0 && (
        <select
          value={typeFilter}
          onChange={(e) => onTypeFilter(e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">All Types</option>
          {allTypes.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      )}

      <FilterChips
        active={chipFilters}
        onChange={onChipFilter}
        showPriceRanges
      />
    </div>
  );
}

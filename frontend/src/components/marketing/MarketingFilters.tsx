"use client";

import FilterChips from "@/components/search/FilterChips";
import PriceRangeFilter from "@/components/search/PriceRangeFilter";
import type { RentCastListing } from "@/types";
import { EXCLUDED_PROPERTY_TYPES } from "@/lib/utils";
import type { ChipFilter } from "@/lib/utils";

interface MarketingFiltersProps {
  listings: RentCastListing[];
  programFilters: string[];
  typeFilters: string[];
  chipFilters: Set<ChipFilter>;
  priceMin: number | null;
  priceMax: number | null;
  onProgramFilters: (p: string[]) => void;
  onTypeFilters: (t: string[]) => void;
  onChipFilter: (c: Set<ChipFilter>) => void;
  onPriceRange: (min: number | null, max: number | null) => void;
  /** Hide the program checkbox filters (e.g. when searching by a specific program) */
  hidePrograms?: boolean;
}

export default function MarketingFilters({
  listings,
  programFilters,
  typeFilters,
  chipFilters,
  priceMin,
  priceMax,
  onProgramFilters,
  onTypeFilters,
  onChipFilter,
  onPriceRange,
  hidePrograms = false,
}: MarketingFiltersProps) {
  const allPrograms = Array.from(
    new Set(
      listings
        .flatMap((l) => l.matchData?.programs ?? [])
        .filter((p) => p.status !== "Ineligible" && !p.is_secondary)
        .map((p) => p.program_name),
    ),
  );

  const allTypes = Array.from(
    new Set(listings.map((l) => l.propertyType).filter((t): t is string => !!t && !EXCLUDED_PROPERTY_TYPES.has(t))),
  );

  function toggleProgram(p: string) {
    if (programFilters.includes(p)) {
      onProgramFilters(programFilters.filter((x) => x !== p));
    } else {
      onProgramFilters([...programFilters, p]);
    }
  }

  function toggleType(t: string) {
    if (typeFilters.includes(t)) {
      onTypeFilters(typeFilters.filter((x) => x !== t));
    } else {
      onTypeFilters([...typeFilters, t]);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">Filters</p>
      <div className="flex flex-wrap gap-x-8 gap-y-4">
        {!hidePrograms && allPrograms.length > 0 && (
          <div>
            <p className="mb-1.5 text-xs font-medium text-gray-600">Program</p>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {allPrograms.map((p) => (
                <label key={p} className="flex cursor-pointer items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={programFilters.includes(p)}
                    onChange={() => toggleProgram(p)}
                    className="h-3.5 w-3.5 rounded accent-red-600"
                  />
                  <span className="text-xs text-gray-700">{p}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        {allTypes.length > 0 && (
          <div>
            <p className="mb-1.5 text-xs font-medium text-gray-600">Property Type</p>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {allTypes.map((t) => (
                <label key={t} className="flex cursor-pointer items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={typeFilters.includes(t)}
                    onChange={() => toggleType(t)}
                    className="h-3.5 w-3.5 rounded accent-red-600"
                  />
                  <span className="text-xs text-gray-700">{t}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        <div>
          <p className="mb-1.5 text-xs font-medium text-gray-600">Tract</p>
          <FilterChips active={chipFilters} onChange={onChipFilter} showPriceRanges={false} />
        </div>
      </div>

      {/* Price range slider */}
      {(() => {
        const allPrices = listings.map((l) => l.price ?? 0);
        return allPrices.filter((p) => p > 0).length >= 2 ? (
          <PriceRangeFilter
            prices={allPrices}
            min={priceMin}
            max={priceMax}
            onChange={onPriceRange}
          />
        ) : null;
      })()}
    </div>
  );
}

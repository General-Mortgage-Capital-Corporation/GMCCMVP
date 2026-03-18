"use client";

import type { ChipFilter } from "@/lib/utils";

const BASE_CHIPS: { id: ChipFilter; label: string }[] = [
  { id: "lmi", label: "LMI Tract" },
  { id: "mmct", label: "MMCT" },
  { id: "aahp", label: "AA/HP ≥50%" },
];

const PRICE_CHIPS: { id: ChipFilter; label: string }[] = [
  { id: "under500k", label: "<$500K" },
  { id: "500kto1m", label: "$500K–$1M" },
  { id: "1mto3m", label: "$1M–$3M" },
  { id: "over3m", label: ">$3M" },
];

interface FilterChipsProps {
  active: Set<ChipFilter>;
  onChange: (filters: Set<ChipFilter>) => void;
  showPriceRanges?: boolean;
}

export default function FilterChips({
  active,
  onChange,
  showPriceRanges = false,
}: FilterChipsProps) {
  const chips = showPriceRanges
    ? [...BASE_CHIPS, ...PRICE_CHIPS]
    : BASE_CHIPS;

  function toggle(id: ChipFilter) {
    const next = new Set(active);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    onChange(next);
  }

  return (
    <div className="flex gap-2 overflow-x-auto md:flex-wrap">
      {chips.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          onClick={() => toggle(id)}
          className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
            active.has(id)
              ? "bg-red-600 text-white"
              : "bg-gray-100 text-gray-600 hover:bg-gray-200"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

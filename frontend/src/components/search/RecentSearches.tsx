"use client";

import { useState, useEffect } from "react";
import {
  getRecentSearches,
  clearRecentSearches,
  relativeTime,
  type RecentSearch,
} from "@/lib/recent-searches";

interface RecentSearchesProps {
  onSelect: (search: RecentSearch) => void;
  tab: "marketing" | "program" | "find";
  /** Bumped by parent after saving a new search so this component re-reads localStorage. */
  refreshKey?: number;
}

export default function RecentSearches({ onSelect, tab, refreshKey }: RecentSearchesProps) {
  const [searches, setSearches] = useState<RecentSearch[]>([]);

  useEffect(() => {
    setSearches(getRecentSearches(tab));
  }, [tab, refreshKey]);

  if (searches.length === 0) return null;

  function handleClear() {
    clearRecentSearches();
    setSearches([]);
  }

  return (
    <div className="mt-2 rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
      <div className="mb-1.5 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs font-medium text-gray-500">
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            className="text-gray-400"
          >
            <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M8 4.5V8l2.5 1.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Recent
        </div>
        <button
          type="button"
          onClick={handleClear}
          className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
        >
          Clear
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {searches.map((s) => {
          const key = s.tab === "find"
            ? `find-${s.query ?? ""}`
            : `${s.county_fips}-${s.tab}-${s.city ?? ""}-${s.program_name ?? ""}`;
          const label = s.tab === "find"
            ? (s.query ?? "Unknown")
            : s.city
              ? `${s.city}, ${s.county_name}, ${s.state}`
              : `${s.county_name}, ${s.state}`;
          const sub = s.program_name ? ` (${s.program_name})` : (s.radius ? ` ${s.radius}mi` : "");
          return (
            <button
              key={key}
              type="button"
              onClick={() => onSelect(s)}
              className="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700 shadow-sm transition-colors hover:border-red-300 hover:bg-red-50"
              title={`${label}${sub} -- ${relativeTime(s.timestamp)}`}
            >
              <span className="max-w-[200px] truncate">
                {label}
                {sub && <span className="text-gray-400">{sub}</span>}
              </span>
              <span className="text-gray-400">{relativeTime(s.timestamp)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

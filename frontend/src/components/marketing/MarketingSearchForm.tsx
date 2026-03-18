"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import type { ProgramLocationEntry, CountyEntry } from "@/types";
import RecentSearches from "@/components/search/RecentSearches";
import { saveRecentSearch, type RecentSearch } from "@/lib/recent-searches";

interface MarketingSearchFormProps {
  programLocations: ProgramLocationEntry[];
  onSearch: (params: { countyFips: string; city?: string }) => void;
  loading: boolean;
}

export default function MarketingSearchForm({
  programLocations,
  onSearch,
  loading,
}: MarketingSearchFormProps) {
  const [selectedState, setSelectedState] = useState("");
  const [selectedCounty, setSelectedCounty] = useState<CountyEntry | null>(
    null,
  );
  const [selectedCity, setSelectedCity] = useState("");
  const [recentRefresh, setRecentRefresh] = useState(0);

  // Aggregate unique states and counties across all programs
  const allStates = useMemo(() => {
    const stateMap = new Map<string, Map<string, CountyEntry>>();
    for (const prog of programLocations) {
      for (const stateEntry of prog.states) {
        if (!stateMap.has(stateEntry.state)) {
          stateMap.set(stateEntry.state, new Map());
        }
        const countyMap = stateMap.get(stateEntry.state)!;
        for (const county of stateEntry.counties) {
          if (!countyMap.has(county.fips)) {
            countyMap.set(county.fips, county);
          } else {
            // Merge cities
            const existing = countyMap.get(county.fips)!;
            const merged = Array.from(
              new Set([...existing.cities, ...county.cities]),
            ).sort();
            countyMap.set(county.fips, { ...existing, cities: merged });
          }
        }
      }
    }
    return stateMap;
  }, [programLocations]);

  const stateOptions = Array.from(allStates.keys()).sort();
  const countyOptions = selectedState
    ? Array.from(allStates.get(selectedState)?.values() ?? []).sort((a, b) =>
        a.county.localeCompare(b.county),
      )
    : [];
  const cityOptions = selectedCounty?.cities ?? [];

  useEffect(() => {
    setSelectedCounty(null);
    setSelectedCity("");
  }, [selectedState]);

  useEffect(() => {
    setSelectedCity("");
  }, [selectedCounty]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedCounty) return;
    saveRecentSearch({
      county_fips: selectedCounty.fips,
      county_name: selectedCounty.county,
      state: selectedState,
      city: selectedCity || undefined,
      timestamp: Date.now(),
      tab: "marketing",
    });
    setRecentRefresh((n) => n + 1);
    onSearch({
      countyFips: selectedCounty.fips,
      city: selectedCity || undefined,
    });
  }

  const handleRecentSelect = useCallback(
    (search: RecentSearch) => {
      // Set state first, then find matching county after state options update
      setSelectedState(search.state);
      // County options depend on the selected state, so resolve county from allStates
      const countyMap = allStates.get(search.state);
      const county = countyMap?.get(search.county_fips) ?? null;
      if (county) {
        setSelectedCounty(county);
        setSelectedCity(search.city ?? "");
        // Trigger search immediately
        onSearch({
          countyFips: search.county_fips,
          city: search.city,
        });
      }
    },
    [allStates, onSearch],
  );

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      {/* State */}
      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700">
          State
        </label>
        <select
          value={selectedState}
          onChange={(e) => setSelectedState(e.target.value)}
          required
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
        >
          <option value="">Select state...</option>
          {stateOptions.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      {/* County */}
      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700">
          County
        </label>
        <select
          value={selectedCounty?.fips ?? ""}
          onChange={(e) => {
            const county =
              countyOptions.find((c) => c.fips === e.target.value) ?? null;
            setSelectedCounty(county);
          }}
          disabled={!selectedState}
          required
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500 disabled:opacity-40"
        >
          <option value="">Select county...</option>
          {countyOptions.map((c) => (
            <option key={c.fips} value={c.fips}>
              {c.county}
            </option>
          ))}
        </select>
      </div>

      {/* City (optional) */}
      {cityOptions.length > 0 && (
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">
            City{" "}
            <span className="font-normal text-gray-400">(optional)</span>
          </label>
          <select
            value={selectedCity}
            onChange={(e) => setSelectedCity(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
          >
            <option value="">All cities</option>
            {cityOptions.map((city) => (
              <option key={city} value={city}>
                {city}
              </option>
            ))}
          </select>
        </div>
      )}

      <button
        type="submit"
        disabled={loading || !selectedCounty}
        className="w-full rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-red-700 disabled:opacity-50"
      >
        {loading ? "Loading..." : "Load Properties"}
      </button>

      <RecentSearches tab="marketing" onSelect={handleRecentSelect} refreshKey={recentRefresh} />
    </form>
  );
}

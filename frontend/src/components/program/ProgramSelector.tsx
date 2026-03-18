"use client";

import { useState, useEffect, useCallback } from "react";
import type { ProgramLocationEntry, CountyEntry } from "@/types";
import RecentSearches from "@/components/search/RecentSearches";
import { saveRecentSearch, type RecentSearch } from "@/lib/recent-searches";

interface ProgramSelectorProps {
  programLocations: ProgramLocationEntry[];
  onSearch: (params: {
    program: string;
    countyFips: string;
    city?: string;
  }) => void;
  loading: boolean;
}

export default function ProgramSelector({
  programLocations,
  onSearch,
  loading,
}: ProgramSelectorProps) {
  const [selectedProgram, setSelectedProgram] = useState("");
  const [selectedState, setSelectedState] = useState("");
  const [selectedCounty, setSelectedCounty] = useState<CountyEntry | null>(
    null,
  );
  const [selectedCity, setSelectedCity] = useState("");
  const [recentRefresh, setRecentRefresh] = useState(0);

  const stateOptions =
    programLocations.find((p) => p.program_name === selectedProgram)?.states ??
    [];
  const countyOptions =
    stateOptions.find((s) => s.state === selectedState)?.counties ?? [];
  const cityOptions = selectedCounty?.cities ?? [];

  useEffect(() => {
    setSelectedState("");
    setSelectedCounty(null);
    setSelectedCity("");
  }, [selectedProgram]);

  useEffect(() => {
    setSelectedCounty(null);
    setSelectedCity("");
  }, [selectedState]);

  useEffect(() => {
    setSelectedCity("");
  }, [selectedCounty]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedProgram || !selectedCounty) return;
    saveRecentSearch({
      county_fips: selectedCounty.fips,
      county_name: selectedCounty.county,
      state: selectedState,
      city: selectedCity || undefined,
      timestamp: Date.now(),
      tab: "program",
      program_name: selectedProgram,
    });
    setRecentRefresh((n) => n + 1);
    onSearch({
      program: selectedProgram,
      countyFips: selectedCounty.fips,
      city: selectedCity || undefined,
    });
  }

  const handleRecentSelect = useCallback(
    (search: RecentSearch) => {
      if (search.program_name) {
        setSelectedProgram(search.program_name);
        // Find the program's state/county options
        const prog = programLocations.find((p) => p.program_name === search.program_name);
        if (prog) {
          const stEntry = prog.states.find((s) => s.state === search.state);
          if (stEntry) {
            setSelectedState(search.state);
            const county = stEntry.counties.find((c) => c.fips === search.county_fips) ?? null;
            if (county) {
              setSelectedCounty(county);
              setSelectedCity(search.city ?? "");
              onSearch({
                program: search.program_name,
                countyFips: search.county_fips,
                city: search.city,
              });
            }
          }
        }
      }
    },
    [programLocations, onSearch],
  );

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      {/* Program */}
      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700">
          Program
        </label>
        <select
          value={selectedProgram}
          onChange={(e) => setSelectedProgram(e.target.value)}
          required
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
        >
          <option value="">Select a program...</option>
          {programLocations.map((p) => (
            <option key={p.program_name} value={p.program_name}>
              {p.program_name}
            </option>
          ))}
        </select>
      </div>

      {/* State */}
      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700">
          State
        </label>
        <select
          value={selectedState}
          onChange={(e) => setSelectedState(e.target.value)}
          disabled={!selectedProgram}
          required
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500 disabled:opacity-40"
        >
          <option value="">Select state...</option>
          {stateOptions.map((s) => (
            <option key={s.state} value={s.state}>
              {s.state}
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
        disabled={loading || !selectedProgram || !selectedCounty}
        className="w-full rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-red-700 disabled:opacity-50"
      >
        {loading ? "Searching..." : "Search Program Eligibility"}
      </button>

      <RecentSearches tab="program" onSelect={handleRecentSelect} refreshKey={recentRefresh} />
    </form>
  );
}

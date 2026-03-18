"use client";

import { useState, useEffect } from "react";
import type { ProgramLocationEntry, CountyEntry } from "@/types";

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
    onSearch({
      program: selectedProgram,
      countyFips: selectedCounty.fips,
      city: selectedCity || undefined,
    });
  }

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
    </form>
  );
}

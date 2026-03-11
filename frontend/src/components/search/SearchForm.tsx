"use client";

import { useState, useRef } from "react";
import dynamic from "next/dynamic";
import AddressAutocomplete from "@/components/AddressAutocomplete";
import type { AutocompleteSuggestion } from "@/types";

// Load MapWidget client-side only (Google Maps needs window)
const MapWidget = dynamic(() => import("./MapWidget"), { ssr: false });

interface SearchFormProps {
  programs: string[];
  onSearch: (params: {
    query: string;
    searchType: "area" | "specific";
    radius: number;
    selectedPrograms: string[];
    lat?: number;
    lng?: number;
  }) => void;
  loading: boolean;
}

export default function SearchForm({
  programs,
  onSearch,
  loading,
}: SearchFormProps) {
  const [query, setQuery] = useState("");
  const [searchType, setSearchType] = useState<"area" | "specific">("area");
  const [radius, setRadius] = useState(5);
  const [selectedPrograms, setSelectedPrograms] = useState<string[]>([]);
  const markerLatRef = useRef<number | undefined>(undefined);
  const markerLngRef = useRef<number | undefined>(undefined);

  function handleSelect(suggestion: AutocompleteSuggestion) {
    setQuery(suggestion.text.replace(", USA", ""));
  }

  function handleMarkerPlace(lat: number, lng: number, address: string) {
    setQuery(address);
    markerLatRef.current = lat;
    markerLngRef.current = lng;
  }

  function handleLatLngChange(lat: number | undefined, lng: number | undefined) {
    markerLatRef.current = lat;
    markerLngRef.current = lng;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    onSearch({
      query,
      searchType,
      radius,
      selectedPrograms,
      lat: markerLatRef.current,
      lng: markerLngRef.current,
    });
  }

  function toggleProgram(prog: string) {
    setSelectedPrograms((prev) =>
      prev.includes(prog) ? prev.filter((p) => p !== prog) : [...prev, prog],
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Location */}
      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700">
          Location
        </label>
        <AddressAutocomplete
          value={query}
          onChange={setQuery}
          onSelect={handleSelect}
          placeholder="Enter address or zip code..."
          required
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        {/* Search type */}
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">
            Type
          </label>
          <select
            value={searchType}
            onChange={(e) =>
              setSearchType(e.target.value as "area" | "specific")
            }
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="area">Area Search</option>
            <option value="specific">Exact Address</option>
          </select>
        </div>

        {/* Radius */}
        <div>
          <label className="mb-1 flex items-center justify-between text-sm font-medium text-gray-700">
            <span>Radius</span>
            <span className="font-normal text-blue-600">{radius} mi</span>
          </label>
          <input
            type="range"
            min={1}
            max={50}
            value={radius}
            onChange={(e) => setRadius(Number(e.target.value))}
            disabled={searchType === "specific"}
            className="w-full accent-blue-600 disabled:opacity-40"
          />
        </div>
      </div>

      {/* Programs filter */}
      {programs.length > 0 && (
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">
            Filter by Program{" "}
            <span className="font-normal text-gray-400">(optional)</span>
          </label>
          <div className="flex flex-wrap gap-2">
            {programs.map((prog) => (
              <button
                key={prog}
                type="button"
                onClick={() => toggleProgram(prog)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  selectedPrograms.includes(prog)
                    ? "bg-blue-600 text-white"
                    : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                {prog}
              </button>
            ))}
          </div>
        </div>
      )}

      <button
        type="submit"
        disabled={loading || !query.trim()}
        className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
      >
        {loading ? "Searching..." : "Search Properties"}
      </button>

      {/* Google Maps widget */}
      <MapWidget
        radius={radius}
        searchType={searchType}
        query={query}
        onMarkerPlace={handleMarkerPlace}
        onLatLngChange={handleLatLngChange}
      />
    </form>
  );
}

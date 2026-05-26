"use client";

import { useState, useRef } from "react";
import dynamic from "next/dynamic";
import AddressAutocomplete from "@/components/AddressAutocomplete";
import RecentSearches from "@/components/search/RecentSearches";
import { saveRecentSearch, type RecentSearch } from "@/lib/recent-searches";
import { authedFetch } from "@/lib/authed-fetch";
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
  const [recentKey, setRecentKey] = useState(0);
  const [geoLoading, setGeoLoading] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);
  const markerLatRef = useRef<number | undefined>(undefined);
  const markerLngRef = useRef<number | undefined>(undefined);

  async function handleUseCurrentLocation() {
    setGeoError(null);
    if (!("geolocation" in navigator)) {
      setGeoError("Geolocation not supported by this browser.");
      return;
    }
    setGeoLoading(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude, longitude } = pos.coords;
        try {
          const res = await authedFetch(
            `/api/reverse-geocode?lat=${latitude}&lng=${longitude}`,
          );
          const data = (await res.json()) as { address?: string | null };
          if (data.address) {
            setQuery(data.address);
            markerLatRef.current = latitude;
            markerLngRef.current = longitude;
          } else {
            setGeoError("Couldn't resolve your address. Try entering it manually.");
          }
        } catch {
          setGeoError("Couldn't resolve your address. Try entering it manually.");
        } finally {
          setGeoLoading(false);
        }
      },
      (err) => {
        setGeoLoading(false);
        setGeoError(
          err.code === err.PERMISSION_DENIED
            ? "Location permission denied. Enable it in your browser settings."
            : "Couldn't get your location. Try again.",
        );
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
    );
  }

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
    saveRecentSearch({
      county_fips: "",
      county_name: "",
      state: "",
      query: query.trim(),
      radius,
      timestamp: Date.now(),
      tab: "find",
    });
    setRecentKey((k) => k + 1);
    onSearch({
      query,
      searchType,
      radius,
      selectedPrograms,
      lat: markerLatRef.current,
      lng: markerLngRef.current,
    });
  }

  function handleRecentSelect(s: RecentSearch) {
    if (s.query) setQuery(s.query);
    if (s.radius) setRadius(s.radius);
    onSearch({
      query: s.query ?? "",
      searchType: "area",
      radius: s.radius ?? 5,
      selectedPrograms,
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
        <div className="mb-1 flex items-center justify-between">
          <label className="block text-sm font-medium text-gray-700">
            Location
          </label>
          <button
            type="button"
            onClick={handleUseCurrentLocation}
            disabled={geoLoading}
            className="flex items-center gap-1 text-xs font-medium text-red-600 hover:text-red-700 disabled:opacity-50"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-3.5 w-3.5"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
            </svg>
            {geoLoading ? "Locating..." : "Use current location"}
          </button>
        </div>
        <AddressAutocomplete
          value={query}
          onChange={setQuery}
          onSelect={handleSelect}
          placeholder="Enter address or zip code..."
          required
        />
        {geoError && (
          <p className="mt-1 text-xs text-red-600">{geoError}</p>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-red-500 sm:text-sm"
          >
            <option value="area">Area Search</option>
            <option value="specific">Exact Address</option>
          </select>
        </div>

        {/* Radius */}
        <div>
          <label className="mb-1 flex items-center justify-between text-sm font-medium text-gray-700">
            <span>Radius</span>
            <span className="font-normal text-red-600">{radius} mi</span>
          </label>
          <input
            type="range"
            min={1}
            max={50}
            value={radius}
            onChange={(e) => setRadius(Number(e.target.value))}
            disabled={searchType === "specific"}
            className="w-full accent-red-600 disabled:opacity-40"
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
                    ? "bg-red-600 text-white"
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
        className="w-full rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-red-700 disabled:opacity-50"
      >
        {loading ? "Searching..." : "Search Properties"}
      </button>

      <RecentSearches tab="find" onSelect={handleRecentSelect} refreshKey={recentKey} />

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

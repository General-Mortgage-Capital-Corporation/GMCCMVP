"use client";

import { useState, useRef } from "react";
import AddressAutocomplete from "@/components/AddressAutocomplete";
import LoadingSpinner from "@/components/LoadingSpinner";
import { formatCurrency, formatPct } from "@/lib/utils";
import type { AutocompleteSuggestion, CensusData } from "@/types";

function demoPct(count: number | undefined, total: number | undefined): string {
  if (count == null || !total) return "";
  return ` (${((count / total) * 100).toFixed(0)}%)`;
}

function ami(base: number | undefined, pct: number): string {
  return base ? formatCurrency(base * pct) : "N/A";
}

function Row({ label, value, children }: { label: string; value?: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <span className="text-sm text-gray-500">{label}</span>
      {children ?? <span className="text-sm font-semibold text-gray-900">{value}</span>}
    </div>
  );
}

interface CRAResult {
  census: CensusData;
  address: string;
}

export default function CRACheckTab() {
  const [address, setAddress] = useState("");
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CRAResult | null>(null);
  // Tracks which place_id we last prefetched for — discards stale results
  const activePlaceId = useRef<string | null>(null);

  // Prefetch coordinates when a suggestion is selected so submit is instant
  async function prefetchCoords(placeId: string) {
    activePlaceId.current = placeId;
    try {
      const geo = await fetch(`/api/place-details?place_id=${encodeURIComponent(placeId)}`).then(
        (r) => r.json() as Promise<{ lat: number | null; lng: number | null }>,
      );
      if (activePlaceId.current !== placeId) return; // stale — user moved on
      if (geo.lat != null && geo.lng != null) {
        setCoords({ lat: geo.lat, lng: geo.lng });
      }
    } catch {
      // non-critical — submit will fall back to address geocoding
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!address.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/cra-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          formattedAddress: address,
          ...(coords ? { latitude: coords.lat, longitude: coords.lng } : {}),
        }),
      });
      const data = await res.json();
      if (!data.success || !data.census_data) {
        setError(data.error ?? "Census data unavailable for this address.");
      } else {
        setResult({ census: data.census_data, address });
      }
    } catch {
      setError("Request failed. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  const c = result?.census;
  const total = c?.total_population;
  const mfi = c?.ffiec_mfi;

  const incomeLevel = c?.tract_income_level ?? "";
  const isLmi = ["low", "moderate"].includes(incomeLevel.toLowerCase());

  return (
    <div>
      {/* Search form */}
      <form onSubmit={handleSubmit} className="flex gap-3">
        <div className="flex-1">
          <AddressAutocomplete
            value={address}
            onChange={(v) => { setAddress(v); setCoords(null); activePlaceId.current = null; }}
            onSelect={(s: AutocompleteSuggestion) => {
              setAddress(s.text);
              setCoords(null);
              if (s.place_id) prefetchCoords(s.place_id);
            }}
            placeholder="Enter a property address…"
          />
        </div>
        <button
          type="submit"
          disabled={loading || !address.trim()}
          className="flex items-center gap-2 rounded-lg bg-red-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-red-700 disabled:opacity-50"
        >
          {loading && <LoadingSpinner size="sm" />}
          {loading ? "Checking…" : "Check"}
        </button>
      </form>

      {error && (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
          {error}
        </div>
      )}

      {result && c && (
        <div className="mt-5 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
          {/* Header */}
          <div className="border-b border-gray-100 bg-gray-50 px-5 py-4">
            <p className="truncate text-xs text-gray-400">{result.address}</p>
            <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1">
              {c.county_name && (
                <span className="text-sm text-gray-700">
                  <span className="font-medium">County:</span> {c.county_name}
                </span>
              )}
              {c.state_name && (
                <span className="text-sm text-gray-700">
                  <span className="font-medium">State:</span> {c.state_name}
                </span>
              )}
              {c.msa_code && (
                <span className="text-sm text-gray-700">
                  <span className="font-medium">MSA Code:</span> {c.msa_code}
                </span>
              )}
              {c.msa_name && (
                <span className="text-sm text-gray-500">{c.msa_name}</span>
              )}
            </div>
          </div>

          {/* Two-column table */}
          <div className="grid grid-cols-1 divide-y divide-gray-100 sm:grid-cols-2 sm:divide-x sm:divide-y-0">
            {/* Left — demographics */}
            <div className="divide-y divide-gray-100">
              <Row label="Tract Income Level">
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                    isLmi ? "bg-emerald-100 text-emerald-800" : "bg-gray-100 text-gray-700"
                  }`}
                >
                  {incomeLevel || "N/A"}
                </span>
              </Row>
              <Row label="Tract Minority" value={formatPct(c.tract_minority_pct)} />
              <Row label="Total Population" value={total?.toLocaleString() ?? "N/A"} />
              <Row
                label="Hispanic Population"
                value={
                  c.hispanic_population != null
                    ? `${c.hispanic_population.toLocaleString()}${demoPct(c.hispanic_population, total)}`
                    : "N/A"
                }
              />
              <Row
                label="Black Population"
                value={
                  c.black_population != null
                    ? `${c.black_population.toLocaleString()}${demoPct(c.black_population, total)}`
                    : "N/A"
                }
              />
              <Row
                label="Asian/Pacific Population"
                value={
                  c.asian_population != null
                    ? `${c.asian_population.toLocaleString()}${demoPct(c.asian_population, total)}`
                    : "N/A"
                }
              />
            </div>

            {/* Right — income thresholds */}
            <div className="divide-y divide-gray-100">
              <Row label="80% of Median Income"  value={ami(mfi, 0.8)} />
              <Row label="100% of Median Income" value={ami(mfi, 1.0)} />
              <Row label="150% of Median Income" value={ami(mfi, 1.5)} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

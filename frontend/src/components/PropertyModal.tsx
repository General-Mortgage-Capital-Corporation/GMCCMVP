"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  RentCastListing,
  ProgramResult,
  CensusData,
  TierResult,
  CriterionStatus,
} from "@/types";
import {
  formatPrice,
  formatNumber,
  formatCurrency,
  formatPct,
  renderSimpleMarkdown,
} from "@/lib/utils";
import { getExplanation } from "@/lib/api";
import ProgramBadge from "./ProgramBadge";
import LoadingSpinner from "./LoadingSpinner";

// ---------------------------------------------------------------------------
// Criterion status icons (inline SVG to avoid icon library dependency)
// ---------------------------------------------------------------------------

function StatusIcon({ status }: { status: CriterionStatus }) {
  if (status === "pass") {
    return (
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        className="shrink-0"
      >
        <path
          d="M13.3 4.3L6 11.6 2.7 8.3"
          stroke="#10b981"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (status === "fail") {
    return (
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        className="shrink-0"
      >
        <path
          d="M12 4L4 12M4 4l8 8"
          stroke="#ef4444"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      className="shrink-0"
    >
      <circle cx="8" cy="8" r="6" stroke="#94a3b8" strokeWidth="2" />
      <path
        d="M6.5 6a1.5 1.5 0 013 0c0 1-1.5 1-1.5 2M8 11h.01"
        stroke="#94a3b8"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function CensusPanel({ census }: { census: CensusData }) {
  const incomeLevel = census.tract_income_level ?? "N/A";
  const incomeBadge =
    incomeLevel === "Low" || incomeLevel === "Moderate"
      ? "bg-blue-100 text-blue-800"
      : "bg-gray-100 text-gray-700";

  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
      <h4 className="mb-3 text-sm font-semibold text-gray-900">
        Census / FFIEC Data
      </h4>
      <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <div>
          <span className="text-gray-500">MSA:</span>{" "}
          <span className="font-medium">{census.msa_name ?? census.msa_code ?? "N/A"}</span>
        </div>
        <div>
          <span className="text-gray-500">Tract Income:</span>{" "}
          <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${incomeBadge}`}>
            {incomeLevel}
          </span>
        </div>
        <div>
          <span className="text-gray-500">Minority %:</span>{" "}
          <span className="font-medium">{formatPct(census.tract_minority_pct)}</span>
        </div>
        <div>
          <span className="text-gray-500">Population:</span>{" "}
          <span className="font-medium">{formatNumber(census.population)}</span>
        </div>
        <div>
          <span className="text-gray-500">Median Family Income:</span>{" "}
          <span className="font-medium">{formatCurrency(census.median_family_income)}</span>
        </div>
        <div>
          <span className="text-gray-500">Tract Median Income:</span>{" "}
          <span className="font-medium">{formatCurrency(census.tract_median_income)}</span>
        </div>
        {census.demographics_total != null && census.demographics_total > 0 && (
          <>
            <div className="col-span-2 mt-2 border-t border-gray-200 pt-2">
              <span className="text-xs font-semibold text-gray-600">Demographics</span>
            </div>
            <div>
              <span className="text-gray-500">Hispanic:</span>{" "}
              <span className="font-medium">
                {formatPct(
                  census.demographics_hispanic != null
                    ? (census.demographics_hispanic / census.demographics_total) * 100
                    : null,
                )}
              </span>
            </div>
            <div>
              <span className="text-gray-500">Black:</span>{" "}
              <span className="font-medium">
                {formatPct(
                  census.demographics_black != null
                    ? (census.demographics_black / census.demographics_total) * 100
                    : null,
                )}
              </span>
            </div>
            <div>
              <span className="text-gray-500">Asian:</span>{" "}
              <span className="font-medium">
                {formatPct(
                  census.demographics_asian != null
                    ? (census.demographics_asian / census.demographics_total) * 100
                    : null,
                )}
              </span>
            </div>
            <div>
              <span className="text-gray-500">White:</span>{" "}
              <span className="font-medium">
                {formatPct(
                  census.demographics_white != null
                    ? (census.demographics_white / census.demographics_total) * 100
                    : null,
                )}
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function TierDetail({
  tier,
  listing,
  programName,
}: {
  tier: TierResult;
  listing: RentCastListing;
  programName: string;
}) {
  const [explanation, setExplanation] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleExplain = async () => {
    if (explanation || loading) return;
    setLoading(true);
    try {
      const res = await getExplanation(programName, listing, tier.tier_name);
      setExplanation(res.explanation ?? "No explanation available.");
    } catch {
      setExplanation("Failed to generate explanation.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-md border border-gray-200 p-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-gray-800">
          {tier.tier_name}
        </span>
        <ProgramBadge
          programName={tier.status}
          status={tier.status}
          compact
        />
      </div>

      <ul className="mt-2 space-y-1">
        {tier.criteria.map((c, i) => (
          <li key={i} className="flex items-center gap-2 text-xs text-gray-700">
            <StatusIcon status={c.status} />
            <span className="font-medium">{c.criterion}:</span>
            <span className="text-gray-500">{c.detail}</span>
          </li>
        ))}
      </ul>

      {tier.status !== "Ineligible" && (
        <div className="mt-2">
          {!explanation && !loading && (
            <button
              onClick={handleExplain}
              className="text-xs font-medium text-blue-600 hover:text-blue-800"
            >
              Generate talking points
            </button>
          )}
          {loading && <LoadingSpinner size="sm" label="Generating..." />}
          {explanation && (
            <div
              className="mt-1 rounded bg-blue-50 p-2 text-xs text-gray-700"
              dangerouslySetInnerHTML={{
                __html: renderSimpleMarkdown(explanation),
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main modal
// ---------------------------------------------------------------------------

interface PropertyModalProps {
  listing: RentCastListing | null;
  onClose: () => void;
}

export default function PropertyModal({ listing, onClose }: PropertyModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    if (!listing) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [listing, onClose]);

  // Close on overlay click
  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === overlayRef.current) onClose();
    },
    [onClose],
  );

  if (!listing) return null;

  const programs: ProgramResult[] = listing.matchData?.programs ?? [];
  const census = listing.censusData;
  const eligible = programs.filter((p) => p.status !== "Ineligible");
  const ineligible = programs.filter((p) => p.status === "Ineligible");

  return (
    <div
      ref={overlayRef}
      onClick={handleOverlayClick}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 pt-[5vh]"
    >
      <div className="relative w-full max-w-2xl rounded-xl bg-white shadow-2xl">
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute right-3 top-3 rounded-full p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          aria-label="Close"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path
              d="M15 5L5 15M5 5l10 10"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>

        <div className="space-y-5 p-6">
          {/* Header */}
          <div>
            <h2 className="text-xl font-bold text-gray-900">
              {formatPrice(listing.price)}
            </h2>
            <p className="text-sm text-gray-600">
              {listing.formattedAddress ?? "Address unavailable"}
            </p>
            <div className="mt-2 flex flex-wrap gap-2 text-xs text-gray-500">
              {listing.bedrooms != null && <span>{listing.bedrooms} bd</span>}
              {listing.bathrooms != null && <span>{listing.bathrooms} ba</span>}
              {listing.squareFootage != null && (
                <span>{listing.squareFootage.toLocaleString()} sqft</span>
              )}
              {listing.propertyType && <span>{listing.propertyType}</span>}
              {listing.yearBuilt != null && (
                <span>Built {listing.yearBuilt}</span>
              )}
              {listing.daysOnMarket != null && (
                <span>{listing.daysOnMarket} days on market</span>
              )}
            </div>
          </div>

          {/* Census panel */}
          {census && <CensusPanel census={census} />}

          {/* Eligible / Potentially Eligible programs */}
          {eligible.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-semibold text-gray-900">
                Eligible Programs ({eligible.length})
              </h3>
              <div className="space-y-3">
                {eligible.map((prog) => (
                  <div key={prog.program_name}>
                    <ProgramBadge
                      programName={prog.program_name}
                      status={prog.status}
                      bestTier={prog.best_tier}
                    />
                    <div className="mt-2 space-y-2 pl-2">
                      {prog.matching_tiers
                        .filter((t) => t.status !== "Ineligible")
                        .map((tier) => (
                          <TierDetail
                            key={tier.tier_name}
                            tier={tier}
                            listing={listing}
                            programName={prog.program_name}
                          />
                        ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Ineligible programs (collapsed) */}
          {ineligible.length > 0 && (
            <details className="group">
              <summary className="cursor-pointer text-sm font-medium text-gray-500 hover:text-gray-700">
                Ineligible Programs ({ineligible.length})
              </summary>
              <div className="mt-2 space-y-2 pl-2">
                {ineligible.map((prog) => (
                  <div key={prog.program_name} className="text-xs text-gray-500">
                    <span className="font-medium">{prog.program_name}</span>
                    {prog.matching_tiers.length > 0 && (
                      <ul className="mt-1 space-y-0.5 pl-3">
                        {prog.matching_tiers[0].criteria
                          .filter((c) => c.status === "fail")
                          .map((c, i) => (
                            <li key={i} className="flex items-center gap-1">
                              <StatusIcon status="fail" />
                              {c.criterion}: {c.detail}
                            </li>
                          ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            </details>
          )}

          {/* No match data */}
          {programs.length === 0 && (
            <p className="text-sm text-gray-400 italic">
              No program matching data available for this property.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

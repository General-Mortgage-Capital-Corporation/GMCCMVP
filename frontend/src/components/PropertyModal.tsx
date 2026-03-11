"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  RentCastListing,
  ProgramResult,
  CensusData,
  CriterionResult,
  CriterionStatus,
} from "@/types";
import {
  formatPrice,
  formatNumber,
  formatCurrency,
  formatPct,
  formatPhone,
  renderSimpleMarkdown,
} from "@/lib/utils";
import { getExplanation } from "@/lib/api";
import LoadingSpinner from "./LoadingSpinner";

// ---------------------------------------------------------------------------
// Criterion status icons
// ---------------------------------------------------------------------------

function StatusIcon({ status }: { status: CriterionStatus }) {
  if (status === "pass") {
    return (
      <span className="mt-0.5 shrink-0 text-emerald-500">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M13.3 4.3L6 11.6 2.7 8.3" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    );
  }
  if (status === "fail") {
    return (
      <span className="mt-0.5 shrink-0 text-red-500">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M12 4L4 12M4 4l8 8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
      </span>
    );
  }
  return (
    <span className="mt-0.5 shrink-0 text-slate-400">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.8" />
        <path d="M6.5 6a1.5 1.5 0 013 0c0 1-1.5 1-1.5 2M8 11h.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Section title (matches original .modal-section-title)
// ---------------------------------------------------------------------------
function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-3 border-b border-gray-200 pb-2 text-xs font-semibold uppercase tracking-widest text-gray-400">
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail grid item
// ---------------------------------------------------------------------------
function GridItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-gray-500">{label}</span>
      <span className="text-[0.9375rem] font-medium text-gray-900">{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MSA / Census panel
// ---------------------------------------------------------------------------

function demoPct(count: number | undefined, total: number | undefined): string {
  if (count == null || !total) return "";
  return ` (${((count / total) * 100).toFixed(0)}%)`;
}

function CensusPanel({ census }: { census: CensusData }) {
  const incomeLevel = census.tract_income_level ?? "N/A";
  const isLmi = ["low", "moderate"].includes(incomeLevel.toLowerCase());

  const minorityPct = census.tract_minority_pct;
  const isMMCT = minorityPct != null && minorityPct > 50;

  const majorityAaHp = census.majority_aa_hp;
  const majorityText =
    majorityAaHp === true ? "Yes" : majorityAaHp === false ? "No" : "N/A";

  const total = census.total_population;

  const tractMsaRatio =
    census.tract_to_msa_ratio != null
      ? census.tract_to_msa_ratio.toFixed(1) + "%"
      : "N/A";

  return (
    <div className="rounded-xl border border-sky-200 bg-sky-50 p-5">
      {/* Panel title with badges */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-widest text-sky-700">
          MSA / Census Tract Data
        </span>
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
            isLmi
              ? "bg-emerald-100 text-emerald-800"
              : "bg-red-100 text-red-700"
          }`}
        >
          {incomeLevel} Income
        </span>
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
            isMMCT
              ? "bg-emerald-100 text-emerald-800"
              : "bg-red-100 text-red-700"
          }`}
        >
          {isMMCT ? "In-MMCT" : "Not MMCT"}
        </span>
      </div>

      {/* Grid */}
      <div className="grid grid-cols-2 gap-x-6 gap-y-3">
        {[
          { label: "MSA/MD Code", value: census.msa_code ?? "N/A" },
          { label: "MSA Name", value: census.msa_name ?? "N/A" },
          { label: "Tract Income Level", value: incomeLevel },
          { label: "Tract Minority %", value: formatPct(minorityPct) },
          { label: "Majority AA/HP", value: majorityText },
          { label: "Total Population", value: formatNumber(total) },
          {
            label: "Hispanic Population",
            value:
              formatNumber(census.hispanic_population) +
              demoPct(census.hispanic_population, total),
          },
          {
            label: "Black Population",
            value:
              formatNumber(census.black_population) +
              demoPct(census.black_population, total),
          },
          {
            label: "Asian Population",
            value:
              formatNumber(census.asian_population) +
              demoPct(census.asian_population, total),
          },
          {
            label: "FFIEC MSA Median Income",
            value: formatCurrency(census.ffiec_mfi),
          },
          {
            label: "Tract Median Income",
            value: formatCurrency(census.tract_mfi),
          },
          { label: "Tract / MSA Ratio", value: tractMsaRatio },
        ].map(({ label, value }) => (
          <div key={label} className="flex flex-col gap-0.5">
            <span className="text-[0.75rem] text-sky-600/80">{label}</span>
            <span className="text-[0.875rem] font-medium text-sky-900">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Criteria grid (inside expanded program card)
// ---------------------------------------------------------------------------
function CriteriaGrid({ criteria }: { criteria: CriterionResult[] }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {criteria.map((c, idx) => (
        <div key={`${c.criterion}-${idx}`} className="flex items-start gap-1.5">
          <StatusIcon status={c.status} />
          <div>
            <div className="text-xs uppercase tracking-wide text-gray-400">
              {c.criterion.replace(/_/g, " ")}
            </div>
            <div className="text-[0.8125rem] text-gray-700">{c.detail}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Talking points (per-program)
// ---------------------------------------------------------------------------
function TalkingPoints({
  program,
  listing,
}: {
  program: ProgramResult;
  listing: RentCastListing;
}) {
  const [explanation, setExplanation] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleExplain = async () => {
    if (explanation || loading) return;
    setLoading(true);
    try {
      const res = await getExplanation(
        program.program_name,
        listing,
        program.best_tier ?? "",
      );
      setExplanation(res.explanation ?? "No explanation available.");
    } catch {
      setExplanation("Failed to generate talking points.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mt-3">
      {!explanation && !loading && (
        <button
          onClick={handleExplain}
          className="inline-flex items-center gap-1.5 rounded-md border border-transparent bg-blue-50 px-3 py-1.5 text-[0.8125rem] font-medium text-blue-600 transition-colors hover:border-blue-300"
        >
          Get Talking Points
        </button>
      )}
      {loading && (
        <div className="flex items-center gap-2 text-xs text-blue-600">
          <LoadingSpinner size="sm" />
          <span>Loading...</span>
        </div>
      )}
      {explanation && (
        <div
          className="mt-2 rounded-lg bg-gray-50 p-3 text-[0.875rem] leading-relaxed text-gray-700"
          dangerouslySetInnerHTML={{ __html: renderSimpleMarkdown(explanation) }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Accordion program card (eligible / potentially eligible)
// ---------------------------------------------------------------------------
function ProgramCard({
  program,
  listing,
}: {
  program: ProgramResult;
  listing: RentCastListing;
}) {
  const [expanded, setExpanded] = useState(false);

  const tier =
    program.matching_tiers.find((t) => t.tier_name === program.best_tier) ??
    program.matching_tiers[0];

  const tierLabel =
    program.best_tier && program.best_tier.length > 50
      ? program.best_tier.slice(0, 50) + "…"
      : (program.best_tier ?? "");

  const isDiamond = program.program_name === "GMCC Diamond";

  return (
    <div
      className={`overflow-hidden rounded-lg border ${
        expanded ? "border-gray-300" : "border-gray-200"
      } bg-white`}
    >
      {/* Header — clickable */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-gray-50"
      >
        <span className="flex-1 text-[0.9375rem] font-semibold text-gray-900">
          {program.program_name}
          {isDiamond && (
            <span className="ml-2 rounded-full bg-violet-100 px-1.5 py-0.5 text-[0.65rem] font-bold uppercase tracking-wide text-violet-700">
              Beta
            </span>
          )}
        </span>
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
            program.status === "Eligible"
              ? "bg-emerald-100 text-emerald-800"
              : "bg-amber-100 text-amber-700"
          }`}
        >
          {program.status}
        </span>
        {tierLabel && (
          <span className="hidden text-xs text-gray-400 sm:block">{tierLabel}</span>
        )}
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          className={`shrink-0 text-gray-400 transition-transform ${expanded ? "rotate-90" : ""}`}
        >
          <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {/* Body */}
      {expanded && (
        <div className="border-t border-gray-100 px-4 pb-4 pt-3">
          {isDiamond && (
            <div className="mb-3 rounded-md border border-violet-200 bg-violet-50 p-2.5 text-xs text-violet-700">
              Beta — Tract eligibility list may be outdated. Please verify before proceeding.
            </div>
          )}
          {tier && <CriteriaGrid criteria={tier.criteria} />}
          <TalkingPoints program={program} listing={listing} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ineligible programs (collapsible)
// ---------------------------------------------------------------------------
function IneligiblePrograms({ programs }: { programs: ProgramResult[] }) {
  return (
    <details className="group">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium text-gray-500 hover:text-gray-700">
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          className="transition-transform group-open:rotate-90"
        >
          <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Ineligible Programs ({programs.length})
      </summary>

      <div className="mt-3 space-y-2 pl-1">
        {programs.map((prog) => {
          // Collect all failed criteria across all tiers
          const failedCriteria = prog.matching_tiers.flatMap((t) =>
            t.criteria.filter((c) => c.status === "fail"),
          );
          return (
            <div
              key={prog.program_name}
              className="rounded-lg border border-red-100 bg-red-50 px-4 py-3"
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-gray-800">
                  {prog.program_name}
                </span>
                <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                  Ineligible
                </span>
              </div>
              {failedCriteria.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {failedCriteria.map((c, idx) => (
                    <li key={`${c.criterion}-${idx}`} className="flex items-start gap-1.5 text-xs text-gray-600">
                      <StatusIcon status="fail" />
                      <span>
                        <span className="font-medium capitalize">
                          {c.criterion.replace(/_/g, " ")}:
                        </span>{" "}
                        {c.detail}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </details>
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

  useEffect(() => {
    if (!listing) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [listing, onClose]);

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

  const agent = listing.listingAgent ?? {};
  const office = listing.listingOffice ?? {};
  const builder = listing.builder ?? {};
  const hoa = listing.hoa ?? {};

  let contactBlock: React.ReactNode = null;
  if (agent.name || agent.phone || agent.email) {
    contactBlock = (
      <div className="rounded-lg bg-gray-50 p-4">
        <div className="mb-1.5 font-semibold text-gray-900">
          {agent.name ?? "Agent"}
        </div>
        <div className="space-y-0.5 text-sm text-gray-600">
          {agent.phone && <div>Phone: {formatPhone(agent.phone)}</div>}
          {agent.email && <div>Email: {agent.email}</div>}
          {agent.website && (
            <div>
              Website:{" "}
              <a
                href={agent.website}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:underline"
              >
                {agent.website}
              </a>
            </div>
          )}
        </div>
      </div>
    );
  } else if (builder.name) {
    contactBlock = (
      <div className="rounded-lg bg-gray-50 p-4">
        <div className="mb-1.5 font-semibold text-gray-900">
          {builder.name} (Builder)
        </div>
        <div className="space-y-0.5 text-sm text-gray-600">
          {builder.phone && <div>Phone: {formatPhone(builder.phone)}</div>}
          {builder.development && <div>Development: {builder.development}</div>}
          {builder.website && (
            <div>
              Website:{" "}
              <a
                href={builder.website}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:underline"
              >
                {builder.website}
              </a>
            </div>
          )}
        </div>
      </div>
    );
  } else {
    contactBlock = (
      <div className="rounded-lg bg-gray-50 p-4 text-sm text-gray-500">
        No contact information available
      </div>
    );
  }

  return (
    <div
      ref={overlayRef}
      onClick={handleOverlayClick}
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/50 p-4 backdrop-blur-sm"
    >
      <div className="relative my-auto w-full max-w-2xl rounded-xl bg-white shadow-2xl">
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute right-4 top-4 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-gray-100 text-gray-500 transition-colors hover:bg-gray-200"
          aria-label="Close"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M12 4L4 12M4 4l8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>

        <div className="max-h-[90vh] overflow-y-auto rounded-xl">
          <div className="space-y-5 p-6">
            {/* ── Header ── */}
            <div className="pr-8">
              <div className="text-3xl font-bold tracking-tight text-gray-900">
                {formatPrice(listing.price)}
              </div>
              <div className="mt-1 text-base text-gray-600">
                {listing.formattedAddress ?? "Address unavailable"}
              </div>
            </div>

            {/* ── MSA / Census panel ── */}
            {census ? (
              <CensusPanel census={census} />
            ) : (
              <div className="rounded-xl border border-sky-200 bg-sky-50 p-4">
                <div className="mb-1 text-xs font-semibold uppercase tracking-widest text-sky-700">
                  MSA / Census Tract Data
                </div>
                <p className="text-sm italic text-gray-500">
                  Census data unavailable for this property.
                </p>
              </div>
            )}

            {/* ── Matching Programs ── */}
            <div>
              <SectionTitle>Matching Programs</SectionTitle>

              {!listing.matchData && (
                <p className="text-sm italic text-gray-400">
                  Match data not yet available.
                </p>
              )}

              {listing.matchData && eligible.length === 0 && (
                <p className="text-sm italic text-gray-400">
                  No matching GMCC programs found for this property.
                </p>
              )}

              {eligible.length > 0 && (
                <div className="space-y-2">
                  {eligible.map((prog) => (
                    <ProgramCard key={prog.program_name} program={prog} listing={listing} />
                  ))}
                </div>
              )}

              {ineligible.length > 0 && (
                <div className={eligible.length > 0 ? "mt-4" : ""}>
                  <IneligiblePrograms programs={ineligible} />
                </div>
              )}
            </div>

            {/* ── Property Details ── */}
            <div>
              <SectionTitle>Property Details</SectionTitle>
              <div className="grid grid-cols-2 gap-4">
                <GridItem label="Type" value={listing.propertyType ?? "N/A"} />
                <GridItem label="Bedrooms" value={listing.bedrooms != null ? String(listing.bedrooms) : "N/A"} />
                <GridItem label="Bathrooms" value={listing.bathrooms != null ? String(listing.bathrooms) : "N/A"} />
                <GridItem label="Square Footage" value={listing.squareFootage ? listing.squareFootage.toLocaleString() + " sq ft" : "N/A"} />
                <GridItem label="Lot Size" value={listing.lotSize ? listing.lotSize.toLocaleString() + " sq ft" : "N/A"} />
                <GridItem label="Year Built" value={listing.yearBuilt ? String(listing.yearBuilt) : "N/A"} />
                <GridItem label="HOA Fee" value={hoa.fee ? "$" + hoa.fee.toLocaleString() + "/mo" : "N/A"} />
                <GridItem label="Status" value={listing.status ?? "N/A"} />
              </div>
            </div>

            {/* ── Listing Information ── */}
            <div>
              <SectionTitle>Listing Information</SectionTitle>
              <div className="grid grid-cols-2 gap-4">
                <GridItem label="Listed Date" value={listing.listedDate ? listing.listedDate.slice(0, 10) : "N/A"} />
                <GridItem label="Days on Market" value={listing.daysOnMarket != null ? listing.daysOnMarket + " days" : "N/A"} />
                <GridItem label="MLS Number" value={listing.mlsNumber ?? "N/A"} />
                <GridItem label="Last Updated" value={listing.lastSeenDate ? listing.lastSeenDate.slice(0, 10) : "N/A"} />
              </div>
            </div>

            {/* ── Location ── */}
            <div>
              <SectionTitle>Location</SectionTitle>
              <div className="grid grid-cols-2 gap-4">
                <GridItem label="City" value={listing.city ?? "N/A"} />
                <GridItem label="State" value={listing.state ?? "N/A"} />
                <GridItem label="Zip Code" value={listing.zipCode ?? "N/A"} />
                <GridItem label="County" value={listing.county ?? "N/A"} />
              </div>
            </div>

            {/* ── Contact Information ── */}
            <div>
              <SectionTitle>Contact Information</SectionTitle>
              {contactBlock}
              {office.name && (
                <div className="mt-3 rounded-lg bg-gray-50 p-4">
                  <div className="mb-1.5 font-semibold text-gray-900">
                    {office.name} (Office)
                  </div>
                  <div className="space-y-0.5 text-sm text-gray-600">
                    {office.phone && <div>Phone: {formatPhone(office.phone)}</div>}
                    {office.email && <div>Email: {office.email}</div>}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

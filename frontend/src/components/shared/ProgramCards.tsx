"use client";

import { useState } from "react";
import DOMPurify from "dompurify";
import type { ProgramResult, RentCastListing } from "@/types";
import { renderSimpleMarkdown, formatPhoneInput } from "@/lib/utils";
import { getExplanation } from "@/lib/api";
import LoadingSpinner from "@/components/LoadingSpinner";
import FlierButton, { type RealtorInfo } from "@/components/flier/FlierButton";
import { StatusIcon, CriteriaGrid } from "./PropertyPanels";

// ---------------------------------------------------------------------------
// Talking points
// ---------------------------------------------------------------------------

export function TalkingPoints({
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
          className="inline-flex items-center gap-1.5 rounded-md border border-transparent bg-red-50 px-3 py-1.5 text-[0.8125rem] font-medium text-red-600 transition-colors hover:border-red-300"
        >
          Get Talking Points
        </button>
      )}
      {loading && (
        <div className="flex items-center gap-2 text-xs text-red-600">
          <LoadingSpinner size="sm" />
          <span>Loading...</span>
        </div>
      )}
      {explanation && (
        <div
          className="mt-2 rounded-lg bg-gray-50 p-3 text-[0.875rem] leading-relaxed text-gray-700"
          dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(renderSimpleMarkdown(explanation)) }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Program card
// ---------------------------------------------------------------------------

export function ProgramCard({
  program,
  listing,
  realtorInfo,
  propertyImage,
  selected,
  onToggleSelect,
}: {
  program: ProgramResult;
  listing: RentCastListing;
  realtorInfo: RealtorInfo;
  propertyImage?: string;
  selected?: boolean;
  onToggleSelect?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const tier =
    program.matching_tiers.find((t) => t.tier_name === program.best_tier) ??
    program.matching_tiers[0];

  const isDiamond = program.program_name === "GMCC Diamond CRA";

  return (
    <div
      className={`overflow-hidden rounded-lg border ${
        selected ? "border-red-300 ring-1 ring-red-200" : expanded ? "border-gray-300" : "border-gray-200"
      } bg-white`}
    >
      {/* Header row */}
      <div
        className="flex w-full cursor-pointer items-center gap-3 px-4 py-3.5 transition-colors hover:bg-gray-50"
        onClick={() => setExpanded((v) => !v)}
      >
        {/* Multi-select checkbox */}
        {onToggleSelect && (
          <input
            type="checkbox"
            checked={!!selected}
            onChange={(e) => { e.stopPropagation(); onToggleSelect(); }}
            onClick={(e) => e.stopPropagation()}
            className="h-4 w-4 shrink-0 rounded border-gray-300 text-red-600 focus:ring-red-500 cursor-pointer"
            title="Select for multi-program summary / email"
          />
        )}
        {/* Name + beta badge */}
        <span className="min-w-0 flex-1 text-[0.9375rem] font-semibold text-gray-900">
          {program.program_name}
          {isDiamond && (
            <span className="ml-2 rounded-full bg-violet-100 px-1.5 py-0.5 text-[0.65rem] font-bold uppercase tracking-wide text-violet-700">
              Beta
            </span>
          )}
        </span>

        {/* Eligibility badge */}
        <span
          className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${
            program.status === "Eligible"
              ? "bg-emerald-100 text-emerald-800"
              : "bg-amber-100 text-amber-700"
          }`}
        >
          {program.status}
        </span>

        {/* Flyer action buttons */}
        <FlierButton
          programName={program.program_name}
          propertyAddress={listing.formattedAddress}
          listingPrice={listing.price}
          realtorInfo={realtorInfo}
          propertyImage={propertyImage}
        />

        {/* Expand chevron */}
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          className={`shrink-0 text-gray-400 transition-transform ${expanded ? "rotate-90" : ""}`}
        >
          <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>

      {/* Expanded body: criteria + talking points */}
      {expanded && (
        <div className="border-t border-gray-100 px-4 pb-4 pt-3">
          {isDiamond && (
            <div className="mb-3 rounded-md border border-violet-200 bg-violet-50 p-2.5 text-xs text-violet-700">
              Beta — Tract eligibility list may be outdated.{" "}
              <a
                href="https://hub.collateralanalytics.com/correspondentsearch"
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold underline hover:text-violet-900"
                onClick={(e) => e.stopPropagation()}
              >
                Double-check this property&apos;s eligibility here
              </a>{" "}
              before proceeding.
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

export function IneligiblePrograms({ programs }: { programs: ProgramResult[] }) {
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
          const failedCriteria = prog.matching_tiers.flatMap((t) =>
            t.criteria.filter((c) => c.status === "fail"),
          );
          return (
            <div
              key={prog.program_name}
              className="rounded-lg border border-red-100 bg-red-50 px-4 py-3"
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-gray-800">{prog.program_name}</span>
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
// Edit Realtor panel
// ---------------------------------------------------------------------------

export function EditRealtorPanel({
  realtorInfo,
  onChange,
}: {
  realtorInfo: RealtorInfo;
  onChange: (info: RealtorInfo) => void;
}) {
  const fields: { key: keyof RealtorInfo; label: string; placeholder: string }[] = [
    { key: "name", label: "Name", placeholder: "Realtor name" },
    { key: "phone", label: "Phone", placeholder: "(xxx) xxx-xxxx" },
    { key: "email", label: "Email", placeholder: "Email address" },
    { key: "nmls", label: "NMLS #", placeholder: "NMLS license number" },
    { key: "company", label: "Company", placeholder: "Brokerage / company" },
  ];

  function handleChange(key: keyof RealtorInfo, raw: string) {
    onChange({ ...realtorInfo, [key]: key === "phone" ? formatPhoneInput(raw) : raw });
  }

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
      <p className="mb-3 text-xs text-amber-700">
        Edit realtor information for flyer generation and emails.
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {fields.map(({ key, label, placeholder }) => (
          <div key={key} className="flex flex-col gap-0.5">
            <label className="text-[0.7rem] font-medium text-amber-800 uppercase tracking-wide">
              {label}
            </label>
            <input
              type="text"
              value={realtorInfo[key]}
              placeholder={placeholder}
              onChange={(e) => handleChange(key, e.target.value)}
              className="rounded border border-amber-200 bg-white px-2 py-1.5 text-xs text-gray-700 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-amber-400"
            />
          </div>
        ))}
      </div>
    </div>
  );
}

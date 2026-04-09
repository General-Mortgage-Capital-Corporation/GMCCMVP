"use client";

import type { CensusData, CriterionResult, CriterionStatus } from "@/types";
import { formatNumber, formatCurrency, formatPct } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Criterion status icons
// ---------------------------------------------------------------------------

/**
 * StatusIcon
 *
 * By default renders:
 *   pass       → green check
 *   fail       → red X
 *   unverified → neutral grey question-mark
 *
 * Pass `variant="warning"` to override the unverified icon to an amber
 * warning triangle — used for unit_count on Multi-Family listings where
 * the ambiguity is load-bearing and should catch the LO's eye.
 */
export function StatusIcon({
  status,
  variant,
}: {
  status: CriterionStatus;
  variant?: "warning";
}) {
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
  // unverified
  if (variant === "warning") {
    return (
      <span className="mt-0.5 shrink-0 text-amber-500">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M8 1.5l6.5 12H1.5L8 1.5z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
          <path d="M8 6v3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <circle cx="8" cy="11.75" r="0.9" fill="currentColor" />
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
// Section title
// ---------------------------------------------------------------------------

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-3 border-b border-gray-200 pb-2 text-xs font-semibold uppercase tracking-widest text-gray-400">
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Grid item (label + value)
// ---------------------------------------------------------------------------

export function GridItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-gray-500">{label}</span>
      <span className="text-[0.9375rem] font-medium text-gray-900">{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Census / MSA panel
// ---------------------------------------------------------------------------

function demoPct(count: number | undefined, total: number | undefined): string {
  if (count == null || !total) return "";
  return ` (${((count / total) * 100).toFixed(0)}%)`;
}

export function CensusPanel({ census }: { census: CensusData }) {
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
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-widest text-sky-700">
          MSA / Census Tract Data
        </span>
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
            isLmi ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-700"
          }`}
        >
          {incomeLevel} Income
        </span>
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
            isMMCT ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-700"
          }`}
        >
          {isMMCT ? "In-MMCT" : "Not MMCT"}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
        {[
          { label: "MSA/MD Code", value: census.msa_code ?? "Non-Metro" },
          { label: "MSA Name", value: census.msa_name && census.msa_name !== "N/A" ? census.msa_name : "Rural / Non-Metropolitan" },
          { label: "Tract Income Level", value: incomeLevel },
          { label: "Tract Minority %", value: formatPct(minorityPct) },
          { label: "Majority AA/HP", value: majorityText },
          { label: "Total Population", value: formatNumber(total) },
          {
            label: "Hispanic Population",
            value: formatNumber(census.hispanic_population) + demoPct(census.hispanic_population, total),
          },
          {
            label: "Black Population",
            value: formatNumber(census.black_population) + demoPct(census.black_population, total),
          },
          {
            label: "Asian Population",
            value: formatNumber(census.asian_population) + demoPct(census.asian_population, total),
          },
          { label: "MSA MFI", value: formatCurrency(census.ffiec_mfi) },
          { label: "Tract MFI", value: formatCurrency(census.tract_mfi) },
          { label: "Tract / MSA Ratio", value: tractMsaRatio },
          { label: "80% MFI", value: census.ffiec_mfi ? formatCurrency(Math.round(census.ffiec_mfi * 0.8)) : "N/A" },
          { label: "100% MFI", value: census.ffiec_mfi ? formatCurrency(census.ffiec_mfi) : "N/A" },
          { label: "150% MFI", value: census.ffiec_mfi ? formatCurrency(Math.round(census.ffiec_mfi * 1.5)) : "N/A" },
          { label: "200% MFI", value: census.ffiec_mfi ? formatCurrency(Math.round(census.ffiec_mfi * 2.0)) : "N/A" },
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
// Criteria grid
// ---------------------------------------------------------------------------

export function CriteriaGrid({ criteria }: { criteria: CriterionResult[] }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {criteria.map((c, idx) => {
        // Unit count on an unverified Multi-Family / Apartment listing is the
        // single most important warning on this panel — it's the difference
        // between "this is a duplex that qualifies for CRA" and "this is a
        // 14-unit apartment building that legally cannot qualify." Give it a
        // full-width amber callout so it can't be skimmed past.
        const isUnitCountWarning =
          c.criterion === "unit_count" && c.status === "unverified";

        if (isUnitCountWarning) {
          return (
            <div
              key={`${c.criterion}-${idx}`}
              className="sm:col-span-2 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2.5"
            >
              <StatusIcon status={c.status} variant="warning" />
              <div className="min-w-0">
                <div className="text-[0.7rem] font-semibold uppercase tracking-wide text-amber-700">
                  Unit count not verified — action required
                </div>
                <div className="mt-0.5 text-[0.8125rem] leading-relaxed text-amber-900">
                  {c.detail}
                </div>
              </div>
            </div>
          );
        }

        return (
          <div key={`${c.criterion}-${idx}`} className="flex items-start gap-1.5">
            <StatusIcon status={c.status} />
            <div>
              <div className="text-xs uppercase tracking-wide text-gray-400">
                {c.criterion.replace(/_/g, " ")}
              </div>
              <div className="text-[0.8125rem] text-gray-700">{c.detail}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

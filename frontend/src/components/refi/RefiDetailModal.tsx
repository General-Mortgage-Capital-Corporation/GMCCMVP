"use client";

import { useEffect } from "react";
import type { RefiRow } from "./types";
import type { UnlockedContact } from "./RefiUnlockModal";

function fmtMoney(v: number | undefined | null): string {
  if (v == null || !isFinite(v)) return "—";
  return `$${Math.round(v).toLocaleString()}`;
}
function fmtPct(v: number | undefined | null, digits = 1): string {
  if (v == null || !isFinite(v)) return "—";
  return `${v.toFixed(digits)}%`;
}
function fmtDate(v: string | undefined | null): string {
  if (!v) return "—";
  const d = new Date(v);
  if (isNaN(d.getTime())) return v;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}
function ownerName(r: RefiRow): string {
  if (r.Owner) return r.Owner;
  const fl = `${r.OwnerFirstName ?? ""} ${r.OwnerLastName ?? ""}`.trim();
  return fl || "(entity owner)";
}

export default function RefiDetailModal({ row, contact, onClose }: { row: RefiRow; contact?: UnlockedContact; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center" onClick={onClose}>
      <div className="relative max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-gray-100 bg-white px-6 py-4">
          <div>
            <div className="text-lg font-semibold text-gray-900">{row.Address}</div>
            <div className="text-sm text-gray-500">{row.City}, {row.State} {row.ZipFive} · APN {row.APN ?? "—"} · {row.County ?? ""}</div>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700" aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none"><path d="M12 4L4 12M4 4l8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          </button>
        </div>

        <div className="space-y-4 px-6 py-5">
          {/* Headline metrics */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric label="Current value (AVM)" value={fmtMoney(row.AVM)} sub={row.AVMAsOf ? `as of ${fmtDate(row.AVMAsOf)}` : ""} />
            <Metric label="Available equity" value={fmtMoney(row.AvailableEquity)} sub={fmtPct(row.EquityPercent, 0)} />
            <Metric label="Combined LTV" value={fmtPct(row.CLTV, 0)} sub={`${row.NumberLoans ?? 0} open lien${row.NumberLoans === 1 ? "" : "s"}`} />
            <Metric label="Est. current balance" value={fmtMoney(row.TotalLoanBalance)} sub="amortized estimate" />
          </div>

          {/* Owner */}
          <Section title="Owner">
            <Field label="Name" value={ownerName(row)} />
            <Field label="Ownership type" value={row.OwnershipType ?? "—"} />
            <Field label="Owner-occupied" value={row.isSameMailingOrExempt === 1 ? "Yes" : "No"} />
            {(contact?.phone || contact?.email) && (
              <>
                {contact?.phone && <Field label="Phone" value={contact.phone} />}
                {contact?.email && <Field label="Email" value={contact.email} />}
              </>
            )}
          </Section>

          {/* First mortgage */}
          <Section title="First mortgage (the refi target)">
            <Field label="Originated" value={fmtDate(row.FirstDate)} />
            <Field label="Original amount" value={fmtMoney(row.FirstAmount)} />
            <Field label="Lender (at origination)" value={row.FirstLenderOriginal ?? "—"} />
            <Field label="Purpose" value={row.FirstPurpose ?? "—"} />
            <Field label="Loan type" value={row.FirstLoanType ?? "—"} />
            <Field label="Rate type" value={row.FirstRateType ?? "—"} />
            <Field label="Term" value={row.FirstTermInYears ? `${row.FirstTermInYears} years` : "—"} />
            <Field
              label="Est. rate"
              value={row.FirstRate != null ? `${fmtPct(row.FirstRate, 2)} (est.)` : "—"}
              hint="Rate is modeled for fixed-rate loans — actual rate lives in the unrecorded promissory note."
            />
          </Section>

          {(row.SecondAmount || row.SecondLenderOriginal) && (
            <Section title="Second mortgage">
              <Field label="Amount" value={fmtMoney(row.SecondAmount)} />
              <Field label="Lender" value={row.SecondLenderOriginal ?? "—"} />
            </Section>
          )}

          {/* Property */}
          <Section title="Property">
            <Field label="Type" value={row.AdvancedPropertyType ?? row.PType ?? "—"} />
            <Field label="Beds / Baths" value={`${row.Beds ?? "—"} bd / ${row.Baths ?? "—"} ba`} />
            <Field label="Square feet" value={row.SqFt ? row.SqFt.toLocaleString() : "—"} />
            <Field label="Year built" value={row.YearBuilt?.toString() ?? "—"} />
            <Field label="Annual taxes" value={fmtMoney(row.AnnualTaxes)} />
            <Field label="Last sale" value={`${fmtDate(row.LastTransferRecDate)} · ${fmtMoney(row.LastTransferValue)}`} />
          </Section>

          {/* Census / tract */}
          {row.census && (
            <Section title="Census tract (FFIEC)">
              <Field label="MSA" value={row.census.msa_name ?? "—"} />
              <Field label="Tract income level" value={row.census.tract_income_level ?? "—"} />
              <Field label="Tract minority %" value={row.census.tract_minority_pct != null ? fmtPct(row.census.tract_minority_pct, 1) : "—"} />
              <Field label="Tract MFI" value={fmtMoney(row.census.tract_mfi)} />
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2">
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums text-gray-900">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-gray-500">{sub}</div>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-gray-100 bg-white">
      <div className="border-b border-gray-100 px-4 py-2 text-xs font-medium uppercase tracking-wide text-gray-500">{title}</div>
      <div className="grid grid-cols-1 gap-x-6 gap-y-2 px-4 py-3 text-sm sm:grid-cols-2">{children}</div>
    </div>
  );
}

function Field({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <div className="text-gray-500">{label}</div>
      <div className="text-right text-gray-900" title={hint}>{value}</div>
    </div>
  );
}

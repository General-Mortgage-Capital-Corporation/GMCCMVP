"use client";

import { useState } from "react";
import type {
  BorrowerResidency,
  BuydownType,
  CreditEvent,
  DocType,
  LoanPurpose,
  Occupancy,
} from "@/types/pricing";
import type { ScenarioInputs } from "@/lib/pricing/scenario";

interface Props {
  inputs: ScenarioInputs;
  onChange: (next: ScenarioInputs) => void;
  /** Listing price — shown to compute loan amount. */
  listingPrice: number | null;
  /** State code from listing. */
  state: string | null;
  className?: string;
}

const OCCUPANCY_OPTIONS: { value: Occupancy; label: string }[] = [
  { value: "primary", label: "Primary" },
  { value: "second_home", label: "Second home" },
  { value: "investment", label: "Investment" },
];

const RESIDENCY_OPTIONS: { value: BorrowerResidency; label: string }[] = [
  { value: "us_citizen", label: "US citizen" },
  { value: "permanent_resident", label: "Permanent resident" },
  { value: "npra", label: "NPRA" },
  { value: "foreign_national", label: "Foreign national" },
  { value: "other", label: "Other" },
];

const BUYDOWN_OPTIONS: { value: BuydownType; label: string }[] = [
  { value: "none", label: "None" },
  { value: "3-2-1", label: "3-2-1" },
  { value: "2-1", label: "2-1" },
  { value: "1-1", label: "1-1" },
  { value: "1-0", label: "1-0" },
];

const PREPAY_OPTIONS: { value: 0 | 12 | 24 | 36 | 60; label: string }[] = [
  { value: 0, label: "None" },
  { value: 12, label: "12 mo" },
  { value: 24, label: "24 mo" },
  { value: 36, label: "36 mo" },
  { value: 60, label: "60 mo" },
];

const MORTGAGE_LATE_OPTIONS = [
  { value: "none", label: "None" },
  { value: "within_12mo", label: "Within 12mo" },
  { value: "within_24mo", label: "Within 24mo" },
] as const;

const BANKRUPTCY_OPTIONS = [
  { value: "none", label: "None" },
  { value: "chapter_7_lt_4yr", label: "Ch 7, < 4yr" },
  { value: "chapter_7_gte_4yr", label: "Ch 7, ≥ 4yr" },
  { value: "chapter_13_lt_4yr", label: "Ch 13, < 4yr" },
  { value: "chapter_13_gte_4yr", label: "Ch 13, ≥ 4yr" },
] as const;

const CE_AGE_OPTIONS = [
  { value: "none", label: "None" },
  { value: "lt_4yr", label: "< 4yr" },
  { value: "gte_4yr", label: "≥ 4yr" },
] as const;

const DOC_OPTIONS: { value: DocType; label: string }[] = [
  { value: "full_doc", label: "Full doc" },
  { value: "1099_12mo", label: "1099 (12mo)" },
  { value: "1099_24mo", label: "1099 (24mo)" },
  { value: "bank_stmt_12mo_personal", label: "Bank stmt 12mo (personal)" },
  { value: "bank_stmt_12mo_business", label: "Bank stmt 12mo (business)" },
  { value: "bank_stmt_24mo_personal", label: "Bank stmt 24mo (personal)" },
  { value: "bank_stmt_24mo_business", label: "Bank stmt 24mo (business)" },
  { value: "asset_depletion", label: "Asset depletion" },
  { value: "wvoe", label: "WVOE" },
  { value: "dscr", label: "DSCR" },
];

const PURPOSE_OPTIONS: { value: LoanPurpose; label: string }[] = [
  { value: "purchase", label: "Purchase" },
  { value: "rate_term_refi", label: "Rate/term refi" },
  { value: "cash_out_refi", label: "Cash-out refi" },
];

function fmtMoney(n?: number | null): string {
  if (!n) return "—";
  return `$${n.toLocaleString()}`;
}

export default function ScenarioForm({ inputs, onChange, listingPrice, state, className }: Props) {
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const set = <K extends keyof ScenarioInputs>(key: K, value: ScenarioInputs[K]) => {
    onChange({ ...inputs, [key]: value });
  };

  const purchase = listingPrice ?? 0;
  const downPmt = Math.round(purchase * (inputs.down_payment_pct / 100));
  const loanAmount = inputs.loan_amount_override ?? Math.round(purchase - downPmt);

  return (
    <div className={className}>
      {/* Quick row */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="FICO">
          <input
            type="number"
            min={300}
            max={850}
            step={5}
            value={inputs.fico}
            onChange={(e) => set("fico", e.target.value === "" ? 0 : Number(e.target.value))}
            onBlur={(e) => {
              const n = Number(e.target.value);
              if (!Number.isFinite(n) || n < 300) set("fico", 300);
              else if (n > 850) set("fico", 850);
            }}
            className="w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-sm font-semibold tabular-nums text-slate-900 outline-none transition focus:border-red-400 focus:ring-2 focus:ring-red-100"
          />
        </Field>
        <Field label="Down %">
          <div className="relative">
            <input
              type="number"
              min={0}
              max={99}
              step={1}
              value={inputs.down_payment_pct}
              onChange={(e) =>
                set("down_payment_pct", e.target.value === "" ? 0 : Number(e.target.value))
              }
              onBlur={(e) => {
                const n = Number(e.target.value);
                if (!Number.isFinite(n) || n < 0) set("down_payment_pct", 0);
                else if (n > 99) set("down_payment_pct", 99);
              }}
              className="w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5 pr-6 text-sm font-semibold tabular-nums text-slate-900 outline-none transition focus:border-red-400 focus:ring-2 focus:ring-red-100"
            />
            <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-slate-400">
              %
            </span>
          </div>
        </Field>
        <Field label="Occupancy">
          <select
            value={inputs.occupancy}
            onChange={(e) => set("occupancy", e.target.value as Occupancy)}
            className="w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm font-semibold text-slate-900 outline-none transition focus:border-red-400 focus:ring-2 focus:ring-red-100"
          >
            {OCCUPANCY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Doc type">
          <select
            value={inputs.doc_type}
            onChange={(e) => set("doc_type", e.target.value as DocType)}
            className="w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm font-semibold text-slate-900 outline-none transition focus:border-red-400 focus:ring-2 focus:ring-red-100"
          >
            {DOC_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {/* Computed summary */}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-slate-100 bg-slate-50/60 px-3 py-2 text-xs text-slate-600">
        <span>
          Loan amount: <strong className="font-semibold tabular-nums text-slate-900">{fmtMoney(loanAmount)}</strong>
        </span>
        <span className="text-slate-300">·</span>
        <span>
          Down payment: <strong className="font-semibold tabular-nums text-slate-900">{fmtMoney(downPmt)}</strong>
        </span>
        <span className="text-slate-300">·</span>
        <span>
          Property: <strong className="font-semibold tabular-nums text-slate-900">{fmtMoney(purchase)}</strong>
        </span>
        {state && (
          <>
            <span className="text-slate-300">·</span>
            <span>
              State: <strong className="font-semibold text-slate-900">{state}</strong>
            </span>
          </>
        )}
      </div>

      {/* Advanced disclosure */}
      <button
        type="button"
        onClick={() => setAdvancedOpen((v) => !v)}
        className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-slate-500 transition-colors hover:text-slate-700"
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 16 16"
          className={`transition-transform ${advancedOpen ? "rotate-90" : ""}`}
          fill="none"
        >
          <path d="M5 4l5 4-5 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Advanced
      </button>

      {advancedOpen && (
        <div className="mt-3 space-y-4 rounded-md border border-slate-100 bg-white p-3">
          {/* ── Loan structure ── */}
          <Subsection title="Loan structure">
            <Field label="Loan purpose">
              <select
                value={inputs.loan_purpose ?? "purchase"}
                onChange={(e) => set("loan_purpose", e.target.value as LoanPurpose)}
                className={selectClass}
              >
                {PURPOSE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="DTI %">
              <input
                type="number"
                min={0}
                max={100}
                step={1}
                value={inputs.dti ?? 43}
                onChange={(e) => set("dti", e.target.value === "" ? 0 : Number(e.target.value))}
                onBlur={(e) => {
                  const n = Number(e.target.value);
                  if (!Number.isFinite(n) || n < 0) set("dti", 0);
                  else if (n > 100) set("dti", 100);
                }}
                className={inputClass}
              />
            </Field>
            <Field label="Lock period">
              <select
                value={inputs.lock_period ?? 30}
                onChange={(e) =>
                  set("lock_period", Number(e.target.value) as 15 | 30 | 45 | 60)
                }
                className={selectClass}
              >
                {[15, 30, 45, 60].map((n) => (
                  <option key={n} value={n}>
                    {n} days
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Loan amount override">
              <input
                type="number"
                placeholder="Auto"
                value={inputs.loan_amount_override ?? ""}
                onChange={(e) =>
                  set(
                    "loan_amount_override",
                    e.target.value ? Math.max(0, Number(e.target.value)) : undefined,
                  )
                }
                className={inputClass}
              />
            </Field>
            {inputs.loan_purpose === "cash_out_refi" && (
              <Field label="Cash-out amount">
                <input
                  type="number"
                  value={inputs.cash_out_amount ?? ""}
                  onChange={(e) =>
                    set("cash_out_amount", e.target.value ? Number(e.target.value) : undefined)
                  }
                  className={inputClass}
                />
              </Field>
            )}
            <Field label="Buydown">
              <select
                value={inputs.buydown_type ?? "none"}
                onChange={(e) => set("buydown_type", e.target.value as BuydownType)}
                className={selectClass}
              >
                {BUYDOWN_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Prepay penalty">
              <select
                value={inputs.prepay_penalty_months ?? 0}
                onChange={(e) =>
                  set("prepay_penalty_months", Number(e.target.value) as 0 | 12 | 24 | 36 | 60)
                }
                className={selectClass}
              >
                {PREPAY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
          </Subsection>

          {/* ── Borrower & property attributes ── */}
          <div>
            <div className="mb-2 flex items-baseline justify-between">
              <h4 className="text-[0.65rem] font-bold uppercase tracking-widest text-slate-500">
                Borrower &amp; property
              </h4>
            </div>
            {/* Row 1: residency on its own — selects look heavy next to checkboxes */}
            <div className="grid grid-cols-1 gap-2.5 sm:max-w-xs">
              <Field label="Residency">
                <select
                  value={inputs.borrower_residency ?? "us_citizen"}
                  onChange={(e) => set("borrower_residency", e.target.value as BorrowerResidency)}
                  className={selectClass}
                >
                  {RESIDENCY_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            {/* Row 2: flag checkboxes — equal-height, wrap freely */}
            <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-4">
              <CheckboxField
                label="Self-employed"
                checked={!!inputs.self_employed}
                onChange={(v) => set("self_employed", v)}
              />
              <CheckboxField
                label="First-time homebuyer"
                checked={!!inputs.first_time_homebuyer}
                onChange={(v) => set("first_time_homebuyer", v)}
              />
              <CheckboxField
                label="First-time investor"
                checked={!!inputs.first_time_investor}
                onChange={(v) => set("first_time_investor", v)}
              />
              <CheckboxField
                label="Interest only"
                checked={!!inputs.interest_only}
                onChange={(v) => set("interest_only", v)}
              />
              <CheckboxField
                label="40-year term"
                checked={!!inputs.forty_year_term}
                onChange={(v) => set("forty_year_term", v)}
              />
              <CheckboxField
                label="Escrow waived"
                checked={!!inputs.escrow_waived}
                onChange={(v) => set("escrow_waived", v)}
              />
              <CheckboxField
                label="Short-term rental"
                checked={!!inputs.short_term_rental}
                onChange={(v) => set("short_term_rental", v)}
              />
              <CheckboxField
                label="Rural property"
                checked={!!inputs.rural_property}
                onChange={(v) => set("rural_property", v)}
              />
              <CheckboxField
                label="Buy without sell"
                checked={!!inputs.buy_without_sell}
                onChange={(v) => set("buy_without_sell", v)}
              />
            </div>
          </div>

          {/* ── Credit history ── */}
          <Subsection title="Credit history" hint="Defaults to clean credit. Change only when applicable.">
            <Field label="Mortgage late">
              <select
                value={inputs.credit_event?.mortgage_late_payment ?? "none"}
                onChange={(e) =>
                  setCredit("mortgage_late_payment", e.target.value as NonNullable<CreditEvent["mortgage_late_payment"]>)
                }
                className={selectClass}
              >
                {MORTGAGE_LATE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Bankruptcy">
              <select
                value={inputs.credit_event?.bankruptcy ?? "none"}
                onChange={(e) =>
                  setCredit("bankruptcy", e.target.value as NonNullable<CreditEvent["bankruptcy"]>)
                }
                className={selectClass}
              >
                {BANKRUPTCY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Foreclosure">
              <select
                value={inputs.credit_event?.foreclosure ?? "none"}
                onChange={(e) =>
                  setCredit("foreclosure", e.target.value as NonNullable<CreditEvent["foreclosure"]>)
                }
                className={selectClass}
              >
                {CE_AGE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Deed in lieu">
              <select
                value={inputs.credit_event?.deed_in_lieu ?? "none"}
                onChange={(e) =>
                  setCredit("deed_in_lieu", e.target.value as NonNullable<CreditEvent["deed_in_lieu"]>)
                }
                className={selectClass}
              >
                {CE_AGE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Short sale">
              <select
                value={inputs.credit_event?.short_sale ?? "none"}
                onChange={(e) =>
                  setCredit("short_sale", e.target.value as NonNullable<CreditEvent["short_sale"]>)
                }
                className={selectClass}
              >
                {CE_AGE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
          </Subsection>
        </div>
      )}
    </div>
  );

  function setCredit<K extends keyof CreditEvent>(key: K, value: CreditEvent[K]) {
    onChange({
      ...inputs,
      credit_event: {
        ...(inputs.credit_event ?? {}),
        [key]: value,
      },
    });
  }
}

const selectClass =
  "w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-900 outline-none focus:border-red-400 focus:ring-2 focus:ring-red-100";

const inputClass =
  "w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-sm tabular-nums text-slate-900 outline-none focus:border-red-400 focus:ring-2 focus:ring-red-100";

function Subsection({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <h4 className="text-[0.65rem] font-bold uppercase tracking-widest text-slate-500">
          {title}
        </h4>
        {hint && <span className="text-[0.65rem] italic text-slate-400">{hint}</span>}
      </div>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[0.65rem] font-semibold uppercase tracking-widest text-slate-400">
        {label}
      </span>
      {children}
    </label>
  );
}

function CheckboxField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label
      className={`flex cursor-pointer select-none items-center gap-2 rounded-md border px-2.5 py-2 text-xs font-medium transition-colors ${
        checked
          ? "border-red-300 bg-red-50 text-red-800"
          : "border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50"
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 shrink-0 rounded border-slate-300 text-red-600 focus:ring-red-400"
      />
      <span className="truncate">{label}</span>
    </label>
  );
}

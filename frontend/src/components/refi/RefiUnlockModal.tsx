"use client";

import { useEffect, useMemo, useState } from "react";
import type { RefiRow } from "./types";

export type UnlockedPerson = {
  person_key?: string;
  name?: string;
  role?: string;
  is_primary?: boolean;
  phones: string[];
  emails: string[];
};

export type UnlockedContact = {
  phone?: string | null;     // back-compat: joined string for CSV/sort
  email?: string | null;
  phone_error?: string | null;
  email_error?: string | null;
  persons?: UnlockedPerson[]; // structured per-person data for nice display
};

export type UnlockResultMap = Record<string, UnlockedContact>;

// Per PropertyRadar's docs: each person record returned charges 1
// export credit (unified pool with record fetches — Solo: 10K/month).
// We fetch via GET /properties/{id}/persons which returns ALL phones +
// emails for ALL owners on the property in one call, including
// previously-purchased contacts that the per-person POST endpoint
// refuses to re-serve.

type Props = {
  rows: RefiRow[];
  alreadyUnlocked: UnlockResultMap;
  onCancel: () => void;
  onConfirm: (rowsToUnlock: RefiRow[]) => Promise<void>;
};

export default function RefiUnlockModal({ rows, alreadyUnlocked, onCancel, onConfirm }: Props) {
  const [submitting, setSubmitting] = useState(false);

  // Categorize each selected row before charging anything.
  // (Properties with no contact-bearing persons are still worth fetching
  // because already-purchased data lives on the property's persons
  // endpoint regardless of the link-array hints.)
  const { skipping, billable, estCredits } = useMemo(() => {
    const skip: RefiRow[] = [];
    const bill: RefiRow[] = [];
    let credits = 0;
    for (const r of rows) {
      const existing = alreadyUnlocked[r.RadarID];
      if (existing && (existing.phone || existing.email)) { skip.push(r); continue; }
      bill.push(r);
      // 1 credit per person record returned. Property typically has 1–3.
      credits += Math.max(1, (r.Persons ?? []).length);
    }
    return { skipping: skip, billable: bill, estCredits: credits };
  }, [rows, alreadyUnlocked]);

  const maxCredits = estCredits;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !submitting) onCancel(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel, submitting]);

  async function handleConfirm() {
    setSubmitting(true);
    try { await onConfirm(billable); }
    finally { setSubmitting(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center" onClick={() => !submitting && onCancel()}>
      <div className="relative max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-gray-100 px-5 py-3.5">
          <div className="text-base font-semibold text-gray-900">Fetch borrower contact info</div>
          <div className="mt-0.5 text-xs text-gray-500">Pulls all phones + emails for every owner on these properties, including any already purchased in prior sessions.</div>
        </div>

        <div className="space-y-3 px-5 py-4 text-sm">
          <div className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-2">
            <div className="flex justify-between"><span className="text-gray-600">Selected properties</span><span className="font-medium text-gray-900">{rows.length}</span></div>
            {skipping.length > 0 && <div className="mt-1 flex justify-between"><span className="text-gray-600">Already fetched (skipped)</span><span className="font-medium text-emerald-700">{skipping.length}</span></div>}
            <div className="mt-1 flex justify-between font-medium border-t border-gray-200 pt-1"><span className="text-gray-900">Will fetch contacts for</span><span className="text-gray-900">{billable.length}</span></div>
          </div>

          {billable.length > 0 ? (
            <div className="rounded-xl border border-blue-200 bg-blue-50 px-3 py-2">
              <div className="text-xs font-medium text-blue-900">Estimated cost</div>
              <div className="mt-0.5 text-sm text-blue-800">
                ≈ <span className="font-semibold">{maxCredits}</span> export credits (1 per person record returned, typically 1–3/property)
              </div>
              <div className="mt-1 text-[11px] text-blue-700">
                Each property fetch returns ALL phones + emails for ALL owners, including any you&apos;ve already purchased in past sessions. Drawn from your monthly Solo pool (10,000/mo, shared with record fetches).
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
              Nothing to fetch. All selected properties already have contact info loaded.
            </div>
          )}

          <div className="text-xs text-gray-500">
            <span className="font-medium text-gray-700">Compliance reminder:</span> Scrub all phone numbers against the National DNC registry before outbound calling. Manual outreach to non-DNC numbers is generally permissible; autodialed calls / SMS need prior express written consent (TCPA).
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-gray-100 px-5 py-3">
          <button type="button" onClick={onCancel} disabled={submitting}
            className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50">Cancel</button>
          <button type="button" onClick={handleConfirm} disabled={submitting || billable.length === 0}
            className="rounded-lg bg-red-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-40">
            {submitting ? "Fetching…" : `Fetch ${billable.length}`}
          </button>
        </div>
      </div>
    </div>
  );
}

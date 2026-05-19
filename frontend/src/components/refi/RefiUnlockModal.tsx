"use client";

import { useEffect, useMemo, useState } from "react";
import type { RefiRow } from "./types";

export type UnlockedContact = {
  phone?: string | null;
  email?: string | null;
  phone_error?: string | null;
  email_error?: string | null;
};

export type UnlockResultMap = Record<string, UnlockedContact>;

// Rough cost per unlock from PropertyRadar (separate from export quota).
// Used for the warning copy — actual billing happens server-side.
const PHONE_COST_USD = 0.08;
const EMAIL_COST_USD = 0.08;

type Props = {
  rows: RefiRow[];
  alreadyUnlocked: UnlockResultMap;
  onCancel: () => void;
  onConfirm: (rowsToUnlock: RefiRow[]) => Promise<void>;
};

export default function RefiUnlockModal({ rows, alreadyUnlocked, onCancel, onConfirm }: Props) {
  const [submitting, setSubmitting] = useState(false);

  // Split rows into "needs unlock" vs "already unlocked" so we don't double-charge.
  const { needsUnlock, skipping } = useMemo(() => {
    const need: RefiRow[] = [];
    const skip: RefiRow[] = [];
    for (const r of rows) {
      const existing = alreadyUnlocked[r.RadarID];
      if (existing && (existing.phone || existing.email)) skip.push(r);
      else need.push(r);
    }
    return { needsUnlock: need, skipping: skip };
  }, [rows, alreadyUnlocked]);

  const noPersonKey = useMemo(
    () => needsUnlock.filter((r) => {
      type Person = { PersonKey?: string };
      const persons = (r as RefiRow & { Persons?: Person[] }).Persons;
      return !Array.isArray(persons) || persons.length === 0 || !persons[0]?.PersonKey;
    }),
    [needsUnlock],
  );

  const billable = needsUnlock.filter((r) => !noPersonKey.includes(r));
  const estCost = billable.length * (PHONE_COST_USD + EMAIL_COST_USD);

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
          <div className="text-base font-semibold text-gray-900">Unlock borrower contact info</div>
          <div className="mt-0.5 text-xs text-gray-500">Phone &amp; email unlocks are billed separately from the record export quota.</div>
        </div>

        <div className="space-y-3 px-5 py-4 text-sm">
          <div className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-2">
            <div className="flex justify-between"><span className="text-gray-600">Selected rows</span><span className="font-medium text-gray-900">{rows.length}</span></div>
            {skipping.length > 0 && <div className="mt-1 flex justify-between"><span className="text-gray-600">Already unlocked (skipped)</span><span className="font-medium text-emerald-700">{skipping.length}</span></div>}
            {noPersonKey.length > 0 && <div className="mt-1 flex justify-between"><span className="text-gray-600">No PersonKey available</span><span className="font-medium text-amber-700">{noPersonKey.length}</span></div>}
            <div className="mt-1 flex justify-between font-medium"><span className="text-gray-900">To unlock</span><span className="text-gray-900">{billable.length}</span></div>
          </div>

          {billable.length > 0 ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2">
              <div className="text-xs font-medium text-amber-900">Estimated cost</div>
              <div className="mt-0.5 text-sm text-amber-800">
                ≈ <span className="font-semibold">${estCost.toFixed(2)}</span> total
                <span className="text-amber-700"> ({billable.length} × phone ${PHONE_COST_USD.toFixed(2)} + email ${EMAIL_COST_USD.toFixed(2)})</span>
              </div>
              <div className="mt-1 text-[11px] text-amber-700">Per-unlock prices are PropertyRadar plan defaults — actual charge appears on your PropertyRadar invoice.</div>
            </div>
          ) : (
            <div className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
              Nothing to unlock. {skipping.length > 0 && "These borrowers already have contact info."} {noPersonKey.length > 0 && "Other selected rows have no PersonKey in their owner record."}
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
            {submitting ? "Unlocking…" : `Unlock ${billable.length}`}
          </button>
        </div>
      </div>
    </div>
  );
}

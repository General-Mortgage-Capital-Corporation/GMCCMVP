/**
 * Itemized confirmation modal shown before any batch credit deduction.
 *
 * Spec-required UX:
 *
 *   You're about to unlock 3 properties (3 property credits)
 *   and reveal their email + text (3 email + 3 text = 6 contact credits).
 *
 *   After this, you'll have 1,997 property and 194 contact credits remaining.
 *
 *   [ Cancel ]  [ Confirm and unlock ]
 *
 * Caller passes an itemized cost breakdown. We render it, compute
 * post-deduction balance, and surface a confirm button. Insufficient-credit
 * state is rendered inline (no separate modal): the confirm button is
 * disabled and a recharge CTA appears.
 *
 * Per design: this fires for BATCH actions (search fetch, multi-row contact
 * reveal). Single-row reveals skip the modal — cost is shown inline on the
 * button.
 */

"use client";

import { useState } from "react";

export interface UnlockLineItem {
  /** Human-readable description, e.g. "Unlock 25 properties" or "Reveal 3 emails". */
  label: string;
  count: number;
  pool: "contact" | "property";
}

interface Props {
  open: boolean;
  title?: string;
  items: UnlockLineItem[];
  /** Current balances — used to compute post-deduction values + gating. */
  balance: { contact: number; property: number };
  /** Async confirm action. Dialog stays mounted with a spinner until it resolves. */
  onConfirm: () => Promise<void>;
  onCancel: () => void;
  /** Optional: triggered when user clicks "Buy recharge" in the insufficient state. */
  onBuyRecharge?: () => void;
}

export default function UnlockConfirmDialog({
  open,
  title = "Confirm unlock",
  items,
  balance,
  onConfirm,
  onCancel,
  onBuyRecharge,
}: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const contactCost = items
    .filter((i) => i.pool === "contact")
    .reduce((acc, i) => acc + i.count, 0);
  const propertyCost = items
    .filter((i) => i.pool === "property")
    .reduce((acc, i) => acc + i.count, 0);

  const afterContact = balance.contact - contactCost;
  const afterProperty = balance.property - propertyCost;

  const insufficient = afterContact < 0 || afterProperty < 0;
  const shortBy = {
    contact: insufficient && afterContact < 0 ? -afterContact : 0,
    property: insufficient && afterProperty < 0 ? -afterProperty : 0,
  };

  async function handleConfirm() {
    setError(null);
    setSubmitting(true);
    try {
      await onConfirm();
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white shadow-xl">
        <div className="border-b border-gray-100 px-6 py-4">
          <h3 className="text-base font-semibold text-gray-900">{title}</h3>
        </div>

        <div className="px-6 py-5">
          <p className="text-sm text-gray-700">You&apos;re about to:</p>
          <ul className="mt-2 space-y-1.5 text-sm">
            {items.map((item, idx) => (
              <li
                key={idx}
                className="flex items-center justify-between rounded-lg border border-gray-100 bg-gray-50 px-3 py-1.5"
              >
                <span className="text-gray-800">{item.label}</span>
                <span className="font-medium text-gray-900">
                  {item.count} {item.pool}
                </span>
              </li>
            ))}
          </ul>

          <div className="mt-4 border-t border-gray-100 pt-4">
            <p className="text-xs uppercase tracking-wide text-gray-500">
              After this:
            </p>
            <div className="mt-1 grid grid-cols-2 gap-3 text-sm">
              <BalanceLine
                label="Property"
                before={balance.property}
                after={afterProperty}
              />
              <BalanceLine
                label="Contact"
                before={balance.contact}
                after={afterContact}
              />
            </div>
          </div>

          {insufficient && (
            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-800">
              <p className="font-medium">Not enough credits.</p>
              <p className="mt-1 text-xs">
                You&apos;re short by{" "}
                {[
                  shortBy.contact > 0 && `${shortBy.contact} contact`,
                  shortBy.property > 0 && `${shortBy.property} property`,
                ]
                  .filter(Boolean)
                  .join(" + ")}
                .
              </p>
              {onBuyRecharge && shortBy.contact > 0 && (
                <button
                  type="button"
                  onClick={onBuyRecharge}
                  className="mt-2 rounded border border-red-300 bg-white px-2 py-1 text-xs font-medium text-red-700 transition hover:bg-red-100"
                >
                  Buy $20 recharge (200 contact)
                </button>
              )}
            </div>
          )}

          {error && (
            <p className="mt-3 text-sm text-red-700">{error}</p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-gray-100 px-6 py-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-600 transition hover:bg-gray-100 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={submitting || insufficient}
            className="rounded-lg bg-red-600 px-4 py-1.5 text-sm font-semibold text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "Working…" : "Confirm and unlock"}
          </button>
        </div>
      </div>
    </div>
  );
}

function BalanceLine({
  label,
  before,
  after,
}: {
  label: string;
  before: number;
  after: number;
}) {
  const negative = after < 0;
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-gray-500">
        {label}
      </p>
      <p className="text-sm text-gray-600">
        <span className="text-gray-400 line-through">
          {before.toLocaleString()}
        </span>
        <span
          className={`ml-2 font-semibold ${negative ? "text-red-700" : "text-gray-900"}`}
        >
          {after.toLocaleString()}
        </span>
      </p>
    </div>
  );
}

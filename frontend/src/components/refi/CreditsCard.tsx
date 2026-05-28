/**
 * Larger credits card shown at the top of the Refi tab when active/buffered.
 *
 * Displays:
 *   - Current contact + property balances
 *   - "Resets {date}" (active) or "Drawing from company buffer" (buffer)
 *   - "Auto-renewal off · expires {date}" if subscription is canceled-in-cycle
 *   - $20 recharge button (active only)
 *   - Cancel auto-renewal link (active only, inline two-button confirm)
 */

"use client";

import { useState } from "react";
import { authedFetch } from "@/lib/authed-fetch";
import type { SubscriptionStatusJSON } from "@/hooks/useRefiSubscription";

interface Props {
  status: SubscriptionStatusJSON;
  /** Called after a successful action that might change subscription state. */
  onChange?: () => void;
}

export default function CreditsCard({ status, onChange }: Props) {
  if (status.state === "buffer") return <BufferCard status={status} />;
  if (status.state === "active") {
    return <ActiveCard status={status} onChange={onChange} />;
  }
  return null;
}

function BufferCard({
  status,
}: {
  status: Extract<SubscriptionStatusJSON, { state: "buffer" }>;
}) {
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-amber-700">
            Internal · GMCC buffer
          </p>
          <p className="mt-1 text-sm text-amber-900">
            Your unlocks deduct from the company PropertyRadar pool.
          </p>
        </div>
        <div className="flex items-center gap-4 text-right">
          <Stat label="Contact" value={status.balance.contact} />
          <Stat label="Property" value={status.balance.property} />
        </div>
      </div>
    </div>
  );
}

function ActiveCard({
  status,
  onChange,
}: {
  status: Extract<SubscriptionStatusJSON, { state: "active" }>;
  onChange?: () => void;
}) {
  const cycleEnd = new Date(status.cycleEndsAt);
  const cycleLabel = cycleEnd.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const canceled = status.autoRenewCanceled;

  const [rechargeLoading, setRechargeLoading] = useState(false);
  const [rechargeError, setRechargeError] = useState<string | null>(null);

  async function handleRecharge() {
    setRechargeError(null);
    setRechargeLoading(true);
    try {
      const res = await authedFetch("/api/refi-subscription/recharge", {
        method: "POST",
      });
      if (!res.ok) throw new Error(`recharge_${res.status}`);
      const data = (await res.json()) as { paymentUrl?: string };
      if (data.paymentUrl) {
        window.open(data.paymentUrl, "_blank", "noopener,noreferrer");
        onChange?.();
      } else {
        setRechargeError("No payment URL returned. Try again.");
      }
    } catch (e) {
      setRechargeError(String(e));
    } finally {
      setRechargeLoading(false);
    }
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
            Refi Finder · $100/month
          </p>
          <p
            className={`mt-1 text-sm ${canceled ? "text-amber-700" : "text-gray-700"}`}
          >
            {canceled
              ? `Auto-renewal off · credits expire ${cycleLabel}`
              : `Credits reset on ${cycleLabel}`}
          </p>
        </div>
        <div className="flex items-center gap-4">
          <Stat label="Contact" value={status.balance.contact} />
          <Stat label="Property" value={status.balance.property} />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 pt-3">
        <button
          type="button"
          onClick={handleRecharge}
          disabled={rechargeLoading}
          className="rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 transition hover:bg-red-100 disabled:opacity-50"
        >
          {rechargeLoading ? "Opening Bill.com…" : "Buy 200 contact credits ($20)"}
        </button>

        {!canceled && (
          <CancelAutoRenewLink onChange={onChange} />
        )}
      </div>

      {rechargeError && (
        <p className="mt-2 text-xs text-red-600">{rechargeError}</p>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="text-right">
      <p className="text-lg font-semibold text-gray-900">
        {value.toLocaleString()}
      </p>
      <p className="text-[10px] uppercase tracking-wide text-gray-500">
        {label}
      </p>
    </div>
  );
}

/**
 * Inline two-button cancel confirm (matches MLO portal pattern — no modal).
 * Idle state shows "Cancel auto-renewal"; clicking switches to "Are you sure?
 * [Yes, cancel] [Keep]".
 */
function CancelAutoRenewLink({ onChange }: { onChange?: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    setLoading(true);
    setError(null);
    try {
      const res = await authedFetch("/api/refi-subscription/cancel", {
        method: "POST",
      });
      if (!res.ok) throw new Error(`cancel_${res.status}`);
      onChange?.();
      setConfirming(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="text-xs text-gray-500 underline-offset-2 transition hover:text-gray-700 hover:underline"
      >
        Cancel auto-renewal
      </button>
    );
  }

  return (
    <span className="flex items-center gap-2 text-xs">
      <span className="text-gray-600">Cancel auto-renewal?</span>
      <button
        type="button"
        onClick={handleConfirm}
        disabled={loading}
        className="rounded border border-red-200 px-2 py-0.5 font-medium text-red-700 transition hover:bg-red-50 disabled:opacity-50"
      >
        {loading ? "Canceling…" : "Yes, cancel"}
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        disabled={loading}
        className="rounded border border-gray-200 px-2 py-0.5 font-medium text-gray-700 transition hover:bg-gray-50"
      >
        Keep
      </button>
      {error && <span className="text-red-600">{error}</span>}
    </span>
  );
}

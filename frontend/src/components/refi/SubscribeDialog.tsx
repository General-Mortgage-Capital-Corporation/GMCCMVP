/**
 * Subscribe dialog — SLA acknowledgement + payment kickoff.
 *
 * Flow:
 *   1. User checks the SLA acknowledgement box and clicks Subscribe.
 *   2. POST /api/refi-subscription/acknowledge — records consent.
 *   3. POST /api/refi-subscription/subscribe — gets Bill.com paymentUrl.
 *   4. Open paymentUrl in a new tab.
 *   5. Dialog flips to "waiting for payment" state; the parent polls
 *      /api/refi-subscription/status (aggressively, 3s) until state === "active".
 *   6. On active, parent closes the dialog.
 *
 * Copy matches the MLO portal's SubscriptionPreview tone:
 *   - $100/month
 *   - 200 contact credits + 5,000 property credits
 *   - Credits reset every cycle, do not accumulate
 *   - Auto-renews until canceled
 */

"use client";

import { useState } from "react";
import { authedFetch } from "@/lib/authed-fetch";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called when payment kickoff succeeds so parent can flip to aggressive polling. */
  onPaymentLaunched?: () => void;
}

export default function SubscribeDialog({
  open,
  onClose,
  onPaymentLaunched,
}: Props) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [phase, setPhase] = useState<"form" | "launching" | "waiting" | "error">(
    "form",
  );
  const [error, setError] = useState<string | null>(null);
  const [paymentUrl, setPaymentUrl] = useState<string | null>(null);

  if (!open) return null;

  async function handleSubscribe() {
    setError(null);
    setPhase("launching");
    try {
      const ackRes = await authedFetch("/api/refi-subscription/acknowledge", {
        method: "POST",
      });
      if (!ackRes.ok) {
        const body = await ackRes.json().catch(() => ({}));
        throw new Error(body?.error ?? `acknowledge_${ackRes.status}`);
      }

      const subRes = await authedFetch("/api/refi-subscription/subscribe", {
        method: "POST",
      });
      if (!subRes.ok) {
        const body = await subRes.json().catch(() => ({}));
        throw new Error(body?.error ?? `subscribe_${subRes.status}`);
      }
      const data = (await subRes.json()) as { paymentUrl?: string };
      if (!data.paymentUrl) throw new Error("no_payment_url");

      setPaymentUrl(data.paymentUrl);
      window.open(data.paymentUrl, "_blank", "noopener,noreferrer");
      setPhase("waiting");
      onPaymentLaunched?.();
    } catch (e) {
      setError(String(e));
      setPhase("error");
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white shadow-xl">
        <div className="border-b border-gray-100 px-6 py-4">
          <h2 className="text-base font-semibold text-gray-900">
            Subscribe to Refi Finder
          </h2>
          <p className="mt-0.5 text-xs text-gray-500">
            $100 / month · auto-renews · cancel anytime
          </p>
        </div>

        <div className="px-6 py-4">
          {phase === "form" && (
            <>
              <ul className="space-y-2 text-sm text-gray-700">
                <Bullet>
                  <strong>5,000 property credits</strong> per cycle —
                  search PropertyRadar for refi-eligible mortgages.
                </Bullet>
                <Bullet>
                  <strong>200 contact credits</strong> per cycle —
                  reveal borrower email or text (1 credit each).
                </Bullet>
                <Bullet>
                  Mid-cycle <strong>$20 recharge</strong> adds 200 more
                  contact credits when you run out.
                </Bullet>
                <Bullet>
                  Credits <strong>do not accumulate</strong> — unused
                  balances reset at the start of each cycle.
                </Bullet>
                <Bullet>
                  Auto-renews on the same day every month. Cancel any time
                  from this page; you keep credits until the cycle ends.
                </Bullet>
              </ul>

              <label className="mt-5 flex items-start gap-2 rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs text-gray-700">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-red-600"
                />
                <span>
                  I understand that Refi Finder is billed monthly at $100,
                  credits hard-reset each cycle, and unused credits do not
                  carry over. Continuing creates a Bill.com invoice and
                  starts the monthly auto-renewal.
                </span>
              </label>

              <div className="mt-4 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-600 transition hover:bg-gray-100"
                >
                  Not now
                </button>
                <button
                  type="button"
                  onClick={handleSubscribe}
                  disabled={!acknowledged}
                  className="rounded-lg bg-red-600 px-4 py-1.5 text-sm font-semibold text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Continue to payment
                </button>
              </div>
            </>
          )}

          {phase === "launching" && (
            <p className="text-sm text-gray-700">
              Creating your Bill.com invoice…
            </p>
          )}

          {phase === "waiting" && (
            <div className="text-sm text-gray-700">
              <p>Your invoice is open in a new tab.</p>
              <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                <p className="font-medium">
                  After you complete payment, credits typically appear here in
                  4–5 minutes.
                </p>
                <p className="mt-1 text-amber-800">
                  You can close this dialog and come back — the balance will
                  refresh on its own once the payment processes.
                </p>
              </div>
              {paymentUrl && (
                <p className="mt-3 text-xs text-gray-500">
                  Tab didn&apos;t open?{" "}
                  <a
                    href={paymentUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-red-600 underline-offset-2 hover:underline"
                  >
                    Open payment page
                  </a>
                  .
                </p>
              )}
              <div className="mt-4 flex justify-end">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
                >
                  Close
                </button>
              </div>
            </div>
          )}

          {phase === "error" && (
            <div className="text-sm">
              <p className="text-red-700">
                Something went wrong: {error ?? "unknown error"}
              </p>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-600 transition hover:bg-gray-100"
                >
                  Close
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPhase("form");
                    setError(null);
                  }}
                  className="rounded-lg bg-red-600 px-4 py-1.5 text-sm font-semibold text-white transition hover:bg-red-700"
                >
                  Try again
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-2">
      <span className="mt-1 text-red-600">•</span>
      <span>{children}</span>
    </li>
  );
}

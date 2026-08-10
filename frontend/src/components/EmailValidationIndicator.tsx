/**
 * Inline notice rendered after a failed send-time deliverability check.
 *
 * - Only shown when the user clicked Send and Bouncer returned non-deliverable
 *   (or the check itself errored). Never debounced / never on input change.
 * - Surfaces the human-readable reason + an optional "Did you mean ...?"
 *   suggestion when Bouncer returns a typo correction.
 * - LOs can NO LONGER self-override. For an APPROVABLE status (risky / unknown —
 *   flagged but not confirmed bad) it renders an amber notice telling the LO to
 *   email an admin (APPROVAL_REQUEST_CONTACT) to have the address allowlisted;
 *   once approved it sends for everyone. For a hard block (undeliverable / bad
 *   syntax) it stays red and just asks them to fix the address.
 * - Renders nothing for `deliverable` (handler proceeds with the send).
 */

"use client";

import {
  APPROVAL_REQUEST_CONTACT,
  describeReason,
  isApprovable,
  type DeliverabilityResult,
} from "@/lib/email-deliverability-types";

export function SendBlockedNotice({
  result,
  onApplySuggestion,
  onDismiss,
}: {
  result: DeliverabilityResult;
  onApplySuggestion?: (suggested: string) => void;
  onDismiss?: () => void;
}) {
  if (result.status === "deliverable") return null;
  const message = describeReason(result.status, result.reason);
  // Flagged-but-not-confirmed-bad → an admin can approve it. Confirmed bad
  // (undeliverable / bad syntax) → the LO must fix the address.
  const approvable = isApprovable(result.status);

  // Amber for a flagged (approvable) address; red for a confirmed hard block.
  const tone = approvable
    ? {
        wrap: "border-amber-200 bg-amber-50 text-amber-800",
        icon: "text-amber-600",
        link: "text-amber-700 hover:text-amber-900",
        dismiss: "text-amber-500 hover:bg-amber-100",
      }
    : {
        wrap: "border-red-200 bg-red-50 text-red-800",
        icon: "text-red-600",
        link: "text-red-700 hover:text-red-900",
        dismiss: "text-red-500 hover:bg-red-100",
      };

  return (
    <div
      className={`mt-1 flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${tone.wrap}`}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden
        className={`mt-0.5 shrink-0 ${tone.icon}`}
      >
        <path
          d="M8 1a7 7 0 100 14A7 7 0 008 1zM7 4h2v5H7V4zm0 6h2v2H7v-2z"
          fill="currentColor"
        />
      </svg>
      <div className="flex-1 space-y-1">
        <p>
          {approvable ? (
            <>
              <span className="font-medium">Flagged — {message}</span> To send
              to this address, email{" "}
              <a
                href={`mailto:${APPROVAL_REQUEST_CONTACT}?subject=${encodeURIComponent(
                  "Email approval request",
                )}&body=${encodeURIComponent(
                  `Please approve this address for sending: ${result.email}`,
                )}`}
                className={`font-medium underline ${tone.link}`}
              >
                {APPROVAL_REQUEST_CONTACT}
              </a>{" "}
              to request approval. Once approved it sends for everyone.
            </>
          ) : (
            <>
              <span className="font-medium">Can&apos;t send — {message}</span>{" "}
              Fix the address and try again.
            </>
          )}
        </p>
        {result.didYouMean && onApplySuggestion && (
          <button
            type="button"
            onClick={() => onApplySuggestion(result.didYouMean as string)}
            className={`underline ${tone.link}`}
          >
            Did you mean{" "}
            <span className="font-mono">{result.didYouMean}</span>?
          </button>
        )}
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className={`shrink-0 rounded p-0.5 ${tone.dismiss}`}
          aria-label="Dismiss"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
            <path
              d="M12 4L4 12M4 4l8 8"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>
      )}
    </div>
  );
}

/**
 * Inline notice rendered after a failed send-time deliverability check.
 *
 * - Only shown when the user clicked Send and Bouncer returned non-deliverable
 *   (or the check itself errored). Never debounced / never on input change.
 * - Surfaces the human-readable reason + an optional "Did you mean ...?"
 *   suggestion when Bouncer returns a typo correction.
 * - Renders nothing for `deliverable` (handler proceeds with the send).
 */

"use client";

import {
  describeReason,
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

  return (
    <div className="mt-1 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden
        className="mt-0.5 shrink-0 text-red-600"
      >
        <path
          d="M8 1a7 7 0 100 14A7 7 0 008 1zM7 4h2v5H7V4zm0 6h2v2H7v-2z"
          fill="currentColor"
        />
      </svg>
      <div className="flex-1 space-y-0.5">
        <p>
          <span className="font-medium">Can&apos;t send — {message}</span>{" "}
          Fix the address and try again.
        </p>
        {result.didYouMean && onApplySuggestion && (
          <button
            type="button"
            onClick={() => onApplySuggestion(result.didYouMean as string)}
            className="text-red-700 underline hover:text-red-900"
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
          className="shrink-0 rounded p-0.5 text-red-500 hover:bg-red-100"
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

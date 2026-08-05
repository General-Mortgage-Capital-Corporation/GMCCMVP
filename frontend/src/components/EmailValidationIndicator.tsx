/**
 * Inline notice rendered after a failed send-time deliverability check.
 *
 * - Only shown when the user clicked Send and Bouncer returned non-deliverable
 *   (or the check itself errored). Never debounced / never on input change.
 * - Surfaces the human-readable reason + an optional "Did you mean ...?"
 *   suggestion when Bouncer returns a typo correction.
 * - For an OVERRIDABLE status (risky / unknown — flagged but not confirmed
 *   bad) it renders an amber warning with a "Send anyway" button so the LO can
 *   knowingly push it through. For a hard block (undeliverable / bad syntax)
 *   it stays red with no override.
 * - Renders nothing for `deliverable` (handler proceeds with the send).
 */

"use client";

import {
  describeReason,
  isOverridable,
  type DeliverabilityResult,
} from "@/lib/email-deliverability-types";

export function SendBlockedNotice({
  result,
  onApplySuggestion,
  onOverride,
  onDismiss,
}: {
  result: DeliverabilityResult;
  onApplySuggestion?: (suggested: string) => void;
  /** When provided AND the status is overridable, shows a "Send anyway" button. */
  onOverride?: () => void;
  onDismiss?: () => void;
}) {
  if (result.status === "deliverable") return null;
  const message = describeReason(result.status, result.reason);
  const overridable = isOverridable(result.status) && !!onOverride;

  // Amber for a flagged-but-overridable address; red for a confirmed hard block.
  const tone = overridable
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
          {overridable ? (
            <>
              <span className="font-medium">Flagged — {message}</span> It may
              not be deliverable.
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
        {overridable && (
          <div>
            <button
              type="button"
              onClick={onOverride}
              className="mt-0.5 rounded-md border border-amber-300 bg-white px-2.5 py-1 font-medium text-amber-800 hover:bg-amber-100"
            >
              Send anyway
            </button>
          </div>
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

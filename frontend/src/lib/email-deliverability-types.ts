/**
 * Pure types + presentation helpers for email deliverability.
 *
 * This file is intentionally free of any server-only imports (no firebase-admin,
 * no node-only APIs) so it can be imported from client components without
 * pulling Node.js packages into the browser bundle. The actual Bouncer call +
 * Firestore cache lives in `email-deliverability.ts` (server-only).
 */

export type DeliverabilityStatus =
  | "deliverable"
  | "undeliverable"
  | "risky"
  | "unknown";

export type DeliverabilityResult = {
  email: string;
  status: DeliverabilityStatus;
  reason: string | null;
  didYouMean: string | null;
  source: "cache" | "bouncer" | "syntax" | "not_configured" | "api_error";
};

/** True for anything that should block a send. */
export function blocksSend(status: DeliverabilityStatus): boolean {
  return status !== "deliverable";
}

/** Friendly reason copy for UI display. */
export function describeReason(
  status: DeliverabilityStatus,
  reason: string | null,
): string {
  if (status === "deliverable") return "Verified deliverable.";
  const r = reason ?? "";
  switch (r) {
    case "rejected_email":
      return "The mailbox does not exist.";
    case "invalid_email":
    case "invalid_syntax":
      return "Invalid email format.";
    case "invalid_domain":
    case "no_mx":
    case "no_mailserver_for_domain":
      return "The domain has no mail server.";
    case "low_deliverability":
      return "Likely to bounce — provider flagged low deliverability.";
    case "low_quality":
      return "Low-quality mailbox (role/disposable/anonymous).";
    case "email_disabled":
      return "The mailbox is disabled.";
    case "inactive_mailbox":
      return "The mailbox is inactive.";
    case "disposable":
      return "Disposable / throwaway mailbox.";
    case "role_based":
      return "Role-based address (info@/admin@/etc.) — usually undeliverable for outreach.";
    case "accept_all":
      return "Catch-all domain — we cannot confirm the mailbox actually exists.";
    case "unverifiable":
    case "unknown":
    case "transient_failure":
      return "The provider didn't return a definitive answer. Try again or use a different address.";
    case "toxic":
      return "Known bad / spam-trap address.";
    default:
      if (status === "undeliverable") return "Confirmed undeliverable.";
      if (status === "risky") return "Risky — we cannot confirm the mailbox exists.";
      return "Could not verify the address.";
  }
}

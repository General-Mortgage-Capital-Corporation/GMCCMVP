/**
 * Send-time email-deliverability client helpers.
 *
 * Bouncer credits cost money even when pre-paid — so we deliberately do
 * NOT verify on input change / debounce. The single allowed surface is
 * `verifyEmailForSend(email)`, called inside a Send handler. It returns a
 * normalized status + a presentation-ready message.
 */

import { authedFetch } from "@/lib/authed-fetch";
import type {
  DeliverabilityResult,
  DeliverabilityStatus,
} from "@/lib/email-deliverability-types";

export type { DeliverabilityResult, DeliverabilityStatus };

const SYNTAX_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * One-shot deliverability check via /api/email/validate.
 * Returns null only if the input is empty / syntactically invalid before
 * we even hit the server.
 */
export async function verifyEmailForSend(
  email: string,
): Promise<DeliverabilityResult | null> {
  const trimmed = email.trim().toLowerCase();
  if (!trimmed || !SYNTAX_RE.test(trimmed)) {
    return {
      email: trimmed,
      status: "undeliverable",
      reason: "invalid_syntax",
      didYouMean: null,
      source: "syntax",
    };
  }
  try {
    const res = await authedFetch("/api/email/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: trimmed }),
    });
    if (!res.ok) return null;
    return (await res.json()) as DeliverabilityResult;
  } catch {
    return null;
  }
}

/** UI policy: a result is OK to send iff status === "deliverable". */
export function isSendAllowed(
  result: DeliverabilityResult | null | undefined,
): boolean {
  return !!result && result.status === "deliverable";
}

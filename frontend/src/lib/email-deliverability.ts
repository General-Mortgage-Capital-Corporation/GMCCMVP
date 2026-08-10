/**
 * Bouncer-backed email deliverability check, with Firestore cache.
 *
 * Used by:
 *   - /api/email/validate           (interactive send-time check)
 *   - lib/tools/send-email.ts       (AI agent send tool)
 *   - api/cron/follow-ups/route.ts  (cache read only — never spend credits)
 *
 * Policy (per product owner): a verified-deliverable response is the ONLY
 * status that allows a send. Everything else — undeliverable, risky,
 * unknown — surfaces an error and blocks. LOs cannot self-override; an admin
 * allowlists a flagged address (lib/email-approvals.ts), after which this
 * function short-circuits it to `deliverable` for everyone.
 *
 * Caching: results persist in Firestore for 90 days under
 * `emailValidations/{base64key}`. Bouncer's pre-paid credits are
 * non-expiring, but repeat verifications still cost a credit per call, so
 * cache aggressively. The cache key is content-addressed by lowercased
 * email — same address from any LO is one credit, not N.
 *
 * SERVER-ONLY. Pure types + UI helpers live in `email-deliverability-types.ts`
 * so client components can import them without pulling firebase-admin into
 * the browser bundle.
 */

import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getDb } from "@/lib/firestore-admin";
import { isEmailApproved } from "@/lib/email-approvals";
import type {
  DeliverabilityResult,
  DeliverabilityStatus,
} from "@/lib/email-deliverability-types";

export type {
  DeliverabilityResult,
  DeliverabilityStatus,
} from "@/lib/email-deliverability-types";
export {
  blocksSend,
  describeReason,
} from "@/lib/email-deliverability-types";

const CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

const SYNTAX_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(s: string): string {
  return s.trim().toLowerCase();
}

export function emailCacheKey(normalizedEmail: string): string {
  return Buffer.from(normalizedEmail, "utf8")
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\//g, "_")
    .replace(/\+/g, "-");
}

function normalizeBouncerStatus(s: string | undefined): DeliverabilityStatus {
  switch (s) {
    case "deliverable":
      return "deliverable";
    case "undeliverable":
      return "undeliverable";
    case "risky":
      return "risky";
    default:
      return "unknown";
  }
}

type CacheRecord = {
  email: string;
  status: DeliverabilityStatus;
  reason: string | null;
  didYouMean: string | null;
  checkedAt: FirebaseFirestore.Timestamp;
  checkedBy?: string;
};

/**
 * Read the cache only. Used by the cron — never spend credits on automated
 * traffic.
 */
export async function readCachedDeliverability(
  email: string,
): Promise<DeliverabilityResult | null> {
  const db = getDb();
  if (!db) return null;
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  try {
    const snap = await db
      .collection("emailValidations")
      .doc(emailCacheKey(normalized))
      .get();
    if (!snap.exists) return null;
    const data = snap.data() as Partial<CacheRecord>;
    if (!data.status || !data.checkedAt) return null;
    if (Date.now() - data.checkedAt.toMillis() >= CACHE_TTL_MS) return null;
    return {
      email: normalized,
      status: data.status,
      reason: data.reason ?? null,
      didYouMean: data.didYouMean ?? null,
      source: "cache",
    };
  } catch {
    return null;
  }
}

/**
 * Verify an email's deliverability via Bouncer, with Firestore cache.
 * Fails open: returns `unknown` if Bouncer is misconfigured or down —
 * the caller's policy (blocksSend) is what enforces the hard block.
 */
export async function verifyDeliverability(
  email: string,
  checkedBy?: string,
): Promise<DeliverabilityResult> {
  const normalized = normalizeEmail(email);

  if (!normalized || !SYNTAX_RE.test(normalized)) {
    return {
      email: normalized,
      status: "undeliverable",
      reason: "invalid_syntax",
      didYouMean: null,
      source: "syntax",
    };
  }

  // Admin allowlist wins over everything — a flagged address an admin approved
  // sends for everyone, and we skip Bouncer entirely (no credit spent).
  if (await isEmailApproved(normalized)) {
    return {
      email: normalized,
      status: "deliverable",
      reason: "approved",
      didYouMean: null,
      source: "approved",
    };
  }

  // Cache hit?
  const cached = await readCachedDeliverability(normalized);
  if (cached) return cached;

  const apiKey = process.env.BOUNCER_API_KEY;
  if (!apiKey) {
    return {
      email: normalized,
      status: "unknown",
      reason: "not_configured",
      didYouMean: null,
      source: "not_configured",
    };
  }

  try {
    const url = `https://api.usebouncer.com/v1.1/email/verify?email=${encodeURIComponent(normalized)}&timeout=15`;
    const res = await fetch(url, {
      method: "GET",
      headers: { "x-api-key": apiKey },
    });
    if (!res.ok) {
      console.warn(
        "[email-deliverability] Bouncer HTTP error:",
        res.status,
        await res.text().catch(() => ""),
      );
      return {
        email: normalized,
        status: "unknown",
        reason: "api_error",
        didYouMean: null,
        source: "api_error",
      };
    }
    const body = (await res.json()) as {
      status?: string;
      reason?: string | null;
      didYouMean?: string | null;
    };
    const status = normalizeBouncerStatus(body.status);
    const reason = body.reason ?? null;
    const didYouMean = body.didYouMean || null;

    // Persist
    const db = getDb();
    if (db) {
      try {
        await db
          .collection("emailValidations")
          .doc(emailCacheKey(normalized))
          .set(
            {
              email: normalized,
              status,
              reason,
              didYouMean,
              checkedAt: FieldValue.serverTimestamp(),
              ...(checkedBy ? { checkedBy } : {}),
            },
            { merge: true },
          );
      } catch (err) {
        console.warn("[email-deliverability] cache write failed:", err);
      }
    }

    return { email: normalized, status, reason, didYouMean, source: "bouncer" };
  } catch (err) {
    console.error("[email-deliverability] call failed:", err);
    return {
      email: normalized,
      status: "unknown",
      reason: "api_error",
      didYouMean: null,
      source: "api_error",
    };
  }
}

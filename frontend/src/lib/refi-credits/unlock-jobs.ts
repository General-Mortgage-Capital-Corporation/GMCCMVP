/**
 * Unlock-job tracking for crash-safe credit accounting.
 *
 * The unlock routes deduct credits UP FRONT, then call PropertyRadar, then
 * refund whatever PR didn't deliver. If the request dies anywhere between the
 * deduction and the refund (timeout, instance recycle, unhandled throw), the
 * user is left over-charged with NO record — exactly the failure that made one
 * user's 49-credit over-charge un-investigable and un-recoverable.
 *
 * This module records a lightweight "job" row the moment credits are deducted
 * and marks it `settled` once the refund+logging finishes. A reconciliation
 * cron (`/api/cron/refi-reconcile`) sweeps jobs still `pending` after a grace
 * window and refunds the full deducted amount — turning a silent over-charge
 * into an automatic, audited make-good.
 *
 * Design notes:
 *   - Top-level `refiUnlockJobs` collection so the cron can scan across all
 *     users with a single indexed query on (status, createdAt).
 *   - Every call here is BEST-EFFORT: a failure to open/settle a job must never
 *     break an unlock. Losing the job row only costs reconciliation coverage
 *     for that one request, which is strictly better than the old behavior.
 */

import { FieldValue } from "firebase-admin/firestore";
import { getDb } from "@/lib/firestore-admin";
import type { CreditAmount } from "./types";

export const UNLOCK_JOBS_COLLECTION = "refiUnlockJobs";

/** Minutes a job may sit `pending` before the reconciler considers it orphaned. */
export const RECONCILE_GRACE_MINUTES = 15;

export interface OpenJobInput {
  email: string;
  deducted: CreditAmount;
  cycleId: string;
  poolRef: string;
  drewFromBuffer: boolean;
  /** e.g. "unlock_contact" | "unlock_search" */
  source: string;
  /** How many discrete rows/channels this unlock requested (for forensics). */
  requested?: number;
}

/**
 * Record a pending unlock job right after the up-front deduction. Returns the
 * job id (to settle later) or null if the write failed — callers treat null as
 * "no reconciliation coverage" and proceed normally.
 */
export async function openUnlockJob(input: OpenJobInput): Promise<string | null> {
  const db = getDb();
  if (!db) return null;
  try {
    const ref = db.collection(UNLOCK_JOBS_COLLECTION).doc();
    await ref.set({
      email: input.email.toLowerCase(),
      status: "pending",
      deducted: { contact: input.deducted.contact, property: input.deducted.property },
      cycleId: input.cycleId,
      poolRef: input.poolRef,
      drewFromBuffer: input.drewFromBuffer,
      source: input.source,
      requested: input.requested ?? null,
      createdAt: FieldValue.serverTimestamp(),
    });
    return ref.id;
  } catch (err) {
    console.warn("[unlock-jobs] openUnlockJob failed (proceeding uncovered):", err);
    return null;
  }
}

/**
 * Mark a job settled once the inline refund+logging completed normally. Records
 * how much was refunded inline so the audit trail is complete. Best-effort.
 */
export async function settleUnlockJob(
  jobId: string | null,
  outcome: { refunded: CreditAmount; note?: string },
): Promise<void> {
  if (!jobId) return;
  const db = getDb();
  if (!db) return;
  try {
    await db.collection(UNLOCK_JOBS_COLLECTION).doc(jobId).set(
      {
        status: "settled",
        refunded: { contact: outcome.refunded.contact, property: outcome.refunded.property },
        note: outcome.note ?? null,
        settledAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  } catch (err) {
    console.warn("[unlock-jobs] settleUnlockJob failed (reconciler will catch it):", err);
  }
}

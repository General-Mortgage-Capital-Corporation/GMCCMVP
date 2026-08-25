/**
 * Orchestrator for credit-gated PropertyRadar unlocks.
 *
 * Used by the unlock API routes. Implements the spec's required flow:
 *
 *   1. Resolve subscription — must be active or buffer; else 402.
 *   2. Resolve pool (buffer vs personal).
 *   3. Atomic Firestore txn: check balance, decrement pool, increment usage.
 *      Throws InsufficientCreditsError if balance is short.
 *   4. Call PropertyRadar (via the Python service).
 *   5. On PR success: write one activity entry per discrete action; return.
 *   6. On PR failure: refund the deduction + write an unlock_failed entry.
 *
 * Why this is a separate file: both the search-unlock and contact-unlock
 * routes share the deduct-then-call-then-log-or-refund choreography. Only
 * the inner PR call + per-row activity actions differ.
 */

import type { ResolvedPool, CreditAmount, ActivityAction } from "./types";
import { deductCredits, refundCredits } from "./deduct";
import { logActivity } from "./activity";
import { openUnlockJob, settleUnlockJob } from "./unlock-jobs";
import { InsufficientCreditsError } from "./types";

interface UnlockRunInput {
  email: string;
  pool: ResolvedPool;
  /** Total credits to deduct upfront (sum of per-row costs). */
  amount: CreditAmount;
  /** Per-row activity entries to log on success. One per discrete action. */
  rowActions: Array<{
    action: ActivityAction;
    propertyId: string;
    propertyAddress: string;
    creditsUsed: { contact?: number; property?: number };
  }>;
  /**
   * The actual PropertyRadar call. Receives the post-deduction balance so
   * an idempotency key can be derived from it if needed. Returns whatever
   * the caller wants to surface back to the client; on PR failure, throw.
   */
  call: (postDeductionBalance: {
    contact: number;
    property: number;
  }) => Promise<{ propertyRadarRef: string; result: unknown }>;
  /** Label for the reconciliation job (e.g. "unlock_search"). */
  source?: string;
}

interface UnlockRunResult {
  result: unknown;
  balanceAfter: { contact: number; property: number };
}

export async function performUnlock(
  input: UnlockRunInput,
): Promise<UnlockRunResult> {
  validateConsistency(input);

  // 1. Atomic deduction. Throws InsufficientCreditsError on short balance.
  //    cycleId pins the cycle the original deduction landed on, so a
  //    refund that fires after midnight on plan-anniversary day can target
  //    the correct usage doc + skip the pack write (webhook already reset).
  const { balanceAfter, cycleId, packEpoch } = await deductCredits({
    email: input.email,
    pool: input.pool,
    amount: input.amount,
  });

  // 1b. Reconciliation job — if this request dies between the deduction and the
  // refund/settle below, /api/cron/refi-reconcile refunds the full amount.
  // Best-effort; never blocks the unlock.
  const jobId = await openUnlockJob({
    email: input.email,
    deducted: input.amount,
    cycleId,
    packEpoch,
    poolRef: input.pool.poolRef,
    drewFromBuffer: input.pool.drewFromBuffer,
    source: input.source ?? "unlock",
    requested: input.rowActions.length,
  });

  // 2. PR call. Failure must trigger a refund.
  let prResult: { propertyRadarRef: string; result: unknown };
  try {
    prResult = await input.call(balanceAfter);
  } catch (err) {
    const refundLanded = await safeRefundAndLogFailure(input, cycleId, packEpoch, err);
    // Settle only when the refund actually landed — otherwise leave the job
    // pending so /api/cron/refi-reconcile refunds the full deduction.
    if (refundLanded) {
      await settleUnlockJob(jobId, { refunded: input.amount, note: "pr_failed" });
    }
    throw err;
  }

  // Success — nothing refunded; settle so the reconciler skips it.
  await settleUnlockJob(jobId, { refunded: { contact: 0, property: 0 } });

  // 3. Success — write one activity entry per row action.
  await Promise.all(
    input.rowActions.map((row) =>
      logActivity({
        email: input.email,
        action: row.action,
        propertyId: row.propertyId,
        propertyAddress: row.propertyAddress,
        creditsUsed: row.creditsUsed,
        propertyRadarRef: prResult.propertyRadarRef,
        drewFromBuffer: input.pool.drewFromBuffer,
        balanceAfter,
      }),
    ),
  );

  return { result: prResult.result, balanceAfter };
}

async function safeRefundAndLogFailure(
  input: UnlockRunInput,
  cycleId: string,
  packEpoch: number | null,
  err: unknown,
): Promise<boolean> {
  let cycleRolled = false;
  let refundLanded = false;
  try {
    const refundResult = await refundCredits({
      email: input.email,
      pool: input.pool,
      amount: input.amount,
      cycleId,
      packEpoch,
    });
    cycleRolled = refundResult.cycleRolled;
    refundLanded = true;
  } catch (refundErr) {
    // Refund failure is bad — surface in logs but don't mask the original PR
    // error (the caller's catch block needs to see what actually failed).
    // Returning false leaves the reconciliation job pending for the cron.
    console.error("[refi-credits] refund after PR failure also failed:", refundErr);
  }

  try {
    // Standard unlock_failed entry summarizing the batch.
    await logActivity({
      email: input.email,
      action: "unlock_failed",
      propertyId: input.rowActions[0]?.propertyId ?? "unknown",
      propertyAddress: input.rowActions[0]?.propertyAddress ?? "unknown",
      creditsUsed: { contact: 0, property: 0 }, // refunded — no net charge
      propertyRadarRef: "n/a",
      drewFromBuffer: input.pool.drewFromBuffer,
      balanceAfter: { contact: 0, property: 0 },
      failureReason: String(err),
    });

    // Sentinel entry when the cycle rolled mid-flow — pack was NOT credited
    // back (webhook already reset it), but the original cycle's usage
    // counter WAS decremented. Surfaces in user history + audit for
    // reconciliation visibility.
    if (cycleRolled) {
      await logActivity({
        email: input.email,
        action: "refund_skipped_rollover",
        propertyId: input.rowActions[0]?.propertyId ?? "unknown",
        propertyAddress: input.rowActions[0]?.propertyAddress ?? "unknown",
        creditsUsed: input.amount,
        propertyRadarRef: "n/a",
        drewFromBuffer: input.pool.drewFromBuffer,
        balanceAfter: { contact: 0, property: 0 },
        failureReason: `cycle rolled mid-flow (original cycle=${cycleId}); pack already reset by webhook so refund skipped`,
      });
    }
  } catch (logErr) {
    console.error("[refi-credits] failed to log unlock_failed entry:", logErr);
  }
  return refundLanded;
}

function validateConsistency(input: UnlockRunInput): void {
  // The sum of rowActions' creditsUsed must equal input.amount. If they
  // disagree, the caller built a bad request and we'd write a misleading
  // activity log. Fail loud.
  const summed = input.rowActions.reduce(
    (acc, r) => ({
      contact: acc.contact + (r.creditsUsed.contact ?? 0),
      property: acc.property + (r.creditsUsed.property ?? 0),
    }),
    { contact: 0, property: 0 },
  );
  if (
    summed.contact !== input.amount.contact ||
    summed.property !== input.amount.property
  ) {
    throw new Error(
      `[refi-credits/performUnlock] sum mismatch — amount=${JSON.stringify(input.amount)} but rowActions sum to ${JSON.stringify(summed)}`,
    );
  }
}

// Re-export so route handlers don't have to chain imports.
export { InsufficientCreditsError };

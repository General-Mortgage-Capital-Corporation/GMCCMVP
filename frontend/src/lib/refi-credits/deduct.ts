/**
 * Atomic credit deduction + refund + activity logging.
 *
 * Every paid Refi Finder action MUST route through deductCredits() BEFORE the
 * PropertyRadar API call. If PR fails after the deduction, the caller MUST
 * call refundCredits() with the same amount to restore the pool.
 *
 * Concurrency: Firestore transactions serialize writes on the pool doc, so
 * concurrent buffer-allowlisted users don't double-spend the company buffer.
 *
 * Race on cycle rollover: if the per-user cycleEndsAt is in the past when the
 * deduction fires, we treat the pool as 0/0 and throw InsufficientCredits.
 * The webhook will have hard-reset by then if the user paid; if they didn't,
 * the gate is correct. We do NOT check cycleEndsAt inside the transaction —
 * that's the caller's job (resolveSubscription) before reaching this code.
 */

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getDb } from "@/lib/firestore-admin";
import { getRefiMeta } from "./meta";
import {
  computeCycleStart,
  BUFFER_CONTACT_RESET,
  BUFFER_PROPERTY_RESET,
} from "./cycle";
import {
  InsufficientCreditsError,
  type CreditAmount,
  type ResolvedPool,
} from "./types";

interface DeductionContext {
  email: string;
  pool: ResolvedPool;
  amount: CreditAmount;
}

interface DeductionResult {
  balanceAfter: { contact: number; property: number };
  cycleId: string;
}

/**
 * Atomic: read pool → verify balance → decrement pool → increment company
 * usage counter for the current cycle. All-or-nothing.
 */
export async function deductCredits(
  ctx: DeductionContext,
): Promise<DeductionResult> {
  const db = getDb();
  if (!db) throw new Error("[refi-credits/deduct] Firestore not initialized");

  validateAmount(ctx.amount);
  const meta = await getRefiMeta();
  const poolDocRef = db.doc(ctx.pool.poolRef);
  const usageDocRef = db.doc(`creditPacks/company_usage_${meta.currentCycleId}`);

  return db.runTransaction(async (tx) => {
    const poolSnap = await tx.get(poolDocRef);
    const poolData = (poolSnap.data() ?? {}) as {
      contactCredits?: number;
      propertyCredits?: number;
      lastResetAt?: Timestamp;
    };

    // Lazy buffer reset: if this is the company buffer and lastResetAt is
    // before the current cycle's start, reset it to the configured size
    // BEFORE checking balance. Single transaction, race-safe — Firestore
    // serializes writes on the buffer doc.
    let have = {
      contact: poolData.contactCredits ?? 0,
      property: poolData.propertyCredits ?? 0,
    };
    let bufferResetAt: Date | null = null;
    if (ctx.pool.poolRef === "creditPacks/company_buffer") {
      const cycleStart = computeCycleStart(meta.planAnniversary);
      const lastReset = poolData.lastResetAt?.toDate() ?? new Date(0);
      if (lastReset < cycleStart) {
        have = {
          contact: BUFFER_CONTACT_RESET,
          property: BUFFER_PROPERTY_RESET,
        };
        bufferResetAt = cycleStart;
      }
    }

    if (
      have.contact < ctx.amount.contact ||
      have.property < ctx.amount.property
    ) {
      throw new InsufficientCreditsError(ctx.amount, have, ctx.pool.poolRef);
    }

    const balanceAfter = {
      contact: have.contact - ctx.amount.contact,
      property: have.property - ctx.amount.property,
    };

    const poolWrite: Record<string, unknown> = {
      contactCredits: balanceAfter.contact,
      propertyCredits: balanceAfter.property,
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (bufferResetAt) {
      // Pin to the deterministic cycle-start instant (NOT serverTimestamp).
      // A second transaction in the same cycle will read this back as
      // exactly equal to cycleStart and short-circuit the reset cleanly,
      // even if Firestore's serverTimestamp resolution is slightly later
      // than wall-clock cycleStart.
      poolWrite.lastResetAt = Timestamp.fromDate(bufferResetAt);
    }
    tx.set(poolDocRef, poolWrite, { merge: true });

    // company_usage counter — atomic increment. set({merge}) instead of
    // update() so the doc gets created if the MLO portal cron hasn't yet
    // rolled to the new cycle ID (safe — increment treats missing field as 0).
    tx.set(
      usageDocRef,
      {
        contactCreditsUsed: FieldValue.increment(ctx.amount.contact),
        propertyCreditsUsed: FieldValue.increment(ctx.amount.property),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return { balanceAfter, cycleId: meta.currentCycleId };
  });
}

/**
 * Atomic inverse of deductCredits — call when PropertyRadar fails after a
 * successful deduction so the user doesn't lose credits on our errors.
 *
 * Re-increments the pool, decrements the usage counter. Activity-log entry
 * with action: "unlock_failed" is the caller's responsibility — see
 * logActivity().
 */
export async function refundCredits(
  ctx: DeductionContext,
): Promise<{ balanceAfter: { contact: number; property: number } }> {
  const db = getDb();
  if (!db) throw new Error("[refi-credits/deduct] Firestore not initialized");

  validateAmount(ctx.amount);
  const meta = await getRefiMeta();
  const poolDocRef = db.doc(ctx.pool.poolRef);
  const usageDocRef = db.doc(`creditPacks/company_usage_${meta.currentCycleId}`);

  return db.runTransaction(async (tx) => {
    const poolSnap = await tx.get(poolDocRef);
    const poolData = (poolSnap.data() ?? {}) as {
      contactCredits?: number;
      propertyCredits?: number;
    };
    const balanceAfter = {
      contact: (poolData.contactCredits ?? 0) + ctx.amount.contact,
      property: (poolData.propertyCredits ?? 0) + ctx.amount.property,
    };

    tx.set(
      poolDocRef,
      {
        contactCredits: balanceAfter.contact,
        propertyCredits: balanceAfter.property,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    tx.set(
      usageDocRef,
      {
        contactCreditsUsed: FieldValue.increment(-ctx.amount.contact),
        propertyCreditsUsed: FieldValue.increment(-ctx.amount.property),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return { balanceAfter };
  });
}

function validateAmount(amount: CreditAmount): void {
  if (!Number.isInteger(amount.contact) || !Number.isInteger(amount.property)) {
    throw new Error(
      `[refi-credits] amounts must be integers (got contact=${amount.contact}, property=${amount.property})`,
    );
  }
  if (amount.contact < 0 || amount.property < 0) {
    throw new Error("[refi-credits] amounts must be non-negative");
  }
  if (amount.contact === 0 && amount.property === 0) {
    throw new Error("[refi-credits] empty deduction (both amounts zero)");
  }
}

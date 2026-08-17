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
  /** Optional label for the ledger (e.g. "unlock_contact", "unlock_search"). */
  source?: string;
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

    // Immutable credit-ledger entry — atomic with the balance change, so unlike
    // the best-effort activity log it can never be lost if the request dies
    // mid-flight (the gap that made an over-charge un-investigable). One row per
    // deduct/refund, keyed per acting user for forensic lookups.
    writeLedger(tx, db, ctx.email, {
      type: "deduct",
      contact: ctx.amount.contact,
      property: ctx.amount.property,
      balanceAfter,
      poolRef: ctx.pool.poolRef,
      cycleId: meta.currentCycleId,
      source: ctx.source,
    });

    return { balanceAfter, cycleId: meta.currentCycleId };
  });
}

/** Write an immutable ledger row inside the caller's transaction. */
function writeLedger(
  tx: FirebaseFirestore.Transaction,
  db: FirebaseFirestore.Firestore,
  email: string,
  entry: {
    type: "deduct" | "refund";
    contact: number;
    property: number;
    balanceAfter: { contact: number; property: number };
    poolRef: string;
    cycleId: string;
    source?: string;
    skippedPackWrite?: boolean;
  },
): void {
  const ref = db.collection(`users/${email.toLowerCase()}/refiCreditLedger`).doc();
  const payload: Record<string, unknown> = {
    ts: FieldValue.serverTimestamp(),
    type: entry.type,
    contact: entry.contact,
    property: entry.property,
    balanceAfter: entry.balanceAfter,
    poolRef: entry.poolRef,
    cycleId: entry.cycleId,
  };
  if (entry.source) payload.source = entry.source;
  if (entry.skippedPackWrite) payload.skippedPackWrite = true;
  tx.set(ref, payload);
}

/**
 * Atomic inverse of deductCredits — call when PropertyRadar fails after a
 * successful deduction so the user doesn't lose credits on our errors.
 *
 * Requires the `cycleId` returned by the original `deductCredits` call. If
 * the cycle has rolled over since the deduction (PR call straddled
 * midnight on the plan anniversary), the refund:
 *   - DECREMENTS the ORIGINAL cycle's usage counter (so company-usage
 *     accounting stays internally consistent — the original +N is paired
 *     with this -N on the same cycle doc).
 *   - SKIPS the pack write — the Bill.com webhook will already have
 *     hard-reset the user's pack to a fresh 200/5000 on renewal; writing
 *     `have + amount` here would over-credit (e.g. 205/5005).
 *   - Returns `skippedPackWrite: true` so the caller can log a sentinel
 *     activity entry (action: "refund_skipped_rollover").
 *
 * Otherwise behaves as before: re-increments the pool AND decrements the
 * (same) cycle's usage counter atomically. Activity-log entry with action
 * "unlock_failed" remains the caller's responsibility.
 */
export async function refundCredits(
  ctx: DeductionContext & { cycleId: string },
): Promise<{
  balanceAfter: { contact: number; property: number };
  skippedPackWrite: boolean;
  cycleRolled: boolean;
}> {
  const db = getDb();
  if (!db) throw new Error("[refi-credits/deduct] Firestore not initialized");

  validateAmount(ctx.amount);
  const meta = await getRefiMeta();
  const cycleRolled = meta.currentCycleId !== ctx.cycleId;

  // Always target the ORIGINAL cycle's usage doc so accounting stays paired
  // with the deduction. If the cycle hasn't rolled, this is also the current
  // cycle — no behavior change for the common case.
  const usageDocRef = db.doc(`creditPacks/company_usage_${ctx.cycleId}`);
  const poolDocRef = db.doc(ctx.pool.poolRef);

  return db.runTransaction(async (tx) => {
    // Always decrement the original cycle's usage counter — accounting must
    // stay symmetric with the deduction regardless of rollover.
    tx.set(
      usageDocRef,
      {
        contactCreditsUsed: FieldValue.increment(-ctx.amount.contact),
        propertyCreditsUsed: FieldValue.increment(-ctx.amount.property),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    if (cycleRolled) {
      // Webhook (per-user pack) or lazy reset (buffer) will have already
      // restored credits at cycle boundary. Don't double-credit.
      const poolSnap = await tx.get(poolDocRef);
      const poolData = (poolSnap.data() ?? {}) as {
        contactCredits?: number;
        propertyCredits?: number;
      };
      const balanceAfter = {
        contact: poolData.contactCredits ?? 0,
        property: poolData.propertyCredits ?? 0,
      };
      writeLedger(tx, db, ctx.email, {
        type: "refund",
        contact: ctx.amount.contact,
        property: ctx.amount.property,
        balanceAfter,
        poolRef: ctx.pool.poolRef,
        cycleId: ctx.cycleId,
        source: ctx.source,
        skippedPackWrite: true,
      });
      return { balanceAfter, skippedPackWrite: true, cycleRolled: true };
    }

    // Same-cycle refund — original behavior.
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

    writeLedger(tx, db, ctx.email, {
      type: "refund",
      contact: ctx.amount.contact,
      property: ctx.amount.property,
      balanceAfter,
      poolRef: ctx.pool.poolRef,
      cycleId: ctx.cycleId,
      source: ctx.source,
    });

    return { balanceAfter, skippedPackWrite: false, cycleRolled: false };
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

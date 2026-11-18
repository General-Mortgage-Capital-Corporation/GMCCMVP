/**
 * GET /api/cron/refi-reconcile
 *
 * Safety net for the credit-unlock flow. The unlock routes deduct credits up
 * front, call PropertyRadar, then refund the undelivered channels. If a request
 * dies between the deduction and the refund (timeout, instance recycle, throw),
 * the user is left over-charged with no record. `openUnlockJob` writes a
 * `pending` job row at deduction time and the route flips it to `settled` once
 * the refund lands; this cron sweeps jobs still `pending` past the grace window
 * and refunds the FULL deducted amount — turning a silent over-charge into an
 * automatic, audited make-good.
 *
 * Idempotency / no-double-refund:
 *   - A transaction claims each job pending → "reconciling" (only if still
 *     pending), so concurrent cron runs can't both refund the same job.
 *   - Only after the refund succeeds is the job set to "reconciled".
 *   - A job stuck in "reconciling" (crash mid-refund) is NOT auto-retried — it's
 *     logged for human review. We accept a rare un-recovered charge over any
 *     risk of double-refunding free credits.
 */

import { type NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getDb } from "@/lib/firestore-admin";
import { getClientIp, rateLimit } from "@/lib/ratelimit";
import {
  refundCredits,
  logActivity,
  UNLOCK_JOBS_COLLECTION,
  RECONCILE_GRACE_MINUTES,
} from "@/lib/refi-credits";
import type { ResolvedPool } from "@/lib/refi-credits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

interface JobDoc {
  email: string;
  status: string;
  deducted: { contact: number; property: number };
  refunded?: { contact: number; property: number };
  cycleId: string;
  packEpoch?: number | null;
  poolRef: ResolvedPool["poolRef"];
  drewFromBuffer: boolean;
  source: string;
  createdAt?: FirebaseFirestore.Timestamp;
}

export async function GET(req: NextRequest) {
  // Auth mirrors the other crons: require CRON_SECRET when set, else fall back
  // to a rate-limited public trigger (safe — reconciliation is idempotent).
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    if (req.headers.get("Authorization") !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  } else {
    const ip = getClientIp(req);
    if (!(await rateLimit(`cron-refi-reconcile:${ip}`, 5))) {
      return NextResponse.json({ error: "Rate limit exceeded." }, { status: 429 });
    }
  }

  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: "Firestore not configured" }, { status: 503 });
  }

  const cutoffMs = Date.now() - RECONCILE_GRACE_MINUTES * 60_000;

  // Query pending jobs only (normally few — settled jobs flip within seconds),
  // then filter by age in code so we don't need a (status, createdAt) composite
  // index.
  const snap = await db
    .collection(UNLOCK_JOBS_COLLECTION)
    .where("status", "==", "pending")
    .limit(500)
    .get();

  let reconciled = 0;
  let refundedContact = 0;
  let skippedYoung = 0;
  let claimFailed = 0;
  const errors: string[] = [];

  for (const docSnap of snap.docs) {
    const job = docSnap.data() as JobDoc;
    const createdMs = job.createdAt?.toMillis?.() ?? 0;
    // Not old enough yet — a normal in-flight request may still settle it.
    if (createdMs > cutoffMs) {
      skippedYoung++;
      continue;
    }

    // Claim the job: pending → reconciling, only if still pending. Prevents a
    // concurrent run (or the original request finally landing) from also
    // refunding it.
    let claimed = false;
    try {
      await db.runTransaction(async (tx) => {
        const fresh = await tx.get(docSnap.ref);
        if (!fresh.exists) return;
        if ((fresh.data() as JobDoc).status !== "pending") return;
        tx.set(
          docSnap.ref,
          { status: "reconciling", reconcileClaimedAt: FieldValue.serverTimestamp() },
          { merge: true },
        );
        claimed = true;
      });
    } catch (e) {
      errors.push(`${docSnap.id}: claim ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (!claimed) {
      claimFailed++;
      continue;
    }

    // Refund the full deducted amount. refundCredits writes the immutable
    // ledger row (type "refund") atomically with the pool restore.
    try {
      const pool: ResolvedPool = {
        poolRef: job.poolRef,
        drewFromBuffer: !!job.drewFromBuffer,
      };
      const ref = await refundCredits({
        email: job.email,
        pool,
        amount: { contact: job.deducted.contact, property: job.deducted.property },
        cycleId: job.cycleId,
        packEpoch: job.packEpoch ?? null,
        source: "reconcile",
      });

      await logActivity({
        email: job.email,
        action: "refund_reconciled",
        propertyId: "reconcile",
        propertyAddress: `orphaned ${job.source} charge`,
        creditsUsed: { contact: 0, property: 0 },
        propertyRadarRef: "n/a",
        drewFromBuffer: !!job.drewFromBuffer,
        balanceAfter: ref.balanceAfter,
        failureReason: `auto-refunded ${job.deducted.contact} contact / ${job.deducted.property} property credit(s) — request died before settling`,
      }).catch(() => {});

      await docSnap.ref.set(
        {
          status: "reconciled",
          refunded: { contact: job.deducted.contact, property: job.deducted.property },
          reconciledAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      reconciled++;
      refundedContact += job.deducted.contact;
    } catch (e) {
      // Refund failed AFTER claiming → job sits in "reconciling" for human
      // review. We deliberately do NOT revert to pending (would risk a double
      // refund if the refund partially applied).
      errors.push(`${docSnap.id}: refund ${e instanceof Error ? e.message : String(e)}`);
      console.error("[cron/refi-reconcile] refund failed for job", docSnap.id, e);
    }
  }

  const result = {
    scanned: snap.size,
    reconciled,
    refundedContact,
    skippedYoung,
    claimFailed,
    errors,
  };
  if (reconciled > 0 || errors.length > 0) {
    console.log("[cron/refi-reconcile]", JSON.stringify(result));
  }
  return NextResponse.json({ ok: true, ...result });
}

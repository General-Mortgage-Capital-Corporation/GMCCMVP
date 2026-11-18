/**
 * POST /api/refi/unlock-contact-paid
 *
 * Credit-gated wrapper around the Python /api/refi/unlock-contact endpoint.
 *
 * Spec-required guarantee: users are only billed for channels PropertyRadar
 * actually returned data for. PR's per-channel endpoints don't charge them
 * on "not available" responses, but our credit-deduction layer charges
 * upfront — so we deduct N for each requested channel, call PR, then refund
 * 1 credit per channel that came back null.
 *
 * Flow:
 *   1. Verify Firebase ID token → email.
 *   2. Resolve subscription (active or buffer only; else 402).
 *   3. Sum requested credits across rows: 1 contact per email, 1 per text.
 *   4. Atomic deduction up front.
 *   5. PR call (Python /api/refi/unlock-contact). Splits into up to 3 calls
 *      (emailOnly / textOnly / both) so each row only requests its channels.
 *   6. Walk the response — refund 1 contact credit per requested channel
 *      that came back as `phone: null` or `email: null`.
 *   7. Activity log: one entry per channel that ACTUALLY paid out. Rows
 *      where a channel returned null get an `unlock_failed` entry instead.
 *
 * Body:
 *   { rows: [{ radar_id, address, email: boolean, text: boolean }, ...] }
 */

import { type NextRequest, NextResponse } from "next/server";
import { verifyIdTokenWithEmail } from "@/lib/firestore-admin";
import { rateLimit, getClientIp } from "@/lib/ratelimit";
import { pyPost, PythonServiceError } from "@/lib/python-client";
import {
  resolveSubscription,
  resolvePool,
  deductCredits,
  refundCredits,
  logActivity,
  openUnlockJob,
  settleUnlockJob,
  InsufficientCreditsError,
} from "@/lib/refi-credits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface UnlockRow {
  radar_id: string;
  address?: string;
  /** Owner display name from the search row — stamped onto the activity entry. */
  owner_name?: string;
  email?: boolean;
  text?: boolean;
}

interface PyContactResult {
  radar_id: string;
  phone?: string | null;
  email?: string | null;
  phone_error?: string | null;
  email_error?: string | null;
  persons?: unknown[];
  /** Python sets this when the row was served from cross-LO Redis cache
   *  (14-day TTL). PR wasn't charged — neither should the user. */
  cache_hit?: boolean;
}

interface PyContactResponse {
  results?: PyContactResult[];
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return NextResponse.json({ error: "missing_bearer" }, { status: 401 });
  }
  const verified = await verifyIdTokenWithEmail(auth.slice(7));
  if (!verified) {
    return NextResponse.json({ error: "invalid_token" }, { status: 401 });
  }

  const ip = getClientIp(req);
  if (!(await rateLimit(ip, 10))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const body = (await req.json().catch(() => null)) as
    | { rows?: UnlockRow[] }
    | null;
  if (!body || !Array.isArray(body.rows) || body.rows.length === 0) {
    return NextResponse.json({ error: "rows required" }, { status: 400 });
  }
  const MAX = 25;
  if (body.rows.length > MAX) {
    return NextResponse.json(
      { error: `max_${MAX}_rows`, detail: `submitted ${body.rows.length}` },
      { status: 400 },
    );
  }

  // Per-row request summary. We index by radar_id for the post-PR walk.
  // Duplicate radar_ids are rejected: PR returns one entry per id, so the
  // refund-walk would only credit back one occurrence — every extra
  // duplicate row silently burns 1-2 contact credits for the user.
  const requested: Record<
    string,
    { address: string; ownerName?: string; wantEmail: boolean; wantText: boolean }
  > = {};
  let contactNeeded = 0;
  for (const row of body.rows) {
    if (!row.radar_id) {
      return NextResponse.json({ error: "row_missing_radar_id" }, { status: 400 });
    }
    if (requested[row.radar_id]) {
      return NextResponse.json(
        { error: "duplicate_radar_id", radar_id: row.radar_id },
        { status: 400 },
      );
    }
    const wantEmail = !!row.email;
    const wantText = !!row.text;
    if (!wantEmail && !wantText) {
      return NextResponse.json(
        { error: "row_must_request_email_or_text", radar_id: row.radar_id },
        { status: 400 },
      );
    }
    requested[row.radar_id] = {
      address: row.address ?? "unknown",
      ownerName: row.owner_name?.trim() || undefined,
      wantEmail,
      wantText,
    };
    contactNeeded += (wantEmail ? 1 : 0) + (wantText ? 1 : 0);
  }

  // Gating
  const sub = await resolveSubscription(verified.email);
  if (sub.state !== "active" && sub.state !== "buffer") {
    return NextResponse.json(
      { error: "no_subscription", state: sub.state },
      { status: 402 },
    );
  }
  const pool = await resolvePool(verified.email);

  // 1. Atomic deduction up front (estimated max — refunds below if PR didn't deliver).
  // cycleId pins the cycle this deduction landed on so refunds below can
  // target the original cycle's usage counter even if PR straddles midnight.
  let balanceAfterDeduct: { contact: number; property: number };
  let cycleId: string;
  let packEpoch: number | null;
  try {
    const ded = await deductCredits({
      email: verified.email,
      pool,
      amount: { contact: contactNeeded, property: 0 },
    });
    balanceAfterDeduct = ded.balanceAfter;
    cycleId = ded.cycleId;
    packEpoch = ded.packEpoch;
  } catch (e) {
    if (e instanceof InsufficientCreditsError) {
      return NextResponse.json(
        { error: "insufficient_credits", needed: e.needed, have: e.have },
        { status: 402 },
      );
    }
    throw e;
  }

  // 1b. Open a reconciliation job. If this request dies before the refund +
  // settle below, the /api/cron/refi-reconcile sweep refunds the full deducted
  // amount so the user is never silently over-charged. Best-effort — a failure
  // here only forfeits reconciliation coverage for this one request.
  const jobId = await openUnlockJob({
    email: verified.email,
    deducted: { contact: contactNeeded, property: 0 },
    cycleId,
    packEpoch,
    poolRef: pool.poolRef,
    drewFromBuffer: pool.drewFromBuffer,
    source: "unlock_contact",
    requested: contactNeeded,
  });

  // 2. Split rows by which channels they want (up to 3 PR calls). Keep the
  // original request shape so we know what was asked, not just what came back.
  const emailOnly = body.rows.filter((r) => r.email && !r.text);
  const textOnly = body.rows.filter((r) => r.text && !r.email);
  const both = body.rows.filter((r) => r.email && r.text);

  // Use Promise.allSettled so a failure in one bucket (e.g. `both`) doesn't
  // discard work the other buckets already paid PR for. Buckets that
  // fulfilled get their normal per-row processing below; failed buckets get
  // their requested credits refunded and their requested rows logged as
  // unlock_failed.
  const settled = await Promise.allSettled([
    callPython(emailOnly, { phone: false, email: true }),
    callPython(textOnly, { phone: true, email: false }),
    callPython(both, { phone: true, email: true }),
  ]);
  const combined: { emailOnly?: PyContactResponse; textOnly?: PyContactResponse; both?: PyContactResponse } = {
    emailOnly: settled[0].status === "fulfilled" ? settled[0].value : undefined,
    textOnly: settled[1].status === "fulfilled" ? settled[1].value : undefined,
    both: settled[2].status === "fulfilled" ? settled[2].value : undefined,
  };
  // Track per-row failures from bucket-level failures. Rows belonging to a
  // failed bucket get a full refund (1 credit per requested channel) +
  // unlock_failed activity entry below. Rows in fulfilled buckets go through
  // the normal cache/null walk.
  const bucketFailures = new Map<string, string>(); // radar_id → reason
  function recordBucketFailure(rows: UnlockRow[], reason: string): void {
    for (const r of rows) bucketFailures.set(r.radar_id, reason);
  }
  if (settled[0].status === "rejected") {
    recordBucketFailure(emailOnly, errToStr(settled[0].reason));
  }
  if (settled[1].status === "rejected") {
    recordBucketFailure(textOnly, errToStr(settled[1].reason));
  }
  if (settled[2].status === "rejected") {
    recordBucketFailure(both, errToStr(settled[2].reason));
  }
  // If ALL buckets failed, behave like the legacy whole-batch failure path
  // so callers still get a single clear error response.
  if (settled.every((s) => s.status === "rejected")) {
    let refundLanded = false;
    try {
      await refundCredits({
        email: verified.email,
        pool,
        amount: { contact: contactNeeded, property: 0 },
        cycleId,
        packEpoch,
      });
      refundLanded = true;
    } catch (rerr) {
      console.error("[unlock-contact-paid] refund failed:", rerr);
    }
    // Settle ONLY when the refund landed (reconciler must not re-refund a
    // settled job). On refund failure the job stays pending and the
    // reconciler sweep refunds the full deduction.
    if (refundLanded) {
      await settleUnlockJob(jobId, {
        refunded: { contact: contactNeeded, property: 0 },
        note: "all_buckets_failed",
      });
    }
    const firstErr = settled.find((s) => s.status === "rejected") as
      | PromiseRejectedResult
      | undefined;
    await logActivity({
      email: verified.email,
      action: "unlock_failed",
      propertyId: "batch_unlock",
      propertyAddress: `${body.rows.length}-row unlock`,
      creditsUsed: { contact: 0, property: 0 },
      propertyRadarRef: "n/a",
      drewFromBuffer: pool.drewFromBuffer,
      balanceAfter: balanceAfterDeduct,
      failureReason: errToStr(firstErr?.reason),
    }).catch(() => {});

    const status =
      firstErr?.reason instanceof PythonServiceError
        ? firstErr.reason.status
        : 502;
    const msg =
      firstErr?.reason instanceof PythonServiceError
        ? firstErr.reason.message
        : "unlock_failed";
    return NextResponse.json(
      { error: msg, refunded: true },
      { status: status === 200 ? 502 : status },
    );
  }

  // 3. Index PR results by radar_id so we can match requested vs. received.
  const byRadar = new Map<string, PyContactResult>();
  for (const bucket of [combined.emailOnly, combined.textOnly, combined.both]) {
    for (const r of bucket?.results ?? []) {
      // If two buckets somehow returned the same row, the later one wins.
      // Shouldn't happen since we partitioned the rows, but be defensive.
      byRadar.set(String(r.radar_id), r);
    }
  }

  // 4. Walk requested rows in two passes:
  //   Pass A: build the list of activity "specs" (without balanceAfter) and
  //           accumulate refundContact total. This decides what to refund.
  //   Pass B: after the refund actually lands, stamp every spec with the
  //           same finalBalance and submit all the writes.
  // This keeps the History view honest — every entry from one batch action
  // shows the actual post-refund balance, not an intermediate value.
  type PendingEntry = Omit<Parameters<typeof logActivity>[0], "balanceAfter">;
  const pending: PendingEntry[] = [];
  let refundContact = 0;
  for (const [radarId, req] of Object.entries(requested)) {
    const bucketFailReason = bucketFailures.get(radarId);
    const res = byRadar.get(radarId);
    const cacheHit = !!res?.cache_hit;
    const gotEmail = !!res?.email;
    const gotText = !!res?.phone;
    const emailErr = res?.email_error ?? (res === undefined ? "no_response" : null);
    const phoneErr = res?.phone_error ?? (res === undefined ? "no_response" : null);

    if (req.wantEmail) {
      if (bucketFailReason) {
        // Bucket-level failure → refund + unlock_failed.
        refundContact += 1;
        pending.push({
          email: verified.email,
          action: "unlock_failed",
          propertyId: radarId,
          propertyAddress: req.address,
          ownerName: req.ownerName,
          creditsUsed: { contact: 0 },
          propertyRadarRef: radarId,
          drewFromBuffer: pool.drewFromBuffer,
          failureReason: `email: ${bucketFailReason}`,
        });
      } else if (gotEmail) {
        if (cacheHit) refundContact += 1;
        pending.push({
          email: verified.email,
          action: "unlock_email",
          propertyId: radarId,
          propertyAddress: req.address,
          ownerName: req.ownerName,
          creditsUsed: { contact: cacheHit ? 0 : 1 },
          propertyRadarRef: radarId,
          drewFromBuffer: pool.drewFromBuffer,
          revealedValue: res?.email ?? undefined,
          fromCache: cacheHit || undefined,
        });
      } else {
        refundContact += 1;
        pending.push({
          email: verified.email,
          action: "unlock_failed",
          propertyId: radarId,
          propertyAddress: req.address,
          ownerName: req.ownerName,
          creditsUsed: { contact: 0 },
          propertyRadarRef: radarId,
          drewFromBuffer: pool.drewFromBuffer,
          failureReason: `email: ${emailErr ?? "not available"}`,
        });
      }
    }

    if (req.wantText) {
      if (bucketFailReason) {
        refundContact += 1;
        pending.push({
          email: verified.email,
          action: "unlock_failed",
          propertyId: radarId,
          propertyAddress: req.address,
          ownerName: req.ownerName,
          creditsUsed: { contact: 0 },
          propertyRadarRef: radarId,
          drewFromBuffer: pool.drewFromBuffer,
          failureReason: `text: ${bucketFailReason}`,
        });
      } else if (gotText) {
        if (cacheHit) refundContact += 1;
        pending.push({
          email: verified.email,
          action: "unlock_text",
          propertyId: radarId,
          propertyAddress: req.address,
          ownerName: req.ownerName,
          creditsUsed: { contact: cacheHit ? 0 : 1 },
          propertyRadarRef: radarId,
          drewFromBuffer: pool.drewFromBuffer,
          revealedValue: res?.phone ?? undefined,
          fromCache: cacheHit || undefined,
        });
      } else {
        refundContact += 1;
        pending.push({
          email: verified.email,
          action: "unlock_failed",
          propertyId: radarId,
          propertyAddress: req.address,
          ownerName: req.ownerName,
          creditsUsed: { contact: 0 },
          propertyRadarRef: radarId,
          drewFromBuffer: pool.drewFromBuffer,
          failureReason: `text: ${phoneErr ?? "not available"}`,
        });
      }
    }
  }

  // 5. Pass B: refund first, THEN stamp every pending entry with the actual
  // final balance and submit. This way the History view shows one consistent
  // post-batch snapshot for every row in the action — not the worst-case
  // pre-refund balance.
  let finalBalance = balanceAfterDeduct;
  let refundLanded = refundContact === 0;
  if (refundContact > 0) {
    try {
      const ref = await refundCredits({
        email: verified.email,
        pool,
        amount: { contact: refundContact, property: 0 },
        cycleId,
        packEpoch,
      });
      finalBalance = ref.balanceAfter;
      refundLanded = true;
    } catch (rerr) {
      console.error("[unlock-contact-paid] partial refund failed:", rerr);
      // Don't surface — user still got data; the pending job below hands the
      // discrepancy to the reconciler instead of eating it.
    }
  }

  // Settle ONLY once any owed refund actually landed. A failed refund (or a
  // crash in the tiny window between the refund above and here) leaves the job
  // pending; the reconciler then refunds the full amount — user-favorable,
  // which matches this route's "only bill for what PR delivered" guarantee.
  if (refundLanded) {
    await settleUnlockJob(jobId, {
      refunded: { contact: refundContact, property: 0 },
    });
  }

  await Promise.all(
    pending.map((p) =>
      logActivity({ ...p, balanceAfter: finalBalance }).catch((werr) =>
        console.warn("[unlock-contact-paid] activity log write failed:", werr),
      ),
    ),
  );

  return NextResponse.json({
    success: true,
    ...combined,
    balanceAfter: finalBalance,
    refundedContactCredits: refundContact,
  });
}

function errToStr(reason: unknown): string {
  if (reason instanceof PythonServiceError) return reason.message;
  if (reason instanceof Error) return reason.message;
  return String(reason);
}

async function callPython(
  rows: UnlockRow[],
  flags: { phone: boolean; email: boolean },
): Promise<PyContactResponse> {
  if (rows.length === 0) return {};
  return await pyPost<PyContactResponse>(
    "/api/refi/unlock-contact",
    {
      radar_ids: rows.map((r) => r.radar_id),
      phone: flags.phone,
      email: flags.email,
    },
  );
}

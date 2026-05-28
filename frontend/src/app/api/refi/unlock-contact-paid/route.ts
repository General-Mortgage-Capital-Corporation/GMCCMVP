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
  if (!rateLimit(ip, 10)) {
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
  const requested: Record<
    string,
    { address: string; ownerName?: string; wantEmail: boolean; wantText: boolean }
  > = {};
  let contactNeeded = 0;
  for (const row of body.rows) {
    if (!row.radar_id) {
      return NextResponse.json({ error: "row_missing_radar_id" }, { status: 400 });
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
  let balanceAfterDeduct: { contact: number; property: number };
  try {
    const ded = await deductCredits({
      email: verified.email,
      pool,
      amount: { contact: contactNeeded, property: 0 },
    });
    balanceAfterDeduct = ded.balanceAfter;
  } catch (e) {
    if (e instanceof InsufficientCreditsError) {
      return NextResponse.json(
        { error: "insufficient_credits", needed: e.needed, have: e.have },
        { status: 402 },
      );
    }
    throw e;
  }

  // 2. Split rows by which channels they want (up to 3 PR calls). Keep the
  // original request shape so we know what was asked, not just what came back.
  const emailOnly = body.rows.filter((r) => r.email && !r.text);
  const textOnly = body.rows.filter((r) => r.text && !r.email);
  const both = body.rows.filter((r) => r.email && r.text);

  let combined: { emailOnly?: PyContactResponse; textOnly?: PyContactResponse; both?: PyContactResponse } = {};
  try {
    const [eo, to, b] = await Promise.all([
      callPython(emailOnly, { phone: false, email: true }),
      callPython(textOnly, { phone: true, email: false }),
      callPython(both, { phone: true, email: true }),
    ]);
    combined = { emailOnly: eo, textOnly: to, both: b };
  } catch (err) {
    // Whole call failed — full refund + log + return.
    await refundCredits({
      email: verified.email,
      pool,
      amount: { contact: contactNeeded, property: 0 },
    }).catch((rerr) =>
      console.error("[unlock-contact-paid] refund failed:", rerr),
    );
    await logActivity({
      email: verified.email,
      action: "unlock_failed",
      propertyId: "batch_unlock",
      propertyAddress: `${body.rows.length}-row unlock`,
      creditsUsed: { contact: 0, property: 0 },
      propertyRadarRef: "n/a",
      drewFromBuffer: pool.drewFromBuffer,
      balanceAfter: balanceAfterDeduct,
      failureReason: String(err),
    }).catch(() => {});

    const status = err instanceof PythonServiceError ? err.status : 502;
    const msg = err instanceof PythonServiceError ? err.message : "unlock_failed";
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

  // 4. Walk requested rows, compute partial refund + activity entries.
  // Per-row cache_hit means PR wasn't charged for that row — neither should
  // the user for whichever channels they requested on it.
  let refundContact = 0;
  const activityWrites: Array<Promise<unknown>> = [];
  for (const [radarId, req] of Object.entries(requested)) {
    const res = byRadar.get(radarId);
    const cacheHit = !!res?.cache_hit;
    const gotEmail = !!res?.email;
    const gotText = !!res?.phone;
    const emailErr = res?.email_error ?? (res === undefined ? "no_response" : null);
    const phoneErr = res?.phone_error ?? (res === undefined ? "no_response" : null);

    if (req.wantEmail) {
      if (gotEmail) {
        if (cacheHit) refundContact += 1;
        activityWrites.push(
          logActivity({
            email: verified.email,
            action: "unlock_email",
            propertyId: radarId,
            propertyAddress: req.address,
            ownerName: req.ownerName,
            creditsUsed: { contact: cacheHit ? 0 : 1 },
            propertyRadarRef: radarId,
            drewFromBuffer: pool.drewFromBuffer,
            balanceAfter: balanceAfterDeduct,
            revealedValue: res?.email ?? undefined,
            fromCache: cacheHit || undefined,
          }),
        );
      } else {
        refundContact += 1;
        activityWrites.push(
          logActivity({
            email: verified.email,
            action: "unlock_failed",
            propertyId: radarId,
            propertyAddress: req.address,
            ownerName: req.ownerName,
            creditsUsed: { contact: 0 },
            propertyRadarRef: radarId,
            drewFromBuffer: pool.drewFromBuffer,
            balanceAfter: balanceAfterDeduct,
            failureReason: `email: ${emailErr ?? "not available"}`,
          }),
        );
      }
    }

    if (req.wantText) {
      if (gotText) {
        if (cacheHit) refundContact += 1;
        activityWrites.push(
          logActivity({
            email: verified.email,
            action: "unlock_text",
            propertyId: radarId,
            propertyAddress: req.address,
            ownerName: req.ownerName,
            creditsUsed: { contact: cacheHit ? 0 : 1 },
            propertyRadarRef: radarId,
            drewFromBuffer: pool.drewFromBuffer,
            balanceAfter: balanceAfterDeduct,
            revealedValue: res?.phone ?? undefined,
            fromCache: cacheHit || undefined,
          }),
        );
      } else {
        refundContact += 1;
        activityWrites.push(
          logActivity({
            email: verified.email,
            action: "unlock_failed",
            propertyId: radarId,
            propertyAddress: req.address,
            ownerName: req.ownerName,
            creditsUsed: { contact: 0 },
            propertyRadarRef: radarId,
            drewFromBuffer: pool.drewFromBuffer,
            balanceAfter: balanceAfterDeduct,
            failureReason: `text: ${phoneErr ?? "not available"}`,
          }),
        );
      }
    }
  }

  // 5. Partial refund + post-refund balance.
  let finalBalance = balanceAfterDeduct;
  if (refundContact > 0) {
    try {
      const ref = await refundCredits({
        email: verified.email,
        pool,
        amount: { contact: refundContact, property: 0 },
      });
      finalBalance = ref.balanceAfter;
    } catch (rerr) {
      console.error("[unlock-contact-paid] partial refund failed:", rerr);
      // Don't surface — user still got data, log will show the discrepancy.
    }
  }

  await Promise.all(activityWrites).catch((werr) =>
    console.warn("[unlock-contact-paid] activity log write batch failed:", werr),
  );

  return NextResponse.json({
    success: true,
    ...combined,
    balanceAfter: finalBalance,
    refundedContactCredits: refundContact,
  });
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

/**
 * POST /api/refi/unlock-search
 *
 * Credit-gated wrapper around the Python /api/refi/search endpoint.
 *
 *   1. Verify Firebase ID token → email.
 *   2. Resolve subscription — must be active or buffer; else 402.
 *   3. Resolve pool (personal vs company_buffer).
 *   4. Atomic deduction of `limit` property credits (search rows = property credits).
 *   5. Call Python /api/refi/search.
 *   6. Log one activity entry per row returned (action: "unlock_property").
 *   7. On PR failure: refund + log unlock_failed.
 *
 * Body: same shape as /api/refi/search forwards to Python, plus:
 *   - confirmedLimit: number   — must equal body.limit. Echoes the count the
 *                                client showed in the confirmation modal so
 *                                we can't be tricked into deducting a
 *                                different amount than the user OK'd.
 *
 * Replaces /api/refi/search for users on the new subscription/buffer system.
 * Legacy free-tier users (has_access without buffer/subscription) continue
 * to hit /api/refi/search directly until Phase 4 removes that path.
 *
 * Why not use lib/refi-credits/performUnlock here: that helper requires
 * rowActions up front, but for search we don't know the row addresses until
 * PR responds. We open-code the deduct→call→log-or-refund flow.
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

interface SearchRowMinimal {
  RadarID?: string | number;
  Address?: string;
  [k: string]: unknown;
}

interface SearchResponse {
  rows?: SearchRowMinimal[];
  results?: SearchRowMinimal[];
  cache_hit?: boolean;
  [k: string]: unknown;
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
  if (!rateLimit(ip, 20)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const body = (await req.json().catch(() => null)) as
    | (Record<string, unknown> & { confirmedLimit?: number; limit?: number })
    | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const limit = Number(body.limit);
  const confirmedLimit = Number(body.confirmedLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return NextResponse.json({ error: "bad_limit" }, { status: 400 });
  }
  if (confirmedLimit !== limit) {
    return NextResponse.json(
      {
        error: "confirmation_mismatch",
        detail: `client confirmed ${confirmedLimit} but body.limit=${limit}`,
      },
      { status: 400 },
    );
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

  // Body for Python (strip our own field).
  const pyBody: Record<string, unknown> = { ...body };
  delete pyBody.confirmedLimit;

  // 1. Atomic deduction. property credits = N rows; no contact credits here.
  let balanceAfter: { contact: number; property: number };
  try {
    const ded = await deductCredits({
      email: verified.email,
      pool,
      amount: { contact: 0, property: limit },
    });
    balanceAfter = ded.balanceAfter;
  } catch (e) {
    if (e instanceof InsufficientCreditsError) {
      return NextResponse.json(
        { error: "insufficient_credits", needed: e.needed, have: e.have },
        { status: 402 },
      );
    }
    throw e;
  }

  // 2. PR call via Python.
  let pyData: SearchResponse;
  try {
    pyData = await pyPost<SearchResponse>("/api/refi/search", pyBody);
  } catch (err) {
    // 3a. Refund + log failure.
    await refundCredits({
      email: verified.email,
      pool,
      amount: { contact: 0, property: limit },
    }).catch((rerr) =>
      console.error("[unlock-search] refund failed:", rerr),
    );
    await logActivity({
      email: verified.email,
      action: "unlock_failed",
      propertyId: "batch_search",
      propertyAddress: `${limit}-row search`,
      creditsUsed: { contact: 0, property: 0 },
      propertyRadarRef: "n/a",
      drewFromBuffer: pool.drewFromBuffer,
      balanceAfter,
      failureReason: String(err),
    }).catch(() => {});

    const status = err instanceof PythonServiceError ? err.status : 502;
    const msg = err instanceof PythonServiceError ? err.message : "search_failed";
    return NextResponse.json({ error: msg, refunded: true }, { status });
  }

  // 3. Cache-hit refund. Python sets cache_hit:true when the entire page came
  // from Redis (cross-LO 24h TTL) — PR wasn't charged, so neither should the
  // user. Refund the full upfront deduction and zero out per-row creditsUsed.
  const cacheHit = !!pyData.cache_hit;
  let finalBalance = balanceAfter;
  if (cacheHit) {
    try {
      const ref = await refundCredits({
        email: verified.email,
        pool,
        amount: { contact: 0, property: limit },
      });
      finalBalance = ref.balanceAfter;
    } catch (rerr) {
      console.error("[unlock-search] cache-hit refund failed:", rerr);
    }
  }

  // 4. Per-row activity log on success.
  const rows = pyData.rows ?? pyData.results ?? [];
  await Promise.all(
    rows.map((row) =>
      logActivity({
        email: verified.email,
        action: "unlock_property",
        propertyId: String(row.RadarID ?? "unknown"),
        propertyAddress: typeof row.Address === "string" ? row.Address : "unknown",
        creditsUsed: { property: cacheHit ? 0 : 1 },
        propertyRadarRef: String(row.RadarID ?? "unknown"),
        drewFromBuffer: pool.drewFromBuffer,
        balanceAfter: finalBalance,
        fromCache: cacheHit || undefined,
      }).catch((err) =>
        console.warn("[unlock-search] per-row activity log failed:", err),
      ),
    ),
  );

  return NextResponse.json({
    ...pyData,
    success: true,
    balanceAfter: finalBalance,
    refundedPropertyCredits: cacheHit ? limit : 0,
  });
}

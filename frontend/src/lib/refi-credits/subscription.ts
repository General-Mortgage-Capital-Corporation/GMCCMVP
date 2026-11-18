/**
 * Subscription gating — reads the per-user clock ONLY.
 *
 * Returns one of four states:
 *   - "buffer"           — user is on bufferAllowlist (always allowed, deducts from company_buffer)
 *   - "active"           — user has paid AND cycleEndsAt > now (regardless of autoRenewCanceled)
 *   - "expired"          — credit pack doc exists but cycleEndsAt <= now
 *   - "never_subscribed" — no credit pack doc + not on allowlist
 *
 * Gating logic NEVER consults the company PR plan cycle here. The two clocks
 * (per-user subscription, company plan anniversary) are independent — a user
 * who paid 5 days ago has 25 days of credits left even if PR resets tomorrow.
 *
 * autoRenewCanceled is informational: a canceled-but-still-in-cycle user is
 * still "active". The MLO portal's cancel endpoint deliberately does NOT
 * touch the credit pack; it only stops the next auto-bill from firing.
 */

import { getDb } from "@/lib/firestore-admin";
import { getRefiMeta } from "./meta";
import type {
  RefiCreditPack,
  RefiSubscription,
  SubscriptionStatus,
} from "./types";

export async function resolveSubscription(
  email: string,
): Promise<SubscriptionStatus> {
  const normalized = email.toLowerCase();
  const db = getDb();
  if (!db) throw new Error("[refi-credits/subscription] Firestore not initialized");

  const meta = await getRefiMeta();
  const onAllowlist = meta.bufferAllowlist.includes(normalized);

  if (onAllowlist) {
    // Buffer users still get a balance display — read company_buffer.
    const bufferSnap = await db.doc("creditPacks/company_buffer").get();
    const bufferData = (bufferSnap.data() ?? {}) as {
      contactCredits?: number;
      propertyCredits?: number;
    };
    return {
      state: "buffer",
      email: normalized,
      balance: {
        contact: bufferData.contactCredits ?? 0,
        property: bufferData.propertyCredits ?? 0,
      },
    };
  }

  // The subscription doc is users/{email}/subscriptions/current, with
  // refi_finder as a nested field. That is the doc the Bill.com webhook, the
  // cancel handler, and the MLO portal all write. This used to read the
  // retired top-level subscriptions/{email} collection instead, so a user
  // who cancelled auto-renewal in the UI never showed as cancelled here.
  const [packSnap, subSnap] = await Promise.all([
    db.doc(`users/${normalized}/creditPacks/refi_finder`).get(),
    db.doc(`users/${normalized}/subscriptions/current`).get(),
  ]);

  if (!packSnap.exists) {
    return { state: "never_subscribed", email: normalized };
  }

  const pack = packSnap.data() as RefiCreditPack;
  const subDoc = (subSnap.data() ?? {}) as { refi_finder?: RefiSubscription };
  const sub = subDoc.refi_finder ?? {};
  const cycleEndsAt = pack.cycleEndsAt?.toDate() ?? null;

  // Webhook-mid-write defense: if the credit pack doc exists but cycleEndsAt
  // is missing (or hasn't been written yet by the Bill.com webhook), treat
  // it as never_subscribed so the user sees the marketing pitch instead of a
  // confusing "your cycle has ended" message during the brief window between
  // pack creation and full webhook completion.
  if (cycleEndsAt === null) {
    return { state: "never_subscribed", email: normalized };
  }

  const isInCycle = cycleEndsAt.getTime() > Date.now();
  if (!isInCycle) {
    // P1-7: if auto-renew is on and we're only just past cycleEndsAt, the
    // Bill.com webhook is probably still in flight (we've seen 10+ min
    // delays). Render "Renewal processing" instead of "Resubscribe" so the
    // user doesn't double-pay. After the window, fall through to expired
    // — the renewal genuinely failed at that point.
    const cycleEndedMsAgo = Date.now() - cycleEndsAt.getTime();
    if (!sub.autoRenewCanceled && cycleEndedMsAgo < RENEWAL_WINDOW_MS) {
      return {
        state: "renewing",
        email: normalized,
        lastCycleEndedAt: cycleEndsAt,
      };
    }
    return { state: "expired", email: normalized, cycleEndsAt };
  }

  return {
    state: "active",
    email: normalized,
    autoRenewCanceled: sub.autoRenewCanceled ?? false,
    cycleEndsAt: cycleEndsAt as Date,
    balance: {
      contact: pack.contactCredits ?? 0,
      property: pack.propertyCredits ?? 0,
    },
  };
}

/** Grace window after cycleEndsAt during which we trust auto-renew to land
 *  and render "Renewal processing" instead of the Resubscribe CTA. */
const RENEWAL_WINDOW_MS = 30 * 60 * 1000;

/** True if the user is allowed to take a paid unlock action right now.
 *  `renewing` users intentionally cannot unlock — the pack is past expiry
 *  and the deduct transaction would fail anyway. */
export function canUnlock(status: SubscriptionStatus): boolean {
  return status.state === "active" || status.state === "buffer";
}

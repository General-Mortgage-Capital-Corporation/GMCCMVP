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

  const [packSnap, subSnap] = await Promise.all([
    db.doc(`users/${normalized}/creditPacks/refi_finder`).get(),
    db.doc(`users/${normalized}/subscriptions/refi_finder`).get(),
  ]);

  if (!packSnap.exists) {
    return { state: "never_subscribed", email: normalized };
  }

  const pack = packSnap.data() as RefiCreditPack;
  const sub = (subSnap.data() ?? {}) as RefiSubscription;
  const cycleEndsAt = pack.cycleEndsAt?.toDate() ?? null;
  const isInCycle = cycleEndsAt !== null && cycleEndsAt.getTime() > Date.now();

  if (!isInCycle) {
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

/** True if the user is allowed to take a paid unlock action right now. */
export function canUnlock(status: SubscriptionStatus): boolean {
  return status.state === "active" || status.state === "buffer";
}

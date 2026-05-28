/**
 * Polled reader for the caller's Refi Finder subscription status.
 *
 * Fetches /api/refi-subscription/status on mount + every `pollIntervalMs`
 * (default 8s). Used by the credits widget + RefiFinderGate to know whether
 * to render the active UI, the Subscribe CTA, or the "expired — resubscribe"
 * state. Faster polling (3s) is enabled while a payment is in flight via the
 * `aggressive` flag — callers flip it on after kicking off subscribe/recharge.
 *
 * Why polling instead of Firestore client-SDK onSnapshot:
 *   - no new client deps (~50KB saved)
 *   - simpler auth (we already attach the Firebase ID token via authedFetch)
 *   - balance updates are infrequent (cycleEndsAt only changes on webhook fire)
 *
 * Returns null `status` while the first fetch is in flight.
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { authedFetch } from "@/lib/authed-fetch";

type SubscriptionStatusBase =
  | {
      state: "active";
      email: string;
      autoRenewCanceled: boolean;
      cycleEndsAt: string; // ISO
      balance: { contact: number; property: number };
    }
  | {
      state: "buffer";
      email: string;
      balance: { contact: number; property: number };
    }
  | {
      state: "expired";
      email: string;
      cycleEndsAt: string | null;
    }
  | {
      state: "never_subscribed";
      email: string;
    };

/** Status payload plus the server-driven paymentsEnabled flag — mirrors
 *  REFI_FINDER_PAYMENTS_DISABLED on the MLO portal so the two surfaces
 *  show/hide payment CTAs together. */
export type SubscriptionStatusJSON = SubscriptionStatusBase & {
  paymentsEnabled?: boolean;
};

interface UseRefiSubscriptionOpts {
  /** Poll cadence in ms. Default 8s. */
  pollIntervalMs?: number;
  /** Tighter cadence (default 3s) used during payment flows. */
  aggressive?: boolean;
}

export function useRefiSubscription(opts: UseRefiSubscriptionOpts = {}): {
  status: SubscriptionStatusJSON | null;
  loading: boolean;
  error: string | null;
  /** Force-refresh now (e.g. when a payment popup closes). */
  refresh: () => void;
} {
  const { user } = useAuth();
  const [status, setStatus] = useState<SubscriptionStatusJSON | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  const fetchOnce = useCallback(async () => {
    if (!user) {
      setStatus(null);
      setLoading(false);
      return;
    }
    try {
      const res = await authedFetch("/api/refi-subscription/status");
      if (!res.ok) {
        if (!cancelledRef.current) setError(`status_${res.status}`);
        return;
      }
      const data = (await res.json()) as SubscriptionStatusJSON;
      if (!cancelledRef.current) {
        setStatus(data);
        setError(null);
      }
    } catch (e) {
      if (!cancelledRef.current) setError(String(e));
    } finally {
      if (!cancelledRef.current) setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    cancelledRef.current = false;
    void fetchOnce();
    const interval = opts.aggressive
      ? 3_000
      : (opts.pollIntervalMs ?? 8_000);
    const id = setInterval(fetchOnce, interval);
    return () => {
      cancelledRef.current = true;
      clearInterval(id);
    };
  }, [fetchOnce, opts.aggressive, opts.pollIntervalMs]);

  return { status, loading, error, refresh: fetchOnce };
}

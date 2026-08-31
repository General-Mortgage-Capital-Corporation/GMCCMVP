/**
 * PostHog analytics — tracks per-user activity (searches, emails, flyers, etc.)
 *
 * Initialize once on app load, identify on sign-in, track events at key actions.
 * PostHog dashboard provides per-user activity feeds, event counts, and retention.
 */

import posthog from "posthog-js";

const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY ?? "";
const POSTHOG_HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com";

let initialized = false;

/** Call once on app mount (client-side only). */
export function initPostHog() {
  if (initialized || !POSTHOG_KEY || typeof window === "undefined") return;
  posthog.init(POSTHOG_KEY, {
    api_host: POSTHOG_HOST,
    capture_pageview: true,
    capture_pageleave: true,
    autocapture: true,
    persistence: "localStorage",
  });
  initialized = true;
}

/**
 * Identify the current user after sign-in.
 *
 * `role` distinguishes LO sessions from partner (realtor/CPA) sessions, and
 * `mloEmail` ties every partner event back to the LO who provisioned the
 * account — so dashboards can slice by partner activity per LO. Registered
 * as super properties too, so every subsequent event carries them without
 * each call site remembering to.
 */
export function identifyUser(
  email: string,
  displayName: string,
  extra?: { role?: "mlo" | "partner"; mloEmail?: string },
) {
  if (!initialized) return;
  const role = extra?.role ?? "mlo";
  posthog.identify(email, {
    email,
    name: displayName,
    role,
    ...(extra?.mloEmail ? { mlo_email: extra.mloEmail } : {}),
  });
  posthog.register({
    role,
    ...(extra?.mloEmail ? { mlo_email: extra.mloEmail } : {}),
  });
}

/** Reset identity on sign-out. */
export function resetUser() {
  if (!initialized) return;
  posthog.reset();
}

/** Track a custom event. */
export function trackEvent(event: string, properties?: Record<string, unknown>) {
  if (!initialized) return;
  posthog.capture(event, properties);
}

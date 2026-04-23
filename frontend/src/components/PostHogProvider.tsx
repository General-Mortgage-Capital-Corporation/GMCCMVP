"use client";

import { useEffect } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { initPostHog, identifyUser, resetUser } from "@/lib/posthog";

/**
 * Initializes PostHog on mount and identifies/resets the user on auth changes.
 * Render once in the root layout.
 */
export default function PostHogProvider() {
  useEffect(() => {
    initPostHog();
  }, []);

  const { user } = useAuth();

  useEffect(() => {
    if (user?.email) {
      identifyUser(user.email, user.displayName);
    } else {
      resetUser();
    }
  }, [user?.email, user?.displayName]);

  return null;
}

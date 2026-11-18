"use client";

/**
 * One-shot per-login sync between the server-stored email signature
 * (userSettings/{emailKey}, source of truth) and the localStorage cache the
 * flier modals read synchronously.
 *
 * - Server has a signature → refresh the local cache with it (fixes
 *   "saved on my desktop but my laptop says no signature").
 * - Server empty but a valid local signature exists → migrate it up
 *   (one-time upgrade path for users who saved before server storage existed).
 * - Local signature is placeholder junk from the old auto-save bug
 *   ("Your Name" / "NMLS# _______") → purge it so the signature-required
 *   gate stops reporting a false positive.
 */
import { useEffect, useRef } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { authedFetch } from "@/lib/authed-fetch";
import {
  getSignatureHtml,
  setSignatureHtml,
  clearSignature,
  findSignaturePlaceholder,
  isSignatureContentEmpty,
} from "@/lib/signature-store";

export function useSignatureSync(): void {
  const { user } = useAuth();
  const syncedFor = useRef<string | null>(null);

  useEffect(() => {
    const email = user?.email;
    // Partners have no signature (the API is LO-only) — skip the doomed call.
    if (!email || user?.role === "partner" || syncedFor.current === email) return;
    syncedFor.current = email;

    (async () => {
      try {
        const res = await authedFetch("/api/user/signature");
        if (!res.ok) return;
        const data = (await res.json()) as { signatureHtml?: string | null };

        if (data.signatureHtml) {
          setSignatureHtml(data.signatureHtml);
          return;
        }

        const local = getSignatureHtml();
        if (!local) return;
        if (findSignaturePlaceholder(local) || isSignatureContentEmpty(local)) {
          // Placeholder/empty junk from the old auto-save bug — remove it so
          // hasSignature() stops returning a false positive.
          clearSignature();
          return;
        }
        await authedFetch("/api/user/signature", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ signatureHtml: local }),
        });
      } catch {
        /* offline / transient — retry next login */
      }
    })();
  }, [user?.email]);
}

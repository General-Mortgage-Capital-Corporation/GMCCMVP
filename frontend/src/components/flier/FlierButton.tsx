"use client";

import { useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import LoadingSpinner from "@/components/LoadingSpinner";

// Maps our internal program names to Firestore product document IDs
const PROGRAM_PRODUCT_IDS: Record<string, string> = {
  "GMCC Jumbo CRA": "jumbo-cra",
  "GMCC Diamond": "diamond-community-lending",
  "GMCC Fabulous Jumbo": "fabulous",
  "GMCC Grandslam": "grandslam",
  "GMCC $10K Grant": "celebrity-10k",
  "GMCC Special Conforming": "conforming-special",
};

interface FlierButtonProps {
  programName: string;
  propertyAddress?: string;
  listingPrice?: number;
}

interface RealtorInfo {
  name: string;
  phone: string;
  email: string;
  nmls: string;
}

export default function FlierButton({ programName, propertyAddress, listingPrice }: FlierButtonProps) {
  const { user, signIn, getIdToken } = useAuth();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [realtor, setRealtor] = useState<RealtorInfo>({ name: "", phone: "", email: "", nmls: "" });

  const productId = PROGRAM_PRODUCT_IDS[programName];
  if (!productId) return null; // unknown program — no flier available

  async function handleGenerate() {
    setError(null);
    setLoading(true);
    try {
      // Sign in if needed
      if (!user) {
        await signIn();
      }
      const idToken = await getIdToken();
      if (!idToken) {
        setError("Session expired. Please sign in again.");
        setLoading(false);
        return;
      }

      const body: Record<string, string | undefined> = {
        productId,
        userId: user!.email,
        ...(propertyAddress ? { address: propertyAddress } : {}),
        ...(listingPrice ? { listingPrice: String(listingPrice) } : {}),
        ...(realtor.name ? { realtorName: realtor.name } : {}),
        ...(realtor.phone ? { realtorPhone: realtor.phone } : {}),
        ...(realtor.email ? { realtorEmail: realtor.email } : {}),
        ...(realtor.nmls ? { realtorNmls: realtor.nmls } : {}),
      };

      const res = await fetch("/api/generate-flier", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Flier generation failed." })) as { error?: string; detail?: string };
        setError(err.detail ?? err.error ?? "Flier generation failed.");
        setLoading(false);
        return;
      }

      // Trigger download
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${productId}-flier.pdf`;
      a.click();
      URL.revokeObjectURL(url);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Flier generation failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mt-3">
      {!open ? (
        <button
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-md border border-transparent bg-violet-50 px-3 py-1.5 text-[0.8125rem] font-medium text-violet-700 transition-colors hover:border-violet-300"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
            <path d="M3 2h10v12H3V2z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
            <path d="M5 6h6M5 9h6M5 12h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
          Generate Flier
        </button>
      ) : (
        <div className="mt-2 rounded-lg border border-violet-200 bg-violet-50 p-3 space-y-3">
          <p className="text-xs font-semibold text-violet-700 uppercase tracking-wide">
            Generate Flier — {programName}
          </p>

          {/* Optional realtor info */}
          <div className="grid grid-cols-2 gap-2">
            {(["name", "phone", "email", "nmls"] as const).map((field) => (
              <input
                key={field}
                type="text"
                placeholder={
                  field === "name" ? "Realtor name (optional)"
                  : field === "phone" ? "Realtor phone (optional)"
                  : field === "email" ? "Realtor email (optional)"
                  : "Realtor NMLS (optional)"
                }
                value={realtor[field]}
                onChange={(e) => setRealtor((r) => ({ ...r, [field]: e.target.value }))}
                className="rounded border border-violet-200 bg-white px-2 py-1.5 text-xs text-gray-700 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-violet-400"
              />
            ))}
          </div>

          {!user && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
              You&apos;ll be prompted to sign in with your Microsoft account.
            </p>
          )}

          {error && (
            <p className="text-xs text-red-600">{error}</p>
          )}

          <div className="flex items-center gap-2">
            <button
              onClick={handleGenerate}
              disabled={loading}
              className="flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-violet-700 disabled:opacity-50"
            >
              {loading && <LoadingSpinner size="sm" />}
              {loading ? "Generating…" : "Download PDF"}
            </button>
            <button
              onClick={() => { setOpen(false); setError(null); }}
              className="text-xs text-gray-400 hover:text-gray-600"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

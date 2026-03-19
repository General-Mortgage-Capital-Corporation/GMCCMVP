"use client";

import { useState, useEffect } from "react";
import DOMPurify from "dompurify";
import { renderSimpleMarkdown } from "@/lib/utils";
import LoadingSpinner from "@/components/LoadingSpinner";
import { useAuth } from "@/contexts/AuthContext";

/** Build a sessionStorage cache key from listing address + program names. */
function summaryCacheKey(
  listing: Record<string, unknown>,
  programs: { name: string }[],
): string {
  const addr = (listing.formattedAddress as string) ?? "unknown";
  const names = programs.map((p) => p.name).sort().join("|");
  return `gmcc_summary:${addr}:${names}`;
}

interface MultiSummaryModalProps {
  programs: { name: string; tier_name?: string; product_id?: string }[];
  listing: Record<string, unknown>;
  authToken: string | null;
  onClose: () => void;
  onComposeEmail: (summary: string) => void;
}

export default function MultiSummaryModal({
  programs,
  listing,
  onClose,
  onComposeEmail,
}: MultiSummaryModalProps) {
  const { user, signIn, getIdToken } = useAuth();
  const [summary, setSummary] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [fromCache, setFromCache] = useState(false);

  // Restore cached summary on mount or when programs change
  const cacheKey = summaryCacheKey(listing, programs);
  useEffect(() => {
    try {
      const cached = sessionStorage.getItem(cacheKey);
      if (cached) {
        setSummary(cached);
        setFromCache(true);
      }
    } catch {
      // sessionStorage not available
    }
  }, [cacheKey]);

  async function handleGenerate() {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      // Get auth token for flyer template fetching
      let idToken: string | null = null;
      try {
        if (!user) {
          const freshUser = await signIn();
          idToken = freshUser.idToken;
        } else {
          idToken = await getIdToken();
        }
      } catch {
        // Continue without auth — summary will work, just without flyer context
      }

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (idToken) headers.Authorization = `Bearer ${idToken}`;

      const res = await fetch("/api/explain-multi", {
        method: "POST",
        headers,
        body: JSON.stringify({ programs, listing }),
      });

      const data = (await res.json()) as {
        summary?: string;
        error?: string;
      };

      if (!res.ok || data.error) {
        setError(data.error ?? "Failed to generate summary.");
        return;
      }

      const text = data.summary ?? "No summary generated.";
      setSummary(text);
      setFromCache(false);
      // Cache in sessionStorage
      try {
        sessionStorage.setItem(cacheKey, text);
      } catch { /* storage full or unavailable */ }
    } catch {
      setError("Failed to generate summary. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  function handleCopy() {
    if (!summary) return;
    navigator.clipboard.writeText(summary).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  // Sanitize and render markdown (same pattern as TalkingPoints component)
  const renderedHtml = summary
    ? DOMPurify.sanitize(renderSimpleMarkdown(summary))
    : "";

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="relative flex w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3.5">
          <div>
            <span className="text-sm font-semibold text-gray-800">
              Multi-Program Summary
            </span>
            <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-[0.65rem] font-medium text-red-700">
              {programs.length} programs
            </span>
          </div>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-full bg-gray-100 text-gray-500 hover:bg-gray-200"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M12 4L4 12M4 4l8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="max-h-[75vh] overflow-y-auto p-5">
          {/* Selected programs list */}
          <div className="mb-4 flex flex-wrap gap-1.5">
            {programs.map((p) => (
              <span
                key={p.name}
                className="rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-700"
              >
                {p.name}
              </span>
            ))}
          </div>

          {/* Generate button or loading */}
          {!summary && !loading && (
            <button
              onClick={handleGenerate}
              className="w-full rounded-lg bg-red-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-red-700 transition-colors"
            >
              Generate Summary with AI
            </button>
          )}

          {loading && (
            <div className="flex flex-col items-center gap-3 py-8">
              <LoadingSpinner size="lg" />
              <p className="text-sm text-gray-500">
                Analyzing {programs.length} programs and flyers...
              </p>
            </div>
          )}

          {error && (
            <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3">
              <p className="text-xs text-red-700">{error}</p>
              <button
                onClick={handleGenerate}
                className="mt-2 text-xs font-medium text-red-600 hover:text-red-800"
              >
                Try again
              </button>
            </div>
          )}

          {/* Summary content */}
          {summary && (
            <div className="space-y-3">
              {/* Cache indicator */}
              {fromCache && (
                <div className="flex items-center justify-between rounded-md border border-blue-200 bg-blue-50 px-3 py-2">
                  <span className="text-xs text-blue-700">
                    Loaded from session cache
                  </span>
                  <button
                    onClick={() => { setSummary(null); setFromCache(false); }}
                    className="text-xs font-medium text-blue-600 hover:text-blue-800"
                  >
                    Regenerate
                  </button>
                </div>
              )}

              <div
                className="rounded-lg bg-gray-50 p-4 text-[0.875rem] leading-relaxed text-gray-700 prose prose-sm max-w-none"
                dangerouslySetInnerHTML={{ __html: renderedHtml }}
              />

              {/* Action buttons */}
              <div className="flex items-center justify-between border-t border-gray-100 pt-3">
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleCopy}
                    className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
                  >
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                    <rect x="5" y="5" width="9" height="9" rx="1" stroke="currentColor" strokeWidth="1.5" />
                    <path d="M11 5V3a1 1 0 00-1-1H3a1 1 0 00-1 1v7a1 1 0 001 1h2" stroke="currentColor" strokeWidth="1.5" />
                  </svg>
                  {copied ? "Copied!" : "Copy to Clipboard"}
                  </button>
                  {!fromCache && (
                    <button
                      onClick={() => { setSummary(null); }}
                      className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
                    >
                      Regenerate
                    </button>
                  )}
                </div>

                <button
                  onClick={() => onComposeEmail(summary)}
                  className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-emerald-700"
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                    <rect x="1" y="3" width="14" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
                    <path d="M1 5l7 5 7-5" stroke="currentColor" strokeWidth="1.5" />
                  </svg>
                  Compose Email
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

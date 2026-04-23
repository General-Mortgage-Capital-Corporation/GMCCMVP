"use client";

import { useState, useCallback, useEffect } from "react";
import { trackEvent } from "@/lib/posthog";
import { useAuth } from "@/contexts/AuthContext";

interface FlyerToolOutput {
  success?: boolean;
  flyerRef?: string;
  programName?: string;
  productId?: string;
  sizeKB?: number;
  error?: string;
}

interface FlyerPreviewPartProps {
  state: string;
  output?: unknown;
}

export default function FlyerPreviewPart({ state, output }: FlyerPreviewPartProps) {
  const { getIdToken } = useAuth();
  const [downloading, setDownloading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isLoading = state === "input-streaming" || state === "input-available";
  const isDone = state === "output-available";
  const data = isDone && output && typeof output === "object" ? (output as FlyerToolOutput) : null;

  const handleDownload = useCallback(async () => {
    if (!data?.flyerRef) return;
    trackEvent("agent_flyer_downloaded", { program: data.programName });
    setDownloading(true);
    setError(null);
    try {
      const token = await getIdToken();
      if (!token) { setError("You must be signed in to download."); return; }
      const res = await fetch(
        `/api/chat/download?ref=${encodeURIComponent(data.flyerRef)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(
          (body as { error?: string }).error ??
            `Download failed (${res.status}). The flyer may have expired — ask the agent to regenerate it.`,
        );
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${data.programName ?? "GMCC"}-flyer.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 100);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed.");
    } finally {
      setDownloading(false);
    }
  }, [data?.flyerRef, data?.programName, getIdToken]);

  const handlePreview = useCallback(async () => {
    if (!data?.flyerRef || previewUrl) return;
    try {
      const token = await getIdToken();
      if (!token) return;
      const res = await fetch(
        `/api/chat/download?ref=${encodeURIComponent(data.flyerRef)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) return;
      const blob = await res.blob();
      setPreviewUrl(URL.createObjectURL(blob));
    } catch { /* ignore preview errors */ }
  }, [data?.flyerRef, previewUrl, getIdToken]);

  // Auto-preview when flyer is ready — must be above early returns (Rules of Hooks)
  const flyerRef = data?.flyerRef;
  useEffect(() => {
    if (flyerRef && !previewUrl) handlePreview();
  }, [flyerRef]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Loading ───────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="my-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs">
        <div className="flex items-center gap-2">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-red-400" />
          <span className="font-medium text-gray-700">Generating flyer…</span>
        </div>
      </div>
    );
  }

  // ── Error ─────────────────────────────────────────────────────────────
  if (data?.error) {
    return (
      <div className="my-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
        Flyer generation failed: {data.error}
      </div>
    );
  }

  if (!data?.flyerRef) return null;

  // ── Success ───────────────────────────────────────────────────────────
  return (
    <div className="my-2 overflow-hidden rounded-lg border border-purple-200 bg-purple-50">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 border-b border-purple-200 bg-white px-3 py-2.5">
        <div className="flex min-w-0 items-start gap-2">
          {/* PDF icon */}
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="mt-0.5 shrink-0 text-purple-600">
            <path d="M3 1.5h7l3 3V14a.5.5 0 01-.5.5H3a.5.5 0 01-.5-.5V2a.5.5 0 01.5-.5z"
              stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
            <path d="M10 1.5V4.5h3" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
            <text x="5" y="11.5" fill="currentColor" fontSize="5" fontWeight="bold">PDF</text>
          </svg>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-gray-900">
              {data.programName ?? "GMCC"} Flyer
            </div>
            <div className="text-[0.68rem] text-gray-500">
              PDF · {data.sizeKB ?? "?"} KB
            </div>
          </div>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <button type="button" onClick={handleDownload} disabled={downloading}
            className="inline-flex items-center gap-1 rounded-md bg-purple-600 px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-purple-700 disabled:opacity-60">
            {downloading ? (
              <>
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-white" />
                Downloading…
              </>
            ) : (
              <>
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                  <path d="M8 2v8M4 7l4 4 4-4M2 13.5h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Download
              </>
            )}
          </button>
        </div>
      </div>

      {/* PDF Preview (embedded iframe) */}
      {previewUrl && (
        <div className="border-t border-purple-100">
          <iframe
            src={`${previewUrl}#navpanes=0`}
            title="Flyer Preview"
            className="h-[85vh] w-full"
          />
        </div>
      )}

      {error && (
        <div className="border-t border-amber-200 bg-amber-50 px-3 py-1.5 text-[0.65rem] text-amber-800">
          {error}
        </div>
      )}
    </div>
  );
}

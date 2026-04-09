"use client";

import { useState, useCallback } from "react";
import { useAuth } from "@/contexts/AuthContext";

/**
 * Rendered output for the generateCsv tool.
 *
 * Shape matches the return value of createGenerateCsvTool.execute — see
 * frontend/src/lib/tools/generate-csv.ts. All fields are optional because
 * the part may render during intermediate states (input-streaming) or
 * after a tool error.
 */
interface CsvToolOutput {
  success?: boolean;
  csvRef?: string;
  filename?: string;
  rowCount?: number;
  sizeKB?: number;
  title?: string;
  preview?: {
    headers: string[];
    rows: string[][];
    truncated: boolean;
  };
  error?: string;
  note?: string;
}

interface CsvDownloadPartProps {
  state: string;
  output?: unknown;
}

export default function CsvDownloadPart({ state, output }: CsvDownloadPartProps) {
  const { getIdToken } = useAuth();
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isLoading = state === "input-streaming" || state === "input-available";
  const isDone = state === "output-available";
  const data = isDone && output && typeof output === "object" ? (output as CsvToolOutput) : null;

  const handleDownload = useCallback(async () => {
    if (!data?.csvRef) return;
    setDownloading(true);
    setError(null);
    try {
      const token = await getIdToken();
      if (!token) {
        setError("You must be signed in to download.");
        return;
      }
      const res = await fetch(
        `/api/chat/download?ref=${encodeURIComponent(data.csvRef)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(
          (body as { error?: string }).error ??
            `Download failed (${res.status}). The CSV may have expired — ask the agent to regenerate it.`,
        );
        return;
      }
      const blob = await res.blob();
      // Synthesize an anchor and click it so the browser triggers a real
      // save dialog with the Content-Disposition filename honored.
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = data.filename ?? "gmcc-export.csv";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Revoke after a tick so Safari has time to kick off the download.
      setTimeout(() => URL.revokeObjectURL(url), 100);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed.");
    } finally {
      setDownloading(false);
    }
  }, [data?.csvRef, data?.filename, getIdToken]);

  // ── Loading state ─────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="my-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs">
        <div className="flex items-center gap-2">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-red-400" />
          <span className="font-medium text-gray-700">Preparing CSV…</span>
        </div>
      </div>
    );
  }

  // ── Error state ───────────────────────────────────────────────────────
  if (data?.error) {
    return (
      <div className="my-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
        CSV generation failed: {data.error}
      </div>
    );
  }

  if (!data?.csvRef) return null;

  // ── Success state ─────────────────────────────────────────────────────
  const rowCount = data.rowCount ?? 0;
  const sizeKB = data.sizeKB ?? 0;
  const title = data.title ?? "GMCC Property Export";
  const preview = data.preview;

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-green-200 bg-green-50">
      {/* Header row */}
      <div className="flex items-start justify-between gap-3 border-b border-green-200 bg-white px-3 py-2.5">
        <div className="flex min-w-0 items-start gap-2">
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            className="mt-0.5 shrink-0 text-green-600"
            aria-hidden
          >
            <path
              d="M3 1.5h7l3 3V14a.5.5 0 01-.5.5H3a.5.5 0 01-.5-.5V2a.5.5 0 01.5-.5z"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinejoin="round"
            />
            <path d="M10 1.5V4.5h3" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
            <path
              d="M5.5 8.5h5M5.5 10.5h5M5.5 12h3"
              stroke="currentColor"
              strokeWidth="1.1"
              strokeLinecap="round"
            />
          </svg>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-gray-900">{title}</div>
            <div className="text-[0.68rem] text-gray-500">
              {rowCount.toLocaleString()} {rowCount === 1 ? "row" : "rows"} · {sizeKB} KB
              {data.filename ? ` · ${data.filename}` : ""}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={handleDownload}
          disabled={downloading}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-green-700 disabled:opacity-60"
        >
          {downloading ? (
            <>
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-white" />
              Downloading…
            </>
          ) : (
            <>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
                <path
                  d="M8 2v8M4 7l4 4 4-4M2 13.5h12"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              Download CSV
            </>
          )}
        </button>
      </div>

      {/* Preview table */}
      {preview && preview.rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-[0.65rem]">
            <thead className="bg-green-100/60 text-left text-green-900">
              <tr>
                {preview.headers.slice(0, 6).map((h) => (
                  <th key={h} className="whitespace-nowrap px-2 py-1.5 font-semibold">
                    {h}
                  </th>
                ))}
                {preview.headers.length > 6 && (
                  <th className="px-2 py-1.5 font-semibold">…</th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-green-100 bg-white/60 text-gray-700">
              {preview.rows.map((row, ri) => (
                <tr key={ri}>
                  {row.slice(0, 6).map((cell, ci) => (
                    <td key={ci} className="whitespace-nowrap px-2 py-1 max-w-[10rem] truncate">
                      {cell || <span className="text-gray-300">—</span>}
                    </td>
                  ))}
                  {row.length > 6 && <td className="px-2 py-1 text-gray-400">…</td>}
                </tr>
              ))}
            </tbody>
          </table>
          {preview.truncated && (
            <div className="border-t border-green-100 bg-white/40 px-3 py-1 text-[0.6rem] text-gray-500">
              Preview · first {preview.rows.length} of {rowCount.toLocaleString()} rows. Download for the full CSV.
            </div>
          )}
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

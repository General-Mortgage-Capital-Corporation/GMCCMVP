/**
 * User-facing usage history for Refi Finder.
 *
 * Paginated 50/page (cursor-based; "Load more" button at the bottom). Shows
 * one row per discrete user action — unlocking 25 properties' emails appears
 * as 25 rows, matching the per-action activity log.
 *
 * Read-only view: this component never writes. Admins manage company-wide
 * usage via the MLO portal's admin UI.
 */

"use client";

import { useCallback, useEffect, useState } from "react";
import { authedFetch } from "@/lib/authed-fetch";
import type { ActivityAction } from "@/lib/refi-credits";

interface ActivityEntryJSON {
  id: string;
  ts: number | null;
  action: ActivityAction;
  propertyId: string;
  propertyAddress: string;
  creditsUsed: { contact?: number; property?: number };
  propertyRadarRef: string;
  drewFromBuffer: boolean;
  balanceAfter: { contact: number; property: number };
  failureReason?: string;
  revealedValue?: string;
  ownerName?: string;
  fromCache?: boolean;
}

const ACTION_LABEL: Record<ActivityAction, string> = {
  unlock_property: "Unlocked property",
  unlock_email: "Revealed email",
  unlock_text: "Revealed text",
  unlock_failed: "Failed (refunded)",
};

export default function ActivityLogTable() {
  const [entries, setEntries] = useState<ActivityEntryJSON[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasInitial, setHasInitial] = useState(false);

  const loadPage = useCallback(
    async (nextCursor: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const qs = nextCursor
          ? `?cursor=${encodeURIComponent(nextCursor)}`
          : "";
        const res = await authedFetch(`/api/refi/activity${qs}`);
        if (!res.ok) throw new Error(`activity_${res.status}`);
        const data = (await res.json()) as {
          entries: ActivityEntryJSON[];
          nextCursor: string | null;
        };
        setEntries((prev) =>
          nextCursor ? [...prev, ...data.entries] : data.entries,
        );
        setCursor(data.nextCursor);
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
        setHasInitial(true);
      }
    },
    [],
  );

  useEffect(() => {
    void loadPage(null);
  }, [loadPage]);

  if (!hasInitial && loading) {
    return (
      <div className="p-4 text-sm text-gray-500">Loading activity…</div>
    );
  }

  if (entries.length === 0 && hasInitial) {
    return (
      <div className="rounded-lg border border-gray-100 bg-gray-50 p-6 text-center text-sm text-gray-500">
        No activity yet. Unlocks and reveals will show up here.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <Th>Date</Th>
              <Th>Action</Th>
              <Th>Property</Th>
              <Th>Unlocked value</Th>
              <Th align="right">Credits</Th>
              <Th>Source</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {entries.map((e) => (
              <tr key={e.id} className="align-top hover:bg-gray-50">
                <Td>
                  {e.ts
                    ? new Date(e.ts).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })
                    : "—"}
                </Td>
                <Td>
                  <span
                    className={`inline-flex items-center gap-1 ${e.action === "unlock_failed" ? "text-amber-700" : "text-gray-800"}`}
                  >
                    {ACTION_LABEL[e.action]}
                  </span>
                  {e.action === "unlock_failed" && e.failureReason && (
                    <div className="mt-0.5 text-[10px] text-amber-700">
                      {shortReason(e.failureReason)} · refunded
                    </div>
                  )}
                  {e.fromCache && (
                    <div className="mt-0.5 inline-block rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                      cached · no charge
                    </div>
                  )}
                </Td>
                <Td>
                  <div className="max-w-xs">
                    <div className="truncate" title={e.propertyAddress}>
                      {e.propertyAddress}
                    </div>
                    {e.ownerName && (
                      <div className="truncate text-[11px] text-gray-500" title={e.ownerName}>
                        {e.ownerName}
                      </div>
                    )}
                  </div>
                </Td>
                <Td>
                  {renderRevealedValue(e)}
                </Td>
                <Td align="right">
                  {renderCreditsUsed(e.creditsUsed)}
                  <div className="text-[10px] text-gray-400">
                    bal {e.balanceAfter.contact}c · {e.balanceAfter.property}p
                  </div>
                </Td>
                <Td>
                  {e.drewFromBuffer ? (
                    <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                      buffer
                    </span>
                  ) : (
                    <span className="text-xs text-gray-400">personal</span>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-xs text-gray-500">
        <span>{entries.length} entries</span>
        {cursor && (
          <button
            type="button"
            onClick={() => loadPage(cursor)}
            disabled={loading}
            className="rounded border border-gray-300 bg-white px-3 py-1 font-medium text-gray-700 transition hover:bg-gray-50 disabled:opacity-50"
          >
            {loading ? "Loading…" : "Load more"}
          </button>
        )}
      </div>

      {error && (
        <p className="text-xs text-red-700">{error}</p>
      )}
    </div>
  );
}

function renderCreditsUsed(c: { contact?: number; property?: number }): string {
  const parts: string[] = [];
  if (c.property) parts.push(`${c.property} property`);
  if (c.contact) parts.push(`${c.contact} contact`);
  return parts.length === 0 ? "—" : parts.join(" + ");
}

function renderRevealedValue(e: ActivityEntryJSON): React.ReactNode {
  if (e.action === "unlock_failed" || e.action === "unlock_property") {
    return <span className="text-xs text-gray-400">—</span>;
  }
  if (!e.revealedValue) {
    return <span className="text-xs text-gray-400">—</span>;
  }
  if (e.action === "unlock_email") {
    return (
      <a
        href={`mailto:${e.revealedValue}`}
        className="break-all text-xs text-gray-800 hover:text-red-600 hover:underline"
      >
        {e.revealedValue}
      </a>
    );
  }
  if (e.action === "unlock_text") {
    const digits = e.revealedValue.replace(/[^0-9+]/g, "");
    const href = digits.length === 10 ? `tel:+1${digits}` : `tel:${digits}`;
    return (
      <a
        href={href}
        className="break-all text-xs font-medium text-gray-800 hover:text-red-600 hover:underline tabular-nums"
      >
        {e.revealedValue}
      </a>
    );
  }
  return <span className="text-xs text-gray-800">{e.revealedValue}</span>;
}

function shortReason(reason: string): string {
  // PR error strings can be long; the activity table is dense, so condense.
  if (reason.toLowerCase().includes("no phone")) return "no phone on file";
  if (reason.toLowerCase().includes("no email")) return "no email on file";
  if (reason.length > 60) return reason.slice(0, 57) + "…";
  return reason;
}

function Th({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      scope="col"
      className={`px-3 py-2 font-medium ${align === "right" ? "text-right" : "text-left"}`}
    >
      {children}
    </th>
  );
}
function Td({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <td
      className={`px-3 py-2 text-gray-800 ${align === "right" ? "text-right" : "text-left"}`}
    >
      {children}
    </td>
  );
}

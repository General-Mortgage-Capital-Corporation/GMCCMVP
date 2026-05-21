"use client";

import { useMemo, useState } from "react";
import type { RefiRow } from "./types";
import type { UnlockResultMap } from "./RefiUnlockModal";
import { ContactCell } from "./ContactDisplay";

type SortKey =
  | "Address" | "Owner" | "FirstDate" | "FirstAmount" | "FirstRate"
  | "AVM" | "AvailableEquity" | "EquityPercent" | "CLTV" | "FirstLenderOriginal";

type SortDir = "asc" | "desc";

type Props = {
  rows: RefiRow[];               // rows for the current view page (already sliced)
  rowsLoaded: number;             // how many rows are loaded in memory total
  rowsAvailable: number;          // matching universe per PR
  viewPage: number;               // 0-indexed
  viewPageSize: number;
  viewTotalPages: number;
  cacheHit: boolean;
  moreAvailable: boolean;
  fetchingMore: boolean;
  unlocked: UnlockResultMap;
  onPageChange: (page: number) => void;
  onFetchMore: () => void;
  onSelectRow: (row: RefiRow) => void;
  onUnlockRequest: (rows: RefiRow[]) => void;
};

function fmtMoney(v: number | undefined | null): string {
  if (v == null || !isFinite(v)) return "—";
  if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (Math.abs(v) >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toLocaleString()}`;
}
function fmtPct(v: number | undefined | null, digits = 1): string {
  if (v == null || !isFinite(v)) return "—";
  return `${v.toFixed(digits)}%`;
}
function fmtDate(v: string | undefined | null): string {
  if (!v) return "—";
  const d = new Date(v);
  if (isNaN(d.getTime())) return v;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function ownerName(r: RefiRow): string {
  if (r.Owner) return r.Owner;
  const fl = `${r.OwnerFirstName ?? ""} ${r.OwnerLastName ?? ""}`.trim();
  return fl || "(entity owner)";
}

// Check whether PR has any contact data for this row's persons.
// Returns {phone, email} availability — used to gate the unlock button.
function contactAvailability(r: RefiRow): { phone: boolean; email: boolean } {
  const persons = r.Persons ?? [];
  let phone = false, email = false;
  for (const p of persons) {
    if (Array.isArray(p.Phone) && p.Phone.length > 0) phone = true;
    if (Array.isArray(p.Email) && p.Email.length > 0) email = true;
    if (phone && email) break;
  }
  return { phone, email };
}
function csvEscape(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  if (/[,"\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function exportCsv(rows: RefiRow[], selected: Set<string>, unlocked: UnlockResultMap) {
  const cols: { header: string; get: (r: RefiRow) => unknown }[] = [
    { header: "RadarID", get: (r) => r.RadarID },
    { header: "Address", get: (r) => r.Address },
    { header: "City", get: (r) => r.City },
    { header: "State", get: (r) => r.State },
    { header: "Zip", get: (r) => r.ZipFive },
    { header: "Owner", get: (r) => ownerName(r) },
    { header: "OwnerOccupied", get: (r) => (r.isSameMailingOrExempt === 1 ? "Yes" : "No") },
    { header: "PropertyType", get: (r) => r.AdvancedPropertyType },
    { header: "Beds", get: (r) => r.Beds },
    { header: "Baths", get: (r) => r.Baths },
    { header: "SqFt", get: (r) => r.SqFt },
    { header: "YearBuilt", get: (r) => r.YearBuilt },
    { header: "AVM", get: (r) => r.AVM },
    { header: "AvailableEquity", get: (r) => r.AvailableEquity },
    { header: "EquityPercent", get: (r) => r.EquityPercent },
    { header: "CLTV", get: (r) => r.CLTV },
    { header: "TotalLoanBalance", get: (r) => r.TotalLoanBalance },
    { header: "NumberLoans", get: (r) => r.NumberLoans },
    { header: "FirstAmount", get: (r) => r.FirstAmount },
    { header: "FirstDate", get: (r) => r.FirstDate },
    { header: "FirstPurpose", get: (r) => r.FirstPurpose },
    { header: "FirstLoanType", get: (r) => r.FirstLoanType },
    { header: "FirstRateType", get: (r) => r.FirstRateType },
    { header: "FirstRate", get: (r) => r.FirstRate },
    { header: "FirstTermYears", get: (r) => r.FirstTermInYears },
    { header: "FirstLender", get: (r) => r.FirstLenderOriginal },
    { header: "LastTransferDate", get: (r) => r.LastTransferRecDate },
    { header: "LastTransferValue", get: (r) => r.LastTransferValue },
    { header: "Phone", get: (r) => unlocked[r.RadarID]?.phone ?? "" },
    { header: "Email", get: (r) => unlocked[r.RadarID]?.email ?? "" },
    { header: "TractIncome", get: (r) => r.census?.tract_income_level },
    { header: "TractMinorityPct", get: (r) => r.census?.tract_minority_pct },
    { header: "MSA", get: (r) => r.census?.msa_name },
  ];
  const toExport = selected.size > 0 ? rows.filter((r) => selected.has(r.RadarID)) : rows;
  const lines = [cols.map((c) => c.header).join(",")];
  for (const r of toExport) lines.push(cols.map((c) => csvEscape(c.get(r))).join(","));
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const ts = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
  a.href = url;
  a.download = `refi-finder-${ts}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function RefiResultsTable({
  rows, rowsLoaded, rowsAvailable, viewPage, viewPageSize, viewTotalPages,
  cacheHit, moreAvailable, fetchingMore, unlocked,
  onPageChange, onFetchMore, onSelectRow, onUnlockRequest,
}: Props) {
  const [sortKey, setSortKey] = useState<SortKey>("AvailableEquity");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = (a as unknown as Record<string, unknown>)[sortKey];
      const bv = (b as unknown as Record<string, unknown>)[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") return sortDir === "asc" ? av - bv : bv - av;
      const as = String(av); const bs = String(bv);
      return sortDir === "asc" ? as.localeCompare(bs) : bs.localeCompare(as);
    });
    return copy;
  }, [rows, sortKey, sortDir]);

  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(k); setSortDir("desc"); }
  }
  function toggleAll() {
    if (selected.size === sorted.length) setSelected(new Set());
    else setSelected(new Set(sorted.map((r) => r.RadarID)));
  }
  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const firstIdx = viewPage * viewPageSize + 1;
  const lastIdx = viewPage * viewPageSize + sorted.length;
  const selectedRows = sorted.filter((r) => selected.has(r.RadarID));

  function HeaderCell({ k, label, align = "left" }: { k: SortKey; label: string; align?: "left" | "right" }) {
    const active = sortKey === k;
    return (
      <th className={`sticky top-0 z-10 bg-gray-50 px-3 py-2 text-xs font-medium uppercase tracking-wide text-gray-600 ${align === "right" ? "text-right" : "text-left"}`}>
        <button type="button" className="inline-flex items-center gap-1 hover:text-gray-900" onClick={() => toggleSort(k)}>
          {label}
          <span className="text-[10px] text-gray-400">{active ? (sortDir === "asc" ? "▲" : "▼") : "↕"}</span>
        </button>
      </th>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <div className="text-gray-600">
          Showing <span className="font-medium text-gray-900">{firstIdx.toLocaleString()}–{lastIdx.toLocaleString()}</span> of <span className="font-medium text-gray-900">{rowsLoaded.toLocaleString()}</span> loaded
          {rowsAvailable > rowsLoaded && <> · <span className="font-medium text-gray-900">{rowsAvailable.toLocaleString()}</span> total matching</>}
          {cacheHit && <span className="ml-2 inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">cached · no records charged</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-gray-500">{selected.size > 0 ? `${selected.size} selected` : "Select rows for bulk actions"}</span>
          <button type="button" disabled={selected.size === 0} onClick={() => onUnlockRequest(selectedRows)}
            className="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-40 disabled:hover:bg-white">
            Fetch contact{selected.size > 1 ? "s" : ""}{selected.size > 0 ? ` (${selected.size})` : ""}
          </button>
          <button type="button" onClick={() => exportCsv(sorted, selected, unlocked)}
            className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50">
            Export CSV{selected.size > 0 ? ` (${selected.size})` : ""}
          </button>
        </div>
      </div>

      <div className="max-h-[640px] overflow-auto rounded-xl border border-gray-200 bg-white">
        <table className="min-w-full divide-y divide-gray-100 text-sm">
          <thead>
            <tr>
              <th className="sticky top-0 z-10 bg-gray-50 px-3 py-2 text-left">
                <input type="checkbox" checked={selected.size === sorted.length && sorted.length > 0} onChange={toggleAll} aria-label="Select all rows" />
              </th>
              <HeaderCell k="Address" label="Address" />
              <HeaderCell k="Owner" label="Owner" />
              <HeaderCell k="AVM" label="AVM" align="right" />
              <HeaderCell k="AvailableEquity" label="Avail. Equity" align="right" />
              <HeaderCell k="EquityPercent" label="Equity %" align="right" />
              <HeaderCell k="CLTV" label="CLTV" align="right" />
              <HeaderCell k="FirstAmount" label="Loan amt" align="right" />
              <HeaderCell k="FirstRate" label="Est. rate" align="right" />
              <HeaderCell k="FirstDate" label="Loan date" />
              <HeaderCell k="FirstLenderOriginal" label="Lender" />
              <th className="sticky top-0 z-10 bg-gray-50 px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-600">Contact</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {sorted.map((r) => {
              const isSel = selected.has(r.RadarID);
              const c = unlocked[r.RadarID];
              return (
                <tr key={r.RadarID} className={isSel ? "bg-red-50/40" : "hover:bg-gray-50"}>
                  <td className="px-3 py-2">
                    <input type="checkbox" checked={isSel} onChange={() => toggleOne(r.RadarID)} aria-label={`Select ${r.Address}`} />
                  </td>
                  <td className="px-3 py-2">
                    <button type="button" onClick={() => onSelectRow(r)} className="text-left">
                      <div className="font-medium text-gray-900 hover:text-red-600">{r.Address ?? "—"}</div>
                      <div className="text-xs text-gray-500">{r.City}, {r.State} {r.ZipFive} · {r.AdvancedPropertyType ?? r.PType ?? ""}</div>
                    </button>
                  </td>
                  <td className="px-3 py-2">
                    <div className="text-gray-900">{ownerName(r)}</div>
                    <div className="text-xs text-gray-500">{r.OwnershipType ?? ""}{r.isSameMailingOrExempt === 1 ? " · owner-occ" : ""}</div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(r.AVM)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(r.AvailableEquity)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtPct(r.EquityPercent, 0)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtPct(r.CLTV, 0)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(r.FirstAmount)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {r.FirstRate != null ? (
                      <span title="Estimated for fixed-rate loans (not in public records)">{fmtPct(r.FirstRate, 2)}<span className="ml-1 text-[10px] text-gray-400">est</span></span>
                    ) : "—"}
                  </td>
                  <td className="px-3 py-2 text-gray-700">{fmtDate(r.FirstDate)}</td>
                  <td className="px-3 py-2">
                    <div className="text-gray-900">{r.FirstLenderOriginal ?? "—"}</div>
                    <div className="text-xs text-gray-500">{r.FirstLoanType ?? ""}{r.FirstRateType ? ` · ${r.FirstRateType}` : ""}{r.FirstTermInYears ? ` · ${r.FirstTermInYears}yr` : ""}</div>
                  </td>
                  <td className="px-3 py-2 align-top min-w-[240px] max-w-[320px]">
                    <ContactCell contact={c} />
                  </td>
                </tr>
              );
            })}
            {sorted.length === 0 && (
              <tr><td colSpan={12} className="px-3 py-8 text-center text-sm text-gray-500">No rows on this page.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Fetch more bar (cost-explicit) */}
      {moreAvailable && (
        <div className="flex items-center justify-between rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm">
          <div className="text-gray-600">
            <span className="font-medium text-gray-900">{rowsLoaded}</span> of <span className="font-medium text-gray-900">{rowsAvailable.toLocaleString()}</span> matching properties loaded.
          </div>
          <button type="button" disabled={fetchingMore} onClick={onFetchMore}
            className="rounded-lg bg-red-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-40">
            {fetchingMore ? "Fetching…" : `Fetch ${Math.min(viewPageSize, rowsAvailable - rowsLoaded)} more (charges ${Math.min(viewPageSize, rowsAvailable - rowsLoaded)} records)`}
          </button>
        </div>
      )}

      {/* Local-only pagination through already-loaded rows */}
      {viewTotalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <button type="button" disabled={viewPage === 0} onClick={() => onPageChange(viewPage - 1)}
            className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40">
            ← Prev
          </button>
          <div className="text-gray-600">Page <span className="font-medium text-gray-900">{viewPage + 1}</span> of <span className="font-medium text-gray-900">{viewTotalPages}</span> <span className="text-xs text-gray-500">(no records charged for paging)</span></div>
          <button type="button" disabled={viewPage + 1 >= viewTotalPages} onClick={() => onPageChange(viewPage + 1)}
            className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40">
            Next →
          </button>
        </div>
      )}
    </div>
  );
}

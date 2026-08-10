"use client";

/**
 * Admin tool: manage the email allowlist. Approve a flagged address here and it
 * sends for everyone (verifyDeliverability short-circuits it to deliverable).
 * Gated server-side by isApprovalAdmin; this page just reflects the API.
 */

import { useCallback, useEffect, useState } from "react";
import { authedFetch } from "@/lib/authed-fetch";

interface ApprovedEmail {
  email: string;
  approvedBy: string;
  approvedAt: number | null;
  note: string | null;
  originalStatus: string | null;
}
interface FlaggedEmail {
  email: string;
  status: string;
  reason: string | null;
  checkedBy: string | null;
  checkedAt: number | null;
  approved: boolean;
}

const fmt = (ms: number | null) =>
  ms ? new Date(ms).toLocaleString() : "—";

const statusBadge = (status: string) => {
  const map: Record<string, string> = {
    risky: "bg-amber-100 text-amber-700",
    unknown: "bg-slate-100 text-slate-600",
    undeliverable: "bg-red-100 text-red-700",
  };
  return map[status] ?? "bg-slate-100 text-slate-600";
};

export default function EmailApprovalsPage() {
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState<null | "auth" | "admin">(null);
  const [approved, setApproved] = useState<ApprovedEmail[]>([]);
  const [flagged, setFlagged] = useState<FlaggedEmail[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [manualEmail, setManualEmail] = useState("");
  const [showApprovedOnly, setShowApprovedOnly] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setDenied(null);
    try {
      const res = await authedFetch("/api/admin/email-approvals");
      if (res.status === 401) { setDenied("auth"); return; }
      if (res.status === 403) { setDenied("admin"); return; }
      if (!res.ok) throw new Error("load failed");
      const data = (await res.json()) as { approved: ApprovedEmail[]; flagged: FlaggedEmail[] };
      setApproved(data.approved ?? []);
      setFlagged(data.flagged ?? []);
    } catch {
      /* leave as-is */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function approve(email: string, originalStatus?: string) {
    setBusy(email);
    try {
      const res = await authedFetch("/api/admin/email-approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, originalStatus: originalStatus ?? null }),
      });
      if (res.ok) await load();
    } finally {
      setBusy(null);
    }
  }

  async function revoke(email: string) {
    setBusy(email);
    try {
      const res = await authedFetch("/api/admin/email-approvals", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (res.ok) await load();
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return <main className="mx-auto max-w-4xl p-6 text-sm text-slate-500">Loading…</main>;
  }
  if (denied === "auth") {
    return (
      <main className="mx-auto max-w-4xl p-6">
        <h1 className="text-lg font-bold text-slate-900">Email approvals</h1>
        <p className="mt-2 text-sm text-slate-600">Please sign in on the main app first, then reload this page.</p>
      </main>
    );
  }
  if (denied === "admin") {
    return (
      <main className="mx-auto max-w-4xl p-6">
        <h1 className="text-lg font-bold text-slate-900">Email approvals</h1>
        <p className="mt-2 text-sm text-slate-600">You don&apos;t have access to this tool.</p>
      </main>
    );
  }

  const pendingFlagged = flagged.filter((f) => !f.approved);

  return (
    <main className="mx-auto max-w-4xl space-y-8 p-6">
      <header>
        <h1 className="text-xl font-bold text-slate-900">Email approvals</h1>
        <p className="mt-1 text-sm text-slate-500">
          Approve a flagged address and it sends for everyone. LOs who hit a flagged
          address are told to email <span className="font-mono">ai@gmccloan.com</span> to request approval.
        </p>
      </header>

      {/* Manual approve */}
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-800">Approve an address</h2>
        <div className="flex flex-wrap gap-2">
          <input
            type="email"
            value={manualEmail}
            onChange={(e) => setManualEmail(e.target.value)}
            placeholder="realtor@example.com"
            className="min-w-[16rem] flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-400"
          />
          <button
            type="button"
            disabled={!manualEmail.trim() || busy === manualEmail.trim().toLowerCase()}
            onClick={() => { const e = manualEmail.trim().toLowerCase(); if (e) approve(e).then(() => setManualEmail("")); }}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            Approve
          </button>
        </div>
      </section>

      {/* Approved list */}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-slate-800">
          Approved addresses <span className="font-normal text-slate-400">({approved.length})</span>
        </h2>
        {approved.length === 0 ? (
          <p className="text-sm text-slate-400">None approved yet.</p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-slate-200">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2">Email</th>
                  <th className="px-3 py-2">Approved by</th>
                  <th className="px-3 py-2">When</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {approved.map((a) => (
                  <tr key={a.email}>
                    <td className="px-3 py-2 font-mono text-xs text-slate-800">{a.email}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">{a.approvedBy || "—"}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">{fmt(a.approvedAt)}</td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        disabled={busy === a.email}
                        onClick={() => revoke(a.email)}
                        className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                      >
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Flagged list */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-800">
            Previously flagged <span className="font-normal text-slate-400">({pendingFlagged.length} not yet approved)</span>
          </h2>
          <label className="flex items-center gap-1.5 text-xs text-slate-500">
            <input type="checkbox" checked={showApprovedOnly} onChange={(e) => setShowApprovedOnly(e.target.checked)} />
            Hide already-approved
          </label>
        </div>
        {(showApprovedOnly ? pendingFlagged : flagged).length === 0 ? (
          <p className="text-sm text-slate-400">No flagged addresses in the cache.</p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-slate-200">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2">Email</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Flagged by</th>
                  <th className="px-3 py-2">When</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {(showApprovedOnly ? pendingFlagged : flagged).map((f) => (
                  <tr key={f.email} className={f.approved ? "opacity-50" : ""}>
                    <td className="px-3 py-2 font-mono text-xs text-slate-800">{f.email}</td>
                    <td className="px-3 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusBadge(f.status)}`}>{f.status}</span>
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-500">{f.checkedBy || "—"}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">{fmt(f.checkedAt)}</td>
                    <td className="px-3 py-2 text-right">
                      {f.approved ? (
                        <span className="text-xs font-medium text-emerald-600">Approved</span>
                      ) : (
                        <button
                          type="button"
                          disabled={busy === f.email}
                          onClick={() => approve(f.email, f.status)}
                          className="rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                        >
                          Approve
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

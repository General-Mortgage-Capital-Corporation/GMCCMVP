"use client";

import { useState } from "react";
import type { DeskItem } from "./api";

const SKIP_REASONS = ["Not a fit for this listing", "I already know this agent", "Outside my area", "Other"];

const money = (n: number | null) => (n == null ? "" : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }));
const listedAgo = (d: number | null) => (d == null ? null : d <= 0 ? "Listed today" : d === 1 ? "Listed yesterday" : `Listed ${d} days ago`);
const time = (ms?: number) => (ms ? new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "");

export default function DeskCard({
  item,
  busy,
  disabled,
  onSend,
  onSkip,
  onEdit,
  onRetry,
}: {
  item: DeskItem;
  busy: boolean;
  disabled: boolean;
  onSend: () => void;
  onSkip: (reason: string) => void;
  onEdit: (subject: string, body: string) => Promise<void>;
  onRetry: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [skipOpen, setSkipOpen] = useState(false);
  const [subject, setSubject] = useState(item.subject);
  const [body, setBody] = useState(item.body);
  const [saving, setSaving] = useState(false);
  const l = item.listing;
  const street = l.address.split(",")[0];
  const rest = l.address.split(",").slice(1).join(",").trim();
  const facts = [l.beds != null ? `${l.beds} bd` : null, l.baths != null ? `${l.baths} ba` : null, l.sqft ? `${l.sqft.toLocaleString()} sqft` : null, listedAgo(l.daysOnMarket)].filter(Boolean);

  if (item.status === "skipped") {
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl border border-dashed border-gray-200 px-4 py-3 text-sm text-gray-400">
        <span className="truncate">
          <span className="font-medium text-gray-500">{street}</span> · skipped
          {item.skipReason ? ` — ${item.skipReason}` : ""}
        </span>
      </div>
    );
  }

  const sent = item.status === "sent";
  const failed = item.status === "failed";

  return (
    <article
      className={`rounded-xl border bg-white transition-shadow ${
        sent ? "border-emerald-200 bg-emerald-50/30" : failed ? "border-red-200" : "border-gray-200 hover:shadow-sm"
      }`}
    >
      <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-start">
        {/* Listing */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-800">{item.program}</span>
            <span className="text-xs text-gray-500">{item.reason}</span>
          </div>
          <div className="mt-2 flex flex-wrap items-baseline gap-x-2">
            <span className="text-lg font-semibold text-gray-900">{money(l.price)}</span>
            <span className="truncate text-sm font-medium text-gray-800">{street}</span>
            <span className="truncate text-sm text-gray-500">{rest}</span>
          </div>
          {facts.length > 0 && <div className="mt-0.5 text-xs text-gray-500">{facts.join(" · ")}</div>}
          <div className="mt-2 flex flex-wrap items-center gap-x-1.5 text-sm text-gray-600">
            <span className="text-gray-400">To</span>
            <span className="font-medium text-gray-800">{l.agentName || l.agentEmail}</span>
            {l.officeName && <span className="text-gray-500">· {l.officeName}</span>}
            <span className="inline-flex items-center gap-1 text-xs text-emerald-700" title="Email address verified">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
                <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              verified
            </span>
          </div>
        </div>

        {/* Actions */}
        <div className="flex shrink-0 items-center gap-2 sm:flex-col sm:items-stretch">
          {sent ? (
            <span className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-100 px-3 py-2 text-sm font-medium text-emerald-800">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
                <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Sent {time(item.sentAt)}
            </span>
          ) : failed ? (
            <button type="button" onClick={onRetry} disabled={disabled} className="rounded-lg border border-red-200 bg-white px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50">
              Try again
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={onSend}
                disabled={disabled || editing}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:bg-red-300"
              >
                {busy && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-r-transparent" />}
                {busy ? "Sending…" : "Send"}
              </button>
              <div className="flex gap-2 sm:justify-between">
                <button type="button" onClick={() => { setEditing(true); setOpen(true); }} disabled={disabled} className="rounded-lg px-2.5 py-1.5 text-sm text-gray-600 hover:bg-gray-100 disabled:opacity-50">
                  Edit
                </button>
                <div className="relative">
                  <button type="button" onClick={() => setSkipOpen((v) => !v)} disabled={disabled} className="rounded-lg px-2.5 py-1.5 text-sm text-gray-600 hover:bg-gray-100 disabled:opacity-50">
                    Skip
                  </button>
                  {skipOpen && (
                    <div className="absolute right-0 z-20 mt-1 w-56 rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
                      {SKIP_REASONS.map((r) => (
                        <button key={r} type="button" onClick={() => { setSkipOpen(false); onSkip(r); }} className="block w-full px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50">
                          {r}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Email */}
      <div className="border-t border-gray-100 px-4 py-3">
        {editing ? (
          <div className="space-y-2">
            <input value={subject} onChange={(e) => setSubject(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium focus:border-red-400 focus:outline-none focus:ring-2 focus:ring-red-100" aria-label="Subject" />
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={9} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm leading-relaxed focus:border-red-400 focus:outline-none focus:ring-2 focus:ring-red-100" aria-label="Email body" />
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-400">Your signature{item.productId ? " and the program flyer" : ""} are added automatically.</span>
              <div className="flex gap-2">
                <button type="button" onClick={() => { setEditing(false); setSubject(item.subject); setBody(item.body); }} className="rounded-lg px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100">
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={async () => {
                    setSaving(true);
                    try {
                      await onEdit(subject, body);
                      setEditing(false);
                    } finally {
                      setSaving(false);
                    }
                  }}
                  className="rounded-lg bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
                >
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <button type="button" onClick={() => setOpen((v) => !v)} className="block w-full text-left" aria-expanded={open}>
            <div className="flex items-center justify-between gap-3">
              <span className="truncate text-sm font-medium text-gray-800">{item.subject}</span>
              <span className="shrink-0 text-xs text-gray-400">{open ? "Hide email" : "Show email"}</span>
            </div>
            <p className={`mt-1 whitespace-pre-line text-sm leading-relaxed text-gray-600 ${open ? "" : "line-clamp-2"}`}>{item.body}</p>
            {open && (
              <p className="mt-2 text-xs text-gray-400">
                + your signature{item.productId ? ` and the ${item.program} flyer shown in the email` : ""}
                {item.edited ? " · edited by you" : ""}
              </p>
            )}
          </button>
        )}
        {failed && item.error && <p className="mt-2 text-xs text-red-600">{item.error}</p>}
        {sent && item.flyer && item.flyer !== "none" && (
          <p className="mt-2 text-xs text-emerald-700">{item.flyer === "embedded" ? "Flyer shown in the email" : "Flyer linked in the email"}</p>
        )}
      </div>
    </article>
  );
}

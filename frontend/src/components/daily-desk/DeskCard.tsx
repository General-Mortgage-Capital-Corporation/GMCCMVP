"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { DESK_FLYER_OPTIONS, type DeskFlyerMode, type DeskItem } from "./api";

const SKIP_REASONS = ["Not a fit for this listing", "I already know this agent", "Outside my area", "Other"];

const money = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }));
const listedAgo = (d: number | null) => (d == null ? null : d <= 0 ? "Listed today" : d === 1 ? "Listed yesterday" : `${d} days on market`);
const time = (ms?: number) => (ms ? new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "");
const date = (s?: string | null) => (s ? new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("") || "?";

const spring = { type: "spring" as const, stiffness: 320, damping: 30 };

function Icon({ d, className = "h-3.5 w-3.5" }: { d: string; className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d={d} />
    </svg>
  );
}
const I = {
  bed: "M3 15V6m0 5h14v4m0-4V9a2 2 0 00-2-2H9v4",
  bath: "M4 10h12v2a4 4 0 01-4 4H8a4 4 0 01-4-4v-2zm2 0V5a2 2 0 013.5-1.3M6 16l-1 2m10-2l1 2",
  area: "M4 4h12v12H4zM4 9h5V4",
  clock: "M10 18a8 8 0 100-16 8 8 0 000 16zm0-12v4l3 2",
  spark: "M10 2l1.8 4.7L16.5 8l-4.7 1.8L10 14.5 8.2 9.8 3.5 8l4.7-1.3L10 2z",
  send: "M3 10l14-7-5 15-2.5-6.5L3 10z",
  chevron: "M6 8l4 4 4-4",
  pin: "M10 18s6-5.3 6-10a6 6 0 10-12 0c0 4.7 6 10 6 10zm0-7.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z",
  expand: "M8 4H4v4m12-4h-4m4 0v4M4 16h4m-4 0v-4m12 4h-4m4 0v-4",
  eye: "M1.5 10S4.5 4 10 4s8.5 6 8.5 6-3 6-8.5 6S1.5 10 1.5 10zm8.5 2.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z",
  clip: "M14.5 9.5l-5.3 5.3a3.5 3.5 0 01-5-5l6-6a2.3 2.3 0 013.3 3.3l-6 6a1.2 1.2 0 01-1.7-1.7l5.3-5.3",
};

export default function DeskCard({
  item,
  index,
  busy,
  disabled,
  onSend,
  onSkip,
  onEdit,
  onRetry,
  onProgram,
  onOpenProperty,
  onPreview,
  onFlyerMode,
  settingsFlyerMode,
}: {
  item: DeskItem;
  index: number;
  busy: boolean;
  disabled: boolean;
  onSend: () => void;
  onSkip: (reason: string) => void;
  onEdit: (subject: string, body: string) => Promise<void>;
  onRetry: () => void;
  onProgram: (program: string) => Promise<void>;
  onOpenProperty: () => void;
  /** Open the full preview (exactly what the realtor gets). */
  onPreview: () => void;
  /** Set this email's flyer option (null = follow the Today setting). */
  onFlyerMode: (mode: DeskFlyerMode | null) => Promise<void>;
  settingsFlyerMode: DeskFlyerMode;
}) {
  const [open, setOpen] = useState(false);
  const [details, setDetails] = useState(false);
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState<null | "skip" | "program">(null);
  const [subject, setSubject] = useState(item.subject);
  const [body, setBody] = useState(item.body);
  const [saving, setSaving] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [flyerSaving, setFlyerSaving] = useState(false);
  const flyerMode = item.flyerMode ?? settingsFlyerMode;
  const l = item.listing;
  const street = l.address.split(",")[0];
  const rest = l.address.split(",").slice(1).join(",").trim();
  const sent = item.status === "sent";
  const failed = item.status === "failed";
  const locked = disabled || switching;

  if (item.status === "skipped") {
    return (
      <motion.div layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={spring} className="flex items-center gap-3 rounded-xl border border-dashed border-gray-200 bg-gray-50/50 px-4 py-2.5 text-sm text-gray-400">
        <span className="h-1.5 w-1.5 rounded-full bg-gray-300" />
        <span className="truncate">
          <span className="font-medium text-gray-500">{street}</span> skipped{item.skipReason ? ` · ${item.skipReason}` : ""}
        </span>
      </motion.div>
    );
  }

  const facts: [string, string][] = [
    ...(l.beds != null ? [[I.bed, `${l.beds} bd`] as [string, string]] : []),
    ...(l.baths != null ? [[I.bath, `${l.baths} ba`] as [string, string]] : []),
    ...(l.sqft ? [[I.area, `${l.sqft.toLocaleString()} sqft`] as [string, string]] : []),
    ...(listedAgo(l.daysOnMarket) ? [[I.clock, listedAgo(l.daysOnMarket)!] as [string, string]] : []),
  ];
  const detailRows: [string, string][] = [
    ["Home type", l.propertyType ?? "—"],
    ["Year built", l.yearBuilt ? String(l.yearBuilt) : "—"],
    ["Lot size", l.lotSize ? `${l.lotSize.toLocaleString()} sqft` : "—"],
    ["Price / sqft", l.price && l.sqft ? money(Math.round(l.price / l.sqft)) : "—"],
    ["HOA", l.hoaFee ? `${money(l.hoaFee)}/mo` : "—"],
    ["Listed", date(l.listedDate)],
    ["Last sold", l.lastSalePrice ? `${money(l.lastSalePrice)} · ${date(l.lastSaleDate)}` : "—"],
    ["MLS #", l.mlsNumber ?? "—"],
    ["Census tract", l.tractIncome ? `${l.tractIncome} income` : "—"],
    ["Agent phone", l.agentPhone ?? l.officePhone ?? "—"],
  ];

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 14, scale: 0.99 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ ...spring, delay: Math.min(index, 8) * 0.05 }}
      className={`group relative rounded-2xl border bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04)] transition-shadow duration-300 hover:shadow-[0_12px_32px_-16px_rgba(16,24,40,0.22)] ${
        sent ? "border-emerald-200/80" : failed ? "border-red-200" : "border-gray-200/80"
      }`}
    >
      {/* status rail */}
      <motion.span
        layout
        className={`absolute inset-y-3 left-0 w-[3px] rounded-r-full ${sent ? "bg-emerald-400" : failed ? "bg-red-400" : "bg-gray-200 group-hover:bg-red-300"}`}
      />

      <div className="grid gap-4 p-4 pl-5 sm:grid-cols-[1fr_auto] sm:p-5 sm:pl-6">
        {/* Listing */}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <button
                type="button"
                onClick={() => item.alternatives?.length && !sent && setMenu(menu === "program" ? null : "program")}
                disabled={locked || sent || !item.alternatives?.length}
                className="inline-flex items-center gap-1 rounded-full bg-gray-900 px-2.5 py-1 text-xs font-medium text-white transition-colors enabled:hover:bg-gray-700 disabled:cursor-default"
                title={item.alternatives?.length ? "Switch program" : undefined}
              >
                {switching ? <span className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-white border-r-transparent" /> : null}
                {item.program}
                {item.alternatives?.length && !sent ? <Icon d={I.chevron} className="h-3 w-3 opacity-70" /> : null}
              </button>
              <AnimatePresence>
                {menu === "program" && (
                  <motion.div
                    initial={{ opacity: 0, y: -4, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -4, scale: 0.98 }}
                    transition={{ duration: 0.14 }}
                    className="absolute left-0 z-30 mt-1.5 w-72 overflow-hidden rounded-xl border border-gray-200 bg-white/95 py-1 shadow-xl backdrop-blur"
                  >
                    <p className="px-3 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-gray-400">Also eligible — email rewrites itself</p>
                    {item.alternatives!.map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={async () => {
                          setMenu(null);
                          setSwitching(true);
                          try {
                            await onProgram(p);
                          } finally {
                            setSwitching(false);
                          }
                        }}
                        className="block w-full px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
                      >
                        {p}
                      </button>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
            <span className="inline-flex items-center gap-1 text-xs text-gray-500">
              <Icon d={I.spark} className="h-3 w-3 text-amber-500" />
              {item.reason}
            </span>
          </div>

          <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <span className="text-2xl font-semibold tracking-tight text-gray-900 tabular-nums">{money(l.price)}</span>
            <span className="min-w-0 truncate text-[15px] font-medium text-gray-800">{street}</span>
            <span className="truncate text-sm text-gray-400">{rest}</span>
          </div>
          {facts.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
              {facts.map(([d, t]) => (
                <span key={t} className="inline-flex items-center gap-1">
                  <Icon d={d} className="h-3.5 w-3.5 text-gray-400" />
                  {t}
                </span>
              ))}
            </div>
          )}

          <div className="mt-3 flex items-center gap-2.5">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-gray-100 to-gray-200 text-[11px] font-semibold text-gray-600 ring-1 ring-white">
              {initials(l.agentName || l.agentEmail)}
            </span>
            <div className="min-w-0 text-sm leading-tight">
              <div className="flex items-center gap-1.5">
                <span className="truncate font-medium text-gray-800">{l.agentName || l.agentEmail}</span>
                <span className="inline-flex items-center gap-0.5 rounded-full bg-emerald-50 px-1.5 py-px text-[10px] font-medium text-emerald-700" title="Email verified deliverable">
                  <svg width="9" height="9" viewBox="0 0 16 16" fill="none" aria-hidden><path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  verified
                </span>
              </div>
              <div className="truncate text-xs text-gray-400">{[l.officeName, l.agentEmail].filter(Boolean).join(" · ")}</div>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-start gap-2 sm:w-36 sm:flex-col sm:items-stretch">
          <AnimatePresence mode="wait" initial={false}>
            {sent ? (
              <motion.span
                key="sent"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={spring}
                className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-emerald-50 px-3 py-2.5 text-sm font-medium text-emerald-700 ring-1 ring-emerald-200"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
                  <motion.path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.45, ease: "easeOut" }} />
                </svg>
                Sent {time(item.sentAt)}
              </motion.span>
            ) : failed ? (
              <motion.button key="retry" type="button" onClick={onRetry} disabled={locked} className="rounded-xl border border-red-200 bg-white px-3 py-2.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50">
                Try again
              </motion.button>
            ) : (
              <motion.button
                key="send"
                type="button"
                whileTap={{ scale: 0.97 }}
                onClick={onSend}
                disabled={locked || editing}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-red-600 px-4 py-2.5 text-sm font-semibold text-white shadow-[0_1px_0_rgba(255,255,255,0.25)_inset,0_6px_16px_-8px_rgba(220,38,38,0.7)] transition-colors hover:bg-red-700 disabled:bg-red-300 disabled:shadow-none"
              >
                {busy ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-r-transparent" /> : <Icon d={I.send} className="h-4 w-4" />}
                {busy ? "Sending" : "Send"}
              </motion.button>
            )}
          </AnimatePresence>
          {!sent && !failed && (
            <div className="flex gap-1 sm:justify-between">
              <button type="button" onClick={() => { setEditing(true); setOpen(true); }} disabled={locked} className="rounded-lg px-2.5 py-1.5 text-sm text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 disabled:opacity-50">
                Edit
              </button>
              <div className="relative">
                <button type="button" onClick={() => setMenu(menu === "skip" ? null : "skip")} disabled={locked} className="rounded-lg px-2.5 py-1.5 text-sm text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 disabled:opacity-50">
                  Skip
                </button>
                <AnimatePresence>
                  {menu === "skip" && (
                    <motion.div
                      initial={{ opacity: 0, y: -4, scale: 0.98 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: -4, scale: 0.98 }}
                      transition={{ duration: 0.14 }}
                      className="absolute right-0 z-30 mt-1.5 w-56 overflow-hidden rounded-xl border border-gray-200 bg-white/95 py-1 shadow-xl backdrop-blur"
                    >
                      {SKIP_REASONS.map((r) => (
                        <button key={r} type="button" onClick={() => { setMenu(null); onSkip(r); }} className="block w-full px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50">
                          {r}
                        </button>
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Email + details */}
      <div className="mx-4 mb-4 sm:mx-5 sm:ml-6">
        <div className="rounded-xl bg-gray-50/80 ring-1 ring-inset ring-gray-100">
          {editing ? (
            <div className="space-y-2 p-3">
              <input value={subject} onChange={(e) => setSubject(e.target.value)} className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium focus:border-red-300 focus:outline-none focus:ring-2 focus:ring-red-100" aria-label="Subject" />
              <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={9} className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm leading-relaxed focus:border-red-300 focus:outline-none focus:ring-2 focus:ring-red-100" aria-label="Email body" />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-gray-400">Your signature{item.productId ? " and the flyer" : ""} are added automatically.</span>
                <div className="flex gap-2">
                  <button type="button" onClick={() => { setEditing(false); setSubject(item.subject); setBody(item.body); }} className="rounded-lg px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100">Cancel</button>
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
            <button type="button" onClick={() => setOpen((v) => !v)} className="block w-full px-3.5 py-3 text-left" aria-expanded={open}>
              <div className="flex items-center justify-between gap-3">
                <span className="truncate text-sm font-semibold text-gray-800">{switching ? "Rewriting for the new program…" : item.subject}</span>
                <motion.span animate={{ rotate: open ? 180 : 0 }} className="shrink-0 text-gray-400">
                  <Icon d={I.chevron} className="h-4 w-4" />
                </motion.span>
              </div>
              <motion.div layout="position" className={`mt-1 whitespace-pre-line text-sm leading-relaxed text-gray-600 ${open ? "" : "line-clamp-2"}`}>
                {item.body}
              </motion.div>
              {open && (
                <p className="mt-2 text-xs text-gray-400">
                  + your signature{item.productId && flyerMode !== "none" ? ` and the program flyer (${flyerMode === "embed" ? "shown in the email" : flyerMode === "attach" ? "attached as a PDF" : "linked"})` : ""}
                  {item.edited ? " · edited by you" : ""}
                </p>
              )}
            </button>
          )}
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <button type="button" onClick={() => setDetails((v) => !v)} className="inline-flex items-center gap-1 font-medium text-gray-500 hover:text-gray-800">
            <motion.span animate={{ rotate: details ? 180 : 0 }}><Icon d={I.chevron} className="h-3.5 w-3.5" /></motion.span>
            Property details
          </button>
          <button type="button" onClick={onOpenProperty} className="inline-flex items-center gap-1 font-medium text-gray-500 hover:text-gray-800">
            <Icon d={I.expand} className="h-3.5 w-3.5" />
            Open full property
          </button>
          <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(l.address)}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-gray-500 hover:text-gray-800">
            <Icon d={I.pin} className="h-3.5 w-3.5" />
            Map
          </a>
          {!sent && (
            <button type="button" onClick={onPreview} disabled={locked || editing} className="inline-flex items-center gap-1 font-medium text-red-600 hover:text-red-700 disabled:opacity-50">
              <Icon d={I.eye} className="h-3.5 w-3.5" />
              Preview email
            </button>
          )}
          {!sent && item.productId && (
            <label className="inline-flex items-center gap-1 text-gray-500" title="How the flyer goes out in this email">
              <Icon d={I.clip} className="h-3.5 w-3.5" />
              <span className="sr-only">Flyer for this email</span>
              <select
                value={flyerMode}
                disabled={locked || flyerSaving || item.status !== "ready"}
                onChange={async (e) => {
                  const m = e.target.value as DeskFlyerMode;
                  setFlyerSaving(true);
                  try {
                    await onFlyerMode(m === settingsFlyerMode ? null : m);
                  } finally {
                    setFlyerSaving(false);
                  }
                }}
                className="cursor-pointer rounded-md border-0 bg-transparent py-0 pl-0 pr-5 text-xs font-medium text-gray-500 hover:text-gray-800 focus:ring-1 focus:ring-red-200 disabled:cursor-default"
              >
                {DESK_FLYER_OPTIONS.map((o) => (
                  <option key={o.key} value={o.key}>
                    Flyer: {o.label}{o.key === settingsFlyerMode ? " (default)" : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
          {sent && item.flyer && item.flyer !== "none" && (
            <span className="text-emerald-700">{item.flyer === "embedded" ? "Flyer shown in the email" : item.flyer === "attached" ? "Flyer attached" : "Flyer linked"}</span>
          )}
          {failed && item.error && <span className="text-red-600">{item.error}</span>}
        </div>

        <AnimatePresence initial={false}>
          {details && (
            <motion.dl
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              className="grid grid-cols-2 gap-x-6 overflow-hidden sm:grid-cols-5"
            >
              {detailRows.map(([k, v]) => (
                <div key={k} className="border-t border-gray-100 py-2 first:pt-2">
                  <dt className="text-[11px] uppercase tracking-wide text-gray-400">{k}</dt>
                  <dd className="truncate text-sm text-gray-800 tabular-nums">{v}</dd>
                </div>
              ))}
            </motion.dl>
          )}
        </AnimatePresence>
      </div>
    </motion.article>
  );
}

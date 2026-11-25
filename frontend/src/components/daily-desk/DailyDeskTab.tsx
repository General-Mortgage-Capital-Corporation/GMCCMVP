"use client";

/**
 * "Today" — the LO's daily realtor outreach, ready to go.
 *
 * Opening the tab builds today's list once (new listings in the LO's areas,
 * each matched to a GMCC program, with a drafted email). Send one, edit, skip,
 * or "Send all" in one click. API: /api/daily-desk.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, animate, motion, useMotionValue, useTransform } from "motion/react";
import { trackEvent } from "@/lib/posthog";
import DeskCard from "./DeskCard";
import DeskSettingsModal from "./DeskSettingsModal";
import DeskPreview from "./DeskPreview";
import { deskApi, locateMe, type AreaInput, type DeskDay, type DeskListing, type DeskState } from "./api";

const BUILD_STEPS = ["Finding new listings in your areas", "Matching each one to GMCC programs", "Checking realtor emails", "Writing your emails"];
const spring = { type: "spring" as const, stiffness: 300, damping: 30 };

function todayLabel() {
  return new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}
function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

/** Number that counts up to its value. */
function Count({ value }: { value: number }) {
  const mv = useMotionValue(0);
  const rounded = useTransform(mv, (v) => Math.round(v).toString());
  useEffect(() => {
    const c = animate(mv, value, { duration: 0.8, ease: [0.22, 1, 0.36, 1] });
    return () => c.stop();
  }, [mv, value]);
  return <motion.span className="tabular-nums">{rounded}</motion.span>;
}

/** Sent / total ring. */
function ProgressRing({ done, total }: { done: number; total: number }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const pct = total ? done / total : 0;
  return (
    <div className="relative h-16 w-16 shrink-0">
      <svg viewBox="0 0 64 64" className="h-16 w-16 -rotate-90">
        <circle cx="32" cy="32" r={r} fill="none" stroke="currentColor" strokeWidth="5" className="text-gray-100" />
        <motion.circle
          cx="32"
          cy="32"
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth="5"
          strokeLinecap="round"
          className={pct >= 1 ? "text-emerald-500" : "text-red-500"}
          strokeDasharray={c}
          initial={{ strokeDashoffset: c }}
          animate={{ strokeDashoffset: c * (1 - pct) }}
          transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center leading-none">
        <span className="text-base font-semibold text-gray-900"><Count value={done} /></span>
        <span className="text-[10px] text-gray-400">of {total}</span>
      </div>
    </div>
  );
}

function Stat({ label, value, suffix }: { label: string; value: number; suffix?: string }) {
  return (
    <div className="rounded-xl bg-white/70 px-3.5 py-2 ring-1 ring-gray-200/70 backdrop-blur">
      <div className="text-[11px] font-medium uppercase tracking-wide text-gray-400">{label}</div>
      <div className="text-lg font-semibold text-gray-900">
        <Count value={value} />
        {suffix}
      </div>
    </div>
  );
}

function SkeletonCard({ i }: { i: number }) {
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.08 }} className="rounded-2xl border border-gray-100 bg-white p-5">
      <div className="flex gap-3">
        <div className="h-5 w-40 animate-pulse rounded-full bg-gray-100" />
        <div className="h-5 w-28 animate-pulse rounded-full bg-gray-50" />
      </div>
      <div className="mt-4 h-7 w-64 animate-pulse rounded-lg bg-gray-100" />
      <div className="mt-3 h-12 animate-pulse rounded-xl bg-gray-50" />
    </motion.div>
  );
}

/** DeskListing → the shape the full property view expects. */
function toRentCast(l: DeskListing) {
  return {
    id: l.id,
    formattedAddress: l.address,
    addressLine1: l.addressLine1 ?? l.address.split(",")[0],
    city: l.city,
    state: l.state,
    zipCode: l.zip,
    county: l.county,
    latitude: l.latitude,
    longitude: l.longitude,
    propertyType: l.propertyType ?? undefined,
    bedrooms: l.beds ?? undefined,
    bathrooms: l.baths ?? undefined,
    squareFootage: l.sqft ?? undefined,
    lotSize: l.lotSize ?? undefined,
    yearBuilt: l.yearBuilt ?? undefined,
    price: l.price ?? undefined,
    listedDate: l.listedDate ?? undefined,
    daysOnMarket: l.daysOnMarket ?? undefined,
    mlsNumber: l.mlsNumber ?? undefined,
    lastSalePrice: l.lastSalePrice ?? undefined,
    lastSaleDate: l.lastSaleDate ?? undefined,
    hoa: l.hoaFee ? { fee: l.hoaFee } : undefined,
    listingAgent: { name: l.agentName, email: l.agentEmail, phone: l.agentPhone ?? undefined },
    listingOffice: l.officeName ? { name: l.officeName, phone: l.officePhone ?? undefined } : undefined,
  };
}
export type DeskRentCastListing = ReturnType<typeof toRentCast>;

export default function DailyDeskTab({
  signedIn,
  onSignIn,
  programs,
  onOpenSignatureSettings,
  onOpenProperty,
}: {
  signedIn: boolean;
  onSignIn: () => void;
  programs: string[];
  onOpenSignatureSettings: () => void;
  onOpenProperty: (listing: DeskRentCastListing) => void;
}) {
  const [state, setState] = useState<DeskState | null>(null);
  const [loading, setLoading] = useState(false);
  const [building, setBuilding] = useState(false);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [sending, setSending] = useState<Set<string>>(new Set());
  const [sendingAll, setSendingAll] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [setupAreas, setSetupAreas] = useState("");
  const [setupRadius, setSetupRadius] = useState(5);
  const [locating, setLocating] = useState(false);
  const started = useRef(false);

  const setDay = (day: DeskDay | null) => setState((s) => (s ? { ...s, day } : s));

  const build = useCallback(async () => {
    setBuilding(true);
    setError(null);
    setStep(0);
    try {
      let { day } = await deskApi.build();
      for (let i = 0; day.status === "building" && i < 45; i++) {
        await new Promise((r) => setTimeout(r, 4000));
        day = (await deskApi.load()).day ?? day;
      }
      setDay(day);
      trackEvent("daily_desk_built", { items: day.items.length });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't build today's list.");
    } finally {
      setBuilding(false);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const s = await deskApi.load();
      setState(s);
      trackEvent("daily_desk_opened", { hasDay: !!s.day });
      if (!s.day || s.day.status === "building") await build();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load today's list.");
    } finally {
      setLoading(false);
    }
  }, [build]);

  useEffect(() => {
    if (!signedIn || started.current) return;
    started.current = true;
    load();
  }, [signedIn, load]);

  useEffect(() => {
    if (!building) return;
    const t = setInterval(() => setStep((s) => Math.min(BUILD_STEPS.length - 1, s + 1)), 6000);
    return () => clearInterval(t);
  }, [building]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  const run = async (fn: () => Promise<{ day: DeskDay }>) => {
    setError(null);
    try {
      const r = await fn();
      setDay(r.day);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    }
  };

  const send = async (ids: string[] | "all") => {
    if (state && !state.signatureOk) {
      setError("Add your email signature first — it's added to every email.");
      return;
    }
    const target = ids === "all" ? (state?.day?.items ?? []).filter((i) => i.status === "ready").map((i) => i.id) : ids;
    setSending(new Set(target));
    if (ids === "all") setSendingAll(true);
    setError(null);
    try {
      const r = await deskApi.send(ids);
      setDay(r.day);
      setState((s) => (s ? { ...s, stats: { ...s.stats, sent: s.stats.sent + r.sent } } : s));
      const parts = [`${r.sent} sent`];
      if (r.skipped) parts.push(`${r.skipped} held back (recently contacted by GMCC or undeliverable)`);
      if (r.failed) parts.push(`${r.failed} failed`);
      setToast(parts.join(" · "));
      trackEvent("daily_desk_sent", { sent: r.sent, skipped: r.skipped, failed: r.failed, all: ids === "all" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sending failed.");
    } finally {
      setSending(new Set());
      setSendingAll(false);
    }
  };

  const startWith = async (inputs: AreaInput[]) => {
    setError(null);
    const r = await deskApi.saveSettings({ areaInputs: inputs, rebuild: true });
    if (!r.settings.areas.length) {
      setError('Use ZIP codes (95112) or "City, ST" (San Jose, CA).');
      return;
    }
    setState((s) => (s ? { ...s, settings: r.settings, day: null } : s));
    await build();
  };

  // ── Not signed in ──
  if (!signedIn) {
    return (
      <div className="flex flex-col items-center px-4 py-12 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-red-50 to-white text-red-600 ring-1 ring-red-100">
          <svg width="22" height="22" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M3 10l14-7-5 15-2.5-6.5L3 10z" /></svg>
        </div>
        <h2 className="mt-4 text-lg font-semibold text-gray-900">Your daily realtor emails, ready to send</h2>
        <p className="mt-1 max-w-md text-sm text-gray-500">Every day we find new listings in your areas, match them to GMCC programs and write the emails. You just press send.</p>
        <button type="button" onClick={onSignIn} className="mt-5 rounded-xl bg-red-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-red-700">Sign in with Outlook</button>
      </div>
    );
  }

  const day = state?.day ?? null;
  const items = day?.items ?? [];
  const ready = items.filter((i) => i.status === "ready");
  const sentCount = items.filter((i) => i.status === "sent").length;
  const skippedCount = items.filter((i) => i.status === "skipped").length;
  const total = items.length - skippedCount;
  const areasLabel = state?.settings.areas.map((a) => (a.lat != null ? a.label.replace(/^Within/, "within") : `in ${a.label}`)).join(" · ");
  const popular = Object.entries(state?.popular ?? {}).slice(0, 2);
  const replyRate = state && state.stats.sent ? Math.round((state.stats.replies / state.stats.sent) * 100) : null;
  const busy = sending.size > 0 || building;

  // ── First run: no areas yet ──
  if (!loading && !building && day?.status === "needs_setup") {
    const radii = state?.limits.radiusOptions ?? [2, 5, 10, 25];
    return (
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="mx-auto max-w-xl px-2 py-10 text-center">
        <h2 className="text-xl font-semibold tracking-tight text-gray-900">Where do you look for buyers?</h2>
        <p className="mt-1.5 text-sm text-gray-500">Every day we&apos;ll line up new listings there, matched to GMCC programs, with the emails written. You only do this once.</p>

        <div className="mt-7 rounded-2xl border border-gray-200 bg-gradient-to-b from-white to-gray-50/60 p-5 shadow-sm">
          <motion.button
            type="button"
            whileTap={{ scale: 0.98 }}
            disabled={locating}
            onClick={async () => {
              setLocating(true);
              try {
                const here = await locateMe(setupRadius);
                trackEvent("daily_desk_location_used", { radius: setupRadius });
                await startWith([here]);
              } catch (e) {
                setError(e instanceof Error ? e.message : "Couldn't get your location.");
              } finally {
                setLocating(false);
              }
            }}
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-red-600 px-5 py-3 text-sm font-semibold text-white shadow-[0_8px_20px_-10px_rgba(220,38,38,0.8)] hover:bg-red-700 disabled:bg-red-300"
          >
            {locating ? (
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-r-transparent" />
            ) : (
              <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden><path fillRule="evenodd" d="M10 18s6-5.33 6-10A6 6 0 004 8c0 4.67 6 10 6 10zm0-7.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z" clipRule="evenodd" /></svg>
            )}
            {locating ? "Finding you…" : "Use my current location"}
          </motion.button>
          <div className="mt-3 flex items-center justify-center gap-1.5 text-sm text-gray-500">
            <span>Within</span>
            {radii.map((r) => (
              <button key={r} type="button" onClick={() => setSetupRadius(r)} className={`relative rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors ${setupRadius === r ? "text-red-700" : "text-gray-600 hover:bg-gray-100"}`}>
                {setupRadius === r && <motion.span layoutId="radius-pill" className="absolute inset-0 rounded-full bg-red-50 ring-1 ring-red-200" transition={spring} />}
                <span className="relative">{r} mi</span>
              </button>
            ))}
          </div>
        </div>

        <div className="my-5 flex items-center gap-3 text-[11px] uppercase tracking-widest text-gray-400">
          <span className="h-px flex-1 bg-gray-200" />or type them<span className="h-px flex-1 bg-gray-200" />
        </div>

        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={async (e) => {
            e.preventDefault();
            const inputs = setupAreas.split(/;|\n|(?<=\d{5})\s*,\s*/).map((x) => x.trim()).filter(Boolean);
            if (!inputs.length) return;
            try {
              await startWith(inputs);
            } catch (err) {
              setError(err instanceof Error ? err.message : "Couldn't save.");
            }
          }}
        >
          <input value={setupAreas} onChange={(e) => setSetupAreas(e.target.value)} placeholder="95112, 95125  or  San Jose, CA" className="flex-1 rounded-xl border border-gray-200 px-3.5 py-2.5 text-sm focus:border-red-300 focus:outline-none focus:ring-2 focus:ring-red-100" />
          <button type="submit" className="rounded-xl border border-gray-200 bg-white px-5 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50">Start</button>
        </form>
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      </motion.div>
    );
  }

  return (
    <div>
      {/* Hero */}
      <div className="relative overflow-hidden rounded-2xl border border-gray-200/80 bg-gradient-to-br from-white via-white to-gray-50 p-5 sm:p-6">
        <div aria-hidden className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-[radial-gradient(closest-side,rgba(220,38,38,0.10),transparent)]" />
        <div aria-hidden className="pointer-events-none absolute -bottom-32 left-1/3 h-64 w-96 rounded-full bg-[radial-gradient(closest-side,rgba(15,23,42,0.05),transparent)]" />

        <div className="relative flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            {total > 0 && !building ? <ProgressRing done={sentCount} total={total} /> : null}
            <div>
              <p className="text-xs font-medium uppercase tracking-widest text-gray-400">{greeting()} · {todayLabel()}</p>
              <AnimatePresence mode="wait">
                <motion.h2 key={building || loading ? "b" : ready.length ? `r${ready.length}` : sentCount ? "d" : "e"} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.2 }} className="mt-1 text-xl font-semibold tracking-tight text-gray-900 sm:text-2xl">
                  {building || loading
                    ? "Getting today's emails ready…"
                    : ready.length
                      ? `${ready.length} email${ready.length === 1 ? "" : "s"} ready to send`
                      : sentCount
                        ? "You're done for today"
                        : "Today's emails"}
                </motion.h2>
              </AnimatePresence>
              {areasLabel && (
                <p className="mt-1 text-sm text-gray-500">
                  New listings {areasLabel}
                  {state?.settings.autoSeeded ? <span className="text-gray-400"> · picked from your activity</span> : null}
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setSettingsOpen(true)} disabled={!state} className="inline-flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white/80 px-3.5 py-2.5 text-sm font-medium text-gray-600 backdrop-blur transition-colors hover:bg-white hover:text-gray-900 disabled:opacity-50">
              <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden><path d="M4 6h8m4 0h0M4 14h2m4 0h6M12 4v4M8 12v4" /></svg>
              Customize
            </button>
            <AnimatePresence>
              {ready.length > 0 && (
                <motion.button
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  whileTap={{ scale: 0.97 }}
                  type="button"
                  onClick={() => send("all")}
                  disabled={busy}
                  className="relative inline-flex items-center gap-2 overflow-hidden rounded-xl bg-gradient-to-b from-red-500 to-red-600 px-5 py-2.5 text-sm font-semibold text-white shadow-[0_1px_0_rgba(255,255,255,0.25)_inset,0_10px_24px_-12px_rgba(220,38,38,0.9)] transition-[filter] hover:brightness-105 disabled:opacity-60"
                >
                  {!busy && (
                    <motion.span aria-hidden className="absolute inset-y-0 -left-1/3 w-1/3 bg-gradient-to-r from-transparent via-white/25 to-transparent" animate={{ x: ["0%", "450%"] }} transition={{ duration: 2.4, repeat: Infinity, repeatDelay: 2.5, ease: "easeInOut" }} />
                  )}
                  {sendingAll ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-r-transparent" /> : (
                    <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3 10l14-7-5 15-2.5-6.5L3 10z" /></svg>
                  )}
                  <span className="relative">{sendingAll ? `Sending ${ready.length}…` : `Send all ${ready.length}`}</span>
                </motion.button>
              )}
            </AnimatePresence>
          </div>
        </div>

        {state && (
          <div className="relative mt-5 flex flex-wrap items-stretch gap-2">
            <Stat label="Sent this week" value={state.stats.sent} />
            <Stat label="Replies" value={state.stats.replies} />
            {replyRate !== null && <Stat label="Reply rate" value={replyRate} suffix="%" />}
            {popular.length > 0 && (
              <div className="flex min-w-0 flex-1 flex-col justify-center rounded-xl bg-white/70 px-3.5 py-2 ring-1 ring-gray-200/70 backdrop-blur">
                {popular.map(([st, progs]) => (
                  <div key={st} className="truncate text-xs text-gray-500">
                    <span className="font-medium uppercase tracking-wide text-gray-400">Popular in {st}</span> · <span className="text-gray-700">{progs.join(" · ")}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <AnimatePresence>
        {state && !state.signatureOk && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
              Add your email signature before sending — it goes on every email.
              <button type="button" onClick={onOpenSignatureSettings} className="rounded-lg bg-amber-600 px-3 py-1 text-xs font-medium text-white hover:bg-amber-700">Set up signature</button>
            </div>
          </motion.div>
        )}
        {error && (
          <motion.div key="err" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">
            {error}
            {(!state || !state.day) && !loading && !building && (
              <button type="button" onClick={() => load()} className="rounded-lg bg-white px-3 py-1 text-xs font-medium text-red-700 ring-1 ring-red-200 hover:bg-red-100">Try again</button>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Body */}
      <div className="mt-4 space-y-3">
        {(loading || building) && !items.length ? (
          <div className="grid gap-3 lg:grid-cols-[18rem_1fr]">
            <div className="rounded-2xl border border-gray-200/80 bg-white p-5">
              <ul className="space-y-3.5">
                {BUILD_STEPS.map((s, i) => (
                  <li key={s} className={`flex items-center gap-3 text-sm transition-colors ${i <= step ? "text-gray-800" : "text-gray-400"}`}>
                    {i < step ? (
                      <motion.span initial={{ scale: 0.5 }} animate={{ scale: 1 }} className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500 text-white">
                        <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                      </motion.span>
                    ) : i === step ? (
                      <span className="h-5 w-5 animate-spin rounded-full border-2 border-red-500 border-r-transparent" />
                    ) : (
                      <span className="h-5 w-5 rounded-full border-2 border-gray-200" />
                    )}
                    {s}
                  </li>
                ))}
              </ul>
              <p className="mt-5 text-xs text-gray-400">About 20–40 seconds, once a day.</p>
            </div>
            <div className="space-y-3">{[0, 1, 2].map((i) => <SkeletonCard key={i} i={i} />)}</div>
          </div>
        ) : (
          <>
            {items
              .slice()
              .sort((a, b) => Number(a.status === "skipped") - Number(b.status === "skipped"))
              .map((it, idx) => (
                <DeskCard
                  key={it.id}
                  item={it}
                  index={idx}
                  busy={sending.has(it.id)}
                  disabled={busy}
                  onSend={() => send([it.id])}
                  onSkip={(reason) => {
                    trackEvent("daily_desk_skipped", { reason });
                    run(() => deskApi.skip(it.id, reason));
                  }}
                  onEdit={async (subject, body) => {
                    await run(() => deskApi.edit(it.id, subject, body));
                    trackEvent("daily_desk_edited", {});
                  }}
                  onRetry={() => run(() => deskApi.retry(it.id))}
                  onProgram={async (program) => {
                    trackEvent("daily_desk_program_switched", { program });
                    await run(() => deskApi.program(it.id, program));
                  }}
                  onOpenProperty={() => {
                    trackEvent("daily_desk_property_opened", {});
                    onOpenProperty(toRentCast(it.listing));
                  }}
                  settingsFlyerMode={state?.settings.flyerMode ?? "embed"}
                  onPreview={() => {
                    trackEvent("daily_desk_previewed", {});
                    setPreviewId(it.id);
                  }}
                  onFlyerMode={async (mode) => {
                    trackEvent("daily_desk_flyer_mode", { mode: mode ?? "default" });
                    await run(() => deskApi.flyer(it.id, mode));
                  }}
                />
              ))}

            {day?.status === "ready" && items.length === 0 && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="rounded-2xl border border-dashed border-gray-200 px-6 py-12 text-center">
                <p className="text-sm font-semibold text-gray-800">Nothing new to send today</p>
                <p className="mt-1 text-sm text-gray-500">{day.note ?? "No new listings matched a GMCC program with a reachable agent."}</p>
                <button type="button" onClick={() => setSettingsOpen(true)} className="mt-3 text-sm font-medium text-red-600 hover:text-red-700">Widen your areas or filters →</button>
              </motion.div>
            )}

            {day?.status === "ready" && items.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs text-gray-400">
                <span className="inline-flex items-center gap-1.5">
                  <svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden><path d="M10 2l6 2.5v5c0 4-2.7 6.8-6 8.5-3.3-1.7-6-4.5-6-8.5v-5L10 2z" /></svg>
                  {day.note ?? "No realtor gets this from more than one GMCC loan officer within 30 days."}
                </span>
                {skippedCount > 0 && ready.length + sentCount < (state?.settings.batchSize ?? 10) && (
                  <button type="button" disabled={busy} onClick={() => run(() => deskApi.more())} className="font-medium text-red-600 hover:text-red-700 disabled:opacity-50">
                    Find replacements for skipped
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Toast */}
      <AnimatePresence>
        {toast && (
          <motion.div initial={{ opacity: 0, y: 16, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 16 }} transition={spring} className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-gray-900 px-5 py-2.5 text-sm font-medium text-white shadow-2xl">
            {toast}
          </motion.div>
        )}
      </AnimatePresence>

      {(() => {
        const it = previewId ? state?.day?.items.find((x) => x.id === previewId) : null;
        if (!it || !state) return null;
        return (
          <DeskPreview
            item={it}
            settingsFlyerMode={state.settings.flyerMode}
            sending={sending.has(it.id)}
            onDay={setDay}
            onSend={async () => {
              trackEvent("daily_desk_sent_from_preview", {});
              await send([it.id]);
              setPreviewId(null);
            }}
            onClose={() => setPreviewId(null)}
          />
        );
      })()}

      <AnimatePresence>
        {settingsOpen && state && (
          <DeskSettingsModal
            settings={state.settings}
            programs={programs}
            maxBatch={state.limits.maxBatch}
            maxAreas={state.limits.maxAreas}
            radiusOptions={state.limits.radiusOptions ?? [2, 5, 10, 25]}
            languages={state.limits.languages ?? ["English"]}
            propertyTypes={state.limits.propertyTypes ?? ["Single Family", "Condo", "Townhouse", "Multi-Family"]}
            canRebuild={sentCount === 0}
            onClose={() => setSettingsOpen(false)}
            onSave={async (s) => {
              const r = await deskApi.saveSettings(s);
              setState((cur) => (cur ? { ...cur, settings: r.settings, day: r.day } : cur));
              trackEvent("daily_desk_settings_saved", { areas: r.settings.areas.length, batch: r.settings.batchSize, tone: r.settings.tone, flyer: r.settings.flyerMode, language: r.settings.language });
              if (s.rebuild || !r.day) await build();
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

"use client";

/**
 * "Today" — the LO's daily realtor outreach, ready to go.
 *
 * Opening the tab builds today's list once (new listings in the LO's areas,
 * each matched to a GMCC program, with a drafted email). Send one, edit, skip,
 * or "Send all" in one click. API: /api/daily-desk.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { trackEvent } from "@/lib/posthog";
import DeskCard from "./DeskCard";
import DeskSettingsModal from "./DeskSettingsModal";
import { deskApi, locateMe, type AreaInput, type DeskDay, type DeskState } from "./api";

const BUILD_STEPS = ["Finding new listings in your areas", "Matching each one to GMCC programs", "Checking realtor emails", "Writing your emails"];

function todayLabel() {
  return new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

export default function DailyDeskTab({
  signedIn,
  onSignIn,
  programs,
  onOpenSignatureSettings,
}: {
  signedIn: boolean;
  onSignIn: () => void;
  programs: string[];
  onOpenSignatureSettings: () => void;
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
      // Another tab is building it: wait for that one.
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

  // Cycle the build checklist while we wait.
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

  // ── Not signed in ──
  if (!signedIn) {
    return (
      <div className="flex flex-col items-center px-4 py-10 text-center">
        <h2 className="text-lg font-semibold text-gray-900">Your daily realtor emails, ready to send</h2>
        <p className="mt-1 max-w-md text-sm text-gray-500">Every day we find new listings in your areas, match them to GMCC programs and write the emails. You just press send.</p>
        <button type="button" onClick={onSignIn} className="mt-4 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700">
          Sign in with Outlook
        </button>
      </div>
    );
  }

  const day = state?.day ?? null;
  const items = day?.items ?? [];
  const ready = items.filter((i) => i.status === "ready");
  const sentCount = items.filter((i) => i.status === "sent").length;
  const skippedCount = items.filter((i) => i.status === "skipped").length;
  const areasLabel = state?.settings.areas
    .map((a) => (a.lat != null ? a.label.replace(/^Within/, "within") : `in ${a.label}`))
    .join(" · ");
  const popular = Object.entries(state?.popular ?? {}).slice(0, 2);
  const replyRate = state && state.stats.sent ? Math.round((state.stats.replies / state.stats.sent) * 100) : null;
  const busy = sending.size > 0 || building;

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

  // ── First run: no areas yet ──
  if (!loading && !building && day?.status === "needs_setup") {
    const radii = state?.limits.radiusOptions ?? [2, 5, 10, 25];
    return (
      <div className="mx-auto max-w-xl px-2 py-8 text-center">
        <h2 className="text-lg font-semibold text-gray-900">Where do you look for buyers?</h2>
        <p className="mt-1 text-sm text-gray-500">Every day we&apos;ll line up new listings there, matched to GMCC programs, with the emails written. We save this — you only do it once.</p>

        <div className="mt-6 rounded-xl border border-gray-200 p-4">
          <button
            type="button"
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
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-red-600 px-5 py-3 text-sm font-semibold text-white shadow-sm hover:bg-red-700 disabled:bg-red-300"
          >
            {locating ? (
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-r-transparent" />
            ) : (
              <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                <path fillRule="evenodd" d="M10 18s6-5.33 6-10A6 6 0 004 8c0 4.67 6 10 6 10zm0-7.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z" clipRule="evenodd" />
              </svg>
            )}
            {locating ? "Finding you…" : "Use my current location"}
          </button>
          <div className="mt-3 flex items-center justify-center gap-1.5 text-sm text-gray-500">
            <span>Within</span>
            {radii.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setSetupRadius(r)}
                className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors ${setupRadius === r ? "bg-red-50 text-red-700 ring-1 ring-red-200" : "text-gray-600 hover:bg-gray-100"}`}
              >
                {r} mi
              </button>
            ))}
          </div>
        </div>

        <div className="my-4 flex items-center gap-3 text-xs uppercase tracking-wide text-gray-400">
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
          <input
            value={setupAreas}
            onChange={(e) => setSetupAreas(e.target.value)}
            placeholder="95112, 95125  or  San Jose, CA"
            className="flex-1 rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-red-400 focus:outline-none focus:ring-2 focus:ring-red-100"
          />
          <button type="submit" className="rounded-lg border border-gray-300 px-5 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50">Start</button>
        </form>
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-gray-400">{todayLabel()}</p>
          <h2 className="mt-0.5 text-lg font-semibold text-gray-900">
            {building || loading
              ? "Getting today's emails ready…"
              : ready.length
                ? `${ready.length} email${ready.length === 1 ? "" : "s"} ready to send`
                : sentCount
                  ? "You're done for today"
                  : "Today's emails"}
          </h2>
          {areasLabel && (
            <p className="mt-0.5 text-sm text-gray-500">
              New listings {areasLabel}
              {state?.settings.autoSeeded ? <span className="text-gray-400"> · picked from your recent activity</span> : null}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            disabled={!state}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50"
          >
            <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
              <path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.53 1.53 0 01-2.29.95c-1.37-.84-2.94.73-2.1 2.1.54.89.06 2.04-.95 2.29-1.56.38-1.56 2.6 0 2.98 1.01.25 1.49 1.4.95 2.29-.84 1.37.73 2.94 2.1 2.1a1.53 1.53 0 012.29.95c.38 1.56 2.6 1.56 2.98 0a1.53 1.53 0 012.29-.95c1.37.84 2.94-.73 2.1-2.1a1.53 1.53 0 01.95-2.29c1.56-.38 1.56-2.6 0-2.98a1.53 1.53 0 01-.95-2.29c.84-1.37-.73-2.94-2.1-2.1a1.53 1.53 0 01-2.29-.95zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
            </svg>
            Settings
          </button>
          {ready.length > 0 && (
            <button
              type="button"
              onClick={() => send("all")}
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-red-700 disabled:bg-red-300"
            >
              {sendingAll && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-r-transparent" />}
              {sendingAll ? `Sending ${ready.length}…` : `Send all ${ready.length}`}
            </button>
          )}
        </div>
      </div>

      {/* Week + popular */}
      {state && (
        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl bg-gray-50 px-4 py-2.5 text-sm">
          <span className="text-gray-600"><span className="font-semibold text-gray-900">{state.stats.sent}</span> sent this week</span>
          <span className="text-gray-600"><span className="font-semibold text-gray-900">{state.stats.replies}</span> {state.stats.replies === 1 ? "reply" : "replies"}{replyRate !== null ? ` (${replyRate}%)` : ""}</span>
          {sentCount + skippedCount > 0 && items.length > 0 && <span className="text-gray-500">Today: {sentCount} sent{skippedCount ? `, ${skippedCount} skipped` : ""}</span>}
          {popular.map(([st, progs]) => (
            <span key={st} className="text-gray-500">
              Popular in {st}: <span className="text-gray-700">{progs.join(" · ")}</span>
            </span>
          ))}
        </div>
      )}

      {state && !state.signatureOk && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
          Add your email signature before sending — it goes on every email.
          <button type="button" onClick={onOpenSignatureSettings} className="rounded-md bg-amber-600 px-3 py-1 text-xs font-medium text-white hover:bg-amber-700">Set up signature</button>
        </div>
      )}
      {error && <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">{error}</div>}
      {toast && <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800">{toast}</div>}

      {/* Body */}
      <div className="mt-4 space-y-3">
        {(loading || building) && !items.length ? (
          <div className="rounded-xl border border-gray-200 p-6">
            <ul className="space-y-3">
              {BUILD_STEPS.map((s, i) => (
                <li key={s} className={`flex items-center gap-3 text-sm ${i <= step ? "text-gray-800" : "text-gray-400"}`}>
                  {i < step ? (
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500 text-white">
                      <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                    </span>
                  ) : i === step ? (
                    <span className="h-5 w-5 animate-spin rounded-full border-2 border-red-500 border-r-transparent" />
                  ) : (
                    <span className="h-5 w-5 rounded-full border-2 border-gray-200" />
                  )}
                  {s}
                </li>
              ))}
            </ul>
            <p className="mt-4 text-xs text-gray-400">This takes about 20–40 seconds, once a day.</p>
          </div>
        ) : (
          <>
            {items
              .slice()
              .sort((a, b) => Number(a.status === "skipped") - Number(b.status === "skipped"))
              .map((it) => (
                <DeskCard
                  key={it.id}
                  item={it}
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
                />
              ))}

            {day?.status === "ready" && items.length === 0 && (
              <div className="rounded-xl border border-dashed border-gray-200 px-6 py-10 text-center">
                <p className="text-sm font-medium text-gray-800">Nothing new to send today</p>
                <p className="mt-1 text-sm text-gray-500">{day.note ?? "No new listings matched a GMCC program with a reachable agent."}</p>
                <button type="button" onClick={() => setSettingsOpen(true)} className="mt-3 text-sm font-medium text-red-600 hover:text-red-700">Add another area →</button>
              </div>
            )}

            {day?.status === "ready" && items.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs text-gray-400">
                <span>{day.note ?? "We never email a realtor another GMCC loan officer contacted in the last 30 days."}</span>
                {skippedCount > 0 && ready.length + sentCount < (state?.settings.batchSize ?? 5) && (
                  <button type="button" disabled={busy} onClick={() => run(() => deskApi.more())} className="font-medium text-red-600 hover:text-red-700 disabled:opacity-50">
                    Find replacements for skipped
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {settingsOpen && state && (
        <DeskSettingsModal
          settings={state.settings}
          programs={programs}
          maxBatch={state.limits.maxBatch}
          maxAreas={state.limits.maxAreas}
          radiusOptions={state.limits.radiusOptions ?? [2, 5, 10, 25]}
          canRebuild={sentCount === 0}
          onClose={() => setSettingsOpen(false)}
          onSave={async (s) => {
            const r = await deskApi.saveSettings(s);
            setState((cur) => (cur ? { ...cur, settings: r.settings, day: r.day } : cur));
            trackEvent("daily_desk_settings_saved", { areas: r.settings.areas.length, batch: r.settings.batchSize });
            if (s.rebuild || !r.day) await build();
          }}
        />
      )}
    </div>
  );
}

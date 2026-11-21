"use client";

/**
 * Today settings — a slide-over with everything pre-set. LOs who never open it
 * get sensible defaults; everything here is optional.
 */
import { useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { locateMe, toAreaInput, type AreaInput, type DeskSettings } from "./api";

type AreaChip = { input: AreaInput; label: string };
const geoLabel = (r: number, place?: string) => `Within ${r} mi of ${place || "my location"}`;

export type DeskSettingsInput = Partial<Omit<DeskSettings, "areas" | "autoSeeded">> & { areaInputs: AreaInput[]; rebuild: boolean };

/** Must match SETTINGS_DEFAULTS in lib/daily-desk/server.ts. */
const DEFAULTS = { batchSize: 10, priceMin: "1000000", priceMax: "10000000", types: ["Single Family"] };
const isDefaultTypes = (t: string[]) => t.length === DEFAULTS.types.length && DEFAULTS.types.every((x) => t.includes(x));

const DOM_PRESETS: { key: string; label: string; min: number | null; max: number | null }[] = [
  { key: "any", label: "Any", min: null, max: null },
  { key: "new", label: "New · 7 days", min: null, max: 7 },
  { key: "month", label: "Under 30 days", min: null, max: 30 },
  { key: "stale", label: "Sitting 30+ days", min: 30, max: null },
];
const TONES = [
  { key: "friendly", label: "Friendly" },
  { key: "professional", label: "Professional" },
  { key: "brief", label: "Brief" },
] as const;
const FLYERS = [
  { key: "embed", label: "Show in email" },
  { key: "attach", label: "Attach PDF" },
  { key: "link", label: "Link" },
  { key: "none", label: "No flyer" },
] as const;
const FOLLOW_UPS = [null, 3, 5, 7, 14] as const;
const BEDS = [null, 1, 2, 3, 4] as const;
const INSTRUCTION_IDEAS = ["Mention I speak Mandarin and Cantonese", "Highlight down-payment help for first-time buyers", "Offer a 15-minute call this week", "Keep it under 80 words"];

function Segmented<T extends string | number | null>({ value, options, onChange }: { value: T; options: { key: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex flex-wrap gap-1 rounded-xl bg-gray-100/80 p-1">
      {options.map((o) => {
        const on = o.key === value;
        return (
          <button key={String(o.key)} type="button" onClick={() => onChange(o.key)} className={`relative rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${on ? "text-gray-900" : "text-gray-500 hover:text-gray-700"}`}>
            {on && <motion.span layoutId={`seg-${options.map((x) => x.key).join("-")}`} className="absolute inset-0 rounded-lg bg-white shadow-sm ring-1 ring-gray-200/70" transition={{ type: "spring", stiffness: 420, damping: 34 }} />}
            <span className="relative">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="border-b border-gray-100 px-6 py-5 last:border-0">
      <h3 className="text-[13px] font-semibold uppercase tracking-wide text-gray-400">{title}</h3>
      {hint && <p className="mt-0.5 text-xs text-gray-400">{hint}</p>}
      <div className="mt-3 space-y-4">{children}</div>
    </section>
  );
}

function Field({ label, children, note }: { label: string; children: ReactNode; note?: string }) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium text-gray-800">{label}</span>
        {note && <span className="text-xs text-gray-400">{note}</span>}
      </div>
      {children}
    </div>
  );
}

const pinPath = "M10 18s6-5.33 6-10A6 6 0 004 8c0 4.67 6 10 6 10zm0-7.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z";

export default function DeskSettingsModal({
  settings,
  programs,
  maxBatch,
  maxAreas,
  radiusOptions,
  languages,
  propertyTypes,
  canRebuild,
  onClose,
  onSave,
}: {
  settings: DeskSettings;
  programs: string[];
  maxBatch: number;
  maxAreas: number;
  radiusOptions: number[];
  languages: string[];
  propertyTypes: string[];
  /** Nothing sent yet today, so today's list can be rebuilt with the new settings. */
  canRebuild: boolean;
  onClose: () => void;
  onSave: (s: DeskSettingsInput) => Promise<void>;
}) {
  const [areas, setAreas] = useState<AreaChip[]>(settings.areas.map((a) => ({ input: toAreaInput(a), label: a.label })));
  const [draftArea, setDraftArea] = useState("");
  const [locating, setLocating] = useState(false);
  const [batchSize, setBatchSize] = useState(settings.batchSize);
  const [priceMin, setPriceMin] = useState(settings.priceMin ? String(settings.priceMin) : "");
  const [priceMax, setPriceMax] = useState(settings.priceMax ? String(settings.priceMax) : "");
  const [dom, setDom] = useState({ min: settings.domMin ?? null, max: settings.domMax ?? null });
  const [types, setTypes] = useState<string[]>(settings.propertyTypes ?? []);
  const [bedsMin, setBedsMin] = useState<number | null>(settings.bedsMin ?? null);
  const [preferred, setPreferred] = useState<string[]>(settings.preferredPrograms);
  const [programMode, setProgramMode] = useState<"prefer" | "only">(settings.programMode ?? "prefer");
  const [tone, setTone] = useState<DeskSettings["tone"]>(settings.tone ?? "friendly");
  const [language, setLanguage] = useState(settings.language ?? "English");
  const [flyerMode, setFlyerMode] = useState<DeskSettings["flyerMode"]>(settings.flyerMode ?? "embed");
  const [followUpDays, setFollowUpDays] = useState<number | null>(settings.followUpDays ?? null);
  const [ccSelf, setCcSelf] = useState(settings.ccSelf !== false);
  const [instructions, setInstructions] = useState(settings.instructions);
  const [rebuild, setRebuild] = useState(canRebuild);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const domKey = DOM_PRESETS.find((p) => p.min === dom.min && p.max === dom.max)?.key ?? "custom";

  const addArea = () => {
    const v = draftArea.trim();
    if (!v) return;
    if (!/^\d{5}$/.test(v) && !/^.+[,\s]+[A-Za-z]{2}$/.test(v)) {
      setError('Use a ZIP code (95112) or "City, ST" (San Jose, CA).');
      return;
    }
    if (areas.length >= maxAreas) return;
    setAreas([...areas, { input: v, label: v }]);
    setDraftArea("");
    setError(null);
  };
  const num = (s: string) => {
    const n = Number(s.replace(/[$,\s]/g, ""));
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  };
  const resetDefaults = () => {
    setBatchSize(DEFAULTS.batchSize);
    setPriceMin(DEFAULTS.priceMin);
    setPriceMax(DEFAULTS.priceMax);
    setDom({ min: null, max: null });
    setTypes(DEFAULTS.types);
    setBedsMin(null);
    setPreferred([]);
    setProgramMode("prefer");
    setTone("friendly");
    setLanguage("English");
    setFlyerMode("embed");
    setFollowUpDays(null);
    setCcSelf(true);
    setInstructions("");
  };

  return (
    <div className="fixed inset-0 z-[60]">
      <motion.div className="absolute inset-0 bg-gray-900/30 backdrop-blur-[2px]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} onClick={onClose} />
      <motion.aside
        initial={{ x: "100%" }}
        animate={{ x: 0 }}
        transition={{ type: "spring", stiffness: 300, damping: 34 }}
        className="absolute inset-y-0 right-0 flex w-full max-w-[34rem] flex-col bg-white shadow-2xl"
        role="dialog"
        aria-label="Today settings"
      >
        <header className="flex items-start justify-between border-b border-gray-100 px-6 py-5">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Today settings</h2>
            <p className="text-sm text-gray-500">Everything is pre-set — change only what you care about. Saved for every day.</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600" aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M12 4L4 12M4 4l8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          </button>
        </header>

        <div className="flex-1 overflow-y-auto">
          <Section title="Where" hint={`Up to ${maxAreas}: your location, ZIP codes or cities.`}>
            <div className="flex flex-wrap gap-2">
              {areas.map((a, idx) => (
                <span key={`${a.label}-${idx}`} className="inline-flex items-center gap-1 rounded-full bg-gray-100 py-1 pl-3 pr-1.5 text-sm text-gray-700">
                  {typeof a.input === "string" ? (
                    a.label
                  ) : (
                    <>
                      <svg width="12" height="12" viewBox="0 0 20 20" fill="currentColor" className="text-red-500" aria-hidden><path fillRule="evenodd" d={pinPath} clipRule="evenodd" /></svg>
                      Within
                      <select
                        value={a.input.radiusMi}
                        onChange={(e) => {
                          const r = Number(e.target.value);
                          const input = a.input as Exclude<AreaInput, string>;
                          setAreas(areas.map((x, j) => (j === idx ? { input: { ...input, radiusMi: r }, label: geoLabel(r, input.place) } : x)));
                        }}
                        className="rounded border-0 bg-transparent py-0 pl-0.5 pr-5 text-sm font-medium text-gray-800 focus:ring-0"
                        aria-label="Distance"
                      >
                        {radiusOptions.map((r) => <option key={r} value={r}>{r} mi</option>)}
                      </select>
                      of {a.input.place || "my location"}
                    </>
                  )}
                  <button type="button" onClick={() => setAreas(areas.filter((_, j) => j !== idx))} className="rounded-full p-0.5 text-gray-400 hover:bg-gray-200 hover:text-gray-600" aria-label={`Remove ${a.label}`}>
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M12 4L4 12M4 4l8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
                  </button>
                </span>
              ))}
              {areas.length < maxAreas && (
                <button
                  type="button"
                  disabled={locating}
                  onClick={async () => {
                    setLocating(true);
                    setError(null);
                    try {
                      const here = await locateMe(5);
                      setAreas([...areas, { input: here, label: geoLabel(here.radiusMi, here.place) }]);
                    } catch (e) {
                      setError(e instanceof Error ? e.message : "Couldn't get your location.");
                    } finally {
                      setLocating(false);
                    }
                  }}
                  className="inline-flex items-center gap-1 rounded-full border border-red-200 px-3 py-1 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                >
                  <svg width="12" height="12" viewBox="0 0 20 20" fill="currentColor" aria-hidden><path fillRule="evenodd" d={pinPath} clipRule="evenodd" /></svg>
                  {locating ? "Finding you…" : "Near me"}
                </button>
              )}
              {areas.length < maxAreas && (
                <input
                  value={draftArea}
                  onChange={(e) => setDraftArea(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addArea(); } }}
                  onBlur={addArea}
                  placeholder="Add ZIP or City, ST"
                  className="min-w-[9rem] flex-1 rounded-full border border-gray-200 px-3 py-1 text-sm focus:border-red-300 focus:outline-none focus:ring-2 focus:ring-red-100"
                />
              )}
            </div>
          </Section>

          <Section title="Listings">
            <Field label="Days on market" note={domKey === "any" ? "Default" : undefined}>
              <Segmented value={domKey} options={DOM_PRESETS.map((p) => ({ key: p.key, label: p.label }))} onChange={(k) => { const p = DOM_PRESETS.find((x) => x.key === k)!; setDom({ min: p.min, max: p.max }); }} />
            </Field>
            <Field label="Price range" note={num(priceMin) === Number(DEFAULTS.priceMin) && num(priceMax) === Number(DEFAULTS.priceMax) ? "$1M–$10M (default)" : !priceMin && !priceMax ? "Any" : undefined}>
              <div className="flex items-center gap-2">
                <input value={priceMin} onChange={(e) => setPriceMin(e.target.value)} placeholder="Min $" inputMode="numeric" className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-red-300 focus:outline-none focus:ring-2 focus:ring-red-100" />
                <span className="text-gray-300">—</span>
                <input value={priceMax} onChange={(e) => setPriceMax(e.target.value)} placeholder="Max $" inputMode="numeric" className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-red-300 focus:outline-none focus:ring-2 focus:ring-red-100" />
              </div>
            </Field>
            <Field label="Home types" note={isDefaultTypes(types) ? "Default" : types.length === 0 ? "All" : undefined}>
              <div className="flex flex-wrap gap-1.5">
                {propertyTypes.map((t) => {
                  const on = types.includes(t);
                  return (
                    <button key={t} type="button" onClick={() => setTypes(on ? types.filter((x) => x !== t) : [...types, t])} className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${on ? "border-gray-900 bg-gray-900 text-white" : "border-gray-200 text-gray-600 hover:border-gray-300"}`}>
                      {t}
                    </button>
                  );
                })}
              </div>
            </Field>
            <Field label="Bedrooms" note={bedsMin == null ? "Any (default)" : undefined}>
              <Segmented value={bedsMin} options={BEDS.map((b) => ({ key: b, label: b == null ? "Any" : `${b}+` }))} onChange={setBedsMin} />
            </Field>
          </Section>

          <Section title="Programs" hint="Leave empty and we pick the best match for each listing.">
            {programs.length > 0 && (
              <div className="flex max-h-44 flex-wrap gap-1.5 overflow-y-auto">
                {programs.map((p) => {
                  const on = preferred.includes(p);
                  return (
                    <button key={p} type="button" onClick={() => setPreferred(on ? preferred.filter((x) => x !== p) : [...preferred, p])} className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${on ? "border-red-200 bg-red-50 font-medium text-red-700" : "border-gray-200 text-gray-600 hover:border-gray-300"}`}>
                      {p}
                    </button>
                  );
                })}
              </div>
            )}
            {preferred.length > 0 && (
              <Field label="How strictly">
                <Segmented value={programMode} options={[{ key: "prefer", label: "Prefer these" }, { key: "only", label: "Only these" }]} onChange={setProgramMode} />
              </Field>
            )}
          </Section>

          <Section title="Emails">
            <Field label="Emails per day" note={batchSize === DEFAULTS.batchSize ? "Default" : `Max ${maxBatch}`}>
              <div className="inline-flex items-center rounded-xl border border-gray-200">
                <button type="button" onClick={() => setBatchSize(Math.max(1, batchSize - 1))} className="px-3 py-1.5 text-gray-500 hover:text-gray-900" aria-label="Fewer">−</button>
                <span className="w-8 text-center text-sm font-semibold tabular-nums">{batchSize}</span>
                <button type="button" onClick={() => setBatchSize(Math.min(maxBatch, batchSize + 1))} className="px-3 py-1.5 text-gray-500 hover:text-gray-900" aria-label="More">+</button>
              </div>
            </Field>
            <Field label="Tone" note={tone === "friendly" ? "Default" : undefined}>
              <Segmented value={tone} options={TONES.map((t) => ({ key: t.key, label: t.label }))} onChange={setTone} />
            </Field>
            <Field label="Language" note={language === "English" ? "Default" : undefined}>
              <select value={language} onChange={(e) => setLanguage(e.target.value)} className="rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-red-300 focus:outline-none">
                {languages.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            </Field>
            <Field label="Flyer" note={flyerMode === "embed" ? "Default" : undefined}>
              <Segmented value={flyerMode} options={FLYERS.map((f) => ({ key: f.key, label: f.label }))} onChange={setFlyerMode} />
            </Field>
            <Field label="CC me on every email" note={ccSelf ? "On (default)" : "Off"}>
              <Segmented value={ccSelf ? "on" : "off"} options={[{ key: "on", label: "On" }, { key: "off", label: "Off" }]} onChange={(k) => setCcSelf(k === "on")} />
            </Field>
            <Field label="Remind me to follow up" note={followUpDays == null ? "Off (default)" : "If they haven't replied"}>
              <Segmented value={followUpDays} options={FOLLOW_UPS.map((d) => ({ key: d, label: d == null ? "Off" : `${d} days` }))} onChange={setFollowUpDays} />
            </Field>
            <Field label="Tell your assistant" note="Optional">
              <textarea
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                rows={3}
                maxLength={600}
                placeholder="Anything every email should say or avoid."
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-red-300 focus:outline-none focus:ring-2 focus:ring-red-100"
              />
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {INSTRUCTION_IDEAS.map((idea) => (
                  <button key={idea} type="button" onClick={() => setInstructions((v) => (v ? `${v.trim()} ${idea}.` : `${idea}.`).slice(0, 600))} className="rounded-full bg-gray-50 px-2.5 py-1 text-[11px] text-gray-500 ring-1 ring-gray-200 hover:bg-gray-100 hover:text-gray-700">
                    + {idea}
                  </button>
                ))}
              </div>
            </Field>
          </Section>
        </div>

        <footer className="border-t border-gray-100 bg-gray-50/60 px-6 py-4">
          {canRebuild && (
            <label className="mb-3 flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={rebuild} onChange={(e) => setRebuild(e.target.checked)} className="accent-red-600" />
              Rebuild today&apos;s list with these settings
            </label>
          )}
          {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
          <div className="flex items-center justify-between gap-2">
            <button type="button" onClick={resetDefaults} className="text-sm text-gray-500 hover:text-gray-800">Reset to defaults</button>
            <div className="flex gap-2">
              <button type="button" onClick={onClose} className="rounded-xl px-4 py-2 text-sm text-gray-600 hover:bg-gray-100">Cancel</button>
              <button
                type="button"
                disabled={saving || areas.length === 0}
                onClick={async () => {
                  setSaving(true);
                  setError(null);
                  try {
                    await onSave({
                      areaInputs: areas.map((a) => a.input),
                      batchSize,
                      priceMin: num(priceMin),
                      priceMax: num(priceMax),
                      domMin: dom.min,
                      domMax: dom.max,
                      propertyTypes: types,
                      bedsMin,
                      preferredPrograms: preferred,
                      programMode,
                      tone,
                      language,
                      flyerMode,
                      followUpDays,
                      ccSelf,
                      instructions: instructions.trim(),
                      rebuild: canRebuild && rebuild,
                    });
                    onClose();
                  } catch (e) {
                    setError(e instanceof Error ? e.message : "Couldn't save.");
                  } finally {
                    setSaving(false);
                  }
                }}
                className="rounded-xl bg-red-600 px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-red-700 disabled:bg-red-300"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </footer>
      </motion.aside>
    </div>
  );
}

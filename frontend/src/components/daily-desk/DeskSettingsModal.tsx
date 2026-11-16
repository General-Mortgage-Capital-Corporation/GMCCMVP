"use client";

import { useState } from "react";
import { locateMe, toAreaInput, type AreaInput, type DeskSettings } from "./api";

type AreaChip = { input: AreaInput; label: string };
const geoLabel = (r: number, place?: string) => `Within ${r} mi of ${place || "my location"}`;

export default function DeskSettingsModal({
  settings,
  programs,
  maxBatch,
  maxAreas,
  radiusOptions,
  canRebuild,
  onClose,
  onSave,
}: {
  settings: DeskSettings;
  programs: string[];
  maxBatch: number;
  maxAreas: number;
  radiusOptions: number[];
  /** Nothing sent yet today, so today's list can be rebuilt with the new settings. */
  canRebuild: boolean;
  onClose: () => void;
  onSave: (s: { areaInputs: AreaInput[]; batchSize: number; priceMin: number | null; priceMax: number | null; preferredPrograms: string[]; instructions: string; rebuild: boolean }) => Promise<void>;
}) {
  const [areas, setAreas] = useState<AreaChip[]>(settings.areas.map((a) => ({ input: toAreaInput(a), label: a.label })));
  const [locating, setLocating] = useState(false);
  const [draftArea, setDraftArea] = useState("");
  const [batchSize, setBatchSize] = useState(settings.batchSize);
  const [priceMin, setPriceMin] = useState(settings.priceMin ? String(settings.priceMin) : "");
  const [priceMax, setPriceMax] = useState(settings.priceMax ? String(settings.priceMax) : "");
  const [preferred, setPreferred] = useState<string[]>(settings.preferredPrograms);
  const [instructions, setInstructions] = useState(settings.instructions);
  const [rebuild, setRebuild] = useState(canRebuild);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
          <h2 className="text-base font-semibold text-gray-900">Today settings</h2>
          <button type="button" onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600" aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M12 4L4 12M4 4l8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          </button>
        </div>

        <div className="space-y-5 px-5 py-4">
          <section>
            <label className="text-sm font-medium text-gray-800">Your areas</label>
            <p className="text-xs text-gray-500">Up to {maxAreas}: your location, ZIP codes or cities. Saved — new listings come from here every day.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {areas.map((a, idx) => (
                <span key={`${a.label}-${idx}`} className="inline-flex items-center gap-1 rounded-full bg-gray-100 py-1 pl-3 pr-1.5 text-sm text-gray-700">
                  {typeof a.input === "string" ? (
                    a.label
                  ) : (
                    <>
                      <svg width="12" height="12" viewBox="0 0 20 20" fill="currentColor" className="text-red-500" aria-hidden>
                        <path fillRule="evenodd" d="M10 18s6-5.33 6-10A6 6 0 004 8c0 4.67 6 10 6 10zm0-7.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z" clipRule="evenodd" />
                      </svg>
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
                  <svg width="12" height="12" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                    <path fillRule="evenodd" d="M10 18s6-5.33 6-10A6 6 0 004 8c0 4.67 6 10 6 10zm0-7.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z" clipRule="evenodd" />
                  </svg>
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
                  className="min-w-[10rem] flex-1 rounded-full border border-gray-300 px-3 py-1 text-sm focus:border-red-400 focus:outline-none focus:ring-2 focus:ring-red-100"
                />
              )}
            </div>
          </section>

          <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="text-sm font-medium text-gray-800" htmlFor="desk-batch">Emails per day</label>
              <select id="desk-batch" value={batchSize} onChange={(e) => setBatchSize(Number(e.target.value))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-red-400 focus:outline-none">
                {Array.from({ length: maxBatch }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-sm font-medium text-gray-800">Price range</label>
              <div className="mt-1 flex items-center gap-2">
                <input value={priceMin} onChange={(e) => setPriceMin(e.target.value)} placeholder="Min" inputMode="numeric" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-red-400 focus:outline-none" />
                <span className="text-gray-400">–</span>
                <input value={priceMax} onChange={(e) => setPriceMax(e.target.value)} placeholder="Max" inputMode="numeric" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-red-400 focus:outline-none" />
              </div>
            </div>
          </section>

          {programs.length > 0 && (
            <section>
              <label className="text-sm font-medium text-gray-800">Programs to feature</label>
              <p className="text-xs text-gray-500">Optional. Leave empty and we pick the best match for each listing.</p>
              <div className="mt-2 flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
                {programs.map((p) => {
                  const on = preferred.includes(p);
                  return (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setPreferred(on ? preferred.filter((x) => x !== p) : [...preferred, p])}
                      className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${on ? "border-red-200 bg-red-50 text-red-700" : "border-gray-200 text-gray-600 hover:border-gray-300"}`}
                    >
                      {p}
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          <section>
            <label className="text-sm font-medium text-gray-800" htmlFor="desk-style">Writing style</label>
            <p className="text-xs text-gray-500">Optional. How your emails should sound.</p>
            <textarea
              id="desk-style"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              rows={3}
              maxLength={600}
              placeholder="e.g. Friendly and brief. Mention I've helped buyers in this neighborhood for 10 years."
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-red-400 focus:outline-none focus:ring-2 focus:ring-red-100"
            />
          </section>

          {canRebuild && (
            <label className="flex items-start gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={rebuild} onChange={(e) => setRebuild(e.target.checked)} className="mt-0.5 accent-red-600" />
              Rebuild today&apos;s list with these settings
            </label>
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-gray-100 px-5 py-3">
          <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-100">Cancel</button>
          <button
            type="button"
            disabled={saving || areas.length === 0}
            onClick={async () => {
              setSaving(true);
              setError(null);
              try {
                await onSave({ areaInputs: areas.map((a) => a.input), batchSize, priceMin: num(priceMin), priceMax: num(priceMax), preferredPrograms: preferred, instructions: instructions.trim(), rebuild: canRebuild && rebuild });
                onClose();
              } catch (e) {
                setError(e instanceof Error ? e.message : "Couldn't save.");
              } finally {
                setSaving(false);
              }
            }}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:bg-red-300"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

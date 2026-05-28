"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import RefiResultsTable from "./RefiResultsTable";
import RefiDetailModal from "./RefiDetailModal";
import RefiUnlockModal, { type UnlockResultMap } from "./RefiUnlockModal";
import UnlockConfirmDialog from "./UnlockConfirmDialog";
import type {
  Geography,
  PreviewResp,
  QuotaResp,
  RefiFilters,
  RefiPreset,
  RefiRow,
  SearchResp,
} from "./types";

type AccessTier = "loading" | "anonymous" | "no_access" | "has_access";
type AccessResp = {
  tier: Exclude<AccessTier, "loading">;
  email?: string;
  quota?: QuotaResp | null;
};

type Phase = "idle" | "filtering" | "previewed" | "results";

const PAGE_SIZE = 25;

// localStorage key — schemaVersion bumped when shape changes to invalidate stale state.
const LS_KEY = "refi-finder/v1/state";
const LS_VERSION = 1;

// Multi-select options shown in the filter form.
const PURPOSE_OPTIONS = [
  { value: "PMoney", label: "Purchase money" },
  { value: "R&TRefi", label: "Rate-and-term refi" },
  { value: "CashOut", label: "Cash-out refi" },
  { value: "Construction", label: "Construction" },
  { value: "ELOC", label: "Equity line (ELOC)" },
  { value: "Reverse", label: "Reverse mortgage" },
  { value: "Wrap", label: "Wrap" },
] as const;

const LOAN_TYPE_OPTIONS = [
  { value: "C", label: "Conforming" },
  { value: "F", label: "FHA" },
  { value: "V", label: "VA" },
  { value: "N", label: "Jumbo (Non-Conforming)" },
  { value: "O", label: "Conventional (other)" },
  { value: "P", label: "Private" },
  { value: "S", label: "Seller" },
  { value: "B", label: "SBA" },
] as const;

const RATE_TYPE_OPTIONS = [
  { value: "F", label: "Fixed" },
  { value: "A", label: "Adjustable (ARM)" },
] as const;

const PROPERTY_TYPE_OPTIONS = [
  { value: "SFR", label: "Single Family" },
  { value: "CND", label: "Condo" },
  { value: "MFR", label: "Multi-family (2–4)" },
  { value: "APT", label: "Apartment (5+)" },
  { value: "LND", label: "Land" },
  { value: "COM", label: "Commercial" },
] as const;

// Stable JSON stringify for criteria-key derivation (object key order matters).
function stableKey(obj: unknown): string {
  return JSON.stringify(obj, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.keys(v).sort().reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = (v as Record<string, unknown>)[k];
        return acc;
      }, {});
    }
    return v;
  });
}

type PersistedState = {
  version: number;
  activePresetId: string | null;
  filters: RefiFilters;
  zipsText: string;
  rows: RefiRow[];
  rowsAvailable: number;
  criteriaKey: string;
  unlocked: UnlockResultMap;
};

interface RefiFinderTabProps {
  /**
   * When true, the tab routes search + contact unlocks through the new
   * credit-deducting endpoints (/api/refi/unlock-search,
   * /api/refi/unlock-contact-paid) and shows a confirmation modal before
   * each batch action. When false (default), the legacy free-tier endpoints
   * are used so existing has_access users keep working unchanged.
   *
   * Phase 4 will remove this prop entirely once the legacy gate is flipped off.
   */
  creditMode?: boolean;
  /** Current credit balance from useRefiSubscription. Required when creditMode. */
  balance?: { contact: number; property: number };
  /** Called after a successful credit-deducting action so the parent can refresh. */
  onCreditChange?: () => void;
}

export default function RefiFinderTab({
  creditMode = false,
  balance,
  onCreditChange,
}: RefiFinderTabProps = {}) {
  const { user, signIn, getIdToken } = useAuth();
  // Confirmation-dialog state for batch fetches when creditMode is on. The
  // dialog is rendered at the bottom of the tab; setting confirmFetch pops it
  // up. effectiveLimit is the actual rows we'll request (and therefore the
  // exact credit cost) — for small result sets it's smaller than PAGE_SIZE so
  // the user isn't charged for rows PR can't return.
  const [confirmFetch, setConfirmFetch] = useState<{
    appendMode: boolean;
    effectiveLimit: number;
  } | null>(null);

  // Access tier. Gates the entire tab: anonymous → log-in CTA, no_access →
  // "coming soon" with future-subscription pitch, has_access → full UI.
  const [accessTier, setAccessTier] = useState<AccessTier>("loading");
  const [accessEmail, setAccessEmail] = useState<string | null>(null);

  const [presets, setPresets] = useState<RefiPreset[]>([]);
  const [presetsLoading, setPresetsLoading] = useState(true);
  const [activePresetId, setActivePresetId] = useState<string | null>(null);

  const [geography, setGeography] = useState<Geography>({});
  const [zipsText, setZipsText] = useState("");

  const [filters, setFilters] = useState<RefiFilters>({});

  const [phase, setPhase] = useState<Phase>("idle");
  const [preview, setPreview] = useState<PreviewResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchingMore, setFetchingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [capError, setCapError] = useState<string | null>(null);

  // Accumulator: rows grow as user clicks "Fetch more". Pagination operates
  // on this in-memory list for free.
  const [rows, setRows] = useState<RefiRow[]>([]);
  const [rowsAvailable, setRowsAvailable] = useState(0);
  const [cacheHit, setCacheHit] = useState(false);
  // The criteria signature of the currently-loaded rows. Any filter change
  // invalidates it and a fresh fetch is required.
  const [loadedCriteriaKey, setLoadedCriteriaKey] = useState<string | null>(null);

  const [viewPage, setViewPage] = useState(0);
  const [detailRow, setDetailRow] = useState<RefiRow | null>(null);

  const [quota, setQuota] = useState<QuotaResp | null>(null);

  // Unlocked contact info, keyed by RadarID. Persisted so reload doesn't lose
  // paid unlocks.
  const [unlocked, setUnlocked] = useState<UnlockResultMap>({});
  // Per-row in-flight tracker for single-row, single-channel reveals (credit
  // mode only). Maps RadarID → { email?: true, text?: true } so multiple
  // channels can spin independently on the same row.
  const [revealingByRow, setRevealingByRow] = useState<
    Record<string, { email?: boolean; text?: boolean }>
  >({});
  const [unlockingRows, setUnlockingRows] = useState<RefiRow[] | null>(null);
  const [unlockSummary, setUnlockSummary] = useState<string | null>(null);

  // Refs to skip the initial localStorage hydration race.
  const hydratedRef = useRef(false);

  // Authed fetch — every refi API call requires the Firebase ID token.
  const authedFetch = useCallback(async (input: RequestInfo, init?: RequestInit) => {
    const token = user ? await getIdToken() : null;
    const headers = new Headers(init?.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  }, [user, getIdToken]);

  // ── Access tier check (runs whenever auth changes) ────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!user) {
        setAccessTier("anonymous");
        return;
      }
      try {
        const res = await authedFetch("/api/refi/access");
        const data: AccessResp = await res.json();
        if (cancelled) return;
        setAccessTier(data.tier);
        setAccessEmail(data.email ?? user.email ?? null);
        if (data.tier === "has_access" && data.quota) setQuota(data.quota);
      } catch {
        if (!cancelled) setAccessTier("anonymous");
      }
    })();
    return () => { cancelled = true; };
  }, [user, authedFetch]);

  // ── Load presets + quota + restore state (only when access is granted) ────
  useEffect(() => {
    if (accessTier !== "has_access") return;
    let cancelled = false;
    (async () => {
      try {
        const [pRes, qRes] = await Promise.all([
          authedFetch("/api/refi/presets").then((r) => r.json()),
          authedFetch("/api/refi/quota?check_remaining=1").then((r) => r.json()),
        ]);
        if (cancelled) return;
        setPresets(Array.isArray(pRes.presets) ? pRes.presets : []);
        if (qRes && typeof qRes.daily_cap === "number") setQuota(qRes);

        // Restore persisted state (filters + rows). Note: rows persist but if
        // they're stale (>24h) the next preview/fetch will re-check anyway.
        const raw = typeof window !== "undefined" ? localStorage.getItem(LS_KEY) : null;
        if (raw) {
          try {
            const saved = JSON.parse(raw) as PersistedState;
            if (saved.version === LS_VERSION) {
              setActivePresetId(saved.activePresetId);
              setFilters(saved.filters ?? {});
              setZipsText(saved.zipsText ?? "");
              setRows(saved.rows ?? []);
              setRowsAvailable(saved.rowsAvailable ?? 0);
              setLoadedCriteriaKey(saved.criteriaKey ?? null);
              setUnlocked(saved.unlocked ?? {});
              if ((saved.rows ?? []).length > 0) setPhase("results");
              else if (saved.activePresetId || (saved.zipsText ?? "").length > 0) setPhase("filtering");
            }
          } catch {/* ignore corrupt state */}
        }
      } catch (err) {
        if (!cancelled) setError("Failed to load refi presets.");
        console.error("refi init failed", err);
      } finally {
        if (!cancelled) {
          setPresetsLoading(false);
          hydratedRef.current = true;
        }
      }
    })();
    return () => { cancelled = true; };
  }, [accessTier, authedFetch]);

  const activePreset = useMemo(
    () => presets.find((p) => p.id === activePresetId) ?? null,
    [presets, activePresetId],
  );

  const parsedZips: number[] = useMemo(() => {
    return zipsText
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => Number(s))
      .filter((n) => Number.isInteger(n) && n >= 1000 && n <= 99999);
  }, [zipsText]);

  const geoForRequest: Geography = useMemo(() => {
    if (parsedZips.length > 0) return { zip_codes: parsedZips };
    return geography;
  }, [parsedZips, geography]);

  // Stable key for the current filter set — used to detect when the
  // accumulated rows become stale.
  const currentCriteriaKey = useMemo(() => stableKey({
    preset: activePresetId,
    geo: geoForRequest,
    filters,
  }), [activePresetId, geoForRequest, filters]);

  // Persist whenever durable state changes.
  useEffect(() => {
    if (!hydratedRef.current || typeof window === "undefined") return;
    try {
      const payload: PersistedState = {
        version: LS_VERSION,
        activePresetId,
        filters,
        zipsText,
        rows,
        rowsAvailable,
        criteriaKey: loadedCriteriaKey ?? "",
        unlocked,
      };
      localStorage.setItem(LS_KEY, JSON.stringify(payload));
    } catch {/* quota or serialization fail — ignore */}
  }, [activePresetId, filters, zipsText, rows, rowsAvailable, loadedCriteriaKey, unlocked]);

  const canPreview: boolean = parsedZips.length > 0 ||
    !!(geography.cities && geography.cities.length > 0) ||
    !!(geography.county_fips && geography.county_fips.length > 0) ||
    !!(geography.states && geography.states.length > 0);

  function selectPreset(p: RefiPreset | null) {
    setActivePresetId(p?.id ?? null);
    setFilters(p ? { ...p.base_filters } : {});
    invalidateResults();
    setPhase("filtering");
  }

  function patchFilters(patch: Partial<RefiFilters>) {
    setFilters((prev) => ({ ...prev, ...patch }));
    invalidateResults();
  }

  function clearFilter(key: keyof RefiFilters) {
    setFilters((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    invalidateResults();
  }

  function invalidateResults() {
    setPreview(null);
    if (phase === "results") setPhase("filtering");
    // Keep rows + unlocked in state but the criteriaKey mismatch will surface
    // a "stale results" hint instead of silently serving the old set.
  }

  const isStale = phase === "results" && loadedCriteriaKey !== null && loadedCriteriaKey !== currentCriteriaKey;

  const runPreview = useCallback(async () => {
    if (!canPreview) {
      setError("Enter at least one zip code (or city / county) before previewing.");
      return;
    }
    setError(null);
    setCapError(null);
    setLoading(true);
    try {
      const res = await authedFetch("/api/refi/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preset_id: activePresetId, geography: geoForRequest, filters }),
      });
      const data: PreviewResp = await res.json();
      if (!data.success) throw new Error(data.error ?? "Preview failed");
      setPreview(data);
      setPhase("previewed");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Preview failed");
    } finally {
      setLoading(false);
    }
  }, [activePresetId, geoForRequest, filters, canPreview, authedFetch]);

  // Fetch — initial OR "fetch more". For "initial", appendMode=false replaces rows.
  // For "fetch more", appendMode=true appends to the current rows.
  //
  // When creditMode is on, this routes to /api/refi/unlock-search which deducts
  // `limitOverride` property credits atomically before calling PR. The caller
  // (requestFetch) computes the effective limit so we never charge the user
  // for rows PR can't return (e.g. only 13 matches → charge 13, not PAGE_SIZE).
  const runFetch = useCallback(async (appendMode: boolean, limitOverride?: number) => {
    setError(null);
    setCapError(null);
    appendMode ? setFetchingMore(true) : setLoading(true);
    try {
      const limit = limitOverride ?? PAGE_SIZE;
      const serverPage = appendMode ? Math.ceil(rows.length / PAGE_SIZE) : 0;
      const endpoint = creditMode ? "/api/refi/unlock-search" : "/api/refi/search";
      const reqBody: Record<string, unknown> = {
        preset_id: activePresetId,
        geography: geoForRequest,
        filters,
        page: serverPage,
        limit,
      };
      if (creditMode) reqBody.confirmedLimit = limit;
      const res = await authedFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reqBody),
      });
      const data: SearchResp & { error?: string; refunded?: boolean } = await res.json();
      if (res.status === 429 || data.code === "daily_cap") {
        setCapError(data.error ?? "Daily record cap reached. Try again tomorrow or raise the cap.");
        return;
      }
      if (res.status === 402) {
        setError(
          `Out of credits — ${data.error === "insufficient_credits" ? "your balance is too low for this fetch." : "subscribe or recharge to continue."}`,
        );
        return;
      }
      if (!data.success) throw new Error(data.error ?? "Search failed");
      // creditMode success → trigger balance refresh on parent
      if (creditMode) onCreditChange?.();

      const newRows = data.results ?? [];
      if (appendMode) {
        // Deduplicate by RadarID to be safe (PR pagination occasionally repeats).
        const seen = new Set(rows.map((r) => r.RadarID));
        setRows((prev) => [...prev, ...newRows.filter((r) => !seen.has(r.RadarID))]);
      } else {
        setRows(newRows);
        setViewPage(0);
        setUnlocked({}); // unlocked map is criteria-scoped; clear on fresh fetch
      }
      setRowsAvailable(data.rows_available ?? 0);
      setCacheHit(!!data.cache_hit);
      setLoadedCriteriaKey(currentCriteriaKey);
      setPhase("results");

      authedFetch("/api/refi/quota?check_remaining=1").then((r) => r.json()).then((q) => setQuota(q)).catch(() => {});
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setLoading(false);
      setFetchingMore(false);
    }
  }, [activePresetId, geoForRequest, filters, rows, currentCriteriaKey, authedFetch, creditMode, onCreditChange]);

  // Wrapper: in creditMode, show the confirmation modal before runFetch; in
  // legacy mode, call runFetch directly. Bound to the Fetch + Fetch-more buttons.
  //
  // effectiveLimit caps PAGE_SIZE at what's actually available so users aren't
  // charged for rows PR can't return:
  //   - First fetch  → min(PAGE_SIZE, preview.totalResultCount)
  //   - Fetch more   → min(PAGE_SIZE, rowsAvailable - rows.length)
  const requestFetch = useCallback((appendMode: boolean) => {
    const available = appendMode
      ? Math.max(0, rowsAvailable - rows.length)
      : preview?.totalResultCount ?? PAGE_SIZE;
    const effectiveLimit = Math.min(PAGE_SIZE, available);
    if (effectiveLimit <= 0) return;
    if (creditMode) {
      setConfirmFetch({ appendMode, effectiveLimit });
    } else {
      void runFetch(appendMode, effectiveLimit);
    }
  }, [creditMode, runFetch, preview?.totalResultCount, rowsAvailable, rows.length]);

  function resetAll() {
    setActivePresetId(null);
    setFilters({});
    setZipsText("");
    setGeography({});
    setPreview(null);
    setRows([]);
    setRowsAvailable(0);
    setCacheHit(false);
    setLoadedCriteriaKey(null);
    setViewPage(0);
    setUnlocked({});
    setPhase("idle");
    setError(null);
    setCapError(null);
    if (typeof window !== "undefined") localStorage.removeItem(LS_KEY);
  }

  // Unlock — fetches phone/email for selected rows via the property-persons
  // endpoint. Returns owned (already-purchased) data inline + any net-new.
  const runUnlock = useCallback(async (selectedRows: RefiRow[]) => {
    const radarIds = selectedRows.map((r) => r.RadarID).filter(Boolean);
    if (radarIds.length === 0) {
      setError("No properties selected for unlock.");
      return;
    }
    try {
      const endpoint = creditMode
        ? "/api/refi/unlock-contact-paid"
        : "/api/refi/unlock-contact";
      const reqBody: Record<string, unknown> = creditMode
        ? {
            // creditMode endpoint takes structured rows with per-channel flags.
            // For now we always request both email+text (matches legacy bundled
            // behavior). Future polish: split into per-row reveal-email vs
            // reveal-text buttons in RefiResultsTable.
            rows: selectedRows.map((r) => ({
              radar_id: r.RadarID,
              address: r.Address ?? "unknown",
              email: true,
              text: true,
            })),
          }
        : { radar_ids: radarIds, phone: true, email: true };
      const res = await authedFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reqBody),
      });
      const data = await res.json() as {
        success: boolean;
        results?: {
          radar_id: string;
          phone?: string|null;
          email?: string|null;
          phone_error?: string|null;
          email_error?: string|null;
          persons?: { person_key?: string; name?: string; role?: string; is_primary?: boolean; phones: string[]; emails: string[] }[];
        }[];
        emailOnly?: { results?: Array<Record<string, unknown>> };
        textOnly?: { results?: Array<Record<string, unknown>> };
        both?: { results?: Array<Record<string, unknown>> };
        error?: string;
      };
      if (res.status === 402) {
        setError("Out of contact credits. Buy a $20 recharge or wait for renewal.");
        return;
      }
      if (!data.success) throw new Error(data.error ?? "Unlock failed");
      if (creditMode) onCreditChange?.();
      // In creditMode the response has per-group buckets (emailOnly/textOnly/both).
      // Merge them into the same `results` shape the legacy path uses so the
      // post-unlock UI doesn't care which mode we're in.
      if (creditMode && !data.results) {
        const merged = [
          ...(data.both?.results ?? []),
          ...(data.emailOnly?.results ?? []),
          ...(data.textOnly?.results ?? []),
        ] as unknown as typeof data.results;
        data.results = merged;
      }

      const results = data.results ?? [];
      setUnlocked((prev) => {
        const next = { ...prev };
        for (const r of results) {
          if (!r.radar_id) continue;
          next[r.radar_id] = {
            phone: r.phone ?? next[r.radar_id]?.phone,
            email: r.email ?? next[r.radar_id]?.email,
            phone_error: r.phone_error ?? null,
            email_error: r.email_error ?? null,
            persons: r.persons ?? next[r.radar_id]?.persons,
          };
        }
        return next;
      });

      let phoneGot = 0, emailGot = 0, bothMissing = 0;
      for (const r of results) {
        if (r.phone) phoneGot++;
        if (r.email) emailGot++;
        if (!r.phone && !r.email) bothMissing++;
      }
      setUnlockSummary(
        `Fetched ${phoneGot} phone${phoneGot === 1 ? "" : "s"} and ${emailGot} email${emailGot === 1 ? "" : "s"} across ${results.length} propert${results.length === 1 ? "y" : "ies"}` +
        (bothMissing > 0 ? ` · ${bothMissing} had no contact in PR's database.` : "")
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unlock failed");
    }
  }, [authedFetch, creditMode, onCreditChange]);

  // Per-row, per-channel reveal — credit-mode only. Skips the bulk
  // confirmation modal; deducts 1 contact credit (server-side); refunds it
  // if PR returns null for that channel. Result merges into the same
  // `unlocked` map the bulk flow writes to, so the table cell flips to
  // "value" or "not available on file" without an extra round trip.
  const runRevealChannel = useCallback(async (row: RefiRow, channel: "email" | "text") => {
    const radarId = row.RadarID;
    if (!radarId) return;
    setRevealingByRow((prev) => ({
      ...prev,
      [radarId]: { ...prev[radarId], [channel]: true },
    }));
    try {
      const res = await authedFetch("/api/refi/unlock-contact-paid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows: [
            {
              radar_id: radarId,
              address: row.Address ?? "unknown",
              email: channel === "email",
              text: channel === "text",
            },
          ],
        }),
      });
      const data = await res.json() as {
        success?: boolean;
        emailOnly?: { results?: Array<Record<string, unknown>> };
        textOnly?: { results?: Array<Record<string, unknown>> };
        error?: string;
      };
      if (res.status === 402) {
        setError("Out of contact credits. Buy a $20 recharge or wait for renewal.");
        return;
      }
      if (!data.success) throw new Error(data.error ?? "Reveal failed");
      // Always trigger a balance refresh — server may have refunded if PR had no data.
      onCreditChange?.();

      const bucket = channel === "email" ? data.emailOnly?.results : data.textOnly?.results;
      const result = (bucket ?? [])[0] as {
        radar_id?: string;
        phone?: string | null;
        email?: string | null;
        phone_error?: string | null;
        email_error?: string | null;
      } | undefined;
      if (!result) return;

      setUnlocked((prev) => ({
        ...prev,
        [radarId]: {
          phone: result.phone ?? prev[radarId]?.phone,
          email: result.email ?? prev[radarId]?.email,
          phone_error: result.phone_error ?? prev[radarId]?.phone_error ?? null,
          email_error: result.email_error ?? prev[radarId]?.email_error ?? null,
          persons: prev[radarId]?.persons,
        },
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reveal failed");
    } finally {
      setRevealingByRow((prev) => {
        const next = { ...prev };
        const row = { ...(next[radarId] ?? {}) };
        delete row[channel];
        if (Object.keys(row).length === 0) delete next[radarId];
        else next[radarId] = row;
        return next;
      });
    }
  }, [authedFetch, onCreditChange]);

  // ── Render ────────────────────────────────────────────────────────────────

  if (accessTier === "loading") {
    return <div className="flex h-40 items-center justify-center text-sm text-gray-500">Checking access…</div>;
  }

  if (accessTier === "anonymous") {
    return <AnonymousGate onSignIn={signIn} />;
  }

  if (accessTier === "no_access") {
    return <NoAccessGate email={accessEmail} />;
  }

  // accessTier === "has_access" — render the full tool
  if (presetsLoading) {
    return <div className="flex h-40 items-center justify-center text-sm text-gray-500">Loading refi presets…</div>;
  }

  // Pagination over the in-memory accumulated rows.
  const viewRows = rows.slice(viewPage * PAGE_SIZE, (viewPage + 1) * PAGE_SIZE);
  const viewTotalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const moreAvailable = rows.length < rowsAvailable;

  return (
    <div className="space-y-6">
      <Header quota={quota} />

      {unlockSummary && (
        <div className="flex items-start justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800">
          <span>{unlockSummary}</span>
          <button type="button" onClick={() => setUnlockSummary(null)} className="text-emerald-600 hover:text-emerald-800" aria-label="Dismiss">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M12 4L4 12M4 4l8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          </button>
        </div>
      )}

      {capError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <div className="font-medium">Daily record cap reached.</div>
          <div className="mt-1">{capError}</div>
          <div className="mt-1 text-xs">Raise <code className="rounded bg-red-100 px-1">PROPERTY_RADAR_DAILY_RECORD_CAP</code> in the backend <code className="rounded bg-red-100 px-1">.env</code> and restart Flask to lift this limit.</div>
        </div>
      )}

      {phase === "idle" && (
        <PresetGrid presets={presets} onPick={selectPreset} onBuildFromScratch={() => selectPreset(null)} />
      )}

      {phase !== "idle" && (
        <div className="space-y-5">
          <ActivePresetHeader
            preset={activePreset}
            onChangePreset={() => { invalidateResults(); setPhase("idle"); }}
          />

          <GeographyInput
            zipsText={zipsText}
            onChange={(t) => { setZipsText(t); invalidateResults(); }}
            parsedZips={parsedZips}
          />

          <FilterForm
            filters={filters}
            onPatch={patchFilters}
            onClear={clearFilter}
            primaryKeys={activePreset?.primary_filter_keys ?? []}
          />

          {error && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">{error}</div>
          )}

          <PreviewActionBar
            phase={phase}
            preview={preview}
            loading={loading}
            canPreview={canPreview}
            onPreview={runPreview}
            onFetch={() => requestFetch(false)}
            onReset={resetAll}
          />

          {phase === "results" && rows.length > 0 && (
            <>
              {isStale && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
                  Filters changed since these results were fetched. Re-preview and fetch to refresh.
                </div>
              )}
              <RefiResultsTable
                rows={viewRows}
                rowsLoaded={rows.length}
                rowsAvailable={rowsAvailable}
                viewPage={viewPage}
                viewPageSize={PAGE_SIZE}
                viewTotalPages={viewTotalPages}
                cacheHit={cacheHit}
                moreAvailable={moreAvailable}
                fetchingMore={fetchingMore}
                unlocked={unlocked}
                onPageChange={(p) => setViewPage(p)}
                onFetchMore={() => requestFetch(true)}
                onSelectRow={(row) => setDetailRow(row)}
                onUnlockRequest={(selected) => setUnlockingRows(selected)}
                {...(creditMode ? {
                  onRevealChannel: runRevealChannel,
                  revealingByRow,
                } : {})}
              />
            </>
          )}
        </div>
      )}

      {detailRow && (
        <RefiDetailModal
          row={detailRow}
          contact={unlocked[detailRow.RadarID]}
          onClose={() => setDetailRow(null)}
        />
      )}

      {/* Contact unlock confirmation.
          - In creditMode: itemized UnlockConfirmDialog that surfaces the exact
            credit cost (1 email + 1 text per billable row = 2 contact credits).
          - In legacy mode: existing RefiUnlockModal with the PR-export-credit
            language. Both filter out rows that already have unlocked contact
            so the user isn't recharged for cached data. */}
      {unlockingRows && creditMode && balance && (() => {
        const billable = unlockingRows.filter((r) => {
          const u = unlocked[r.RadarID];
          return !(u && (u.phone || u.email));
        });
        const n = billable.length;
        return (
          <UnlockConfirmDialog
            open
            title={`Reveal contact info for ${n} ${n === 1 ? "property" : "properties"}`}
            items={n === 0 ? [] : [
              {
                label: n === 1 ? "Reveal 1 email" : `Reveal ${n} emails`,
                count: n,
                pool: "contact",
              },
              {
                label: n === 1 ? "Reveal 1 text" : `Reveal ${n} texts`,
                count: n,
                pool: "contact",
              },
            ]}
            balance={balance}
            onCancel={() => setUnlockingRows(null)}
            onConfirm={async () => {
              const toUnlock = billable;
              setUnlockingRows(null);
              if (toUnlock.length > 0) await runUnlock(toUnlock);
            }}
          />
        );
      })()}
      {unlockingRows && !creditMode && (
        <RefiUnlockModal
          rows={unlockingRows}
          alreadyUnlocked={unlocked}
          onCancel={() => setUnlockingRows(null)}
          onConfirm={async (toUnlock) => {
            setUnlockingRows(null);
            await runUnlock(toUnlock);
          }}
        />
      )}

      {/* Credit-mode batch fetch confirmation. Pops up when user clicks
          Fetch/Fetch-more while creditMode is on. effectiveLimit is the
          actual cost — capped at what PR can return so we never deduct
          for rows that don't exist. */}
      {creditMode && balance && confirmFetch && (
        <UnlockConfirmDialog
          open
          title={
            confirmFetch.appendMode
              ? `Fetch ${confirmFetch.effectiveLimit} more`
              : `Fetch ${confirmFetch.effectiveLimit} ${confirmFetch.effectiveLimit === 1 ? "property" : "properties"}`
          }
          items={[
            {
              label: `Search ${confirmFetch.effectiveLimit} ${confirmFetch.effectiveLimit === 1 ? "property" : "properties"}`,
              count: confirmFetch.effectiveLimit,
              pool: "property",
            },
          ]}
          balance={balance}
          onCancel={() => setConfirmFetch(null)}
          onConfirm={async () => {
            const { appendMode, effectiveLimit } = confirmFetch;
            setConfirmFetch(null);
            await runFetch(appendMode, effectiveLimit);
          }}
        />
      )}
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function Header(_props: { quota: QuotaResp | null }) {
  // The PR company-plan quota used to render here ("Credits remaining this
  // month") was the LIVE PropertyRadar quota — real money. We now expose only
  // the per-user / buffer balances via CreditsHeaderPill + CreditsCard, so the
  // company quota is intentionally hidden from end users.
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="text-xl font-semibold text-gray-900">Refi Finder</h2>
        <p className="mt-1 text-sm text-gray-500">
          Surface refinance prospects from public mortgage records. Pick a scenario, narrow the geography, preview the count for free, then fetch the table.
        </p>
      </div>
    </div>
  );
}

// ─── Gate states ────────────────────────────────────────────────────────────

function AnonymousGate({ onSignIn }: { onSignIn: () => void }) {
  return (
    <div className="mx-auto max-w-md py-10 text-center">
      <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-red-50 ring-1 ring-red-100">
        <svg className="h-6 w-6 text-red-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="4" y="11" width="16" height="9" rx="2" />
          <path d="M8 11V8a4 4 0 0 1 8 0v3" />
          <circle cx="12" cy="15.5" r="1.1" fill="currentColor" stroke="none" />
        </svg>
      </div>
      <h2 className="text-xl font-semibold text-gray-900">Sign in to use Refi Finder</h2>
      <p className="mt-2 text-sm text-gray-600">
        Refi Finder surfaces refinance prospects from public mortgage records — for subscribed GMCC loan officers only.
      </p>
      <button
        type="button"
        onClick={onSignIn}
        className="mt-5 inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-red-700"
      >
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M11.4 2H2v9.4h9.4V2zM22 2h-9.4v9.4H22V2zM11.4 12.6H2V22h9.4v-9.4zM22 12.6h-9.4V22H22v-9.4z" />
        </svg>
        Sign in with Microsoft
      </button>
    </div>
  );
}

function NoAccessGate({ email }: { email: string | null }) {
  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="rounded-2xl border border-gray-200 bg-gradient-to-br from-white to-gray-50 p-6 shadow-sm">
        <div className="inline-flex items-center gap-2 rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-800">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
          Private beta
        </div>
        <h2 className="mt-3 text-2xl font-semibold text-gray-900">Refi Finder — coming soon</h2>
        <p className="mt-2 text-sm text-gray-600">
          A new GMCC tool for finding refinance prospects from public mortgage records. Filter by zip, scenario (cash-out, rate-and-term, FHA→Conv, VA IRRRL, ARM reset, etc.), then fetch borrower contact info to start outreach.
        </p>

        <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
          {[
            ["Pick a scenario", "6 curated refi presets"],
            ["Preview free", "See the universe before you charge"],
            ["Direct contact", "Phones + emails per borrower"],
          ].map(([t, s]) => (
            <div key={t} className="rounded-xl border border-gray-100 bg-white p-3">
              <div className="text-xs font-semibold text-gray-900">{t}</div>
              <div className="mt-0.5 text-xs text-gray-500">{s}</div>
            </div>
          ))}
        </div>

        <div className="mt-5 rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm text-gray-700">
          <div className="font-medium text-gray-900">Currently access-limited.</div>
          <div className="mt-1 text-gray-600">
            Subscription plans with allocated monthly credits are coming.
          </div>
          {email && (
            <div className="mt-2 text-xs text-gray-500">Signed in as <span className="font-mono">{email}</span></div>
          )}
        </div>
      </div>
    </div>
  );
}

function PresetGrid({ presets, onPick, onBuildFromScratch }: {
  presets: RefiPreset[]; onPick: (p: RefiPreset) => void; onBuildFromScratch: () => void;
}) {
  return (
    <div>
      <div className="mb-3 text-sm font-medium text-gray-700">Pick a refi scenario to start with</div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {presets.map((p) => (
          <button key={p.id} type="button" onClick={() => onPick(p)}
            className="group rounded-2xl border border-gray-200 bg-white p-4 text-left transition-all hover:-translate-y-0.5 hover:border-red-300 hover:shadow-md">
            <div className="text-base font-semibold text-gray-900 group-hover:text-red-600">{p.name}</div>
            <div className="mt-1 text-sm text-gray-600">{p.tagline}</div>
            <div className="mt-3 line-clamp-3 text-xs text-gray-500">{p.why}</div>
          </button>
        ))}
        <button type="button" onClick={onBuildFromScratch}
          className="group rounded-2xl border border-dashed border-gray-300 bg-gray-50 p-4 text-left transition-all hover:border-red-300 hover:bg-white">
          <div className="text-base font-semibold text-gray-700 group-hover:text-red-600">Build from scratch</div>
          <div className="mt-1 text-sm text-gray-600">No preset — set every filter yourself.</div>
          <div className="mt-3 text-xs text-gray-500">Recommended for niche scenarios or testing custom criteria.</div>
        </button>
      </div>
    </div>
  );
}

function ActivePresetHeader({ preset, onChangePreset }: { preset: RefiPreset | null; onChangePreset: () => void }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 rounded-2xl border border-gray-200 bg-white p-4">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">{preset ? "Scenario" : "Custom"}</span>
          <div className="text-base font-semibold text-gray-900">{preset?.name ?? "Build from scratch"}</div>
        </div>
        {preset && <div className="mt-1 text-sm text-gray-600">{preset.why}</div>}
      </div>
      <button type="button" onClick={onChangePreset} className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50">
        Change scenario
      </button>
    </div>
  );
}

function GeographyInput({ zipsText, onChange, parsedZips }: { zipsText: string; onChange: (s: string) => void; parsedZips: number[] }) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4">
      <label className="block text-sm font-medium text-gray-700">Zip codes <span className="text-red-600">*</span></label>
      <p className="mt-0.5 text-xs text-gray-500">Comma or space separated. e.g. <code className="rounded bg-gray-100 px-1">95014, 95129</code></p>
      <input type="text" value={zipsText} onChange={(e) => onChange(e.target.value)} placeholder="95014, 95129, 95130"
        className="mt-2 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500" />
      <div className="mt-1 text-xs text-gray-500">
        {parsedZips.length > 0 ? `${parsedZips.length} valid zip${parsedZips.length === 1 ? "" : "s"}: ${parsedZips.join(", ")}` : "Enter at least one valid 5-digit zip to enable preview"}
      </div>
    </div>
  );
}

function FilterForm({ filters, onPatch, onClear, primaryKeys }: {
  filters: RefiFilters; onPatch: (p: Partial<RefiFilters>) => void; onClear: (k: keyof RefiFilters) => void; primaryKeys: string[];
}) {
  const [showAll, setShowAll] = useState(false);
  const isPrimary = (k: string) => primaryKeys.length === 0 || primaryKeys.includes(k) || showAll;

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm font-medium text-gray-700">Filters</div>
        {primaryKeys.length > 0 && (
          <button type="button" onClick={() => setShowAll((v) => !v)} className="text-xs font-medium text-red-600 hover:text-red-700">
            {showAll ? "Hide advanced filters" : "Show all filters"}
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {isPrimary("property_types") && <ChipMulti label="Property type" options={PROPERTY_TYPE_OPTIONS as unknown as {value:string;label:string}[]} selected={filters.property_types ?? []} onChange={(v) => onPatch({ property_types: v as RefiFilters["property_types"] })} />}
        {isPrimary("owner_occupied") && <TriToggle label="Owner-occupied" value={filters.owner_occupied} onChange={(v) => onPatch({ owner_occupied: v ?? undefined })} labels={{ true: "Owner-occupied only", false: "Non-owner-occupied only", null: "Either" }} />}
        {isPrimary("first_date_range") && <DateRangeField label="First mortgage originated" value={filters.first_date_range ?? {}} onChange={(v) => onPatch({ first_date_range: v })} />}
        {isPrimary("first_rate_min") && <NumberRangeField label="Est. interest rate" suffix="%" min={filters.first_rate_min} max={filters.first_rate_max} onChange={(min, max) => onPatch({ first_rate_min: min, first_rate_max: max })} />}
        {isPrimary("first_rate_type") && <ChipMulti label="Rate type" options={RATE_TYPE_OPTIONS as unknown as {value:string;label:string}[]} selected={filters.first_rate_type ?? []} onChange={(v) => onPatch({ first_rate_type: v as RefiFilters["first_rate_type"] })} />}
        {isPrimary("first_loan_type") && <ChipMulti label="Loan program" options={LOAN_TYPE_OPTIONS as unknown as {value:string;label:string}[]} selected={filters.first_loan_type ?? []} onChange={(v) => onPatch({ first_loan_type: v as RefiFilters["first_loan_type"] })} />}
        {isPrimary("first_purpose") && <ChipMulti label="Loan purpose (at origination)" options={PURPOSE_OPTIONS as unknown as {value:string;label:string}[]} selected={filters.first_purpose ?? []} onChange={(v) => onPatch({ first_purpose: v as RefiFilters["first_purpose"] })} />}
        {isPrimary("available_equity_min") && <NumberRangeField label="Available equity" prefix="$" min={filters.available_equity_min} max={filters.available_equity_max} onChange={(min, max) => onPatch({ available_equity_min: min, available_equity_max: max })} step={10000} />}
        {isPrimary("equity_percent_min") && <NumberRangeField label="Equity percent" suffix="%" min={filters.equity_percent_min} max={filters.equity_percent_max} onChange={(min, max) => onPatch({ equity_percent_min: min, equity_percent_max: max })} />}
        {showAll && <NumberRangeField label="Original loan amount" prefix="$" min={filters.first_amount_min} max={filters.first_amount_max} onChange={(min, max) => onPatch({ first_amount_min: min, first_amount_max: max })} step={50000} />}
        {showAll && <NumberRangeField label="Current value (AVM)" prefix="$" min={filters.avm_min} max={filters.avm_max} onChange={(min, max) => onPatch({ avm_min: min, avm_max: max })} step={50000} />}
        {(isPrimary("last_transfer_date_from") || isPrimary("last_transfer_date_to") || showAll) && (
          <DateRangeField label="Last sale date"
            value={{ from: filters.last_transfer_date_from ?? filters.last_transfer_date_range?.from, to: filters.last_transfer_date_to ?? filters.last_transfer_date_range?.to }}
            onChange={(v) => onPatch({ last_transfer_date_from: v.from, last_transfer_date_to: v.to, last_transfer_date_range: undefined })} />
        )}
        {(isPrimary("first_arm_reset_within_months") || showAll) && (
          <NumberField label="ARM resets within (months)" value={filters.first_arm_reset_within_months}
            onChange={(v) => onPatch({ first_arm_reset_within_months: v })} onClear={() => onClear("first_arm_reset_within_months")} />
        )}
        {showAll && <TriToggle label="Free and clear (no mortgage)" value={filters.is_free_and_clear} onChange={(v) => onPatch({ is_free_and_clear: v ?? undefined })} labels={{ true: "Only free-and-clear", false: "Has a mortgage", null: "Either" }} />}
        {showAll && <TriToggle label="Exclude distressed (foreclosure/bankruptcy)" value={filters.exclude_distressed} onChange={(v) => onPatch({ exclude_distressed: v ?? undefined })} labels={{ true: "Exclude distressed", false: "Include all", null: "Default" }} />}
      </div>
    </div>
  );
}

// ─── Form widgets ───────────────────────────────────────────────────────────

function ChipMulti({ label, options, selected, onChange }: { label: string; options: { value: string; label: string }[]; selected: string[]; onChange: (v: string[]) => void }) {
  function toggle(v: string) { if (selected.includes(v)) onChange(selected.filter((x) => x !== v)); else onChange([...selected, v]); }
  return (
    <div>
      <div className="text-xs font-medium text-gray-700">{label}</div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {options.map((o) => {
          const on = selected.includes(o.value);
          return (
            <button key={o.value} type="button" onClick={() => toggle(o.value)}
              className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${on ? "border-red-600 bg-red-50 text-red-700" : "border-gray-200 bg-white text-gray-700 hover:bg-gray-50"}`}>
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function TriToggle({ label, value, onChange, labels }: { label: string; value: boolean | undefined; onChange: (v: boolean | null) => void; labels: { true: string; false: string; null: string } }) {
  return (
    <div>
      <div className="text-xs font-medium text-gray-700">{label}</div>
      <div className="mt-1.5 inline-flex rounded-lg border border-gray-200 bg-gray-50 p-0.5 text-xs">
        {([[null, labels.null], [true, labels.true], [false, labels.false]] as const).map(([v, lbl]) => {
          const on = value === v;
          return (
            <button key={String(v)} type="button" onClick={() => onChange(v)}
              className={`rounded-md px-2.5 py-1 font-medium transition-colors ${on ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"}`}>
              {lbl}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function NumberField({ label, value, onChange, onClear, prefix, suffix, step = 1 }: { label: string; value?: number; onChange: (v: number | undefined) => void; onClear: () => void; prefix?: string; suffix?: string; step?: number }) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <div className="text-xs font-medium text-gray-700">{label}</div>
        {value != null && <button type="button" onClick={onClear} className="text-[10px] text-gray-400 hover:text-gray-600">clear</button>}
      </div>
      <div className="mt-1 flex items-center gap-1 rounded-lg border border-gray-200 px-2 py-1 focus-within:border-red-500">
        {prefix && <span className="text-xs text-gray-500">{prefix}</span>}
        <input type="number" step={step} value={value ?? ""} onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))} className="w-full bg-transparent text-sm outline-none" />
        {suffix && <span className="text-xs text-gray-500">{suffix}</span>}
      </div>
    </div>
  );
}

function NumberRangeField({ label, min, max, onChange, prefix, suffix, step = 1 }: { label: string; min?: number; max?: number; onChange: (min?: number, max?: number) => void; prefix?: string; suffix?: string; step?: number }) {
  return (
    <div>
      <div className="text-xs font-medium text-gray-700">{label}</div>
      <div className="mt-1 grid grid-cols-2 gap-2">
        <div className="flex items-center gap-1 rounded-lg border border-gray-200 px-2 py-1 focus-within:border-red-500">
          {prefix && <span className="text-xs text-gray-500">{prefix}</span>}
          <input type="number" step={step} placeholder="min" value={min ?? ""} onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value), max)} className="w-full bg-transparent text-sm outline-none" />
          {suffix && <span className="text-xs text-gray-500">{suffix}</span>}
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-gray-200 px-2 py-1 focus-within:border-red-500">
          {prefix && <span className="text-xs text-gray-500">{prefix}</span>}
          <input type="number" step={step} placeholder="max" value={max ?? ""} onChange={(e) => onChange(min, e.target.value === "" ? undefined : Number(e.target.value))} className="w-full bg-transparent text-sm outline-none" />
          {suffix && <span className="text-xs text-gray-500">{suffix}</span>}
        </div>
      </div>
    </div>
  );
}

function DateRangeField({ label, value, onChange }: { label: string; value: { from?: string; to?: string }; onChange: (v: { from?: string; to?: string }) => void }) {
  return (
    <div>
      <div className="text-xs font-medium text-gray-700">{label}</div>
      <div className="mt-1 grid grid-cols-2 gap-2">
        <input type="date" value={value.from ?? ""} onChange={(e) => onChange({ ...value, from: e.target.value || undefined })} className="rounded-lg border border-gray-200 px-2 py-1 text-sm focus:border-red-500 focus:outline-none" />
        <input type="date" value={value.to ?? ""} onChange={(e) => onChange({ ...value, to: e.target.value || undefined })} className="rounded-lg border border-gray-200 px-2 py-1 text-sm focus:border-red-500 focus:outline-none" />
      </div>
    </div>
  );
}

function PreviewActionBar({ phase, preview, loading, canPreview, onPreview, onFetch, onReset }: { phase: Phase; preview: PreviewResp | null; loading: boolean; canPreview: boolean; onPreview: () => void; onFetch: () => void; onReset: () => void }) {
  // Cap the displayed cost at the actual match count — fewer than PAGE_SIZE
  // matches means fewer credits charged.
  const totalMatches = preview?.totalResultCount ?? 0;
  const willCharge = Math.min(25, totalMatches);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-gray-200 bg-white p-4">
      <div className="flex-1">
        {preview ? (
          <div className="text-sm">
            <span className="font-semibold text-gray-900 tabular-nums">{totalMatches.toLocaleString()}</span>
            {totalMatches === 0 ? (
              <span className="text-gray-600"> properties match. Adjust filters to find more.</span>
            ) : willCharge < 25 ? (
              <span className="text-gray-600">
                {totalMatches === 1 ? " property matches" : " properties match"}.
                Fetching {totalMatches === 1 ? "it" : `all ${willCharge}`} will charge{" "}
                <span className="font-semibold tabular-nums text-gray-900">{willCharge}</span>{" "}
                property {willCharge === 1 ? "credit" : "credits"}.
              </span>
            ) : (
              <span className="text-gray-600"> properties match. Fetching the first {willCharge} will charge <span className="font-semibold tabular-nums text-gray-900">{willCharge}</span> property credits.</span>
            )}
          </div>
        ) : (
          <div className="text-sm text-gray-500">Preview is free — it tells you how many properties match before any records are charged.</div>
        )}
      </div>
      <div className="flex items-center gap-2">
        <button type="button" onClick={onReset} className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50">Reset</button>
        <button type="button" onClick={onPreview} disabled={!canPreview || loading} className="rounded-lg border border-gray-300 bg-white px-4 py-1.5 text-sm font-medium text-gray-800 hover:bg-gray-50 disabled:opacity-40">
          {loading && phase !== "results" ? "Previewing…" : "Preview (free)"}
        </button>
        <button type="button" onClick={onFetch} disabled={!preview || loading || (preview.totalResultCount ?? 0) === 0} className="rounded-lg bg-red-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-40">
          {loading && phase === "previewed" ? "Fetching…" : "Fetch results"}
        </button>
      </div>
    </div>
  );
}

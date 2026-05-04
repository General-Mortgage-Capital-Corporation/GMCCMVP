"use client";

import { useEffect, useState } from "react";
import {
  pickRecord,
  type ParsedFilename,
} from "@/lib/rate-sheets/parser";
import type {
  ProgramKey,
  RateSheetRecord,
  RateSheetSnapshot,
} from "@/lib/rate-sheets/types";

/**
 * Map of display program name → canonical program key. Only programs that
 * the SharePoint scraper can match are listed; everything else falls back
 * to the hardcoded `PROGRAM_CONFIG.ratesheetUrl` in FlierButton.
 */
const DISPLAY_NAME_TO_PROGRAM_KEY: Record<string, ProgramKey> = {
  "GMCC Thunder": "thunder",
  "GMCC Fabulous Jumbo": "fabulous",
  "GMCC Jubilant": "jubilant",
  "GMCC Hermes": "hermes",
  "GMCC Ocean": "ocean",
  "GMCC Universe": "universe",
  "GMCC Radiant": "radiant",
};

const STORAGE_KEY = "gmcc_rate_sheets_v1";
const STORAGE_TTL_MS = 60 * 60 * 1000; // 1 hour

interface CachedSnapshot {
  fetched_at: number;
  snapshot: RateSheetSnapshot;
}

function loadFromStorage(): CachedSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedSnapshot;
    if (!parsed?.snapshot || !parsed.fetched_at) return null;
    if (Date.now() - parsed.fetched_at > STORAGE_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveToStorage(snapshot: RateSheetSnapshot) {
  if (typeof window === "undefined") return;
  try {
    const payload: CachedSnapshot = { fetched_at: Date.now(), snapshot };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* quota / disabled — ignore */
  }
}

/**
 * Hook that fetches the current rate-sheet snapshot from the server and
 * caches it in localStorage. Returns the snapshot (or null if unavailable
 * yet) plus a resolver function that picks the best record for a program +
 * state.
 *
 * Usage:
 *   const { resolveUrl } = useRateSheets();
 *   const url = resolveUrl("GMCC Thunder", "CA");
 *   if (url) // use it
 *
 * The resolver returns null when:
 *   - No live snapshot is available yet
 *   - The program isn't in our scraper's list (hardcoded names only)
 *   - The scraper hasn't found any rate sheet for the program
 *
 * Callers should fall back to PROGRAM_CONFIG.ratesheetUrl when null.
 */
export function useRateSheets() {
  const [snapshot, setSnapshot] = useState<RateSheetSnapshot | null>(
    () => loadFromStorage()?.snapshot ?? null,
  );

  useEffect(() => {
    let cancelled = false;
    const cached = loadFromStorage();
    if (cached) {
      // Have fresh local cache; skip fetch.
      return;
    }
    fetch("/api/rate-sheets")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { ok: boolean; snapshot?: RateSheetSnapshot } | null) => {
        if (cancelled || !data?.ok || !data.snapshot) return;
        setSnapshot(data.snapshot);
        saveToStorage(data.snapshot);
      })
      .catch(() => {
        /* network failure — caller will fall back to hardcoded */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Resolve a display program name + optional state to a fresh URL, or null. */
  function resolveUrl(programName: string, state?: string): string | null {
    if (!snapshot) return null;
    const key = DISPLAY_NAME_TO_PROGRAM_KEY[programName];
    if (!key) return null;
    const records = snapshot.programs[key];
    if (!records || records.length === 0) return null;
    const picked = pickRecord(records, { state });
    return picked?.url ?? null;
  }

  /** Get the underlying record for richer UI (date, variant, etc.), or null. */
  function resolveRecord(
    programName: string,
    state?: string,
  ): RateSheetRecord | null {
    if (!snapshot) return null;
    const key = DISPLAY_NAME_TO_PROGRAM_KEY[programName];
    if (!key) return null;
    const records = snapshot.programs[key];
    if (!records || records.length === 0) return null;
    return pickRecord(records, { state });
  }

  return {
    snapshot,
    /** Unix ms when the snapshot was last synced from SharePoint. */
    syncedAt: snapshot?.synced_at ?? null,
    resolveUrl,
    resolveRecord,
  };
}

/** Re-export for callers that want to do their own picking. */
export type { ParsedFilename, RateSheetRecord, RateSheetSnapshot };

/**
 * Rate-sheet sync orchestrator.
 *
 * For each configured SharePoint folder:
 *   1. List files via Graph API.
 *   2. Parse each filename → structured record (program/states/variant/date).
 *   3. Generate a stable org-scoped view link via createLink.
 *
 * Aggregates everything into a single RateSheetSnapshot ready to write to
 * Redis. Failure on a single folder doesn't fail the whole sync.
 */

import { buildRecord, groupByProgram } from "./parser";
import { listSharedFolderChildren, createOrgViewLink } from "./sharepoint";
import type { ProgramKey, RateSheetRecord, RateSheetSnapshot } from "./types";

/**
 * SharePoint folders we scrape. Listed in user-supplied order; both belong to
 * the LOTraining site. To add new folders later, append here.
 */
export const RATE_SHEET_FOLDERS: { label: string; url: string }[] = [
  {
    label: "QM (Thunder, Fabulous, Jubilant)",
    url: "https://netorgft1191593.sharepoint.com/:f:/r/sites/LOTraining/Shared%20Documents/GMCC%20Portfolio%20Ratesheet/GMCC%20Special%20Programs/QM",
  },
  {
    label: "Non-QM (Hermes, Ocean, Universe, Radiant)",
    url: "https://netorgft1191593.sharepoint.com/:f:/r/sites/LOTraining/Shared%20Documents/GMCC%20Portfolio%20Ratesheet/GMCC%20Special%20Programs/Non-QM",
  },
];

const ALL_PROGRAMS: ProgramKey[] = [
  "thunder", "fabulous", "jubilant", "hermes", "ocean", "universe", "radiant",
];

export interface SyncResult {
  ok: boolean;
  snapshot?: RateSheetSnapshot;
  /** Per-folder error messages so we can surface partial failures. */
  errors: { folder: string; error: string }[];
}

export async function syncRateSheets(): Promise<SyncResult> {
  const errors: SyncResult["errors"] = [];
  const records: RateSheetRecord[] = [];
  const unmatched: { filename: string; url: string }[] = [];

  for (const folder of RATE_SHEET_FOLDERS) {
    const list = await listSharedFolderChildren(folder.url);
    if (!list.ok || !list.items) {
      errors.push({ folder: folder.label, error: list.error ?? "unknown" });
      continue;
    }

    // Resolve sharing links in parallel — each createLink call is ~200-400ms.
    // Cap concurrency to 8 to avoid hammering Graph.
    const items = list.items;
    const linkResults: string[] = new Array(items.length);
    const queue = items.map((item, i) => ({ item, i }));
    const concurrency = 8;
    await Promise.all(
      Array.from({ length: concurrency }).map(async () => {
        for (;;) {
          const next = queue.shift();
          if (!next) return;
          linkResults[next.i] = await createOrgViewLink(next.item);
        }
      }),
    );

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const url = linkResults[i] ?? item.webUrl;
      const record = buildRecord(item.name, url);
      if (record) {
        records.push(record);
      } else {
        unmatched.push({ filename: item.name, url });
      }
    }
  }

  const programs = groupByProgram(records);
  const missing_programs = ALL_PROGRAMS.filter((k) => programs[k].length === 0);

  const snapshot: RateSheetSnapshot = {
    synced_at: Date.now(),
    programs,
    unmatched,
    missing_programs,
  };

  return {
    ok: errors.length === 0,
    snapshot,
    errors,
  };
}

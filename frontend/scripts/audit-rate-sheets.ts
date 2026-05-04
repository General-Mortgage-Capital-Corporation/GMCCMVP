/**
 * One-off: list both SharePoint rate-sheet folders, parse what's there,
 * compare against the URLs hardcoded in FlierButton.tsx today.
 *
 * Run:   npx tsx --env-file=.env.local scripts/audit-rate-sheets.ts
 *
 * Output:
 *   - Per-folder file listing with parsed fields.
 *   - "STALE" flag for any program where the live filename differs from
 *     what's hardcoded (so we know if Universe/Fabulous are actually broken).
 *   - "UNMATCHED" list for filenames our parser doesn't recognize.
 */

import {
  listSharedFolderChildren,
  type DriveItem,
} from "@/lib/rate-sheets/sharepoint";
import { parseFilename } from "@/lib/rate-sheets/parser";
import { RATE_SHEET_FOLDERS } from "@/lib/rate-sheets/sync";

// Hardcoded filenames currently embedded in FlierButton.tsx PROGRAM_CONFIG.
// Derived from the existing URLs (the path segment after the last /).
const HARDCODED: Record<string, string> = {
  Universe: "GMCC Universe 4-20-2026 Omicron.pdf",
  Fabulous: "GMCC Fabulous Rate Sheet 4.14.2026.xlsx",
  Jubilant: "GMCC Jubilant Rate Sheet 4.14.2026.xlsx",
  "Thunder CA": "GMCC Thunder Rate Sheet CA 4.13.2026.pdf",
  "Thunder ID": "GMCC Thunder Rate Sheet ID 4.13.2026.pdf",
  "Thunder TX": "GMCC Thunder Rate Sheet TX 4.13.2026.pdf",
  "Thunder WA": "GMCC Thunder Rate Sheet WA 4.13.2026.pdf",
  "Hermes CA": "GMCC Hermes Rate Sheet 3.30.2026 - CA.pdf",
  "Hermes default":
    "GMCC Hermes Rate Sheet 3.30.2026 CO, DC, GA, IL, NJ, NY, NV, TX, VA, WA, AZ.pdf",
  Ocean: "GMCC Ocean Rate Sheet 2.3.2026.pdf",
  Radiant: "GMCC Radiant Rate Sheet 2.10.2026.pdf",
};

async function main() {
  for (const folder of RATE_SHEET_FOLDERS) {
    console.log(`\n========== ${folder.label} ==========`);
    console.log(folder.url);
    const res = await listSharedFolderChildren(folder.url);
    if (!res.ok || !res.items) {
      console.error("  ❌ List failed:", res.error);
      continue;
    }
    console.log(`  ${res.items.length} files\n`);
    for (const item of res.items) {
      const parsed = parseFilename(item.name);
      const tag = parsed.program ? `[${parsed.program}]` : "[??]";
      const states = parsed.states.length ? parsed.states.join(",") : "any";
      const variant = parsed.variant ?? "(base)";
      const date = parsed.date ?? "??";
      console.log(`  ${tag.padEnd(12)} ${date.padEnd(11)} ${states.padEnd(20)} ${variant.padEnd(20)} ${item.name}`);
    }
  }

  // Cross-check: which hardcoded filenames are still present in SharePoint?
  console.log("\n========== STALENESS CHECK ==========\n");

  // Build a flat set of all live filenames across both folders.
  const liveFilenames = new Set<string>();
  for (const folder of RATE_SHEET_FOLDERS) {
    const res = await listSharedFolderChildren(folder.url);
    if (res.ok && res.items) {
      for (const item of res.items) liveFilenames.add(item.name);
    }
  }

  let staleCount = 0;
  let freshCount = 0;
  for (const [label, hardcodedName] of Object.entries(HARDCODED)) {
    const stillThere = liveFilenames.has(hardcodedName);
    if (stillThere) {
      console.log(`  ✅ ${label.padEnd(20)} present:    ${hardcodedName}`);
      freshCount++;
    } else {
      console.log(`  ❌ ${label.padEnd(20)} STALE:      ${hardcodedName}`);
      staleCount++;
    }
  }
  console.log(`\n  ${freshCount} fresh, ${staleCount} stale`);

  // Show unmatched live files
  console.log("\n========== UNMATCHED FILES (our parser couldn't classify) ==========\n");
  let unmatched = 0;
  for (const filename of liveFilenames) {
    const parsed = parseFilename(filename);
    if (!parsed.program) {
      console.log(`  ${filename}`);
      unmatched++;
    }
  }
  if (unmatched === 0) console.log("  (none)");
}

main().catch((err) => {
  console.error("Audit failed:", err);
  process.exit(1);
});

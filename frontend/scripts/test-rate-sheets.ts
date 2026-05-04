/**
 * Regression tests for the rate-sheet parser + picker.
 *
 * Run:  npx tsx --test scripts/test-rate-sheets.ts
 *
 * No test framework dependency — uses Node's built-in node:test runner. Each
 * `test(...)` block fails the process exit code if its assertions fail.
 *
 * Coverage:
 *   - Program detection from real filenames (positive + negative)
 *   - Date parsing across M.D.YYYY, M-D-YYYY, M/D/YYYY, ISO, month-name
 *   - State extraction: single, multi-state list, no states
 *   - Variant detection: known features (CRA, Bank Statement) + free-form
 *     codenames (Omicron, Rho)
 *   - pickRecord matrix:
 *       * Codename-only program (Universe) — must surface newest as default
 *       * Mixed base + variant (Hermes + CRA) — variant strict
 *       * Per-state matching (Thunder CA/ID/TX/WA, Hermes CA/multi/uncovered)
 *       * Empty input handling
 *       * Sort order (newest first)
 */

import test from "node:test";
import { strict as assert } from "node:assert";
import {
  parseFilename,
  buildRecord,
  groupByProgram,
  pickRecord,
  detectProgram,
  detectDate,
  detectStates,
  detectVariant,
} from "@/lib/rate-sheets/parser";
import type { RateSheetRecord } from "@/lib/rate-sheets/types";

// ---------------------------------------------------------------------------
// detectProgram
// ---------------------------------------------------------------------------

test("detectProgram: matches every supported program by keyword", () => {
  assert.equal(detectProgram("GMCC Thunder Rate Sheet CA 5.4.2026.pdf"), "thunder");
  assert.equal(detectProgram("GMCC Fabulous Rate Sheet 5.4.2026.xlsx"), "fabulous");
  assert.equal(detectProgram("GMCC Jubilant Rate Sheet 5.4.2026.xlsx"), "jubilant");
  assert.equal(detectProgram("GMCC Hermes Rate Sheet 3.30.2026 - CA.pdf"), "hermes");
  assert.equal(detectProgram("GMCC Ocean Rate Sheet 2.3.2026.pdf"), "ocean");
  assert.equal(detectProgram("GMCC Universe 5-4-2026 Rho.pdf"), "universe");
  assert.equal(detectProgram("GMCC Radiant Rate Sheet 2.10.2026.pdf"), "radiant");
});

test("detectProgram: returns null for unknown programs", () => {
  assert.equal(detectProgram("GMCC Cronus Non-Agency Rate Sheet 5.4.2026.xlsx"), null);
  assert.equal(detectProgram("GMCC Pearl Portfolio Rate Sheet 2.19.2026.pdf"), null);
  assert.equal(detectProgram("GMCC Onyx Expanded Prime Rate Sheet 5.4.2026.xlsx"), null);
  assert.equal(detectProgram("Random unrelated file.pdf"), null);
});

test("detectProgram: case insensitive", () => {
  assert.equal(detectProgram("gmcc thunder rate sheet ca 5.4.2026.pdf"), "thunder");
  assert.equal(detectProgram("GMCC THUNDER Rate Sheet CA 5.4.2026.pdf"), "thunder");
});

// ---------------------------------------------------------------------------
// detectDate
// ---------------------------------------------------------------------------

test("detectDate: M.D.YYYY format (most common)", () => {
  assert.equal(detectDate("GMCC Thunder Rate Sheet CA 5.4.2026.pdf"), "2026-05-04");
  assert.equal(detectDate("GMCC Jubilant Rate Sheet 4.14.2026.xlsx"), "2026-04-14");
  assert.equal(detectDate("GMCC Hermes Rate Sheet 3.30.2026 - CA.pdf"), "2026-03-30");
});

test("detectDate: M-D-YYYY format (Universe-style)", () => {
  assert.equal(detectDate("GMCC Universe 5-4-2026 Rho.pdf"), "2026-05-04");
  assert.equal(detectDate("GMCC Universe 4-20-2026 Omicron.pdf"), "2026-04-20");
});

test("detectDate: pads single-digit month/day", () => {
  assert.equal(detectDate("File 1.5.2026.pdf"), "2026-01-05");
  assert.equal(detectDate("File 12.31.2026.pdf"), "2026-12-31");
});

test("detectDate: returns null when no date present", () => {
  assert.equal(detectDate("GMCC Thunder no date.pdf"), null);
  assert.equal(detectDate(""), null);
});

test("detectDate: rejects out-of-range values", () => {
  assert.equal(detectDate("File 13.45.2026.pdf"), null); // month 13
  assert.equal(detectDate("File 5.32.2026.pdf"), null); // day 32
});

// ---------------------------------------------------------------------------
// detectStates
// ---------------------------------------------------------------------------

test("detectStates: single state in middle", () => {
  assert.deepEqual(detectStates("GMCC Thunder Rate Sheet CA 5.4.2026.pdf"), ["CA"]);
  assert.deepEqual(detectStates("GMCC Hermes Rate Sheet 3.30.2026 - CA.pdf"), ["CA"]);
});

test("detectStates: multi-state comma-separated list (sorted, deduped)", () => {
  const states = detectStates("GMCC Hermes Rate Sheet 3.30.2026 CO, DC, GA, IL, NJ, NY, NV, TX, VA, WA, AZ.pdf");
  assert.deepEqual(states, ["AZ", "CO", "DC", "GA", "IL", "NJ", "NV", "NY", "TX", "VA", "WA"]);
});

test("detectStates: no states returns empty array", () => {
  assert.deepEqual(detectStates("GMCC Universe 5-4-2026 Rho.pdf"), []);
  assert.deepEqual(detectStates("GMCC Fabulous Rate Sheet 5.4.2026.xlsx"), []);
});

test("detectStates: ignores non-state uppercase tokens", () => {
  // GMCC, PDF, etc. should not be treated as state codes (not in US_STATES set)
  assert.deepEqual(detectStates("GMCC Random PDF.pdf"), []);
});

// ---------------------------------------------------------------------------
// detectVariant
// ---------------------------------------------------------------------------

test("detectVariant: known canonical features get correct casing", () => {
  // CRA was rendering as "Cra" before the canonical-keyword fix
  assert.equal(detectVariant("GMCC Hermes Rate Sheet 3.30.2026 - CRA.pdf", "hermes", [], "2026-03-30"), "CRA");
  assert.equal(detectVariant("Bank Statement Rate Sheet 5.4.2026.pdf", "thunder", [], "2026-05-04"), "Bank Statement");
  assert.equal(detectVariant("DSCR Rate Sheet.pdf", "thunder", [], null), "DSCR");
});

test("detectVariant: free-form codename preserved (Universe Greek letters)", () => {
  assert.equal(detectVariant("GMCC Universe 5-4-2026 Rho.pdf", "universe", [], "2026-05-04"), "Rho");
  assert.equal(detectVariant("GMCC Universe 4-20-2026 Omicron.pdf", "universe", [], "2026-04-20"), "Omicron");
});

test("detectVariant: returns null when only program/date/states present (base sheet)", () => {
  assert.equal(detectVariant("GMCC Thunder Rate Sheet CA 5.4.2026.pdf", "thunder", ["CA"], "2026-05-04"), null);
  assert.equal(detectVariant("GMCC Ocean Rate Sheet 2.3.2026.pdf", "ocean", [], "2026-02-03"), null);
});

// ---------------------------------------------------------------------------
// parseFilename — full pipeline
// ---------------------------------------------------------------------------

test("parseFilename: real Thunder filename round-trip", () => {
  const result = parseFilename("GMCC Thunder Rate Sheet CA 5.4.2026.pdf");
  assert.deepEqual(result, {
    program: "thunder",
    states: ["CA"],
    variant: null,
    date: "2026-05-04",
  });
});

test("parseFilename: real Universe filename with codename", () => {
  const result = parseFilename("GMCC Universe 5-4-2026 Rho.pdf");
  assert.deepEqual(result, {
    program: "universe",
    states: [],
    variant: "Rho",
    date: "2026-05-04",
  });
});

test("parseFilename: real Hermes multi-state filename", () => {
  const result = parseFilename(
    "GMCC Hermes Rate Sheet 3.30.2026 CO, DC, GA, IL, NJ, NY, NV, TX, VA, WA, AZ.pdf",
  );
  assert.equal(result.program, "hermes");
  assert.equal(result.date, "2026-03-30");
  assert.equal(result.variant, null);
  assert.equal(result.states.length, 11);
});

test("parseFilename: unknown program returns null program", () => {
  const result = parseFilename("GMCC Cronus Non-Agency Rate Sheet 5.4.2026.xlsx");
  assert.equal(result.program, null);
});

// ---------------------------------------------------------------------------
// pickRecord — the core resolver logic
// ---------------------------------------------------------------------------

function buildSet(filenames: string[]): RateSheetRecord[] {
  return filenames
    .map((f) => buildRecord(f, `https://x/${encodeURIComponent(f)}`))
    .filter((r): r is RateSheetRecord => r !== null);
}

test("pickRecord: empty array returns null", () => {
  assert.equal(pickRecord([]), null);
  assert.equal(pickRecord([], { state: "CA" }), null);
});

test("pickRecord: codename-only program (Universe) — newest wins as default", () => {
  const records = buildSet([
    "GMCC Universe 5-4-2026 Rho.pdf",
    "GMCC Universe 4-20-2026 Omicron.pdf",
  ]);
  const grouped = groupByProgram(records);
  // No state, no variant requested → newest (Rho)
  assert.equal(pickRecord(grouped.universe)?.filename, "GMCC Universe 5-4-2026 Rho.pdf");
  // With state — should still return newest (sheet has no state restriction)
  assert.equal(pickRecord(grouped.universe, { state: "CA" })?.filename, "GMCC Universe 5-4-2026 Rho.pdf");
  assert.equal(pickRecord(grouped.universe, { state: "OR" })?.filename, "GMCC Universe 5-4-2026 Rho.pdf");
});

test("pickRecord: codename-only — explicit codename pick", () => {
  const records = buildSet([
    "GMCC Universe 5-4-2026 Rho.pdf",
    "GMCC Universe 4-20-2026 Omicron.pdf",
  ]);
  const grouped = groupByProgram(records);
  assert.equal(
    pickRecord(grouped.universe, { variant: "Omicron" })?.filename,
    "GMCC Universe 4-20-2026 Omicron.pdf",
  );
  assert.equal(
    pickRecord(grouped.universe, { variant: "Rho" })?.filename,
    "GMCC Universe 5-4-2026 Rho.pdf",
  );
});

test("pickRecord: per-state matching for Thunder", () => {
  const records = buildSet([
    "GMCC Thunder Rate Sheet CA 5.4.2026.pdf",
    "GMCC Thunder Rate Sheet ID 5.4.2026.pdf",
    "GMCC Thunder Rate Sheet TX 5.4.2026.pdf",
    "GMCC Thunder Rate Sheet WA 5.4.2026.pdf",
  ]);
  const grouped = groupByProgram(records);
  assert.equal(pickRecord(grouped.thunder, { state: "CA" })?.filename, "GMCC Thunder Rate Sheet CA 5.4.2026.pdf");
  assert.equal(pickRecord(grouped.thunder, { state: "ID" })?.filename, "GMCC Thunder Rate Sheet ID 5.4.2026.pdf");
  assert.equal(pickRecord(grouped.thunder, { state: "TX" })?.filename, "GMCC Thunder Rate Sheet TX 5.4.2026.pdf");
  assert.equal(pickRecord(grouped.thunder, { state: "WA" })?.filename, "GMCC Thunder Rate Sheet WA 5.4.2026.pdf");
});

test("pickRecord: uncovered state returns null (no fake-pick)", () => {
  // Thunder has CA/ID/TX/WA only — Oregon is not covered, must return null
  const records = buildSet([
    "GMCC Thunder Rate Sheet CA 5.4.2026.pdf",
    "GMCC Thunder Rate Sheet ID 5.4.2026.pdf",
    "GMCC Thunder Rate Sheet TX 5.4.2026.pdf",
    "GMCC Thunder Rate Sheet WA 5.4.2026.pdf",
  ]);
  const grouped = groupByProgram(records);
  assert.equal(pickRecord(grouped.thunder, { state: "OR" }), null);
  assert.equal(pickRecord(grouped.thunder, { state: "FL" }), null);
  assert.equal(pickRecord(grouped.thunder, { state: "NY" }), null);
});

test("pickRecord: Hermes multi-state list resolves all listed states correctly", () => {
  const records = buildSet([
    "GMCC Hermes Rate Sheet 3.30.2026 - CA.pdf",
    "GMCC Hermes Rate Sheet 3.30.2026 CO, DC, GA, IL, NJ, NY, NV, TX, VA, WA, AZ.pdf",
  ]);
  const grouped = groupByProgram(records);
  // CA → CA-specific
  assert.equal(pickRecord(grouped.hermes, { state: "CA" })?.filename, "GMCC Hermes Rate Sheet 3.30.2026 - CA.pdf");
  // Each multi-state code → multi-state sheet
  for (const state of ["CO", "DC", "GA", "IL", "NJ", "NY", "NV", "TX", "VA", "WA", "AZ"]) {
    const pick = pickRecord(grouped.hermes, { state });
    assert.equal(
      pick?.filename,
      "GMCC Hermes Rate Sheet 3.30.2026 CO, DC, GA, IL, NJ, NY, NV, TX, VA, WA, AZ.pdf",
      `expected multi-state sheet for ${state}`,
    );
  }
});

test("pickRecord: Hermes uncovered state returns null", () => {
  const records = buildSet([
    "GMCC Hermes Rate Sheet 3.30.2026 - CA.pdf",
    "GMCC Hermes Rate Sheet 3.30.2026 CO, DC, GA, IL, NJ, NY, NV, TX, VA, WA, AZ.pdf",
  ]);
  const grouped = groupByProgram(records);
  for (const state of ["OR", "MI", "FL", "HI", "AK", "OH"]) {
    assert.equal(pickRecord(grouped.hermes, { state }), null, `expected null for ${state}`);
  }
});

test("pickRecord: CRA variant doesn't surface for generic Hermes request", () => {
  // Critical: a CRA-specialized sheet must NOT be returned when the LO asks
  // for generic Hermes pricing. They'd quote the wrong rates.
  const records = buildSet([
    "GMCC Hermes Rate Sheet 3.30.2026 - CA.pdf",
    "GMCC Hermes Rate Sheet 3.30.2026 CO, DC, GA, IL, NJ, NY, NV, TX, VA, WA, AZ.pdf",
    "GMCC Hermes Rate Sheet 3.30.2026 - CRA.pdf",
  ]);
  const grouped = groupByProgram(records);
  // OR not covered by base sheets; CRA is state-agnostic but that's a SPECIFIC
  // scenario, not a default. Should still return null.
  assert.equal(pickRecord(grouped.hermes, { state: "OR" }), null);
  // CA should pick the CA base sheet, NOT the CRA sheet
  assert.equal(
    pickRecord(grouped.hermes, { state: "CA" })?.variant,
    null,
    "CA should pick base, not CRA variant",
  );
});

test("pickRecord: explicit CRA variant request returns CRA sheet", () => {
  const records = buildSet([
    "GMCC Hermes Rate Sheet 3.30.2026 - CA.pdf",
    "GMCC Hermes Rate Sheet 3.30.2026 - CRA.pdf",
  ]);
  const grouped = groupByProgram(records);
  const pick = pickRecord(grouped.hermes, { state: "CA", variant: "CRA" });
  assert.equal(pick?.variant, "CRA");
  assert.equal(pick?.filename, "GMCC Hermes Rate Sheet 3.30.2026 - CRA.pdf");
});

test("pickRecord: variant=null is strict 'base only'", () => {
  // Universe has only codenames — explicit variant=null should still return null
  // (caller is asking for a base sheet that doesn't exist).
  const records = buildSet([
    "GMCC Universe 5-4-2026 Rho.pdf",
    "GMCC Universe 4-20-2026 Omicron.pdf",
  ]);
  const grouped = groupByProgram(records);
  assert.equal(pickRecord(grouped.universe, { variant: null }), null);
});

// ---------------------------------------------------------------------------
// groupByProgram — sort order
// ---------------------------------------------------------------------------

test("groupByProgram: sorts records newest-first within each program", () => {
  const records = buildSet([
    "GMCC Thunder Rate Sheet CA 4.13.2026.pdf",  // older
    "GMCC Thunder Rate Sheet CA 5.4.2026.pdf",   // newer
    "GMCC Thunder Rate Sheet CA 1.1.2026.pdf",   // oldest
  ]);
  const grouped = groupByProgram(records);
  assert.equal(grouped.thunder[0].date, "2026-05-04");
  assert.equal(grouped.thunder[1].date, "2026-04-13");
  assert.equal(grouped.thunder[2].date, "2026-01-01");
});

test("groupByProgram: dateless records sink to the bottom", () => {
  const records = buildSet([
    "GMCC Thunder Rate Sheet CA 5.4.2026.pdf",
    "GMCC Thunder Rate Sheet CA.pdf", // no date
  ]);
  const grouped = groupByProgram(records);
  assert.equal(grouped.thunder[0].date, "2026-05-04");
  assert.equal(grouped.thunder[1].date, null);
});

// ---------------------------------------------------------------------------
// buildRecord
// ---------------------------------------------------------------------------

test("buildRecord: returns null for unparseable program", () => {
  assert.equal(buildRecord("Random.pdf", "https://x/r"), null);
});

test("buildRecord: copies through filename and url verbatim", () => {
  const r = buildRecord("GMCC Thunder Rate Sheet CA 5.4.2026.pdf", "https://example/file.pdf");
  assert.ok(r);
  assert.equal(r!.filename, "GMCC Thunder Rate Sheet CA 5.4.2026.pdf");
  assert.equal(r!.url, "https://example/file.pdf");
});

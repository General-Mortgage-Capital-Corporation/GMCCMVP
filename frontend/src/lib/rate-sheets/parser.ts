/**
 * Parse a SharePoint rate-sheet filename into a structured record.
 *
 * The matching is intentionally tolerant — file names drift and we'd rather
 * extract partial info than fail outright. Each program is identified
 * positively against a known list; unknown programs are skipped.
 *
 * Sample inputs handled (verified against current SharePoint folder):
 *
 *   "GMCC Thunder Rate Sheet CA 4.13.2026.pdf"
 *     → { program: "thunder", states: ["CA"],     variant: null,            date: "2026-04-13" }
 *
 *   "GMCC Hermes Rate Sheet 3.30.2026 - CA.pdf"
 *     → { program: "hermes",  states: ["CA"],     variant: null,            date: "2026-03-30" }
 *
 *   "GMCC Hermes Rate Sheet 3.30.2026 CO, DC, GA, IL, NJ, NY, NV, TX, VA, WA, AZ.pdf"
 *     → { program: "hermes",  states: [11 codes], variant: null,            date: "2026-03-30" }
 *
 *   "GMCC Universe 4-20-2026 Omicron.pdf"
 *     → { program: "universe", states: [],        variant: "Omicron",       date: "2026-04-20" }
 *
 *   "GMCC Fabulous Rate Sheet 4.14.2026.xlsx"
 *     → { program: "fabulous", states: [],        variant: null,            date: "2026-04-14" }
 *
 *   "GMCC Thunder Rate Sheet CA Bank Statement 4.13.2026.pdf"
 *     → { program: "thunder", states: ["CA"],     variant: "Bank Statement", date: "2026-04-13" }
 */

import type { ProgramKey, RateSheetRecord } from "./types";

const PROGRAM_KEYWORDS: { key: ProgramKey; pattern: RegExp }[] = [
  { key: "thunder",  pattern: /\bthunder\b/i },
  { key: "fabulous", pattern: /\bfabulous\b/i },
  { key: "jubilant", pattern: /\bjubilant\b/i },
  { key: "hermes",   pattern: /\bhermes\b/i },
  { key: "ocean",    pattern: /\bocean\b/i },
  { key: "universe", pattern: /\buniverse\b/i },
  { key: "radiant",  pattern: /\bradiant\b/i },
];

// Two-letter US state + DC + territories. Matches what SharePoint filenames use.
const US_STATES = new Set<string>([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
  "DC", "PR", "VI", "GU", "MP", "AS",
]);

// Words to strip when looking for "leftover = variant" — these are noise.
const NOISE_TOKENS = new Set<string>([
  "GMCC", "RATE", "SHEET", "RATESHEET", "PROGRAM", "PROGRAMS",
  "AND", "OR", "THE", "A", "AN",
]);

// Known feature/variant keywords. We capture these explicitly so we can use
// canonical casing (e.g. "Bank Statement" instead of "BANK STATEMENT", "CRA"
// instead of "Cra"). Any other unrecognized leftover is still kept as a
// free-form variant string.
const VARIANT_KEYWORDS: { canonical: string; pattern: RegExp }[] = [
  { canonical: "Bank Statement",   pattern: /\bbank\s*statements?\b/i },
  { canonical: "DSCR",             pattern: /\bdscr\b/i },
  { canonical: "CRA",              pattern: /\bcra\b/i },
  { canonical: "Investor",         pattern: /\binvestor\b/i },
  { canonical: "Foreign National", pattern: /\bforeign\s+national\b/i },
  { canonical: "P&L",              pattern: /\bp\s*&\s*l\b|\bpnl\b/i },
  { canonical: "Asset Depletion",  pattern: /\basset\s+depletion\b/i },
  { canonical: "WVOE",             pattern: /\bwvoe\b/i },
  { canonical: "SVOE",             pattern: /\bsvoe\b/i },
  { canonical: "Interest Only",    pattern: /\binterest\s*only\b|\bio\b/i },
  { canonical: "ITIN",             pattern: /\bitin\b/i },
  { canonical: "1099",             pattern: /\b1099\b/i },
];

const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/** Strip extension, normalize separators to spaces, trim. */
function normalizeFilename(filename: string): string {
  return filename
    .replace(/\.(pdf|xlsx?|docx?)$/i, "")
    .replace(/[_]+/g, " ")
    .trim();
}

/** Detect the canonical program key from a filename. Returns null if unknown. */
export function detectProgram(filename: string): ProgramKey | null {
  for (const { key, pattern } of PROGRAM_KEYWORDS) {
    if (pattern.test(filename)) return key;
  }
  return null;
}

/**
 * Parse a date from a filename. Supports:
 *   - "4.13.2026", "4-13-2026", "4/13/2026" → 2026-04-13
 *   - "April 13 2026", "Apr 13 2026" (month names)
 *   - "2026-04-13" (already ISO)
 * Returns null if no recognizable date.
 */
export function detectDate(filename: string): string | null {
  // ISO first (least ambiguous)
  const iso = filename.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) {
    const [, y, m, d] = iso;
    return formatIso(Number(y), Number(m), Number(d));
  }

  // M.D.YYYY or M-D-YYYY or M/D/YYYY
  const numeric = filename.match(/\b(\d{1,2})[.\-/](\d{1,2})[.\-/](20\d{2})\b/);
  if (numeric) {
    const [, m, d, y] = numeric;
    return formatIso(Number(y), Number(m), Number(d));
  }

  // Month name pattern: "April 13 2026", "Apr 13, 2026"
  for (let i = 0; i < MONTH_NAMES.length; i++) {
    const monthFull = MONTH_NAMES[i];
    const monthAbbr = monthFull.slice(0, 3);
    const re = new RegExp(`\\b(${monthFull}|${monthAbbr})\\s+(\\d{1,2})[,\\s]+(20\\d{2})\\b`, "i");
    const m = filename.match(re);
    if (m) {
      return formatIso(Number(m[3]), i + 1, Number(m[2]));
    }
  }
  return null;
}

function formatIso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Detect US state codes in a filename. Handles single-state ("CA"),
 * comma-separated lists ("CO, DC, GA, IL"), or no state at all.
 *
 * Returns deduped, uppercased state codes. Empty array means "any state".
 */
export function detectStates(filename: string): string[] {
  const found = new Set<string>();
  // Match standalone 2-letter uppercase tokens — must be word-bounded so we
  // don't catch things like "CA" inside "CASE" or "OR" inside "OREGON".
  const tokenRe = /\b[A-Z]{2}\b/g;
  for (const match of filename.matchAll(tokenRe)) {
    const code = match[0];
    if (US_STATES.has(code)) found.add(code);
  }
  return Array.from(found).sort();
}

/**
 * Extract the variant/feature label, if any.
 *
 * Strategy:
 *   1. Check for known feature keywords — return canonical name.
 *   2. Strip program name, "rate sheet", date, state codes, and noise words.
 *   3. If a meaningful leftover token remains (3+ chars, not a number),
 *      return it as the variant. This catches things like "Omicron" code names.
 *   4. Otherwise null.
 */
export function detectVariant(
  filename: string,
  program: ProgramKey,
  states: string[],
  date: string | null,
): string | null {
  // Strip extension defensively so callers don't have to pre-normalize.
  // parseFilename already normalizes before calling us, but exporting this
  // function means external callers (and tests) might pass raw filenames.
  const cleaned = filename.replace(/\.(pdf|xlsx?|docx?)$/i, "");

  // Known features first — they take priority.
  for (const { canonical, pattern } of VARIANT_KEYWORDS) {
    if (pattern.test(cleaned)) return canonical;
  }

  // Otherwise, strip everything we recognize and see what's left.
  let residue = cleaned;
  // Strip program name (case-insensitive)
  residue = residue.replace(new RegExp(`\\b${program}\\b`, "i"), " ");
  // Strip "rate sheet", "rate", "sheet"
  residue = residue.replace(/\brate\s*sheets?\b/gi, " ");
  // Strip dates (numeric forms; ISO; month names)
  residue = residue.replace(/\b\d{1,2}[.\-/]\d{1,2}[.\-/]20\d{2}\b/g, " ");
  residue = residue.replace(/\b20\d{2}-\d{1,2}-\d{1,2}\b/g, " ");
  if (date) {
    // Belt-and-suspenders for stringy month names already matched
    for (const monthFull of MONTH_NAMES) {
      residue = residue.replace(
        new RegExp(`\\b(${monthFull}|${monthFull.slice(0, 3)})\\s+\\d{1,2}[,\\s]+20\\d{2}\\b`, "gi"),
        " ",
      );
    }
  }
  // Strip state codes we already matched
  for (const state of states) {
    residue = residue.replace(new RegExp(`\\b${state}\\b`, "g"), " ");
  }
  // Strip commas and dashes (separator noise from state lists)
  residue = residue.replace(/[,\-]+/g, " ");
  // Tokenize and clean
  const tokens = residue
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => !NOISE_TOKENS.has(t.toUpperCase()))
    .filter((t) => !/^\d+$/.test(t)) // pure numbers (leftover from version codes etc.)
    .filter((t) => t.length >= 3); // ignore tiny artifacts

  if (tokens.length === 0) return null;
  // Title-case the leftover tokens — "Omicron" stays, "BANK" → "Bank"
  return tokens
    .map((t) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase())
    .join(" ");
}

export interface ParsedFilename {
  program: ProgramKey | null;
  states: string[];
  variant: string | null;
  date: string | null;
}

/** Parse a filename into structured fields. Returns null program if unknown. */
export function parseFilename(filename: string): ParsedFilename {
  const normalized = normalizeFilename(filename);
  const program = detectProgram(normalized);
  if (!program) {
    return { program: null, states: [], variant: null, date: null };
  }
  const states = detectStates(normalized);
  const date = detectDate(normalized);
  const variant = detectVariant(normalized, program, states, date);
  return { program, states, variant, date };
}

/** Build a record from a Graph driveItem + resolved share URL. */
export function buildRecord(filename: string, url: string): RateSheetRecord | null {
  const parsed = parseFilename(filename);
  if (!parsed.program) return null;
  return {
    program: parsed.program,
    filename,
    url,
    date: parsed.date,
    states: parsed.states,
    variant: parsed.variant,
  };
}

/**
 * Group records by program, sorting each group newest-first by date.
 * Records without a parseable date sink to the bottom of their group.
 */
export function groupByProgram(records: RateSheetRecord[]): Record<ProgramKey, RateSheetRecord[]> {
  const out: Record<ProgramKey, RateSheetRecord[]> = {
    thunder: [], fabulous: [], jubilant: [], hermes: [], ocean: [], universe: [], radiant: [],
  };
  for (const r of records) out[r.program].push(r);
  for (const key of Object.keys(out) as ProgramKey[]) {
    out[key].sort((a, b) => {
      // Date desc; null dates go last
      if (a.date && b.date) return b.date.localeCompare(a.date);
      if (a.date) return -1;
      if (b.date) return 1;
      return 0;
    });
  }
  return out;
}

/**
 * Pick the best record for a program given an optional state + variant.
 *
 * STATE-AWARE STRICTNESS: when a state is requested and no rate sheet
 * explicitly lists that state AND no state-agnostic sheet exists, we return
 * NULL — not a misleading fallback. If the program isn't authoring rate
 * sheets that cover the LO's state, that's a strong signal the program
 * isn't offered there (e.g., Hermes has no Oregon sheet → likely not
 * available in OR). The caller can fall back to its hardcoded value or
 * warn the LO; we don't silently lie.
 *
 * Preference order:
 *   1. State explicitly listed AND variant matches
 *   2. State-agnostic record (states=[]) AND variant matches
 *   3. (state requested but no match) → null
 *   No state requested → newest matching-variant record (or just newest)
 */
export function pickRecord(
  records: RateSheetRecord[],
  opts: { state?: string; variant?: string | null } = {},
): RateSheetRecord | null {
  if (records.length === 0) return null;
  const state = opts.state?.toUpperCase();
  const requestedVariant = opts.variant;

  // Some programs (Universe) tag every release with a Greek-letter codename
  // (Omicron, Rho, …) — those are version identifiers, not feature variants.
  // If NO record for this program has variant=null, treat all the existing
  // variant tags as base-equivalent: the newest one IS the default sheet.
  // This preserves strict variant matching when there's a real base + named
  // variants alongside (e.g. Hermes base + Hermes CRA).
  const hasBaseSheet = records.some((r) => r.variant === null);

  // Variant matcher:
  //   - undefined → "no variant preference"
  //       → if any base sheet exists, match base only
  //       → if none, all records count as base (codename-only programs)
  //   - null      → explicit "base only" → strict base match
  //   - string    → caller explicitly wants that named variant
  const matchesVariant = (r: RateSheetRecord) => {
    if (requestedVariant === null) return r.variant === null;
    if (requestedVariant === undefined) {
      return hasBaseSheet ? r.variant === null : true;
    }
    return r.variant === requestedVariant;
  };

  if (state) {
    // 1. State explicitly covered + variant matches
    const explicit = records.find(
      (r) => matchesVariant(r) && r.states.length > 0 && r.states.includes(state),
    );
    if (explicit) return explicit;

    // 2. State-agnostic sheet (no state restriction at all) + variant matches
    const agnostic = records.find(
      (r) => matchesVariant(r) && r.states.length === 0,
    );
    if (agnostic) return agnostic;

    // 3. State requested but no sheet covers it → null (don't fake-pick)
    return null;
  }

  // No state requested — return newest record matching variant (base by default).
  const variantMatch = records.find(matchesVariant);
  return variantMatch ?? null;
}

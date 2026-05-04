/**
 * Types for the SharePoint rate-sheet auto-sync system.
 *
 * The cron lists files in known SharePoint folders, parses filenames into
 * structured records, and writes a map keyed by canonical program name into
 * Redis. The frontend resolver merges this map over a hardcoded fallback so
 * the UI keeps working if the cron hasn't run or fails.
 */

/** Canonical program keys recognized by the parser. */
export type ProgramKey =
  | "thunder"
  | "fabulous"
  | "jubilant"
  | "hermes"
  | "ocean"
  | "universe"
  | "radiant";

/**
 * One rate-sheet record extracted from a SharePoint file.
 *
 * `states`:
 *   - empty array → "applies to any state" (the default sheet for a program)
 *   - non-empty   → applies ONLY to the listed states
 *
 * `variant`:
 *   - null            → the base/default rate sheet for this program
 *   - "DSCR" / "Bank Statement" / "Omicron" / etc. → a feature/version variant
 *   The consumer can ask for a specific variant, otherwise the resolver
 *   returns the base sheet (variant=null) when no variant is requested.
 */
export interface RateSheetRecord {
  program: ProgramKey;
  /** Original filename — useful for debugging + showing the LO what version they're seeing. */
  filename: string;
  /** Resolved sharing URL (Graph `createLink` action result, or webUrl fallback). */
  url: string;
  /** ISO date YYYY-MM-DD parsed from filename, or null if not parseable. */
  date: string | null;
  /** US state codes the sheet applies to. Empty = applies to any state. */
  states: string[];
  /** Feature/version variant or null for base. */
  variant: string | null;
}

/** Map of program → all records found for that program (sorted newest first). */
export type RateSheetMap = Record<ProgramKey, RateSheetRecord[]>;

/** What the cron writes to Redis and the resolver reads back. */
export interface RateSheetSnapshot {
  /** Unix ms when the cron last successfully synced. */
  synced_at: number;
  /** Per-program list of records, all variants and states. */
  programs: RateSheetMap;
  /** Files we couldn't classify — visible for debugging. */
  unmatched: { filename: string; url: string }[];
  /** Programs we expected to find but didn't — useful for monitoring. */
  missing_programs: ProgramKey[];
}

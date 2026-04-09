/**
 * Server-durable cache of flat listing datasets produced by searchProperties
 * and matchPrograms.
 *
 * Why this exists: when the agent has 100 listings and the user asks for a
 * CSV, we don't want to round-trip all 100 rows (×20 fields) through the
 * LLM just to hand them to generateCsv. That blows context, is slow, and
 * Gemini silently drops fields on large structured outputs.
 *
 * Instead, the search / match tools stash the full dataset here under a
 * short ref (e.g. "ds-a1b2c3"), return the ref to the LLM, and generateCsv
 * pulls the full dataset directly when given that ref. The LLM only ever
 * sees a compact display-oriented view.
 *
 * Storage: backed by the shared redis-cache layer which uses Upstash in
 * production and a local JSON file in dev. This survives Next.js HMR and
 * works across Vercel Fluid Compute instances — unlike a module-level Map.
 */

import { randomBytes } from "crypto";
import { getAgentDataset, setAgentDataset } from "@/lib/redis-cache";

/**
 * Row shape used across searchProperties → matchPrograms → generateCsv.
 * Match-specific fields are optional so searchProperties-only results fit.
 */
export interface DatasetRow {
  address: string;
  city?: string | null;
  state?: string | null;
  zipCode?: string | null;
  county?: string | null;
  propertyType?: string | null;
  price?: number | null;
  bedrooms?: number | null;
  bathrooms?: number | null;
  sqft?: number | null;
  daysOnMarket?: number | null;
  distance?: number | null;
  latitude?: number;
  longitude?: number;
  countyFips?: string;
  stateFips?: string;
  listingAgentName?: string | null;
  listingAgentEmail?: string | null;
  listingAgentPhone?: string | null;
  listingOfficeName?: string | null;
  // Match-specific (only present after matchPrograms)
  eligiblePrograms?: string[];
  potentialPrograms?: string[];
  tractIncomeLevel?: string | null;
  msaName?: string | null;
  tractMinorityPct?: number | null;
  majorityAaHp?: boolean | null;
  error?: string;
}

/** Store a dataset and return its reference ID. */
export async function storeDataset(rows: DatasetRow[]): Promise<string> {
  const id = `ds-${randomBytes(6).toString("hex")}`;
  await setAgentDataset(id, rows);
  return id;
}

/** Retrieve a dataset by ref, or null if missing/expired. */
export async function getDataset(ref: string): Promise<DatasetRow[] | null> {
  const rows = await getAgentDataset(ref);
  return rows as DatasetRow[] | null;
}

import { tool } from "ai";
import { z } from "zod";
import { pyPost, PythonServiceError } from "@/lib/python-client";
import {
  storeDataset,
  getDataset,
  type DatasetRow,
} from "@/lib/tools/dataset-store";

interface MatchBatchResultItem {
  programs: {
    program_name: string;
    status: string;
    best_tier: string | null;
    is_secondary?: boolean;
  }[];
  census_data: Record<string, unknown> | null;
}

interface MatchBatchResponse {
  success: boolean;
  results: (MatchBatchResultItem | null)[];
  error?: string;
}

export const matchProgramsTool = tool({
  description:
    "Check which GMCC loan programs a set of properties qualify for. " +
    "Pass an array of property listings (from searchProperties output). " +
    "Returns per-property program eligibility (Eligible, Potentially Eligible, Ineligible) " +
    "and census tract data (income level, minority %, MSA). " +
    "Use this after searching for properties to find matches.",
  inputSchema: z.object({
    datasetRef: z
      .string()
      .optional()
      .describe(
        "Reference ID from searchProperties output. PREFERRED: pass this instead of inline listings — " +
          "the full dataset stays server-side and doesn't waste tokens. If omitted, pass inline listings.",
      ),
    listings: z
      .array(
        z.object({
          address: z.string(),
          city: z.string().nullable().optional(),
          state: z.string().nullable().optional(),
          zipCode: z.string().nullable().optional(),
          county: z.string().nullable().optional(),
          price: z.number().nullable().optional(),
          propertyType: z.string().nullable().optional(),
          bedrooms: z.number().nullable().optional(),
          bathrooms: z.number().nullable().optional(),
          sqft: z.number().nullable().optional(),
          daysOnMarket: z.number().nullable().optional(),
          latitude: z.number().optional(),
          longitude: z.number().optional(),
          countyFips: z.string().optional(),
          stateFips: z.string().optional(),
          listingAgentName: z.string().nullable().optional(),
          listingAgentEmail: z.string().nullable().optional(),
          listingAgentPhone: z.string().nullable().optional(),
          listingOfficeName: z.string().nullable().optional(),
        }),
      )
      .max(50)
      .optional()
      .describe("Fallback: inline array of listings to check (max 50). Only use when datasetRef is unavailable."),
  }),
  execute: async ({ datasetRef, listings: inlineListings }) => {
    // Resolve listings: datasetRef wins if both are present.
    let listings: DatasetRow[];
    if (datasetRef) {
      const resolved = await getDataset(datasetRef);
      if (!resolved) {
        return {
          error: `Dataset "${datasetRef}" not found or expired. Re-run searchProperties.`,
          results: [],
        };
      }
      // Matcher caps at 50 per call.
      listings = resolved.slice(0, 50);
    } else if (inlineListings && inlineListings.length > 0) {
      listings = inlineListings as DatasetRow[];
    } else {
      return { error: "Either datasetRef or listings is required.", results: [] };
    }
    // Convert to the RentCast-like shape the Python matcher expects.
    // Prefer explicit city/state fields if provided; only fall back to
    // splitting the address string when they're missing.
    const rentcastFormat = listings.map((l) => ({
      formattedAddress: l.address,
      addressLine1: l.address.split(",")[0]?.trim(),
      city: l.city ?? l.address.split(",")[1]?.trim(),
      state: l.state ?? l.address.split(",")[2]?.trim()?.split(" ")[0],
      price: l.price,
      propertyType: l.propertyType,
      bedrooms: l.bedrooms,
      bathrooms: l.bathrooms,
      latitude: l.latitude,
      longitude: l.longitude,
      county: l.county,
      countyFips: l.countyFips,
      stateFips: l.stateFips,
    }));

    try {
      const data = await pyPost<MatchBatchResponse>(
        "/api/match-batch",
        rentcastFormat,
      );

      if (!data.success) {
        return { error: data.error ?? "Matching service error.", results: [] };
      }

      // Merge the match results back onto the original listing fields.
      // These full rows are stored server-side under a new datasetRef so
      // generateCsv can pull the complete dataset without the LLM having
      // to echo every field back in a second round-trip.
      const mergedRows: DatasetRow[] = data.results.map((r, i) => {
        const src = listings[i];
        if (!r) return { ...src, error: "Match failed" };

        const eligible = r.programs.filter((p) => p.status === "Eligible" && !p.is_secondary);
        const potential = r.programs.filter(
          (p) => p.status === "Potentially Eligible" && !p.is_secondary,
        );

        return {
          ...src,
          eligiblePrograms: eligible.map((p) => p.program_name),
          potentialPrograms: potential.map((p) => p.program_name),
          tractIncomeLevel: (r.census_data?.tract_income_level as string | undefined) ?? null,
          msaName: (r.census_data?.msa_name as string | undefined) ?? null,
          tractMinorityPct: (r.census_data?.tract_minority_pct as number | undefined) ?? null,
          majorityAaHp: (r.census_data?.majority_aa_hp as boolean | undefined) ?? null,
        };
      });

      const newDatasetRef = await storeDataset(mergedRows);

      // Compact display-only view for the LLM. Only fields the MatchResultsPart
      // UI renders + the program names (agent needs these to summarize).
      // Keeps the tool output bounded regardless of batch size.
      const results = mergedRows.map((r) => ({
        address: r.address,
        price: r.price ?? null,
        eligiblePrograms: r.eligiblePrograms ?? [],
        potentialPrograms: r.potentialPrograms ?? [],
        ...(r.error ? { error: r.error } : {}),
      }));

      const totalEligible = results.filter(
        (r) => (r.eligiblePrograms?.length ?? 0) > 0,
      ).length;

      return {
        totalChecked: results.length,
        totalWithEligiblePrograms: totalEligible,
        // Pass this ref into generateCsv — the full merged dataset lives
        // server-side and generateCsv will pull it directly, avoiding a
        // multi-thousand-token round-trip of listing fields.
        datasetRef: newDatasetRef,
        results,
      };
    } catch (err) {
      if (err instanceof PythonServiceError) {
        return { error: err.message, results: [] };
      }
      return { error: "Matching service unavailable.", results: [] };
    }
  },
});

import { tool } from "ai";
import { z } from "zod";
import { pyPost, PythonServiceError } from "@/lib/python-client";

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
    listings: z
      .array(
        z.object({
          address: z.string(),
          price: z.number().nullable(),
          propertyType: z.string().nullable(),
          bedrooms: z.number().nullable().optional(),
          bathrooms: z.number().nullable().optional(),
          latitude: z.number().optional(),
          longitude: z.number().optional(),
          state: z.string().optional(),
          county: z.string().optional(),
          countyFips: z.string().optional(),
          stateFips: z.string().optional(),
        }),
      )
      .max(50)
      .describe("Array of property listings to check (max 50)"),
  }),
  execute: async ({ listings }) => {
    // Convert compact format back to RentCast-like dicts for the Python service
    const rentcastFormat = listings.map((l) => ({
      formattedAddress: l.address,
      addressLine1: l.address.split(",")[0]?.trim(),
      city: l.address.split(",")[1]?.trim(),
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

      // Compact the results for the LLM
      const results = data.results.map((r, i) => {
        if (!r) return { address: listings[i].address, error: "Match failed" };

        const eligible = r.programs.filter((p) => p.status === "Eligible" && !p.is_secondary);
        const potential = r.programs.filter(
          (p) => p.status === "Potentially Eligible" && !p.is_secondary,
        );

        return {
          address: listings[i].address,
          price: listings[i].price,
          eligiblePrograms: eligible.map((p) => p.program_name),
          potentialPrograms: potential.map((p) => p.program_name),
          censusData: r.census_data
            ? {
                tractIncomeLevel: r.census_data.tract_income_level,
                msaName: r.census_data.msa_name,
                tractMinorityPct: r.census_data.tract_minority_pct,
                majorityAaHp: r.census_data.majority_aa_hp,
              }
            : null,
        };
      });

      const totalEligible = results.filter(
        (r) => "eligiblePrograms" in r && (r.eligiblePrograms?.length ?? 0) > 0,
      ).length;

      return {
        totalChecked: results.length,
        totalWithEligiblePrograms: totalEligible,
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

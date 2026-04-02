import { tool } from "ai";
import { z } from "zod";
import { pyPost, PythonServiceError } from "@/lib/python-client";
import type { CensusData } from "@/types";

export const checkCRAEligibilityTool = tool({
  description:
    "Quick check if a single address is in a CRA-eligible census tract. " +
    "Returns census data: tract income level (Low/Moderate/Middle/Upper), MSA, " +
    "minority %, and whether it qualifies as LMI or MMCT. " +
    "Use this for fast eligibility checks without a full property search.",
  inputSchema: z.object({
    address: z.string().describe("Full property address to check"),
    latitude: z.number().optional(),
    longitude: z.number().optional(),
  }),
  execute: async ({ address, latitude, longitude }) => {
    try {
      const payload: Record<string, unknown> = { formattedAddress: address };
      if (latitude != null) payload.latitude = latitude;
      if (longitude != null) payload.longitude = longitude;

      const result = await pyPost<{
        success: boolean;
        census_data: CensusData | null;
        programs?: { program_name: string; status: string }[];
        error?: string;
      }>("/api/match", payload);

      if (!result.success || !result.census_data) {
        return { error: result.error ?? "Census data unavailable for this address." };
      }

      const c = result.census_data;
      const isLMI = c.tract_income_level?.toLowerCase() === "low" || c.tract_income_level?.toLowerCase() === "moderate";
      const isMMCT = (c.tract_minority_pct ?? 0) > 50;
      const isMajorityAaHp = c.majority_aa_hp === true;

      // Determine CRA eligibility summary
      const qualifications: string[] = [];
      if (isLMI) qualifications.push("LMI (Low/Moderate Income) tract");
      if (isMMCT) qualifications.push("MMCT (Majority-Minority Census Tract)");
      if (isMajorityAaHp) qualifications.push("DMMCT (Designated Majority-Minority — Black+Hispanic >50%)");

      // Include matched programs if returned
      const eligiblePrograms = (result.programs ?? [])
        .filter((p) => p.status === "Eligible" || p.status === "Potentially Eligible")
        .map((p) => ({ name: p.program_name, status: p.status }));

      return {
        address,
        tractIncomeLevel: c.tract_income_level ?? "Unknown",
        isLMI,
        isMMCT,
        isDMMCT: isMajorityAaHp,
        tractMinorityPct: c.tract_minority_pct != null ? Math.round(c.tract_minority_pct) : null,
        msaName: c.msa_name ?? null,
        msaCode: c.msa_code ?? null,
        countyName: c.county_name ?? null,
        ffiecMfi: c.ffiec_mfi ?? null,
        qualifications: qualifications.length > 0 ? qualifications : ["None — not in a CRA-qualifying tract"],
        ...(eligiblePrograms.length > 0 ? { eligiblePrograms } : {}),
      };
    } catch (err) {
      if (err instanceof PythonServiceError) {
        return { error: err.message };
      }
      return { error: "CRA eligibility check failed." };
    }
  },
});

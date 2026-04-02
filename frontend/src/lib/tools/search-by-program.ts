import { tool } from "ai";
import { z } from "zod";
import { pyGet, PythonServiceError } from "@/lib/python-client";

interface ProgramLocationEntry {
  program_name: string;
  states: {
    state: string;
    counties: { fips: string; county: string; cities: string[] }[];
  }[];
}

export const searchByProgramTool = tool({
  description:
    "Find which states and counties a specific GMCC program covers, with city-level detail. " +
    "Use this when the user wants to search for properties eligible for a specific program, " +
    "or when you need to find valid county FIPS codes for a program before searching properties. " +
    "Returns the geographic coverage so you can then use searchProperties with filters in those areas.",
  inputSchema: z.object({
    programName: z
      .string()
      .describe("GMCC program name, e.g. 'GMCC Universe', 'GMCC CRA: Diamond CRA'"),
  }),
  execute: async ({ programName }) => {
    try {
      const locations = await pyGet<{ programs: ProgramLocationEntry[] }>(
        "/api/program-locations",
      );

      // Find the matching program (case-insensitive partial match)
      const lower = programName.toLowerCase();
      const match = locations.programs.find(
        (p) =>
          p.program_name.toLowerCase() === lower ||
          p.program_name.toLowerCase().includes(lower.replace("gmcc ", "")) ||
          lower.includes(p.program_name.toLowerCase().replace("gmcc ", "")),
      );

      if (!match) {
        const available = locations.programs.map((p) => p.program_name).join(", ");
        return {
          error: `Program "${programName}" not found. Available: ${available}`,
        };
      }

      // Build compact coverage summary
      const coverage = match.states.map((s) => ({
        state: s.state,
        counties: s.counties.map((c) => ({
          fips: c.fips,
          name: c.county,
          cities: c.cities.slice(0, 5),
          totalCities: c.cities.length,
        })),
      }));

      const totalCounties = coverage.reduce((sum, s) => sum + s.counties.length, 0);

      return {
        programName: match.program_name,
        totalStates: coverage.length,
        totalCounties,
        coverage,
        hint: "Use searchProperties with a city or zip from these counties to find eligible properties. Then use matchPrograms to confirm eligibility.",
      };
    } catch (err) {
      if (err instanceof PythonServiceError) {
        return { error: err.message };
      }
      return { error: "Could not load program locations." };
    }
  },
});

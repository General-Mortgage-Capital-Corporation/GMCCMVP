import { tool } from "ai";
import { z } from "zod";
import { pyGet, PythonServiceError } from "@/lib/python-client";

interface ProgramListResponse {
  success: boolean;
  programs: string[];
}

interface ProgramLocationEntry {
  program_name: string;
  states: {
    state: string;
    counties: { fips: string; county: string; cities: string[] }[];
  }[];
}

export const lookupProgramsTool = tool({
  description:
    "List all available GMCC loan programs and their geographic coverage. " +
    "Returns program names plus which states and counties each program covers. " +
    "Use this when the user asks what programs are available, or to find which programs serve a specific area.",
  inputSchema: z.object({
    includeLocations: z
      .boolean()
      .default(false)
      .describe("If true, include state/county coverage for each program"),
  }),
  execute: async ({ includeLocations }) => {
    try {
      const programList = await pyGet<ProgramListResponse>("/api/programs");

      if (!includeLocations) {
        return { programs: programList.programs };
      }

      const locations = await pyGet<{ programs: ProgramLocationEntry[] }>(
        "/api/program-locations",
      );

      const programsWithLocations = locations.programs.map((p) => ({
        name: p.program_name,
        states: p.states.map((s) => ({
          state: s.state,
          counties: s.counties.map((c) => c.county),
        })),
      }));

      return { programs: programsWithLocations };
    } catch (err) {
      if (err instanceof PythonServiceError) {
        return { error: err.message };
      }
      return { error: "Could not load programs." };
    }
  },
});

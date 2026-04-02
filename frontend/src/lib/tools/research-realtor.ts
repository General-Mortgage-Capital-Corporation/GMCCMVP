import { tool } from "ai";
import { z } from "zod";
import { researchRealtor } from "@/lib/services/realtor-research";

export function createResearchRealtorTool() {
  return tool({
    description:
      "Research a real estate agent or listing office for email personalization. " +
      "Returns their specialties, experience, recent activity, and personal hooks " +
      "you can use to make emails more genuine. Uses Google search grounding.",
    inputSchema: z.object({
      name: z.string().optional().describe("Agent's name"),
      email: z.string().optional().describe("Agent's email"),
      company: z.string().optional().describe("Brokerage or company name"),
      city: z.string().optional().describe("City they operate in"),
      state: z.string().optional().describe("State abbreviation"),
    }),
    execute: async ({ name, email, company, city, state }) => {
      if (!name && !email && !company) {
        return { error: "Need at least a name, email, or company to research." };
      }

      try {
        const { research, cached } = await researchRealtor({
          name,
          email,
          company,
          city,
          state,
        });

        return {
          summary: research.summary,
          specialties: research.specialties,
          personalHooks: research.personalHooks,
          confidence: research.confidence,
          cached,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Realtor research failed.";
        return { error: msg };
      }
    },
  });
}

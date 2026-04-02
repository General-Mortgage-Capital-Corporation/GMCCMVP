import { tool } from "ai";
import { z } from "zod";

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
        // Call existing realtor-research API route (handles Gemini + caching internally)
        const res = await fetch(
          `${process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000"}/api/realtor-research`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, email, company, city, state }),
            signal: AbortSignal.timeout(115_000),
          },
        );

        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          return { error: err.error ?? "Research failed." };
        }

        const data = (await res.json()) as {
          research: {
            summary: string;
            specialties: string[];
            personalHooks: string[];
            confidence: string;
          };
          cached: boolean;
        };

        return {
          summary: data.research.summary,
          specialties: data.research.specialties,
          personalHooks: data.research.personalHooks,
          confidence: data.research.confidence,
          cached: data.cached,
        };
      } catch {
        return { error: "Realtor research timed out or failed." };
      }
    },
  });
}

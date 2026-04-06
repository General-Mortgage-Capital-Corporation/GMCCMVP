import { tool } from "ai";
import { z } from "zod";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "";
const GEMINI_MODEL = "gemini-2.5-flash";

export function createWebSearchTool() {
  return tool({
    description:
      "Search the web for current information using Google Search. " +
      "Uses Gemini with Google Search grounding to find and read actual web page content, not just links. " +
      "Use this for: current market data, interest rates, recent news, company info, " +
      "competitor analysis, local market trends, or any question requiring up-to-date information. " +
      "Do NOT use this for GMCC program details — use searchKnowledge or queryAdmiral instead.",
    inputSchema: z.object({
      query: z.string().describe(
        "The search query. Be specific for best results. " +
        "E.g. 'current 30-year fixed mortgage rates April 2026', " +
        "'top real estate agents in Pasadena CA', " +
        "'Santa Clara County housing market trends 2026'",
      ),
    }),
    execute: async ({ query }) => {
      if (!GEMINI_API_KEY) {
        return { error: "Web search not configured (missing Gemini API key)." };
      }

      const prompt = `Search the web for the following and provide a concise, factual answer with key details. Include source URLs when available.\n\nQuery: ${query}`;

      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

      try {
        const res = await fetch(geminiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.2,
              maxOutputTokens: 3000,
              thinkingConfig: { thinkingBudget: 0 },
            },
            tools: [{ google_search: {} }],
          }),
          signal: AbortSignal.timeout(30_000),
        });

        if (!res.ok) {
          return { error: `Web search failed (${res.status})` };
        }

        const data = (await res.json()) as {
          candidates?: {
            content?: {
              parts?: { text?: string }[];
            };
            groundingMetadata?: {
              webSearchQueries?: string[];
              groundingChunks?: { web?: { uri?: string; title?: string } }[];
            };
          }[];
        };

        const candidate = data.candidates?.[0];
        const parts = candidate?.content?.parts ?? [];

        // Extract text (skip thought parts)
        const answer = parts
          .filter((p) => typeof p.text === "string")
          .map((p) => p.text)
          .join("")
          .trim();

        // Extract sources from grounding metadata
        const grounding = candidate?.groundingMetadata;
        const sources = (grounding?.groundingChunks ?? [])
          .filter((c) => c.web?.uri)
          .map((c) => ({ url: c.web!.uri!, title: c.web?.title ?? "" }))
          .slice(0, 5);

        if (!answer) {
          return { error: "Web search returned no results." };
        }

        return {
          answer,
          sources,
          searchQueries: grounding?.webSearchQueries ?? [],
        };
      } catch (err) {
        if (err instanceof Error && err.message.includes("timeout")) {
          return { error: "Web search timed out." };
        }
        return { error: "Web search failed." };
      }
    },
  });
}

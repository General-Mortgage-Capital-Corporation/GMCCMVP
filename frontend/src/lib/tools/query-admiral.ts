import { tool } from "ai";
import { z } from "zod";

const CLOUD_FUNCTIONS_BASE = "https://us-central1-gmcc-66e1e.cloudfunctions.net";

interface AuthContext {
  firebaseToken: string;
}

export function createQueryAdmiralTool(auth: AuthContext) {
  return tool({
    description:
      "Ask GMCC's Admiral AI advisor for detailed program knowledge — rate sheet details, " +
      "guideline nuances, underwriting rules, eligibility edge cases, and anything the local " +
      "knowledge base doesn't cover. The Admiral has an extensive knowledge base of all GMCC " +
      "mortgage guidelines. Use this when searchKnowledge returns insufficient detail.",
    inputSchema: z.object({
      question: z
        .string()
        .describe("The question to ask Admiral — be specific for best results"),
    }),
    execute: async ({ question }) => {
      if (!auth.firebaseToken) {
        return { error: "User not signed in. Sign in with Outlook to use Admiral AI." };
      }

      try {
        const res = await fetch(`${CLOUD_FUNCTIONS_BASE}/aiChat`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${auth.firebaseToken}`,
          },
          body: JSON.stringify({
            message: question,
            conversationHistory: [],
          }),
          signal: AbortSignal.timeout(30_000),
        });

        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          return { error: err.error ?? `Admiral returned ${res.status}` };
        }

        const data = (await res.json()) as { content?: unknown };
        if (!data.content || typeof data.content !== "string") {
          return { error: "Admiral returned an invalid response." };
        }
        return { answer: data.content };
      } catch (err) {
        if (err instanceof Error && err.message.includes("timeout")) {
          return { error: "Admiral request timed out." };
        }
        return { error: "Failed to reach Admiral AI." };
      }
    },
  });
}

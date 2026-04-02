import { tool } from "ai";
import { z } from "zod";

export const askUserTool = tool({
  description:
    "Ask the user an open-ended question and wait for their typed response. " +
    "Use this when you need information that wasn't provided — office address, preferences, tone, " +
    "interest rate to quote, which realtors to prioritize, etc. " +
    "Do NOT guess critical information; ask instead.",
  inputSchema: z.object({
    question: z
      .string()
      .describe("The question to ask the user. Be specific and clear."),
    context: z
      .string()
      .optional()
      .describe("Optional context about why you're asking, shown below the question"),
  }),
  outputSchema: z.string().describe("The user's typed response"),
  // No execute — handled client-side via addToolOutput
});

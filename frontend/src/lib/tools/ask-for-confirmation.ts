import { tool } from "ai";
import { z } from "zod";

export const askForConfirmationTool = tool({
  description:
    "Ask the user to approve or reject an action before proceeding. " +
    "ALWAYS use this before sending emails, generating flyers, or performing any batch operation. " +
    "Present a clear summary of what will happen if approved.",
  inputSchema: z.object({
    action: z.string().describe("Short label for the action, e.g. 'Send 5 emails'"),
    details: z
      .string()
      .describe(
        "Detailed summary of what will happen — recipients, property addresses, programs, etc.",
      ),
  }),
  outputSchema: z.string().describe("User's approval or rejection response"),
  // No execute — handled client-side via addToolOutput
});

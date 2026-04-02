import { tool } from "ai";
import { z } from "zod";
import { COMPANY_DISCLAIMER } from "@/lib/signature-store";
import { generateEmailDraft } from "@/lib/services/email-draft";

interface DraftEmailContext {
  signatureHtml: string;
}

export function createDraftEmailTool(ctx?: DraftEmailContext) {
  return tool({
    description:
      "Draft a personalized email for a realtor or borrower about a GMCC loan program. " +
      "Uses AI to generate a warm, professional email body and subject line. " +
      "Optionally include realtor research for personalization.",
    inputSchema: z.object({
      recipientType: z.enum(["realtor", "borrower"]).describe("Who the email is for"),
      recipientName: z.string().optional().describe("Recipient's name"),
      recipientEmail: z.string().optional().describe("Recipient's email"),
      programName: z.string().describe("GMCC program name"),
      propertyAddress: z.string().optional().describe("Property address"),
      listingPrice: z.string().optional().describe("Listing price"),
      loName: z.string().optional().describe("Loan officer's name"),
      userPrompt: z
        .string()
        .default("Write a professional outreach email about this program")
        .describe("Instructions for the email tone/content"),
      realtorResearch: z
        .string()
        .optional()
        .describe("Research summary for personalization (from researchRealtor output)"),
    }),
    execute: async (input) => {
      const hasSignature = !!(ctx?.signatureHtml);

      if (!hasSignature) {
        return {
          error:
            "No email signature found. Please ask the user to go to Settings (gear icon) and set up their email signature before drafting emails. " +
            "The signature should include their name, title, NMLS#, and contact info.",
        };
      }

      try {
        const { subject, body } = await generateEmailDraft({
          recipientType: input.recipientType,
          recipientName: input.recipientName,
          recipientEmail: input.recipientEmail,
          programName: input.programName,
          propertyAddress: input.propertyAddress,
          listingPrice: input.listingPrice,
          loName: input.loName,
          userPrompt: input.userPrompt,
          realtorResearch: input.realtorResearch,
          hasSignature: true,
        });

        return {
          subject,
          body,
          signatureNote:
            "Your saved email signature and GMCC company disclaimer will be appended automatically when sent.",
          companyDisclaimer: COMPANY_DISCLAIMER,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Email draft failed.";
        return { error: msg };
      }
    },
  });
}

import { tool } from "ai";
import { z } from "zod";
import { COMPANY_DISCLAIMER } from "@/lib/signature-store";

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
        const res = await fetch(
          `${process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000"}/api/suggest-email`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              recipientType: input.recipientType,
              userPrompt: input.userPrompt,
              programName: input.programName,
              propertyAddress: input.propertyAddress,
              listingPrice: input.listingPrice,
              realtorName: input.recipientName,
              realtorEmail: input.recipientEmail,
              loName: input.loName,
              realtorResearch: input.realtorResearch,
              hasSignature: true,
            }),
            signal: AbortSignal.timeout(100_000),
          },
        );

        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          return { error: err.error ?? "Email draft failed." };
        }

        const data = (await res.json()) as { subject: string; body: string };
        return {
          subject: data.subject,
          body: data.body,
          signatureNote:
            "Your saved email signature and GMCC company disclaimer will be appended automatically when sent.",
          companyDisclaimer: COMPANY_DISCLAIMER,
        };
      } catch {
        return { error: "Email draft timed out or failed." };
      }
    },
  });
}

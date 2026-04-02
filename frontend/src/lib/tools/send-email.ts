import { tool } from "ai";
import { z } from "zod";
import { sendMailAs, type GraphMessage } from "@/lib/graph-client";
import { getPdf } from "@/lib/tools/flyer-store";
import { buildHtmlBodyWithSignature } from "@/lib/signature-store";

interface AuthContext {
  userEmail: string;
  signatureHtml: string;
}

export function createSendEmailTool(auth: AuthContext) {
  return tool({
    description:
      "Send an email via Microsoft Outlook/Graph API as the signed-in user. " +
      "Can include a PDF flyer attachment using a flyerRef from generateFlyer output. " +
      "ALWAYS call askForConfirmation before using this tool.",
    inputSchema: z.object({
      to: z.string().email().describe("Recipient email address"),
      toName: z.string().optional().describe("Recipient display name"),
      subject: z.string().describe("Email subject line"),
      body: z.string().describe("Email body (plain text with newlines)"),
      cc: z.string().email().optional().describe("CC email address"),
      flyerRef: z
        .string()
        .optional()
        .describe("Flyer reference ID from generateFlyer output (e.g. 'flyer-1'). The PDF will be attached automatically."),
      attachmentFilename: z
        .string()
        .optional()
        .describe("Filename for the attachment, e.g. 'GMCC-Jumbo-CRA-flier.pdf'"),
    }),
    execute: async (input) => {
      if (!auth.userEmail) {
        return { error: "User not signed in. Sign in with Outlook to send emails." };
      }

      if (!auth.signatureHtml) {
        return {
          error:
            "No email signature found. Please go to Settings (gear icon) and set up your email signature before sending emails. " +
            "Your signature must include your name, title, NMLS#, and contact info. " +
            "The company compliance disclaimer is added automatically.",
        };
      }

      // Build HTML email body with user signature + company disclaimer
      const htmlBody = buildHtmlBodyWithSignature(input.body, auth.signatureHtml);

      const message: GraphMessage = {
        subject: input.subject,
        body: {
          contentType: "HTML",
          content: htmlBody,
        },
        toRecipients: [
          {
            emailAddress: {
              address: input.to,
              ...(input.toName ? { name: input.toName } : {}),
            },
          },
        ],
      };

      // Add CC if provided
      if (input.cc) {
        (message as unknown as Record<string, unknown>).ccRecipients = [
          { emailAddress: { address: input.cc } },
        ];
      }

      // Resolve flyer PDF from server-side store
      if (input.flyerRef) {
        const pdfBase64 = getPdf(input.flyerRef);
        if (!pdfBase64) {
          return { error: `Flyer "${input.flyerRef}" not found or expired. Please regenerate.` };
        }
        (message as unknown as Record<string, unknown>).attachments = [
          {
            "@odata.type": "#microsoft.graph.fileAttachment",
            name: input.attachmentFilename ?? "GMCC-flier.pdf",
            contentType: "application/pdf",
            contentBytes: pdfBase64,
          },
        ];
      }

      const result = await sendMailAs(auth.userEmail, message);

      if (!result.ok) {
        return { error: result.error ?? "Failed to send email." };
      }

      return {
        success: true,
        sentTo: input.to,
        subject: input.subject,
        hasAttachment: !!input.flyerRef,
      };
    },
  });
}

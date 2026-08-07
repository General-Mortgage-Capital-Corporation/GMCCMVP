import { tool } from "ai";
import { z } from "zod";
import { recordFollowUp } from "@/lib/services/follow-up";
import type { SendLedger } from "@/lib/tools/send-ledger";

interface AuthContext {
  firebaseToken: string;
  userEmail: string;
}

export function createRecordFollowUpTool(auth: AuthContext, ledger?: SendLedger) {
  return tool({
    description:
      "Record a sent email and schedule a follow-up reminder. " +
      "Use this after successfully sending an email via sendEmail.",
    inputSchema: z.object({
      recipientEmail: z.string().describe("Email address of the recipient"),
      recipientName: z.string().optional().describe("Recipient's name"),
      recipientType: z
        .enum(["realtor", "borrower"])
        .default("realtor"),
      subject: z.string().describe("Email subject line"),
      body: z.string().optional().describe("Email body preview (first 500 chars)"),
      propertyAddress: z.string().optional(),
      programNames: z
        .array(z.string())
        .optional()
        .describe("GMCC program names mentioned in the email"),
      followUpDays: z
        .number()
        .min(1)
        .max(30)
        .default(3)
        .describe("Days until follow-up reminder (1-30, default 3)"),
      followUpMode: z
        .enum(["remind", "auto-send"])
        .default("remind")
        .describe("'remind' shows a reminder, 'auto-send' sends automatically"),
    }),
    execute: async (input) => {
      if (!auth.firebaseToken) {
        return { error: "User not signed in." };
      }

      // The email that was actually sent for this subject is the source of
      // truth. If the model passes a different address here (e.g. it kept the
      // address the deliverability gate rejected), correct it to the real one
      // so the follow-up — especially an auto-send — never targets an address
      // the email never went to.
      const recipientEmail = ledger
        ? ledger.resolve(input.subject, input.recipientEmail)
        : input.recipientEmail;
      const corrected =
        recipientEmail.toLowerCase() !== input.recipientEmail.toLowerCase();
      if (corrected) {
        console.warn(
          `[record-follow-up] recipient corrected from "${input.recipientEmail}" to the actually-sent "${recipientEmail}" (subject: "${input.subject}")`,
        );
      }

      try {
        const result = await recordFollowUp({
          firebaseToken: auth.firebaseToken,
          userEmail: auth.userEmail,
          recipientEmail,
          recipientName: input.recipientName,
          recipientType: input.recipientType,
          subject: input.subject,
          body: input.body?.slice(0, 500),
          propertyAddress: input.propertyAddress,
          programNames: input.programNames,
          followUpDays: input.followUpDays,
          followUpMode: input.followUpMode,
        });

        return {
          success: true,
          followUpId: result.id,
          scheduledIn: `${input.followUpDays} days`,
          mode: input.followUpMode,
          recordedRecipient: recipientEmail,
          ...(corrected
            ? { note: `Recorded against ${recipientEmail} (the address the email was actually sent to).` }
            : {}),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to record follow-up.";
        return { error: msg };
      }
    },
  });
}

import { tool } from "ai";
import { z } from "zod";

interface AuthContext {
  firebaseToken: string;
  userEmail: string;
}

export function createRecordFollowUpTool(auth: AuthContext) {
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

      try {
        const res = await fetch(
          `${process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000"}/api/follow-up/record`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${auth.firebaseToken}`,
            },
            body: JSON.stringify({
              recipientEmail: input.recipientEmail,
              recipientName: input.recipientName,
              recipientType: input.recipientType,
              subject: input.subject,
              body: input.body?.slice(0, 500),
              propertyAddress: input.propertyAddress,
              programNames: input.programNames,
              userEmail: auth.userEmail,
              followUpDays: input.followUpDays,
              followUpMode: input.followUpMode,
            }),
            signal: AbortSignal.timeout(15_000),
          },
        );

        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          return { error: err.error ?? "Failed to record follow-up." };
        }

        const data = (await res.json()) as { id: string };
        return {
          success: true,
          followUpId: data.id,
          scheduledIn: `${input.followUpDays} days`,
          mode: input.followUpMode,
        };
      } catch {
        return { error: "Failed to record follow-up." };
      }
    },
  });
}

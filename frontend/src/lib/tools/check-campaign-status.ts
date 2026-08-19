import { tool } from "ai";
import { z } from "zod";
import {
  getCampaign,
  listUserCampaigns,
  cancelCampaign,
} from "@/lib/campaigns/engine";

interface AuthContext {
  userEmail: string;
}

export function createCheckCampaignStatusTool(auth: AuthContext) {
  return tool({
    description:
      "Check (or cancel) a mass marketing campaign started with runMarketingCampaign. " +
      "Without a campaignId it reports the user's most recent campaign. " +
      "Use whenever the user asks how their campaign/mass emails are going, or wants to stop one.",
    inputSchema: z.object({
      campaignId: z
        .string()
        .optional()
        .describe("Campaign ID (e.g. 'cmp-a1b2c3'). Omit for the most recent campaign."),
      action: z
        .enum(["status", "cancel"])
        .default("status")
        .describe("'cancel' stops all remaining unsent emails in the campaign."),
    }),
    execute: async ({ campaignId, action }) => {
      if (!auth.userEmail) return { error: "User not signed in." };

      const campaign = campaignId
        ? await getCampaign(campaignId)
        : (await listUserCampaigns(auth.userEmail, 1))[0] ?? null;

      if (!campaign) {
        return { error: campaignId ? `Campaign "${campaignId}" not found.` : "No campaigns found for this user." };
      }
      if (campaign.userEmail !== auth.userEmail.toLowerCase()) {
        return { error: "This campaign belongs to a different user." };
      }

      if (action === "cancel" && (campaign.status === "running" || campaign.status === "blocked")) {
        await cancelCampaign(campaign);
      }

      const pending = campaign.rows.filter((r) => r.status === "pending").length;
      const failures = campaign.rows
        .filter((r) => r.status === "failed" || r.status === "skipped")
        .slice(0, 10)
        .map((r) => ({ agent: r.agentName, email: r.agentEmail, outcome: r.status, reason: r.reason }));

      return {
        campaignId: campaign.id,
        status: campaign.status,
        totals: campaign.totals,
        pending,
        ...(campaign.lastError ? { lastError: campaign.lastError } : {}),
        ...(failures.length ? { recentIssues: failures } : {}),
        startedAt: new Date(campaign.createdAt).toLocaleString(),
        note:
          campaign.status === "running"
            ? "Still sending in the background — remaining emails go out within minutes."
            : campaign.status === "blocked"
              ? "Blocked — fix the issue in lastError, then the background worker resumes automatically."
              : campaign.status === "cancelled"
                ? "Cancelled — no further emails will be sent."
                : "Complete.",
      };
    },
  });
}

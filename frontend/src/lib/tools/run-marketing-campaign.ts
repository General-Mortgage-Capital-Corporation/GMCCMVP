import { tool } from "ai";
import { z } from "zod";
import { randomBytes } from "crypto";
import { getDb, verifyIdToken } from "@/lib/firestore-admin";
import { getDataset } from "@/lib/tools/dataset-store";
import { generateProgramFlyerBase64 } from "@/lib/tools/generate-flyer";
import { getStoredSignature } from "@/lib/signature-server";
import {
  findSignaturePlaceholder,
  isSignatureContentEmpty,
} from "@/lib/signature-store";
import {
  planCampaignRows,
  fetchAlreadyEmailed,
  draftCampaignSample,
  processCampaign,
  CAMPAIGNS_COLLECTION,
  CAMPAIGN_ASSETS_COLLECTION,
  MAX_CAMPAIGN_ROWS,
  stripUndefined,
  type CampaignDoc,
} from "@/lib/campaigns/engine";

interface AuthContext {
  firebaseToken: string;
  userEmail: string;
  loName?: string;
  loTitle?: string;
}

/** How long the initial invocation processes rows before handing to the cron. */
const INLINE_BUDGET_MS = 60_000;

/** Max distinct program flyers pre-generated per campaign. */
const MAX_FLYER_PROGRAMS = 6;

export function createRunMarketingCampaignTool(auth: AuthContext) {
  return tool({
    description:
      "Run a mass email marketing campaign over a property dataset — the RIGHT tool whenever the user wants " +
      "to email the listing agents of more than ~10 properties. Executes the whole pipeline server-side " +
      "(deliverability check → personalized AI draft per agent → program flyer attachment → send → history record) " +
      "and continues in the background, so it works for 100+ properties without timing out. " +
      "One email per listing agent (agents with multiple listings get a single email). " +
      "\n\n" +
      "WORKFLOW (mandatory): first call with mode 'preview' — it returns recipient counts and a sample draft WITHOUT " +
      "sending anything. Show the user the counts + sample and get approval via askForConfirmation. Only after approval, " +
      "call again with mode 'start'. After starting, report the returned progress; the rest sends automatically in the " +
      "background within minutes — use checkCampaignStatus to report progress when asked.",
    inputSchema: z.object({
      mode: z
        .enum(["preview", "start"])
        .describe("'preview' = plan + sample draft, sends nothing. 'start' = create and begin sending (requires prior user approval)."),
      datasetRef: z
        .string()
        .describe("Dataset ref from the most recent matchPrograms (preferred) or searchProperties call, e.g. 'ds-a1b2c3'."),
      instructions: z
        .string()
        .default("Write a warm, professional outreach email introducing the GMCC program that fits their listing and offering to partner.")
        .describe("Tone/content instructions applied to every email (from the user's request)."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_CAMPAIGN_ROWS)
        .default(100)
        .describe("Max number of listing agents to email."),
      includeFlyer: z
        .boolean()
        .default(true)
        .describe("Attach the matched program's flyer PDF to each email."),
      usePotential: z
        .boolean()
        .default(false)
        .describe("Also include properties that are only Potentially Eligible (their first potential program is used). Default false — eligible-only."),
      skipAlreadyEmailed: z
        .boolean()
        .default(true)
        .describe("Skip agents this LO has already emailed before (recommended)."),
      followUpDays: z
        .number()
        .int()
        .min(1)
        .max(30)
        .optional()
        .describe("If set, schedule a follow-up reminder N days after each send."),
    }),
    execute: async (input) => {
      if (!auth.userEmail || !auth.firebaseToken) {
        return { error: "User not signed in. Sign in with Outlook first." };
      }
      const db = getDb();
      if (!db) return { error: "Database not configured." };

      const dataset = await getDataset(input.datasetRef);
      if (!dataset) {
        return {
          error: `Dataset "${input.datasetRef}" not found or expired. Re-run searchProperties/matchPrograms first.`,
        };
      }

      const uid = await verifyIdToken(auth.firebaseToken);
      if (!uid) return { error: "Invalid authentication." };

      const alreadyEmailed = input.skipAlreadyEmailed
        ? await fetchAlreadyEmailed(uid)
        : new Set<string>();

      const plan = planCampaignRows(dataset, {
        limit: input.limit,
        usePotential: input.usePotential,
        alreadyEmailed,
        skipAlreadyEmailed: input.skipAlreadyEmailed,
      });

      if (plan.rows.length === 0) {
        return {
          error: "No sendable recipients in this dataset.",
          counts: plan.counts,
          hint:
            plan.counts.skippedNoProgram > 0 && !input.usePotential
              ? "Many rows only had Potentially Eligible programs — re-run with usePotential: true if the user wants to include them (flagged, not verified)."
              : "Check that the dataset came from matchPrograms and has listing agent emails.",
        };
      }

      // Signature gate applies to both modes — no point previewing a campaign
      // that can't send.
      const sig = (await getStoredSignature(auth.userEmail)) ?? "";
      if (!sig || isSignatureContentEmpty(sig) || findSignaturePlaceholder(sig)) {
        return {
          error:
            "No valid email signature on file. Tell the user to open Settings (gear icon), complete their signature (no placeholders), and save — then try again.",
        };
      }

      const campaignMeta = {
        instructions: input.instructions,
        loName: auth.loName,
        includeFlyer: input.includeFlyer,
      };

      if (input.mode === "preview") {
        const sample = await draftCampaignSample(plan.rows[0], campaignMeta).catch(
          (err) => ({ subject: "(draft failed)", body: String(err instanceof Error ? err.message : err) }),
        );
        return {
          mode: "preview",
          counts: plan.counts,
          recipientsSample: plan.rows.slice(0, 5).map((r) => ({
            agent: r.agentName,
            email: r.agentEmail,
            property: r.address,
            program: r.program,
          })),
          sampleDraft: { to: plan.rows[0].agentEmail, ...sample },
          programsUsed: [...new Set(plan.rows.map((r) => r.program))],
          note:
            `Ready to email ${plan.rows.length} listing agents. Show the user the counts and the sample draft, ` +
            "then call askForConfirmation. Only call mode 'start' after the user approves.",
        };
      }

      // ── mode: "start" ─────────────────────────────────────────────────────
      const id = `cmp-${randomBytes(6).toString("hex")}`;
      const now = Date.now();

      // Pre-generate one flyer per distinct program while the user's Firebase
      // token is valid (the cron has no user token). Failures degrade to
      // no-attachment rather than blocking the campaign.
      const flyers: Record<string, string> = {};
      const flyerNotes: string[] = [];
      if (input.includeFlyer) {
        const programs = [...new Set(plan.rows.map((r) => r.program))].slice(0, MAX_FLYER_PROGRAMS);
        for (const program of programs) {
          const result = await generateProgramFlyerBase64(program, auth);
          if ("error" in result) {
            flyerNotes.push(`${program}: ${result.error} — emails for it go out without an attachment.`);
            continue;
          }
          if (result.base64.length > 950_000) {
            flyerNotes.push(`${program}: flyer too large to store — emails for it go out without an attachment.`);
            continue;
          }
          const assetId = `${id}_${result.productId}`;
          await db.collection(CAMPAIGN_ASSETS_COLLECTION).doc(assetId).set({
            campaignId: id,
            program,
            base64: result.base64,
            createdAt: now,
          });
          flyers[program] = assetId;
        }
      }

      const campaign: CampaignDoc = {
        id,
        userId: uid,
        userEmail: auth.userEmail.toLowerCase(),
        loName: auth.loName,
        loTitle: auth.loTitle,
        instructions: input.instructions,
        includeFlyer: input.includeFlyer,
        followUpDays: input.followUpDays ?? null,
        status: "running",
        createdAt: now,
        updatedAt: now,
        totals: { total: plan.rows.length, sent: 0, skipped: 0, failed: 0 },
        rows: plan.rows,
        flyers,
        lastError: null,
      };
      await db.collection(CAMPAIGNS_COLLECTION).doc(id).set(stripUndefined(campaign));

      // Process as many rows as fit in the inline budget for fast feedback;
      // the cron drains the rest within ~5 minutes.
      const remaining = await processCampaign(campaign, Date.now() + INLINE_BUDGET_MS);

      return {
        mode: "start",
        campaignId: id,
        status: campaign.status,
        totals: campaign.totals,
        remaining,
        ...(flyerNotes.length ? { flyerNotes } : {}),
        note:
          remaining > 0
            ? `Campaign started: ${campaign.totals.sent} sent so far, ${remaining} remaining — the rest sends automatically in the background over the next several minutes. The user can close the tab. Use checkCampaignStatus (campaignId "${id}") to report progress.`
            : `Campaign complete: ${campaign.totals.sent} sent, ${campaign.totals.skipped} skipped, ${campaign.totals.failed} failed.`,
      };
    },
  });
}

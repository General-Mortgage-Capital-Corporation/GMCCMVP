import { tool } from "ai";
import { z } from "zod";
import { randomBytes } from "crypto";
import { getDb, verifyIdToken } from "@/lib/firestore-admin";
import { getDataset } from "@/lib/tools/dataset-store";
import { generateProgramFlyerBase64, resolveProductId } from "@/lib/tools/generate-flyer";
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
  listUserCampaigns,
  summarizeCampaign,
  DedupeUnavailableError,
  CAMPAIGNS_COLLECTION,
  MAX_CAMPAIGN_ROWS,
  stripUndefined,
  type CampaignDoc,
  type CampaignFlyer,
} from "@/lib/campaigns/engine";
import { saveCampaignFlyer } from "@/lib/campaigns/flyer-assets";
import { deliveryForSize, describeFlyerDelivery, kb } from "@/lib/email/attachment-policy";

interface AuthContext {
  firebaseToken: string;
  userEmail: string;
  loName?: string;
  loTitle?: string;
  loNmls?: string;
}

/** How long the initial invocation processes rows before handing to the cron. */
const INLINE_BUDGET_MS = 60_000;

/** Max distinct program flyers pre-generated per campaign. */
const MAX_FLYER_PROGRAMS = 6;

/** A second campaign this soon after one is still running is almost always a loop or a double-click. */
const CONCURRENT_WINDOW_MS = 15 * 60 * 1000;

export function createRunMarketingCampaignTool(auth: AuthContext) {
  return tool({
    description:
      "Run a mass email marketing campaign over a property dataset — the RIGHT tool whenever the user wants " +
      "to email the listing agents of more than ~10 properties. Executes the whole pipeline server-side " +
      "(deliverability check → personalized AI draft per agent → program flyer → send → history record) " +
      "and continues in the background, so it works for 100+ properties without timing out. " +
      "One email per listing agent (agents with multiple listings get a single email). Agents this LO emailed " +
      "in the last 30 days are always skipped. " +
      "\n\n" +
      "WORKFLOW (mandatory): first call with mode 'preview' — it returns recipient counts, flyer availability and a sample draft WITHOUT " +
      "sending anything. Show the user the counts, the flyer status per program, and the sample; get approval via askForConfirmation. " +
      "Only after approval, call again with mode 'start'. After starting, repeat the returned `summary` to the user word for word " +
      "(it says exactly how many went out and whether flyers were attached, linked or missing) — the rest sends automatically in the " +
      "background within minutes; use checkCampaignStatus to report progress when asked. Never start a second campaign while one is running.",
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
        .describe("Send the matched program's flyer PDF with each email (attached when it fits Outlook's size limit, otherwise linked)."),
      usePotential: z
        .boolean()
        .default(false)
        .describe("Also include properties that are only Potentially Eligible (their first potential program is used). Default false — eligible-only."),
      skipAlreadyEmailed: z
        .boolean()
        .default(true)
        .describe("Skip agents this LO has EVER emailed before (recommended). Agents emailed in the last 30 days are skipped regardless."),
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

      // Send history is mandatory for both modes — without it the plan would
      // re-email people. (This used to fail silently in production.)
      let alreadyEmailed: Map<string, number>;
      try {
        alreadyEmailed = await fetchAlreadyEmailed(uid);
      } catch (err) {
        const msg = err instanceof DedupeUnavailableError ? err.message : "Could not read send history.";
        return { error: `${msg} Tell the user the campaign was NOT started and to try again in a few minutes.` };
      }

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
            plan.counts.skippedRecentlyEmailed > 0
              ? `${plan.counts.skippedRecentlyEmailed} agent(s) were emailed in the last 30 days and are never re-sent by a campaign. Tell the user that — do not retry.`
              : plan.counts.skippedNoProgram > 0 && !input.usePotential
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

      const programs = [...new Set(plan.rows.map((r) => r.program))];
      const campaignMeta = { instructions: input.instructions, loName: auth.loName };

      if (input.mode === "preview") {
        const flyerAvailability = Object.fromEntries(
          programs.map((p) => [
            p,
            !input.includeFlyer
              ? "not requested"
              : resolveProductId(p)
                ? "flyer template available (attached if it fits Outlook's size limit, otherwise linked)"
                : "NO flyer template — emails for this program go out without a flyer and won't mention one",
          ]),
        );
        const sampleDelivery = input.includeFlyer && resolveProductId(plan.rows[0].program) ? "attached" : "none";
        const sample = await draftCampaignSample(plan.rows[0], campaignMeta, sampleDelivery).catch(
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
          programsUsed: programs,
          flyerAvailability,
          note:
            `Ready to email ${plan.rows.length} listing agents` +
            (plan.counts.skippedRecentlyEmailed ? ` (${plan.counts.skippedRecentlyEmailed} skipped: emailed in the last 30 days)` : "") +
            ". Show the user the counts, the flyer availability and the sample draft, then call askForConfirmation. Only call mode 'start' after the user approves.",
        };
      }

      // ── mode: "start" ─────────────────────────────────────────────────────
      const recent = (await listUserCampaigns(auth.userEmail, 1))[0];
      if (recent && recent.status === "running" && Date.now() - recent.createdAt < CONCURRENT_WINDOW_MS) {
        return {
          error:
            `Campaign ${recent.id} started ${Math.round((Date.now() - recent.createdAt) / 60000)} min ago and is still sending ` +
            `(${summarizeCampaign(recent)}). Not starting another one. Report that status to the user; they can cancel it with checkCampaignStatus if they want to change it.`,
          campaignId: recent.id,
        };
      }

      const id = `cmp-${randomBytes(6).toString("hex")}`;
      const now = Date.now();

      // Pre-generate one flyer per distinct program while the user's Firebase
      // token is valid (the cron has no user token). Each program's delivery
      // is decided here from the real file size: attached when it fits
      // Graph's 4 MB sendMail body, linked when it doesn't, none when the
      // program has no template or generation failed. The draft for every
      // email is told which one applies, so the text never promises an
      // attachment that isn't there.
      const flyerMeta: Record<string, CampaignFlyer> = {};
      if (input.includeFlyer) {
        for (const program of programs.slice(0, MAX_FLYER_PROGRAMS)) {
          const productId = resolveProductId(program);
          if (!productId) {
            flyerMeta[program] = { productId: "", path: null, sizeKB: 0, delivery: "none", reason: "no flyer template for this program" };
            continue;
          }
          const result = await generateProgramFlyerBase64(program, auth);
          if ("error" in result) {
            // Generation failed but the portal can still serve the flyer.
            flyerMeta[program] = { productId, path: null, sizeKB: 0, delivery: "linked", reason: `flyer generation failed (${result.error})` };
            continue;
          }
          const sizeKB = kb(result.base64.length);
          const delivery = deliveryForSize(result.base64.length);
          let path: string | null = null;
          if (delivery === "attached") {
            try {
              path = await saveCampaignFlyer(id, productId, result.base64);
            } catch (err) {
              console.error("[campaigns] flyer upload failed:", err);
            }
          }
          flyerMeta[program] = path
            ? { productId, path, sizeKB, delivery: "attached" }
            : {
                productId,
                path: null,
                sizeKB,
                delivery: "linked",
                reason: delivery === "linked" ? `${Math.round(sizeKB / 102.4) / 10} MB is over Outlook's attachment limit` : "flyer could not be stored",
              };
        }
        for (const program of programs.slice(MAX_FLYER_PROGRAMS)) {
          const productId = resolveProductId(program);
          flyerMeta[program] = productId
            ? { productId, path: null, sizeKB: 0, delivery: "linked", reason: `more than ${MAX_FLYER_PROGRAMS} programs in one campaign` }
            : { productId: "", path: null, sizeKB: 0, delivery: "none", reason: "no flyer template for this program" };
        }
      }

      const campaign: CampaignDoc = {
        id,
        userId: uid,
        userEmail: auth.userEmail.toLowerCase(),
        loName: auth.loName,
        loTitle: auth.loTitle,
        loNmls: auth.loNmls,
        instructions: input.instructions,
        includeFlyer: input.includeFlyer,
        followUpDays: input.followUpDays ?? null,
        status: "running",
        createdAt: now,
        updatedAt: now,
        totals: { total: plan.rows.length, sent: 0, skipped: 0, failed: 0, attached: 0, linked: 0 },
        rows: plan.rows,
        flyers: {},
        flyerMeta,
        lastError: null,
      };
      await db.collection(CAMPAIGNS_COLLECTION).doc(id).set(stripUndefined(campaign));

      // Process as many rows as fit in the inline budget for fast feedback;
      // the cron drains the rest within ~5 minutes.
      const remaining = await processCampaign(campaign, Date.now() + INLINE_BUDGET_MS);

      const flyers = Object.fromEntries(
        Object.entries(flyerMeta).map(([p, m]) => [p, describeFlyerDelivery(m.delivery, { sizeKB: m.sizeKB, reason: m.reason })]),
      );
      const summary =
        `Campaign ${id}: ${summarizeCampaign(campaign)}` +
        (remaining > 0 ? " The rest sends automatically in the background over the next several minutes; the user can close the tab." : "");

      return {
        mode: "start",
        campaignId: id,
        status: campaign.status,
        summary,
        totals: campaign.totals,
        remaining,
        flyers,
        note: "Tell the user exactly what `summary` says — including linked or missing flyers. Use checkCampaignStatus for progress.",
      };
    },
  });
}

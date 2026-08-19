/**
 * Marketing-campaign engine — the deterministic server-side pipeline behind
 * the agent's `runMarketingCampaign` tool.
 *
 * Why: mass marketing used to run through the LLM one tool call per property
 * (research → draft → flyer → send × N). At 50-100 properties that meant
 * hundreds of tool calls against a hard step cap and a 300s function limit —
 * runs died mid-flight and poisoned conversations with orphaned tool calls.
 * Here the LLM plans and parameterizes ONE tool call; plain code executes the
 * batch with per-row error capture, and a cron drains whatever doesn't fit in
 * the initial invocation. Campaigns survive timeouts, closed tabs, and
 * redeploys.
 *
 * Storage:
 *   agentCampaigns/{id}        — campaign doc (rows embedded; ≤200 rows)
 *   agentCampaignAssets/{id}   — pre-generated per-program flyer PDFs
 *                                (generated at start while the user's Firebase
 *                                token is valid — the flyer Cloud Function
 *                                needs it; sends + drafts don't)
 *
 * Sending uses Graph APPLICATION credentials (sendMailAs), drafting uses the
 * server's GEMINI_API_KEY, and the signature is read live from the server
 * store — so the cron can finish a campaign with no user token at all.
 */
import "server-only";

import { getDb } from "@/lib/firestore-admin";
import { sendMailAs, type GraphMessage } from "@/lib/graph-client";
import { generateEmailDraft } from "@/lib/services/email-draft";
import {
  buildHtmlBodyWithSignature,
  findSignaturePlaceholder,
  isSignatureContentEmpty,
} from "@/lib/signature-store";
import { getStoredSignature } from "@/lib/signature-server";
import {
  verifyDeliverability,
  describeReason,
} from "@/lib/email-deliverability";
import type { DatasetRow } from "@/lib/tools/dataset-store";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CampaignRowStatus = "pending" | "sent" | "skipped" | "failed";

export interface CampaignRow {
  /** Primary property for this recipient (rows are deduped per agent). */
  address: string;
  city?: string;
  state?: string;
  price?: number | null;
  /** Other property addresses by the same listing agent in this dataset. */
  otherAddresses?: string[];
  agentName: string;
  agentEmail: string;
  agentPhone?: string;
  officeName?: string;
  program: string;
  status: CampaignRowStatus;
  reason?: string;
  subject?: string;
  sentAt?: number;
}

export interface CampaignDoc {
  id: string;
  userId: string;
  userEmail: string;
  loName?: string;
  loTitle?: string;
  instructions: string;
  includeFlyer: boolean;
  followUpDays: number | null;
  status: "running" | "done" | "cancelled" | "blocked";
  createdAt: number;
  updatedAt: number;
  totals: { total: number; sent: number; skipped: number; failed: number };
  rows: CampaignRow[];
  /** program name -> agentCampaignAssets doc id (flyer PDF). */
  flyers: Record<string, string>;
  lastError?: string | null;
}

export const CAMPAIGNS_COLLECTION = "agentCampaigns";
export const CAMPAIGN_ASSETS_COLLECTION = "agentCampaignAssets";

/** Hard cap on recipients per campaign. */
export const MAX_CAMPAIGN_ROWS = 200;

// ---------------------------------------------------------------------------
// Planning: dataset rows -> campaign rows (pure, shared by preview + start)
// ---------------------------------------------------------------------------

export interface CampaignPlan {
  rows: CampaignRow[];
  counts: {
    listings: number;
    recipients: number;
    skippedNoEmail: number;
    skippedNoProgram: number;
    skippedAlreadyEmailed: number;
    cappedAtLimit: boolean;
  };
}

export interface PlanOptions {
  limit: number;
  usePotential: boolean;
  /** Lowercased recipient emails already contacted (from sentEmails). */
  alreadyEmailed: Set<string>;
  skipAlreadyEmailed: boolean;
}

export function planCampaignRows(
  dataset: DatasetRow[],
  opts: PlanOptions,
): CampaignPlan {
  let skippedNoEmail = 0;
  let skippedNoProgram = 0;
  let skippedAlreadyEmailed = 0;

  // One email per listing agent — an agent with several listings in the
  // dataset gets a single email about their first listing (others noted).
  const byAgent = new Map<string, CampaignRow>();

  for (const l of dataset) {
    const email = (l.listingAgentEmail ?? "").trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      skippedNoEmail++;
      continue;
    }
    const program =
      l.eligiblePrograms?.[0] ??
      (opts.usePotential ? l.potentialPrograms?.[0] : undefined);
    if (!program) {
      skippedNoProgram++;
      continue;
    }
    if (opts.skipAlreadyEmailed && opts.alreadyEmailed.has(email)) {
      skippedAlreadyEmailed++;
      continue;
    }
    const existing = byAgent.get(email);
    if (existing) {
      existing.otherAddresses = [...(existing.otherAddresses ?? []), l.address];
      continue;
    }
    byAgent.set(email, {
      address: l.address,
      city: l.city ?? undefined,
      state: l.state ?? undefined,
      price: l.price ?? null,
      agentName: l.listingAgentName ?? "",
      agentEmail: email,
      agentPhone: l.listingAgentPhone ?? undefined,
      officeName: l.listingOfficeName ?? undefined,
      program,
      status: "pending",
    });
  }

  const all = [...byAgent.values()];
  const capped = all.length > opts.limit;
  return {
    rows: all.slice(0, opts.limit),
    counts: {
      listings: dataset.length,
      recipients: Math.min(all.length, opts.limit),
      skippedNoEmail,
      skippedNoProgram,
      skippedAlreadyEmailed,
      cappedAtLimit: capped,
    },
  };
}

/** Lowercased recipient emails this user has already contacted (recent 500). */
export async function fetchAlreadyEmailed(userId: string): Promise<Set<string>> {
  const out = new Set<string>();
  const db = getDb();
  if (!db || !userId) return out;
  try {
    const snap = await db
      .collection("sentEmails")
      .where("userId", "==", userId)
      .orderBy("sentAt", "desc")
      .limit(500)
      .get();
    for (const d of snap.docs) {
      const e = d.data().recipientEmail;
      if (typeof e === "string" && e) out.add(e.trim().toLowerCase());
    }
  } catch {
    /* dedupe is best-effort */
  }
  return out;
}

// ---------------------------------------------------------------------------
// Draft generation (shared: preview sample + real sends)
// ---------------------------------------------------------------------------

async function draftForRow(
  row: CampaignRow,
  campaign: Pick<CampaignDoc, "instructions" | "loName" | "includeFlyer">,
): Promise<{ subject: string; body: string }> {
  const extra = row.otherAddresses?.length
    ? ` (They also list: ${row.otherAddresses.slice(0, 3).join("; ")}${row.otherAddresses.length > 3 ? "; and more" : ""} — you may mention you noticed their other listings too.)`
    : "";
  return generateEmailDraft({
    recipientType: "realtor",
    recipientName: row.agentName || undefined,
    recipientEmail: row.agentEmail,
    programName: row.program,
    propertyAddress: [row.address, row.city, row.state].filter(Boolean).join(", "),
    listingPrice: row.price != null ? String(row.price) : undefined,
    loName: campaign.loName,
    userPrompt: campaign.instructions + extra,
    hasSignature: true,
  });
}

/** Public wrapper so the tool can produce a preview sample draft. */
export async function draftCampaignSample(
  row: CampaignRow,
  campaign: Pick<CampaignDoc, "instructions" | "loName" | "includeFlyer">,
): Promise<{ subject: string; body: string }> {
  return draftForRow(row, campaign);
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

async function readFlyerAsset(
  assetId: string,
  cache: Map<string, string | null>,
): Promise<string | null> {
  if (cache.has(assetId)) return cache.get(assetId) ?? null;
  const db = getDb();
  let base64: string | null = null;
  if (db) {
    try {
      const snap = await db.collection(CAMPAIGN_ASSETS_COLLECTION).doc(assetId).get();
      const b = snap.data()?.base64;
      base64 = typeof b === "string" && b ? b : null;
    } catch {
      base64 = null;
    }
  }
  cache.set(assetId, base64);
  return base64;
}

async function recordCampaignSend(
  campaign: CampaignDoc,
  row: CampaignRow,
  subject: string,
  body: string,
): Promise<void> {
  const db = getDb();
  if (!db) return;
  const now = Date.now();
  const followUpDays = campaign.followUpDays;
  try {
    await db.collection("sentEmails").add({
      userId: campaign.userId,
      userEmail: campaign.userEmail,
      recipientEmail: row.agentEmail,
      recipientName: row.agentName || "",
      recipientType: "realtor",
      subject,
      bodyPreview: body.slice(0, 500),
      propertyAddress: row.address,
      programNames: [row.program],
      sentAt: now,
      campaignId: campaign.id,
      followUp: followUpDays
        ? {
            mode: "remind",
            scheduledAt: now + followUpDays * 24 * 60 * 60 * 1000,
            status: "pending",
            reminderCount: 0,
            lastReminderAt: null,
            draftSubject: null,
            draftBody: null,
          }
        : null,
    });
  } catch (err) {
    console.warn("[campaigns] sentEmails write failed:", err);
  }
}

/**
 * Firestore Admin rejects `undefined` values (ignoreUndefinedProperties is not
 * enabled in this repo) — JSON round-trip drops them from optional fields.
 */
export function stripUndefined<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function persistCampaign(campaign: CampaignDoc): Promise<void> {
  const db = getDb();
  if (!db) return;
  campaign.updatedAt = Date.now();
  await db
    .collection(CAMPAIGNS_COLLECTION)
    .doc(campaign.id)
    .set(stripUndefined(campaign), { merge: false });
}

function recount(campaign: CampaignDoc): void {
  const t = { total: campaign.rows.length, sent: 0, skipped: 0, failed: 0 };
  for (const r of campaign.rows) {
    if (r.status === "sent") t.sent++;
    else if (r.status === "skipped") t.skipped++;
    else if (r.status === "failed") t.failed++;
  }
  campaign.totals = t;
}

export async function deleteCampaignAssets(campaign: CampaignDoc): Promise<void> {
  const db = getDb();
  if (!db) return;
  await Promise.all(
    Object.values(campaign.flyers).map((assetId) =>
      db.collection(CAMPAIGN_ASSETS_COLLECTION).doc(assetId).delete().catch(() => {}),
    ),
  );
}

/**
 * Process pending rows until `deadlineMs` (epoch) or none remain. Mutates and
 * persists the campaign doc after every batch so progress survives crashes.
 * Returns the number of rows still pending.
 */
export async function processCampaign(
  campaign: CampaignDoc,
  deadlineMs: number,
): Promise<number> {
  // Signature is read live so it always matches what the LO currently has
  // saved. No valid signature → the whole campaign blocks (never send
  // unsigned or placeholder-signed mail).
  const signatureHtml = (await getStoredSignature(campaign.userEmail)) ?? "";
  if (
    !signatureHtml ||
    isSignatureContentEmpty(signatureHtml) ||
    findSignaturePlaceholder(signatureHtml)
  ) {
    campaign.status = "blocked";
    campaign.lastError =
      "No valid email signature on file. Set it up in Settings (gear icon), then resume the campaign.";
    await persistCampaign(campaign);
    return campaign.rows.filter((r) => r.status === "pending").length;
  }

  const flyerCache = new Map<string, string | null>();
  const CONCURRENCY = 3;

  const processRow = async (row: CampaignRow): Promise<void> => {
    try {
      const verify = await verifyDeliverability(row.agentEmail, campaign.userEmail);
      if (verify.status !== "deliverable") {
        row.status = "skipped";
        row.reason = describeReason(verify.status, verify.reason);
        return;
      }

      const { subject, body } = await draftForRow(row, campaign);

      const message: GraphMessage = {
        subject,
        body: {
          contentType: "HTML",
          content: buildHtmlBodyWithSignature(body, signatureHtml),
        },
        toRecipients: [
          {
            emailAddress: {
              address: row.agentEmail,
              ...(row.agentName ? { name: row.agentName } : {}),
            },
          },
        ],
      };

      const assetId = campaign.includeFlyer ? campaign.flyers[row.program] : undefined;
      if (assetId) {
        const base64 = await readFlyerAsset(assetId, flyerCache);
        if (base64) {
          (message as unknown as Record<string, unknown>).attachments = [
            {
              "@odata.type": "#microsoft.graph.fileAttachment",
              name: `GMCC-${row.program.replace(/[^a-zA-Z0-9]+/g, "-")}.pdf`,
              contentType: "application/pdf",
              contentBytes: base64,
            },
          ];
        }
      }

      const result = await sendMailAs(campaign.userEmail, message);
      if (!result.ok) {
        row.status = "failed";
        row.reason = result.error ?? "Send failed.";
        return;
      }

      row.status = "sent";
      row.subject = subject;
      row.sentAt = Date.now();
      await recordCampaignSend(campaign, row, subject, body);
    } catch (err) {
      row.status = "failed";
      row.reason = err instanceof Error ? err.message.slice(0, 200) : "Unknown error";
    }
  };

  while (Date.now() < deadlineMs) {
    const batch = campaign.rows
      .filter((r) => r.status === "pending")
      .slice(0, CONCURRENCY);
    if (batch.length === 0) break;
    await Promise.all(batch.map(processRow));
    recount(campaign);
    await persistCampaign(campaign);
  }

  const remaining = campaign.rows.filter((r) => r.status === "pending").length;
  if (remaining === 0 && campaign.status === "running") {
    campaign.status = "done";
    recount(campaign);
    await persistCampaign(campaign);
    await deleteCampaignAssets(campaign);
  }
  return remaining;
}

/** Cancel: no further sends; remaining pending rows stay recorded as-is. */
export async function cancelCampaign(campaign: CampaignDoc): Promise<void> {
  campaign.status = "cancelled";
  await persistCampaign(campaign);
  await deleteCampaignAssets(campaign);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getCampaign(id: string): Promise<CampaignDoc | null> {
  const db = getDb();
  if (!db) return null;
  const snap = await db.collection(CAMPAIGNS_COLLECTION).doc(id).get();
  return snap.exists ? (snap.data() as CampaignDoc) : null;
}

/** Most recent campaigns for a user (in-memory sort — users have few). */
export async function listUserCampaigns(
  userEmail: string,
  limit = 5,
): Promise<CampaignDoc[]> {
  const db = getDb();
  if (!db) return [];
  const snap = await db
    .collection(CAMPAIGNS_COLLECTION)
    .where("userEmail", "==", userEmail.toLowerCase())
    .get();
  return snap.docs
    .map((d) => d.data() as CampaignDoc)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}

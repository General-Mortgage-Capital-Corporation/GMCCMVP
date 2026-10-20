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
 * Honesty rules the engine enforces (the model never gets to decide these):
 *   - A recipient this LO emailed in the last 30 days is skipped — checked at
 *     plan time AND again right before each send, so parallel campaigns can't
 *     double up either. If send history can't be read, the campaign refuses
 *     to start rather than sending blind.
 *   - A flyer is "attached" only when it really is. Flyers too big for Graph's
 *     4 MB sendMail body are LINKED (portal URL) and the draft is told so; a
 *     program with no flyer template gets a draft that mentions no flyer.
 *
 * Storage:
 *   agentCampaigns/{id}                    — campaign doc (rows embedded; ≤200 rows)
 *   Storage agent-campaign-flyers/{id}/…   — pre-generated per-program flyer PDFs
 *                                            (generated at start while the user's
 *                                            Firebase token is valid; sends + drafts
 *                                            don't need it)
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
import {
  RECIPIENT_COOLDOWN_MS,
  appendFlyerLink,
  daysAgo,
  portalFlyerUrl,
  type FlyerDelivery,
} from "@/lib/email/attachment-policy";
import { readCampaignFlyer, deleteCampaignFlyers } from "@/lib/campaigns/flyer-assets";
import { planCampaignRows, type CampaignRow } from "@/lib/campaigns/plan";

export { planCampaignRows };
export type { CampaignRow, CampaignRowStatus, CampaignPlan, PlanOptions } from "@/lib/campaigns/plan";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One program's flyer for a campaign, decided once at start. */
export interface CampaignFlyer {
  productId: string;
  /** Storage path of the PDF; null when it couldn't be generated. */
  path: string | null;
  sizeKB: number;
  delivery: FlyerDelivery;
  /** Why it's linked or missing ("3.9 MB is over Outlook's attachment limit"). */
  reason?: string;
}

export interface CampaignDoc {
  id: string;
  userId: string;
  userEmail: string;
  loName?: string;
  loTitle?: string;
  /** For personalized portal flyer links. */
  loNmls?: string;
  instructions: string;
  includeFlyer: boolean;
  followUpDays: number | null;
  status: "running" | "done" | "cancelled" | "blocked";
  createdAt: number;
  updatedAt: number;
  totals: { total: number; sent: number; skipped: number; failed: number; attached?: number; linked?: number };
  rows: CampaignRow[];
  /**
   * Legacy (pre-2026-10-20): program name -> agentCampaignAssets doc id.
   * New campaigns leave this empty and use `flyerMeta`.
   */
  flyers: Record<string, string>;
  /** program name -> how its flyer goes out. */
  flyerMeta?: Record<string, CampaignFlyer>;
  lastError?: string | null;
}

export const CAMPAIGNS_COLLECTION = "agentCampaigns";
export const CAMPAIGN_ASSETS_COLLECTION = "agentCampaignAssets";

/** Hard cap on recipients per campaign. */
export const MAX_CAMPAIGN_ROWS = 200;

// ---------------------------------------------------------------------------
// Send history (dedupe + cooldown)
// ---------------------------------------------------------------------------

export class DedupeUnavailableError extends Error {
  constructor(cause: string) {
    super(`Could not read this user's send history (${cause}). Refusing to plan a campaign without it — it would re-email people.`);
    this.name = "DedupeUnavailableError";
  }
}

/**
 * Lowercased recipient email -> most recent sentAt for this LO (recent 500
 * sends). Throws instead of returning an empty map: an empty map here means
 * "never emailed anyone", which is exactly the wrong default when the query
 * fails (that's how one LO's realtors got the same email ten times in a day).
 */
export async function fetchAlreadyEmailed(userId: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const db = getDb();
  if (!db) throw new DedupeUnavailableError("Firestore not configured");
  if (!userId) throw new DedupeUnavailableError("no user id");
  try {
    const snap = await db
      .collection("sentEmails")
      .where("userId", "==", userId)
      .orderBy("sentAt", "desc")
      .limit(500)
      .get();
    for (const d of snap.docs) {
      const data = d.data();
      const e = typeof data.recipientEmail === "string" ? data.recipientEmail.trim().toLowerCase() : "";
      const at = typeof data.sentAt === "number" ? data.sentAt : 0;
      if (e && (out.get(e) ?? 0) < at) out.set(e, at);
    }
  } catch (err) {
    throw new DedupeUnavailableError(err instanceof Error ? err.message.slice(0, 160) : "query failed");
  }
  return out;
}

/** Most recent send from this LO to this address (equality-only query — no composite index needed). */
export async function lastSentTo(userId: string, recipientEmail: string): Promise<{ sentAt: number; subject: string } | null> {
  const db = getDb();
  if (!db || !userId) return null;
  const snap = await db
    .collection("sentEmails")
    .where("userId", "==", userId)
    .where("recipientEmail", "==", recipientEmail.trim().toLowerCase())
    .get();
  let best: { sentAt: number; subject: string } | null = null;
  for (const d of snap.docs) {
    const data = d.data();
    const at = typeof data.sentAt === "number" ? data.sentAt : 0;
    if (!best || at > best.sentAt) best = { sentAt: at, subject: String(data.subject ?? "") };
  }
  return best;
}

// ---------------------------------------------------------------------------
// Draft generation (shared: preview sample + real sends)
// ---------------------------------------------------------------------------

async function draftForRow(
  row: CampaignRow,
  campaign: Pick<CampaignDoc, "instructions" | "loName">,
  flyerDelivery: FlyerDelivery,
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
    flyerDelivery,
  });
}

/** Public wrapper so the tool can produce a preview sample draft. */
export async function draftCampaignSample(
  row: CampaignRow,
  campaign: Pick<CampaignDoc, "instructions" | "loName">,
  flyerDelivery: FlyerDelivery,
): Promise<{ subject: string; body: string }> {
  return draftForRow(row, campaign, flyerDelivery);
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** The flyer PDF for a program: Storage for new campaigns, Firestore for legacy ones. */
async function readFlyer(
  campaign: CampaignDoc,
  program: string,
  cache: Map<string, string | null>,
): Promise<string | null> {
  const meta = campaign.flyerMeta?.[program];
  const key = meta?.path ?? campaign.flyers[program];
  if (!key) return null;
  if (cache.has(key)) return cache.get(key) ?? null;
  let base64: string | null = null;
  if (meta?.path) {
    base64 = await readCampaignFlyer(meta.path);
  } else {
    const db = getDb();
    if (db) {
      try {
        const snap = await db.collection(CAMPAIGN_ASSETS_COLLECTION).doc(key).get();
        const b = snap.data()?.base64;
        base64 = typeof b === "string" && b ? b : null;
      } catch {
        base64 = null;
      }
    }
  }
  cache.set(key, base64);
  return base64;
}

async function recordCampaignSend(
  campaign: CampaignDoc,
  row: CampaignRow,
  subject: string,
  body: string,
  flyer: { delivery: FlyerDelivery; productId?: string; sizeKB?: number; url?: string },
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
      flyer: stripUndefined(flyer),
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
  const t = { total: campaign.rows.length, sent: 0, skipped: 0, failed: 0, attached: 0, linked: 0 };
  for (const r of campaign.rows) {
    if (r.status === "sent") {
      t.sent++;
      if (r.flyer === "attached") t.attached++;
      else if (r.flyer === "linked") t.linked++;
    } else if (r.status === "skipped") t.skipped++;
    else if (r.status === "failed") t.failed++;
  }
  campaign.totals = t;
}

export async function deleteCampaignAssets(campaign: CampaignDoc): Promise<void> {
  await deleteCampaignFlyers(campaign.id);
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

  /** How this row's flyer goes out right now (a program can be downgraded to "linked" mid-campaign). */
  const flyerFor = (program: string): CampaignFlyer | null => {
    if (!campaign.includeFlyer) return null;
    const meta = campaign.flyerMeta?.[program];
    if (meta) return meta;
    // Legacy campaign with a Firestore asset.
    if (campaign.flyers[program]) return { productId: "", path: null, sizeKB: 0, delivery: "attached" };
    return null;
  };

  const sendRow = async (row: CampaignRow, flyer: CampaignFlyer | null): Promise<"sent" | "too-large"> => {
    let delivery: FlyerDelivery = flyer?.delivery ?? "none";
    let base64: string | null = null;
    if (delivery === "attached") {
      base64 = await readFlyer(campaign, row.program, flyerCache);
      if (!base64) {
        // The PDF is gone (bucket hiccup, cleaned up early) — link instead of
        // sending a body that promises an attachment.
        delivery = flyer?.productId ? "linked" : "none";
      }
    }

    const draft = await draftForRow(row, campaign, delivery);
    let body = draft.body;
    let url: string | undefined;
    if (delivery === "linked" && flyer?.productId) {
      url = portalFlyerUrl(flyer.productId, campaign.loNmls);
      body = appendFlyerLink(body, url);
    } else if (delivery === "linked") {
      delivery = "none";
    }

    const message: GraphMessage = {
      subject: draft.subject,
      body: { contentType: "HTML", content: buildHtmlBodyWithSignature(body, signatureHtml) },
      toRecipients: [
        { emailAddress: { address: row.agentEmail, ...(row.agentName ? { name: row.agentName } : {}) } },
      ],
    };
    if (delivery === "attached" && base64) {
      message.attachments = [
        {
          "@odata.type": "#microsoft.graph.fileAttachment",
          name: `GMCC-${row.program.replace(/[^a-zA-Z0-9]+/g, "-")}.pdf`,
          contentType: "application/pdf",
          contentBytes: base64,
        },
      ];
    }

    const result = await sendMailAs(campaign.userEmail, message);
    if (!result.ok) {
      if (result.code === "TOO_LARGE" && delivery === "attached") return "too-large";
      throw new Error(result.error ?? "Send failed.");
    }

    row.status = "sent";
    row.subject = draft.subject;
    row.sentAt = Date.now();
    row.flyer = delivery;
    await recordCampaignSend(campaign, row, draft.subject, body, {
      delivery,
      productId: flyer?.productId || undefined,
      sizeKB: delivery === "attached" ? flyer?.sizeKB : undefined,
      url,
    });
    return "sent";
  };

  const processRow = async (row: CampaignRow): Promise<void> => {
    try {
      // Send-time cooldown: another campaign (or a hand-sent email) may have
      // reached this agent since the plan was made.
      const last = await lastSentTo(campaign.userId, row.agentEmail);
      if (last && Date.now() - last.sentAt < RECIPIENT_COOLDOWN_MS) {
        row.status = "skipped";
        row.reason = `Already emailed ${daysAgo(last.sentAt)} day(s) ago — not sent twice within 30 days.`;
        return;
      }

      const verify = await verifyDeliverability(row.agentEmail, campaign.userEmail);
      if (verify.status !== "deliverable") {
        row.status = "skipped";
        row.reason = describeReason(verify.status, verify.reason);
        return;
      }

      const flyer = flyerFor(row.program);
      const outcome = await sendRow(row, flyer);
      if (outcome === "too-large" && flyer) {
        // Graph refused the attachment: link this program's flyer from now on
        // and send this row again with an honest draft.
        const linked: CampaignFlyer = {
          ...flyer,
          delivery: flyer.productId ? "linked" : "none",
          reason: "Outlook rejected the attachment as too large",
        };
        campaign.flyerMeta = { ...(campaign.flyerMeta ?? {}), [row.program]: linked };
        const retry = await sendRow(row, linked);
        if (retry !== "sent") throw new Error("Send failed after dropping the attachment.");
      }
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

/** One line a person can trust: counts plus how flyers went out. */
export function summarizeCampaign(campaign: CampaignDoc): string {
  const t = campaign.totals;
  const pending = campaign.rows.filter((r) => r.status === "pending").length;
  const flyerBits: string[] = [];
  if (campaign.includeFlyer) {
    if (t.attached) flyerBits.push(`${t.attached} with the flyer attached`);
    if (t.linked) flyerBits.push(`${t.linked} with a flyer link (too large to attach)`);
    const bare = t.sent - (t.attached ?? 0) - (t.linked ?? 0);
    if (bare > 0) flyerBits.push(`${bare} WITHOUT a flyer`);
  }
  const parts = [
    `${t.sent} sent${flyerBits.length ? ` (${flyerBits.join(", ")})` : campaign.includeFlyer ? "" : " (no flyers requested)"}`,
    `${t.skipped} skipped`,
    `${t.failed} failed`,
  ];
  if (pending) parts.push(`${pending} still to send`);
  return parts.join(", ") + ".";
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

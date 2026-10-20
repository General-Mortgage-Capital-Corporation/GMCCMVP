import { tool } from "ai";
import { z } from "zod";
import { sendMailAs, type GraphMessage } from "@/lib/graph-client";
import { getArtifact } from "@/lib/tools/flyer-store";
import { getDb, verifyIdToken } from "@/lib/firestore-admin";
import { lastSentTo } from "@/lib/campaigns/engine";
import {
  buildHtmlBodyWithSignature,
  findSignaturePlaceholder,
  isSignatureContentEmpty,
} from "@/lib/signature-store";
import {
  verifyDeliverability,
  describeReason,
} from "@/lib/email-deliverability";
import {
  MAX_INLINE_ATTACHMENT_BASE64,
  RECIPIENT_COOLDOWN_MS,
  appendFlyerLink,
  daysAgo,
  describeFlyerDelivery,
  kb,
  mentionsAttachment,
  portalFlyerUrl,
  type FlyerDelivery,
} from "@/lib/email/attachment-policy";
import type { SendLedger } from "@/lib/tools/send-ledger";

interface AuthContext {
  userEmail: string;
  signatureHtml: string;
  firebaseToken?: string;
  loNmls?: string;
}

interface SentRecord {
  success: true;
  sentTo: string;
  subject: string;
  flyer: { delivery: FlyerDelivery; name?: string; sizeKB?: number; url?: string; productId?: string };
  summary: string;
  sentEmailId?: string;
}

function dedupKey(to: string, subject: string): string {
  return `${to.toLowerCase()}::${subject.toLowerCase()}`;
}

const mb = (sizeKB: number) => `${Math.round(sizeKB / 102.4) / 10} MB`;

/**
 * Send one email as the signed-in LO.
 *
 * What this tool guarantees, whatever the model asked for:
 *   - the body never promises an attachment that isn't on the message;
 *   - a flyer is reported "attached" only when Graph accepted it inline,
 *     "linked" when it went out as a portal link, otherwise "no flyer";
 *   - nobody gets an automated email twice within 30 days unless the LO
 *     explicitly asks (allowRecent);
 *   - every send is written to sentEmails so dedupe and history see it even
 *     if recordFollowUp is never called.
 */
export function createSendEmailTool(auth: AuthContext, ledger?: SendLedger) {
  // Track sent emails per request (per tool instance) to prevent duplicate
  // sends from auto-recovery retries. Scoped to the closure here — NOT a
  // module-level Map — so a warm Fluid Compute instance handling requests
  // for different users (or back-to-back unrelated emails with the same
  // subject) will not silently dedupe across requests.
  const sent = new Map<string, SentRecord>();

  return tool({
    description:
      "Send an email via Microsoft Outlook/Graph API as the signed-in user. " +
      "To include a program flyer, generate it FIRST (generateFlyer) and pass its flyerRef; the result's `flyer.delivery` " +
      "tells you whether it was 'attached', 'linked' (too large for Outlook — a portal link was added under the text) or 'none'. " +
      "Report exactly that to the user. If the body says anything is attached but no flyer is attached, the send is refused. " +
      "ALWAYS call askForConfirmation before using this tool.",
    inputSchema: z.object({
      to: z.string().email().describe("Recipient email address"),
      toName: z.string().optional().describe("Recipient display name"),
      recipientType: z.enum(["realtor", "borrower"]).default("realtor"),
      subject: z.string().describe("Email subject line"),
      body: z.string().describe("Email body (plain text with newlines)"),
      cc: z.string().email().optional().describe("CC email address"),
      flyerRef: z
        .string()
        .optional()
        .describe("Flyer reference ID from generateFlyer output (e.g. 'pdf-1a2b3c')."),
      flyerDelivery: z
        .enum(["attach", "link"])
        .default("attach")
        .describe(
          "'attach' puts the PDF on the email (only works when generateFlyer said canAttach: true). " +
            "'link' adds a personalized portal link to the flyer under the body instead — use it when the flyer is too large, " +
            "and draft the email with draftEmail flyerDelivery 'linked' so the text doesn't say 'attached'.",
        ),
      attachmentFilename: z
        .string()
        .optional()
        .describe("Filename for the attachment, e.g. 'GMCC-Jumbo-CRA-flyer.pdf'"),
      propertyAddress: z.string().optional().describe("Property the email is about (for history)."),
      programName: z.string().optional().describe("GMCC program the email is about (for history)."),
      allowRecent: z
        .boolean()
        .default(false)
        .describe("Set true ONLY when the user explicitly wants to email someone they already emailed in the last 30 days."),
    }),
    execute: async (input) => {
      // Prevent duplicate sends from auto-recovery retries
      const key = dedupKey(input.to, input.subject);
      const already = sent.get(key);
      if (already) {
        return {
          ...already,
          note: `This email was already sent earlier in this conversation (${already.summary}). It was NOT sent again.`,
        };
      }

      if (!auth.userEmail) {
        return { error: "User not signed in. Sign in with Outlook to send emails." };
      }

      if (!auth.signatureHtml || isSignatureContentEmpty(auth.signatureHtml)) {
        return {
          error:
            "No email signature found. Please go to Settings (gear icon) and set up your email signature before sending emails. " +
            "Your signature must include your name, title, NMLS#, and contact info. " +
            "The company compliance disclaimer is added automatically.",
        };
      }
      // Backstop: never send a half-filled preset signature in a real email.
      const placeholder = findSignaturePlaceholder(auth.signatureHtml);
      if (placeholder) {
        return {
          error:
            `Refusing to send: the saved email signature still contains the placeholder "${placeholder}". ` +
            "Ask the user to open Settings (gear icon), replace the placeholder with their real information, and save the signature.",
        };
      }

      const uid = auth.firebaseToken ? await verifyIdToken(auth.firebaseToken) : null;

      // 30-day cooldown per recipient (campaign or hand-sent, same history).
      if (uid && !input.allowRecent) {
        const last = await lastSentTo(uid, input.to).catch(() => null);
        if (last && Date.now() - last.sentAt < RECIPIENT_COOLDOWN_MS) {
          return {
            error:
              `Not sent: the user already emailed ${input.to} ${daysAgo(last.sentAt)} day(s) ago` +
              (last.subject ? ` ("${last.subject}")` : "") +
              ". Tell the user. Only if they explicitly want to email this person again, call sendEmail again with allowRecent: true.",
          };
        }
      }

      // ── Flyer: decide what can honestly be said before anything is sent ──
      let body = input.body;
      let flyer: SentRecord["flyer"] = { delivery: "none" };
      let attachmentBase64: string | null = null;

      if (input.flyerRef) {
        const entry = await getArtifact(input.flyerRef);
        if (!entry?.base64) {
          return { error: `Flyer "${input.flyerRef}" not found or expired. Regenerate it with generateFlyer, then send again.` };
        }
        const sizeKB = kb(entry.base64.length);
        if (input.flyerDelivery === "attach") {
          if (entry.base64.length > MAX_INLINE_ATTACHMENT_BASE64) {
            return {
              error:
                `Not sent: this flyer is ${mb(sizeKB)}, over Outlook's attachment limit. ` +
                "Re-draft with draftEmail (flyerDelivery: 'linked') so the text says the flyer is linked, then call sendEmail again with flyerDelivery: 'link' and the same flyerRef.",
            };
          }
          attachmentBase64 = entry.base64;
          flyer = {
            delivery: "attached",
            name: input.attachmentFilename ?? entry.filename ?? "GMCC-flyer.pdf",
            sizeKB,
            productId: entry.productId,
          };
        } else {
          if (!entry.productId) {
            return { error: "This flyer can't be linked (unknown program). Regenerate it with generateFlyer, then send again." };
          }
          if (mentionsAttachment(body)) {
            return {
              error:
                "Not sent: the email body says something is attached, but the flyer would only be linked. " +
                "Re-draft with draftEmail (flyerDelivery: 'linked') and send again.",
            };
          }
          const url = portalFlyerUrl(entry.productId, auth.loNmls);
          body = appendFlyerLink(body, url);
          flyer = { delivery: "linked", url, productId: entry.productId, sizeKB };
        }
      } else if (mentionsAttachment(body)) {
        return {
          error:
            "Not sent: the email body mentions an attachment, but no flyerRef was provided — the realtor would get a promise with nothing attached. " +
            "Either generate the flyer (generateFlyer) and pass its flyerRef, or re-draft with draftEmail (flyerDelivery: 'none') so the text doesn't mention one.",
        };
      }

      // Send-time deliverability gate. Only `deliverable` allows the send.
      // The verifier is cached in Firestore (90d) so repeat verifications of
      // the same address don't double-spend Bouncer credits. Run right before
      // sendMailAs so we only spend credits on addresses we're actually about
      // to send to.
      const toVerify = await verifyDeliverability(input.to, auth.userEmail);
      if (toVerify.status !== "deliverable") {
        return {
          error:
            `Refusing to send: recipient ${input.to} is not verified deliverable — ` +
            `${describeReason(toVerify.status, toVerify.reason)}` +
            (toVerify.didYouMean
              ? ` Did you mean ${toVerify.didYouMean}?`
              : "") +
            ` Fix the address or skip this send to protect sender reputation.`,
        };
      }
      if (input.cc) {
        const ccVerify = await verifyDeliverability(input.cc, auth.userEmail);
        if (ccVerify.status !== "deliverable") {
          return {
            error:
              `Refusing to send: CC ${input.cc} is not verified deliverable — ` +
              `${describeReason(ccVerify.status, ccVerify.reason)}` +
              (ccVerify.didYouMean
                ? ` Did you mean ${ccVerify.didYouMean}?`
                : "") +
              ` Remove the CC, fix the address, or skip this send.`,
          };
        }
      }

      // Build HTML email body with user signature + company disclaimer
      const message: GraphMessage = {
        subject: input.subject,
        body: { contentType: "HTML", content: buildHtmlBodyWithSignature(body, auth.signatureHtml) },
        toRecipients: [
          { emailAddress: { address: input.to, ...(input.toName ? { name: input.toName } : {}) } },
        ],
        ...(input.cc ? { ccRecipients: [{ emailAddress: { address: input.cc } }] } : {}),
        ...(attachmentBase64
          ? {
              attachments: [
                {
                  "@odata.type": "#microsoft.graph.fileAttachment" as const,
                  name: flyer.name ?? "GMCC-flyer.pdf",
                  contentType: "application/pdf",
                  contentBytes: attachmentBase64,
                },
              ],
            }
          : {}),
      };

      const result = await sendMailAs(auth.userEmail, message);
      if (!result.ok) {
        if (result.code === "TOO_LARGE") {
          return {
            error:
              `Not sent: Outlook rejected the message as too large (${flyer.sizeKB ? mb(flyer.sizeKB) : "attachment"}). ` +
              "Re-draft with draftEmail (flyerDelivery: 'linked') and send again with flyerDelivery: 'link'.",
          };
        }
        return { error: `Not sent: ${result.error ?? "Failed to send email."}` };
      }

      const summary =
        `Sent to ${input.to}` +
        (flyer.delivery === "none" && !input.flyerRef
          ? " (no flyer)"
          : ` — flyer ${describeFlyerDelivery(flyer.delivery, { sizeKB: flyer.sizeKB, reason: flyer.delivery === "linked" ? "over Outlook's attachment limit" : undefined })}`) +
        ".";

      // History: every send is recorded here, follow-up or not.
      let sentEmailId: string | undefined;
      const db = getDb();
      if (db && uid) {
        try {
          const ref = await db.collection("sentEmails").add({
            userId: uid,
            userEmail: auth.userEmail,
            recipientEmail: input.to.trim().toLowerCase(),
            recipientName: input.toName ?? "",
            recipientType: input.recipientType,
            subject: input.subject,
            bodyPreview: body.slice(0, 500),
            propertyAddress: input.propertyAddress ?? "",
            programNames: input.programName ? [input.programName] : [],
            sentAt: Date.now(),
            source: "agent-sendEmail",
            flyer: JSON.parse(JSON.stringify(flyer)),
            followUp: null,
          });
          sentEmailId = ref.id;
        } catch (err) {
          console.warn("[send-email] sentEmails write failed:", err);
        }
      }

      const record: SentRecord = { success: true, sentTo: input.to, subject: input.subject, flyer, summary, sentEmailId };
      sent.set(key, record);

      // Record the ACTUAL recipient (keyed by subject) so a later
      // recordFollowUp call reconciles against the real send — even if the
      // model proposed a different address after the gate rejected its first.
      ledger?.record(input.subject, input.to, sentEmailId);

      return record;
    },
  });
}

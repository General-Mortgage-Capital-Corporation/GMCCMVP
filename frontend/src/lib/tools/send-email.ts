import { tool } from "ai";
import { z } from "zod";
import { sendMailAs, type GraphFileAttachment, type GraphMessage } from "@/lib/graph-client";
import { attachableFlyerBase64 } from "@/lib/email/flyer-pdf-compact";
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
import {
  MAX_EMBEDDED_FLYERS,
  flyerImagesHtml,
  inlineFlyerAttachment,
  type EmbeddedFlyer,
} from "@/lib/email/flyer-embed";
import type { SendLedger } from "@/lib/tools/send-ledger";

interface AuthContext {
  userEmail: string;
  signatureHtml: string;
  firebaseToken?: string;
  loNmls?: string;
}

interface SentFlyer {
  delivery: FlyerDelivery;
  name?: string;
  sizeKB?: number;
  url?: string;
  productId?: string;
}

interface SentRecord {
  success: true;
  sentTo: string;
  subject: string;
  flyer: SentFlyer;
  flyers: SentFlyer[];
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
 *   - a flyer is reported "embedded" only when it is shown in the body,
 *     "attached" when the PDF is on the message, "linked" when it went out as
 *     a portal link, otherwise "no flyer";
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
      "To include a program flyer, generate it FIRST (generateFlyer) and pass its flyerRef; the result's `flyers` list " +
      "tells you whether each was 'embedded' (shown in the email body), 'attached', or 'linked' (too large for Outlook — a portal link was added under the text). " +
      "At most 2 flyers can be embedded; more can be attached or linked through moreFlyers. " +
      "Report exactly that to the user. If the body says anything is attached but no PDF is attached, the send is refused. " +
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
        .enum(["embed", "attach", "link"])
        .default("embed")
        .describe(
          "'embed' shows the flyer as an image in the email body (the default; needs canEmbed: true from generateFlyer). " +
            "'attach' puts the PDF on the email (only works when generateFlyer said canAttach: true). " +
            "'link' adds a personalized portal link to the flyer under the body instead — use it when the flyer is too large, " +
            "and draft the email with draftEmail flyerDelivery 'linked' so the text doesn't say 'attached'.",
        ),
      moreFlyers: z
        .array(z.object({ flyerRef: z.string(), flyerDelivery: z.enum(["embed", "attach", "link"]) }))
        .default([])
        .describe("Any further flyers for this email. At most 2 flyers in total can use 'embed'."),
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

      // ── Flyers: decide what can honestly be said before anything is sent ──
      let body = input.body;
      const requested = [
        ...(input.flyerRef ? [{ flyerRef: input.flyerRef, flyerDelivery: input.flyerDelivery }] : []),
        ...input.moreFlyers,
      ].filter((f, i, all) => all.findIndex((x) => x.flyerRef === f.flyerRef) === i);
      const toEmbed = requested.filter((f) => f.flyerDelivery === "embed");
      if (toEmbed.length > MAX_EMBEDDED_FLYERS) {
        return {
          error: `Not sent: at most ${MAX_EMBEDDED_FLYERS} flyers can be shown in the email body, and ${toEmbed.length} were requested. Ask the user which ${MAX_EMBEDDED_FLYERS} to show; the others can go with flyerDelivery 'attach'.`,
        };
      }

      const embedded: EmbeddedFlyer[] = [];
      const pdfAttachments: GraphFileAttachment[] = [];
      const sentFlyers: SentFlyer[] = [];
      let usedBase64 = 0;

      // Embedded flyers first: they are small and shouldn't lose out to a big PDF.
      for (const f of [...toEmbed, ...requested.filter((x) => x.flyerDelivery !== "embed")]) {
        const entry = await getArtifact(f.flyerRef);
        if (!entry?.base64) {
          return { error: `Flyer "${f.flyerRef}" not found or expired. Regenerate it with generateFlyer, then send again.` };
        }
        const sizeKB = kb(entry.base64.length);
        if (f.flyerDelivery === "embed") {
          if (!entry.image) {
            return {
              error:
                `Not sent: flyer "${f.flyerRef}" can't be shown in the email. ` +
                "Re-draft with draftEmail (flyerDelivery: 'attached' or 'linked') and send it with the matching flyerDelivery.",
            };
          }
          embedded.push({
            ...entry.image,
            id: f.flyerRef,
            title:
              input.programName && toEmbed.length === 1
                ? input.programName
                : (entry.productId ?? "GMCC program").replace(/-/g, " "),
            ...(entry.productId ? { pdfUrl: portalFlyerUrl(entry.productId, auth.loNmls) } : {}),
          });
          usedBase64 += entry.image.base64.length;
          sentFlyers.push({
            delivery: "embedded",
            productId: entry.productId,
            ...(entry.productId ? { url: portalFlyerUrl(entry.productId, auth.loNmls) } : {}),
          });
        } else if (f.flyerDelivery === "attach") {
          let pdfBase64 = entry.base64;
          if (usedBase64 + pdfBase64.length > MAX_INLINE_ATTACHMENT_BASE64) {
            // Shrink it to the room left before giving up on attaching it.
            const roomBytes = Math.floor(((MAX_INLINE_ATTACHMENT_BASE64 - usedBase64) * 3) / 4);
            if (roomBytes > 0) pdfBase64 = await attachableFlyerBase64(pdfBase64, roomBytes);
          }
          if (usedBase64 + pdfBase64.length > MAX_INLINE_ATTACHMENT_BASE64) {
            return {
              error:
                `Not sent: this flyer is ${mb(sizeKB)}, which puts the email over Outlook's size limit. ` +
                "Re-draft with draftEmail (flyerDelivery: 'embedded' or 'linked') and send it with flyerDelivery 'embed' or 'link' and the same flyerRef.",
            };
          }
          const name = (pdfAttachments.length === 0 && input.attachmentFilename) || entry.filename || "GMCC-flyer.pdf";
          pdfAttachments.push({
            "@odata.type": "#microsoft.graph.fileAttachment",
            name,
            contentType: "application/pdf",
            contentBytes: pdfBase64,
          });
          usedBase64 += pdfBase64.length;
          sentFlyers.push({ delivery: "attached", name, sizeKB: kb(pdfBase64.length), productId: entry.productId });
        } else {
          if (!entry.productId) {
            return { error: "This flyer can't be linked (unknown program). Regenerate it with generateFlyer, then send again." };
          }
          const url = portalFlyerUrl(entry.productId, auth.loNmls);
          body = appendFlyerLink(body, url);
          sentFlyers.push({ delivery: "linked", url, productId: entry.productId, sizeKB });
        }
      }
      const flyer: SentFlyer = sentFlyers[0] ?? { delivery: "none" };

      if (pdfAttachments.length === 0 && mentionsAttachment(input.body)) {
        return {
          error:
            "Not sent: the email body says something is attached, but no PDF is attached. " +
            (sentFlyers.length
              ? "Re-draft with draftEmail using the flyerDelivery that matches how the flyer goes out ('embedded' or 'linked') and send again."
              : "Either generate the flyer (generateFlyer) and pass its flyerRef, or re-draft with draftEmail (flyerDelivery: 'none') so the text doesn't mention one."),
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
        body: {
          contentType: "HTML",
          content: buildHtmlBodyWithSignature(body, auth.signatureHtml, flyerImagesHtml(embedded)),
        },
        toRecipients: [
          { emailAddress: { address: input.to, ...(input.toName ? { name: input.toName } : {}) } },
        ],
        ...(input.cc ? { ccRecipients: [{ emailAddress: { address: input.cc } }] } : {}),
        ...(embedded.length || pdfAttachments.length
          ? { attachments: [...embedded.map(inlineFlyerAttachment), ...pdfAttachments] }
          : {}),
      };

      const result = await sendMailAs(auth.userEmail, message);
      if (!result.ok) {
        if (result.code === "TOO_LARGE") {
          return {
            error:
              "Not sent: Outlook rejected the message as too large. " +
              "Re-draft with draftEmail (flyerDelivery: 'embedded' or 'linked') and send again with flyerDelivery 'embed' or 'link'.",
          };
        }
        return { error: `Not sent: ${result.error ?? "Failed to send email."}` };
      }

      const summary =
        `Sent to ${input.to}` +
        (sentFlyers.length === 0
          ? " (no flyer)"
          : ` — ${sentFlyers
              .map((f) =>
                `flyer ${describeFlyerDelivery(f.delivery, { sizeKB: f.sizeKB, reason: f.delivery === "linked" ? "over Outlook's attachment limit" : undefined })}`,
              )
              .join("; ")}`) +
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
            flyers: JSON.parse(JSON.stringify(sentFlyers)),
            followUp: null,
          });
          sentEmailId = ref.id;
        } catch (err) {
          console.warn("[send-email] sentEmails write failed:", err);
        }
      }

      const record: SentRecord = { success: true, sentTo: input.to, subject: input.subject, flyer, flyers: sentFlyers, summary, sentEmailId };
      sent.set(key, record);

      // Record the ACTUAL recipient (keyed by subject) so a later
      // recordFollowUp call reconciles against the real send — even if the
      // model proposed a different address after the gate rejected its first.
      ledger?.record(input.subject, input.to, sentEmailId);

      return record;
    },
  });
}

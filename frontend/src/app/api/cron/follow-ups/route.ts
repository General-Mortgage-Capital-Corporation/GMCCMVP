import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firestore-admin";
import { sendMailAs, checkForReply, isAutoSendAvailable, getOriginalMessageIds } from "@/lib/graph-client";

export const runtime = "nodejs";
export const maxDuration = 60;

const ESCALATION_DAYS = [3, 7, 14]; // follow-up #1 after 3d, #2 after 7d, #3 after 14d
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://gmccmvp-two.vercel.app";

/** Send a reminder email to the LO's own inbox about a pending follow-up. */
async function sendReminderToLO(
  userEmail: string,
  recipientName: string,
  recipientEmail: string,
  propertyAddress: string,
  draftSubject: string,
) {
  await sendMailAs(userEmail, {
    subject: `Follow-up due: ${recipientName || recipientEmail}`,
    body: {
      contentType: "HTML",
      content: `<div style="font-family:sans-serif;font-size:14px;color:#333">
        <p>You have a follow-up due:</p>
        <table style="border-collapse:collapse;margin:12px 0">
          <tr><td style="padding:4px 12px 4px 0;color:#888">To:</td><td><strong>${recipientName}</strong> (${recipientEmail})</td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#888">Property:</td><td>${propertyAddress || "N/A"}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#888">Draft subject:</td><td>"${draftSubject}"</td></tr>
        </table>
        <p><a href="${APP_URL}" style="display:inline-block;padding:8px 16px;background:#dc2626;color:#fff;text-decoration:none;border-radius:6px;font-size:13px">Open Dashboard to Review &amp; Send</a></p>
        <p style="font-size:12px;color:#999;margin-top:16px">This is an automated reminder from GMCC Property Search.</p>
      </div>`,
    },
    toRecipients: [{ emailAddress: { address: userEmail } }],
  });
}

export async function GET(req: NextRequest) {
  // Verify cron secret (Vercel auto-sets this for cron routes)
  const authHeader = req.headers.get("Authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: "Firestore not configured" }, { status: 503 });
  }

  const now = Date.now();

  // Check once if application Graph credentials are available
  const canCheckReplies = await isAutoSendAvailable();

  let processed = 0;
  let errors = 0;
  let autoSent = 0;
  let replied = 0;

  // Step 1: Check replies for ALL sent emails (not just follow-up ones)
  // This tracks reply status for every email in the dashboard
  if (canCheckReplies) {
    // Get all emails that haven't been marked as replied yet
    const allEmails = await db.collection("sentEmails")
      .limit(300)
      .get();

    for (const doc of allEmails.docs) {
      const data = doc.data();
      if (!data.userEmail || !data.recipientEmail) continue;

      // Skip if already marked as replied
      if (data.followUp?.status === "replied") continue;
      if (data.hasReply === true) continue;

      try {
        const hasReply = await checkForReply(data.userEmail, data.subject, data.recipientEmail, data.sentAt);
        if (hasReply) {
          if (data.followUp) {
            // Has follow-up: mark follow-up as replied (stops the sequence)
            await doc.ref.update({ "followUp.status": "replied", hasReply: true });
          } else {
            // No follow-up: just mark the reply flag
            await doc.ref.update({ hasReply: true });
          }
          replied++;
        }
      } catch { /* continue */ }
    }
  }

  // Step 2: Re-query pending follow-ups FRESH (excludes items marked replied in Step 1)
  const pendingSnapshot = await db
    .collection("sentEmails")
    .where("followUp.status", "==", "pending")
    .limit(200)
    .get();

  // Filter to only due items, exclude any with hasReply flag
  const dueDocs = pendingSnapshot.docs.filter((doc) => {
    const data = doc.data();
    if (data.hasReply) return false;
    const fu = data.followUp;
    return fu && fu.scheduledAt <= now;
  });

  if (dueDocs.length === 0) {
    return NextResponse.json({ processed: 0, replied, total: 0 });
  }

  for (const doc of dueDocs) {
    const data = doc.data();
    const followUp = data.followUp;
    if (!followUp) continue;

    try {
      // Reply check already done above for all pending items

      const daysSinceSent = Math.round((now - data.sentAt) / (24 * 60 * 60 * 1000));
      const followUpNumber = followUp.reminderCount + 1;

      // Step 2: Generate AI draft
      const baseUrl = process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : "http://localhost:3000";

      const draftRes = await fetch(`${baseUrl}/api/follow-up/generate-draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          originalSubject: data.subject,
          originalBodyPreview: data.bodyPreview,
          recipientName: data.recipientName,
          recipientType: data.recipientType,
          programNames: data.programNames,
          propertyAddress: data.propertyAddress,
          daysSinceSent,
          followUpNumber,
          loName: (data.userEmail && data.userEmail.includes("@")) ? data.userEmail.split("@")[0] : "Loan Officer",
        }),
      });

      if (!draftRes.ok) {
        errors++;
        continue;
      }

      const draft = (await draftRes.json()) as { subject?: string; body?: string };
      if (!draft.subject || !draft.body) {
        errors++;
        continue;
      }

      // Calculate next follow-up schedule
      const nextDaysIdx = Math.min(followUpNumber, ESCALATION_DAYS.length - 1);
      const nextScheduledAt = now + ESCALATION_DAYS[nextDaysIdx] * 24 * 60 * 60 * 1000;

      // Step 3: Handle based on mode
      const updates: Record<string, unknown> = {
        "followUp.draftSubject": draft.subject,
        "followUp.draftBody": draft.body,
        "followUp.reminderCount": followUpNumber,
        "followUp.lastReminderAt": now,
      };

      if (followUp.mode === "auto-send" && data.userEmail) {
        // Try to find the original message for same-thread reply
        const threadIds = await getOriginalMessageIds(
          data.userEmail, data.subject, data.recipientEmail,
        ).catch(() => null);

        // Auto-send: send the follow-up in the same thread as the original
        const message: import("@/lib/graph-client").GraphMessage = {
          subject: threadIds ? `Re: ${data.subject}` : draft.subject,
          body: { contentType: "Text", content: draft.body },
          toRecipients: [
            {
              emailAddress: {
                address: data.recipientEmail,
                name: data.recipientName || undefined,
              },
            },
          ],
        };

        // Add threading headers so email appears in same conversation
        if (threadIds) {
          message.conversationId = threadIds.conversationId;
          message.internetMessageHeaders = [
            { name: "In-Reply-To", value: threadIds.internetMessageId },
            { name: "References", value: threadIds.internetMessageId },
          ];
        }

        const sendResult = await sendMailAs(data.userEmail, message);

        if (sendResult.ok) {
          autoSent++;
          if (followUpNumber >= 3) {
            // Final follow-up sent — mark as sent (done)
            updates["followUp.status"] = "sent";
          } else {
            // Schedule next follow-up, keep as pending
            updates["followUp.scheduledAt"] = nextScheduledAt;
          }
        } else {
          console.error("[cron] Auto-send failed:", sendResult.error);
          // Fall back to remind mode so user sees it in dashboard
          updates["followUp.mode"] = "remind";
          updates["followUp.scheduledAt"] = nextScheduledAt;
        }
      } else {
        // Remind mode: save draft, send reminder email to LO if Graph is available
        if (data.userEmail && canCheckReplies) {
          await sendReminderToLO(
            data.userEmail,
            data.recipientName,
            data.recipientEmail,
            data.propertyAddress,
            draft.subject,
          ).catch(() => {}); // don't fail the whole flow if reminder fails
        }
        if (followUpNumber >= 3) {
          updates["followUp.status"] = "dismissed";
        } else {
          updates["followUp.scheduledAt"] = nextScheduledAt;
        }
      }

      await doc.ref.update(updates);
      processed++;
    } catch {
      errors++;
    }
  }

  return NextResponse.json({ processed, errors, autoSent, replied, total: dueDocs.length });
}

/**
 * Core follow-up recording logic — shared by the API route and the agent tool.
 */

import { getDb, verifyIdToken } from "@/lib/firestore-admin";

export interface RecordFollowUpInput {
  firebaseToken: string;
  userEmail: string;
  recipientEmail: string;
  recipientName?: string;
  recipientType?: "realtor" | "borrower";
  subject: string;
  body?: string;
  propertyAddress?: string;
  programNames?: string[];
  followUpDays?: number;
  followUpMode?: "remind" | "auto-send";
}

export interface RecordFollowUpResult {
  id: string;
  followUp: {
    mode: string;
    scheduledAt: number;
    status: string;
  } | null;
}

export async function recordFollowUp(
  input: RecordFollowUpInput,
): Promise<RecordFollowUpResult> {
  const uid = await verifyIdToken(input.firebaseToken);
  if (!uid) throw new Error("Invalid Firebase token");

  const db = getDb();
  if (!db) throw new Error("Firestore not configured");

  const now = Date.now();
  const rawDays = Number(input.followUpDays);
  const followUpDays =
    Number.isFinite(rawDays) && rawDays >= 1 && rawDays <= 180 ? rawDays : null;
  const followUpMode = input.followUpMode === "auto-send" ? "auto-send" : "remind";

  const doc = {
    userId: uid,
    userEmail: input.userEmail || "",
    recipientEmail: input.recipientEmail,
    recipientName: input.recipientName || "",
    recipientType: input.recipientType || "realtor",
    subject: input.subject,
    bodyPreview: (input.body || "").slice(0, 500),
    propertyAddress: input.propertyAddress || "",
    programNames: input.programNames || [],
    sentAt: now,
    followUp: followUpDays
      ? {
          mode: followUpMode,
          scheduledAt: now + followUpDays * 24 * 60 * 60 * 1000,
          status: "pending" as const,
          reminderCount: 0,
          lastReminderAt: null,
          draftSubject: null,
          draftBody: null,
        }
      : null,
  };

  const ref = await db.collection("sentEmails").add(doc);

  return {
    id: ref.id,
    followUp: doc.followUp
      ? { mode: doc.followUp.mode, scheduledAt: doc.followUp.scheduledAt, status: doc.followUp.status }
      : null,
  };
}

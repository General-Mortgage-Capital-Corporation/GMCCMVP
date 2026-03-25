import { type NextRequest, NextResponse } from "next/server";
import { getDb, verifyIdToken } from "@/lib/firestore-admin";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("Authorization");
  const idToken = authHeader?.replace("Bearer ", "");
  if (!idToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const uid = await verifyIdToken(idToken);
  if (!uid) {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: "Firestore not configured" }, { status: 503 });
  }

  const body = await req.json().catch(() => null);
  if (!body?.recipientEmail || !body?.subject) {
    return NextResponse.json({ error: "recipientEmail and subject are required" }, { status: 400 });
  }

  const now = Date.now();
  const rawDays = Number(body.followUpDays);
  const followUpDays = Number.isFinite(rawDays) && rawDays >= 1 && rawDays <= 180 ? rawDays : null;

  const followUpMode = body.followUpMode === "auto-send" ? "auto-send" : "remind";

  const doc = {
    userId: uid,
    userEmail: body.userEmail || "",
    recipientEmail: body.recipientEmail,
    recipientName: body.recipientName || "",
    recipientType: body.recipientType || "realtor",
    subject: body.subject,
    bodyPreview: (body.body || "").slice(0, 500),
    propertyAddress: body.propertyAddress || "",
    programNames: body.programNames || [],
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

  return NextResponse.json({ id: ref.id, followUp: doc.followUp });
}

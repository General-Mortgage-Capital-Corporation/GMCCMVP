import { type NextRequest, NextResponse } from "next/server";
import { getDb, verifyIdToken } from "@/lib/firestore-admin";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
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

  // status: "pending" | "sent" | "replied" | "dismissed" | "all" | "no-followup"
  const status = req.nextUrl.searchParams.get("status") || "pending";

  const snapshot = await db
    .collection("sentEmails")
    .where("userId", "==", uid)
    .limit(200)
    .get();

  let items = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

  if (status === "all") {
    // Return everything
  } else if (status === "all-replied") {
    // All emails with replies: followUp.status === "replied" OR hasReply === true
    items = items.filter((d: Record<string, unknown>) => {
      return d.hasReply === true || (d.followUp as { status?: string } | null)?.status === "replied";
    });
  } else if (status === "no-followup") {
    // Emails sent without follow-up enabled AND no reply detected
    items = items.filter((d: Record<string, unknown>) => !d.followUp && !d.hasReply);
  } else if (status === "pending") {
    items = items.filter((d: Record<string, unknown>) => {
      const fu = d.followUp as { status?: string } | null;
      return fu?.status === "pending";
    });
  } else {
    // "sent", "replied", "dismissed"
    items = items.filter((d: Record<string, unknown>) => {
      const fu = d.followUp as { status?: string } | null;
      return fu?.status === status;
    });
  }

  // Sort: pending by scheduledAt asc, others by sentAt desc
  items.sort((a: Record<string, unknown>, b: Record<string, unknown>) => {
    if (status === "pending") {
      const aAt = (a.followUp as { scheduledAt?: number })?.scheduledAt ?? 0;
      const bAt = (b.followUp as { scheduledAt?: number })?.scheduledAt ?? 0;
      return aAt - bAt;
    }
    return ((b.sentAt as number) ?? 0) - ((a.sentAt as number) ?? 0);
  });

  return NextResponse.json({ items: items.slice(0, 50) });
}

/** DELETE — clear all sent emails for the authenticated user */
export async function DELETE(req: NextRequest) {
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

  const snapshot = await db
    .collection("sentEmails")
    .where("userId", "==", uid)
    .limit(500)
    .get();

  if (snapshot.empty) {
    return NextResponse.json({ deleted: 0 });
  }

  const batch = db.batch();
  for (const doc of snapshot.docs) {
    batch.delete(doc.ref);
  }
  await batch.commit();

  return NextResponse.json({ deleted: snapshot.size });
}

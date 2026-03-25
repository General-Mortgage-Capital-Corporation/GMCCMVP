import { type NextRequest, NextResponse } from "next/server";
import { getDb, verifyIdToken } from "@/lib/firestore-admin";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("Authorization");
  const idToken = authHeader?.replace("Bearer ", "");
  if (!idToken) return NextResponse.json({ count: 0 });

  const uid = await verifyIdToken(idToken);
  if (!uid) return NextResponse.json({ count: 0 });

  const db = getDb();
  if (!db) return NextResponse.json({ count: 0 });

  const snapshot = await db
    .collection("sentEmails")
    .where("userId", "==", uid)
    .limit(200)
    .get();

  const now = Date.now();
  const dueCount = snapshot.docs.filter((doc) => {
    const fu = doc.data().followUp;
    return fu && fu.status === "pending" && fu.scheduledAt <= now;
  }).length;

  const pendingCount = snapshot.docs.filter((doc) => {
    const fu = doc.data().followUp;
    return fu && fu.status === "pending";
  }).length;

  return NextResponse.json({ due: dueCount, pending: pendingCount });
}

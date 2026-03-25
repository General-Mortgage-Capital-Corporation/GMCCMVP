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
  if (!body?.id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const docRef = db.collection("sentEmails").doc(body.id);
  const doc = await docRef.get();
  if (!doc.exists || doc.data()?.userId !== uid || !doc.data()?.followUp) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await docRef.update({ "followUp.status": "dismissed" });

  return NextResponse.json({ ok: true });
}

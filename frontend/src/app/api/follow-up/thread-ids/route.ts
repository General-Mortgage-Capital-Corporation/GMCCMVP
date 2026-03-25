import { type NextRequest, NextResponse } from "next/server";
import { verifyIdToken } from "@/lib/firestore-admin";
import { getOriginalMessageIds } from "@/lib/graph-client";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  // Auth check
  const authHeader = req.headers.get("Authorization");
  const idToken = authHeader?.replace("Bearer ", "");
  if (!idToken) return NextResponse.json({ threadIds: null });

  const uid = await verifyIdToken(idToken);
  if (!uid) return NextResponse.json({ threadIds: null });

  const body = await req.json().catch(() => null);
  if (!body?.userEmail || !body?.subject || !body?.recipientEmail) {
    return NextResponse.json({ threadIds: null });
  }

  const threadIds = await getOriginalMessageIds(
    body.userEmail,
    body.subject,
    body.recipientEmail,
  ).catch(() => null);

  return NextResponse.json({ threadIds });
}

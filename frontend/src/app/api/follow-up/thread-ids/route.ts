import { type NextRequest, NextResponse } from "next/server";
import { verifyIdToken } from "@/lib/firestore-admin";
import { getOriginalMessageIds } from "@/lib/graph-client";
import { unauthorized } from "@/lib/require-auth";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  // Auth check
  const authHeader = req.headers.get("Authorization");
  const idToken = authHeader?.replace("Bearer ", "");
  if (!idToken) return unauthorized();

  const uid = await verifyIdToken(idToken);
  if (!uid) return unauthorized();

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

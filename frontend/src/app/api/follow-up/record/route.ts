import { type NextRequest, NextResponse } from "next/server";
import { recordFollowUp } from "@/lib/services/follow-up";
import { verifyIdToken } from "@/lib/firestore-admin";
import { unauthorized } from "@/lib/require-auth";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("Authorization");
  const idToken = authHeader?.replace("Bearer ", "");
  if (!idToken) return unauthorized();
  // Verify token (previously only checked for presence — fixed in API hardening)
  const uid = await verifyIdToken(idToken);
  if (!uid) return unauthorized();

  const body = await req.json().catch(() => null);
  if (!body?.recipientEmail || !body?.subject) {
    return NextResponse.json({ error: "recipientEmail and subject are required" }, { status: 400 });
  }

  try {
    const result = await recordFollowUp({
      firebaseToken: idToken,
      userEmail: body.userEmail || "",
      recipientEmail: body.recipientEmail,
      recipientName: body.recipientName,
      recipientType: body.recipientType,
      subject: body.subject,
      body: body.body,
      propertyAddress: body.propertyAddress,
      programNames: body.programNames,
      followUpDays: body.followUpDays,
      followUpMode: body.followUpMode,
    });

    return NextResponse.json({ id: result.id, followUp: result.followUp });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to record follow-up";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

import { type NextRequest, NextResponse } from "next/server";
import { generateEmailDraft } from "@/lib/services/email-draft";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body?.recipientType || !body?.userPrompt) {
    return NextResponse.json({ error: "recipientType and userPrompt are required." }, { status: 400 });
  }

  try {
    const result = await generateEmailDraft({
      recipientType: body.recipientType,
      recipientName: body.realtorName,
      recipientEmail: body.realtorEmail,
      programName: body.programName,
      propertyAddress: body.propertyAddress,
      listingPrice: body.listingPrice,
      loName: body.loName,
      userPrompt: body.userPrompt,
      realtorResearch: body.realtorResearch,
      hasSignature: !!body.hasSignature,
    });

    return NextResponse.json(result);
  } catch (err) {
    console.error("[suggest-email] error:", err);
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Failed to generate email suggestion: ${msg}` }, { status: 502 });
  }
}

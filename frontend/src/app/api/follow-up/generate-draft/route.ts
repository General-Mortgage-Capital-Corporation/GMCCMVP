import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "";
const GEMINI_MODEL = "gemini-2.5-flash";

interface DraftRequest {
  originalSubject: string;
  originalBodyPreview: string;
  recipientName: string;
  recipientType: "realtor" | "borrower";
  programNames: string[];
  propertyAddress: string;
  daysSinceSent: number;
  followUpNumber: number;
  loName: string;
}

export async function POST(req: NextRequest) {
  if (!GEMINI_API_KEY) {
    return NextResponse.json({ error: "AI not configured" }, { status: 503 });
  }

  const body = (await req.json().catch(() => null)) as DraftRequest | null;
  if (!body?.originalSubject) {
    return NextResponse.json({ error: "originalSubject is required" }, { status: 400 });
  }

  const toneGuide =
    body.followUpNumber <= 1
      ? "Gentle and friendly — a casual check-in. Don't be pushy."
      : body.followUpNumber === 2
        ? "Polite but more direct — express genuine interest in connecting."
        : "Final follow-up — mention this is your last note, create soft urgency without pressure.";

  const prompt = `You are a loan officer named ${body.loName} following up on an email you sent to a ${body.recipientType} named ${body.recipientName}.

Original email subject: "${body.originalSubject}"
Original email preview: "${body.originalBodyPreview}"
Property: ${body.propertyAddress || "N/A"}
Programs discussed: ${body.programNames.join(", ") || "N/A"}
Days since original email: ${body.daysSinceSent}
This is follow-up #${body.followUpNumber}.

Tone: ${toneGuide}

Rules:
- Keep it 2-4 sentences MAX. No fluff, no filler.
- Sound like a real person texting a colleague, not a marketing bot.
- Reference the property or program naturally so they remember the context.
- Do NOT start with "I hope this email finds you well" or any cliché opener.
- Do NOT repeat the original email content — just nudge.
- Vary the subject line — don't just add "Re:" or "Following up on".

Return JSON only: {"subject": "...", "body": "..."}
Use \\n for line breaks in the body. Do not include a signature — one will be appended automatically.`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.6, maxOutputTokens: 4000, thinkingConfig: { thinkingBudget: 0 } },
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );

    if (!res.ok) {
      return NextResponse.json({ error: "AI request failed" }, { status: 502 });
    }

    const data = await res.json();
    // Gemini 2.5 may return thinking + text parts — concatenate all text parts
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const rawText: string = parts
      .filter((p: Record<string, unknown>) => typeof p.text === "string")
      .map((p: { text: string }) => p.text)
      .join("")
      .trim();
    // Strip markdown code blocks if present
    const text = rawText.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
    console.log("[generate-draft] Gemini text:", text.slice(0, 300));

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error("[generate-draft] No JSON found. Raw parts:", JSON.stringify(parts).slice(0, 500));
      return NextResponse.json({ error: "Could not parse AI response" }, { status: 502 });
    }

    const parsed = JSON.parse(jsonMatch[0]) as { subject: string; body: string };
    return NextResponse.json({ subject: parsed.subject, body: parsed.body });
  } catch {
    return NextResponse.json({ error: "AI draft generation failed" }, { status: 500 });
  }
}

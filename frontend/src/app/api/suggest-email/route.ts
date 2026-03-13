import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "";
const GEMINI_MODEL = "gemini-2.5-flash";

export async function POST(req: NextRequest) {
  if (!GEMINI_API_KEY) {
    return NextResponse.json({ error: "AI suggestions not configured." }, { status: 503 });
  }

  const body = await req.json().catch(() => null);
  if (!body?.recipientType || !body?.userPrompt) {
    return NextResponse.json({ error: "recipientType and userPrompt are required." }, { status: 400 });
  }

  const {
    recipientType,
    userPrompt,
    programName,
    propertyAddress,
    listingPrice,
    realtorName,
    realtorEmail,
    loName,
  } = body as Record<string, string>;

  const recipientLabel =
    recipientType === "realtor" ? `a real estate agent named ${realtorName || "the agent"}` :
    recipientType === "borrower" ? "a prospective home buyer (borrower)" :
    "themselves (self-reference note)";

  const priceFormatted = listingPrice
    ? `$${Number(listingPrice).toLocaleString()}`
    : "price not specified";

  const prompt = `You are helping a mortgage loan officer at GMCC (General Mortgage Capital Corporation) write a professional email.

Context:
- Loan Officer: ${loName || "the loan officer"} at GMCC
- Recipient: ${recipientLabel}${realtorEmail ? ` (${realtorEmail})` : ""}
- Property: ${propertyAddress || "property address not specified"}, listed at ${priceFormatted}
- GMCC Loan Program: ${programName || "GMCC program"}
- A PDF flier for this program will be attached to the email

The loan officer's instructions: ${userPrompt}

Write a concise, professional email. Keep it brief (2–4 short paragraphs). Include an appropriate salutation (e.g. "Hi [Name]," or "Dear [Name],") at the top and a professional closing (e.g. "Best regards,\\n${loName || "the loan officer"}") at the bottom.

Respond ONLY with valid JSON in this exact format (no markdown, no code block):
{"subject":"...","body":"..."}

The body should be plain text with line breaks using \\n.`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.5, maxOutputTokens: 5000 },
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({})) as { error?: { message?: string } };
      const detail = errBody.error?.message ?? `Gemini HTTP ${res.status}`;
      return NextResponse.json({ error: `AI service error: ${detail}` }, { status: 502 });
    }

    const data = await res.json() as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

    // Strip markdown code blocks if Gemini wraps the JSON
    const cleaned = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
    const parsed = JSON.parse(cleaned) as { subject: string; body: string };

    return NextResponse.json({ subject: parsed.subject, body: parsed.body });
  } catch (err) {
    console.error("[suggest-email] error:", err);
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Failed to generate email suggestion: ${msg}` }, { status: 502 });
  }
}

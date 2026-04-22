import { type NextRequest, NextResponse } from "next/server";
import { stripSignOff } from "@/lib/services/email-draft";

export const runtime = "nodejs";
export const maxDuration = 45;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "";
const GEMINI_MODEL = "gemini-2.5-flash";

interface RequestBody {
  recipientType: "realtor" | "borrower";
  userPrompt: string;
  programs: string[];
  summary: string; // multi-program summary from explain-multi
  propertyAddress?: string;
  listingPrice?: string;
  realtorName?: string;
  realtorEmail?: string;
  realtorCompany?: string;
  loName?: string;
  hasSignature?: boolean;
  realtorResearch?: string;
}

export async function POST(req: NextRequest) {
  if (!GEMINI_API_KEY) {
    return NextResponse.json({ error: "AI not configured." }, { status: 503 });
  }

  const body = (await req.json().catch(() => null)) as RequestBody | null;
  if (!body?.recipientType || !body?.userPrompt || !body?.programs?.length) {
    return NextResponse.json(
      { error: "recipientType, userPrompt, and programs are required." },
      { status: 400 },
    );
  }

  const {
    recipientType,
    userPrompt,
    programs,
    summary,
    propertyAddress,
    listingPrice,
    realtorName,
    realtorEmail,
    realtorCompany,
    loName,
    hasSignature,
    realtorResearch,
  } = body;

  const recipientLabel =
    recipientType === "realtor"
      ? `a real estate agent named ${realtorName || "the agent"}${realtorCompany ? ` at ${realtorCompany}` : ""}`
      : "a prospective home buyer (borrower)";

  const priceFormatted = listingPrice
    ? `$${Number(listingPrice).toLocaleString()}`
    : "price not specified";

  const researchBlock = realtorResearch
    ? `\n\nResearch on the recipient:\n${realtorResearch}\n\nPersonalization guidance: Use the research to make a genuine connection to the programs being marketed. For example, if the agent works in areas where these programs are strong, or serves a client base that would benefit, connect those dots naturally. Pick the most relevant detail — don't force it or list everything.`
    : "";

  const prompt = `You are helping a mortgage loan officer at GMCC (General Mortgage Capital Corporation) write an email marketing multiple loan programs together.

Context:
- Loan Officer: ${loName || "the loan officer"} at GMCC
- Recipient: ${recipientLabel}${realtorEmail ? ` (${realtorEmail})` : ""}
- Property: ${propertyAddress || "property not specified"}, listed at ${priceFormatted}
- Programs being marketed: ${programs.join(", ")}
- PDF flyers for each program will be attached to the email

Multi-Program Summary (use this as your source for program details and marketing hooks):
${summary || "No summary provided — focus on the programs listed above."}${researchBlock}

The loan officer's instructions: ${userPrompt}

Tone: Professional but warm and conversational — like a knowledgeable colleague reaching out, not a corporate mass email. Write like a real person, not a template.

Write a concise email (2–4 short paragraphs). Use compelling one-liners from the summary for each program — do NOT dump all details. Include an appropriate salutation.
${hasSignature ? "Do NOT include a closing signature or sign-off — the loan officer's email signature will be appended automatically." : `Include a professional closing with the LO's name. Also include a brief professional signature block with the LO's name, title "Loan Officer", and company "GMCC (General Mortgage Capital Corporation)".`}

Mention that ${programs.length} program flyers are attached for their review.

Respond ONLY with valid JSON in this exact format (no markdown, no code block):
{"subject":"...","body":"..."}

The body should be plain text with line breaks using \\n.`;

  try {
    const requestBody: Record<string, unknown> = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.5, maxOutputTokens: 5000 },
    };

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(30_000),
      },
    );

    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      return NextResponse.json(
        { error: `AI error: ${errBody.error?.message ?? res.status}` },
        { status: 502 },
      );
    }

    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

    // Strip markdown code blocks if Gemini wraps the JSON
    const cleaned = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
    let parsed: { subject: string; body: string };
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return NextResponse.json(
        { error: "AI returned invalid response. Please try again." },
        { status: 502 },
      );
    }

    return NextResponse.json({
      subject: parsed.subject,
      body: hasSignature ? stripSignOff(parsed.body) : parsed.body,
      searched: !!realtorResearch,
    });
  } catch (err) {
    console.error("[suggest-multi-email] error:", err);
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Failed to generate email: ${msg}` },
      { status: 502 },
    );
  }
}

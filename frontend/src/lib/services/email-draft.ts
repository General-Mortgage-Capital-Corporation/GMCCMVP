/**
 * Core email draft generation logic — shared by the API route and the agent tool.
 * Calls Gemini directly (no HTTP round-trip).
 */

const GEMINI_MODEL = "gemini-2.5-flash";

/**
 * Strip trailing sign-offs that the LLM adds despite being told not to.
 * Matches common patterns like "Best regards,\nName", "Sincerely,\nName Title",
 * "Warm regards,\nName\nTitle\nCompany\nPhone", etc.
 */
export function stripSignOff(body: string): string {
  // Common sign-off openers (case-insensitive)
  const signoffs = [
    "best regards", "best", "regards", "warm regards", "kind regards",
    "sincerely", "thanks", "thank you", "many thanks", "cheers",
    "looking forward", "talk soon", "take care",
    "with appreciation", "respectfully", "cordially",
  ];

  const lines = body.split("\n");

  // Scan from the bottom up to find where the sign-off block starts.
  // A sign-off is: a line matching a known phrase (optionally followed by comma),
  // followed by 0+ lines of name/title/company/phone/email/NMLS junk.
  let cutIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue; // skip trailing blank lines

    const lower = trimmed.toLowerCase().replace(/[,.:!]+$/, "").trim();
    if (signoffs.includes(lower)) {
      cutIndex = i;
      break;
    }

    // If this line looks like name/title/contact info trailing after a sign-off,
    // keep scanning upward. But stop if we hit a line that looks like real content
    // (longer than ~60 chars or contains question marks / multiple sentences).
    if (trimmed.length > 60 || trimmed.includes("?") || (trimmed.match(/\./g) || []).length > 1) {
      break;
    }
  }

  if (cutIndex === -1) return body;

  // Remove the sign-off and everything below it, then trim trailing whitespace
  return lines.slice(0, cutIndex).join("\n").replace(/\s+$/, "");
}

export interface EmailDraftInput {
  recipientType: "realtor" | "borrower";
  recipientName?: string;
  recipientEmail?: string;
  programName?: string;
  propertyAddress?: string;
  listingPrice?: string;
  loName?: string;
  userPrompt: string;
  realtorResearch?: string;
  hasSignature: boolean;
}

export interface EmailDraftResult {
  subject: string;
  body: string;
}

export async function generateEmailDraft(input: EmailDraftInput): Promise<EmailDraftResult> {
  const apiKey = process.env.GEMINI_API_KEY ?? "";
  if (!apiKey) throw new Error("GEMINI_API_KEY not configured");

  const recipientLabel =
    input.recipientType === "realtor"
      ? `a real estate agent named ${input.recipientName || "the agent"}`
      : input.recipientType === "borrower"
        ? "a prospective home buyer (borrower)"
        : "themselves (self-reference note)";

  const priceFormatted = input.listingPrice
    ? `$${Number(input.listingPrice).toLocaleString()}`
    : "price not specified";

  const researchBlock = input.realtorResearch
    ? `\n\nResearch on the recipient:\n${input.realtorResearch}\n\nPersonalization guidance: Use the research to make a genuine connection to the loan program being marketed. For example, if the agent specializes in an area where this program shines, mention that. If they work with first-time buyers and the program suits that, connect those dots. Pick the most relevant detail — don't force it or list everything.`
    : "";

  const prompt = `You are helping a mortgage loan officer at GMCC (General Mortgage Capital Corporation) write an email.

Context:
- Loan Officer: ${input.loName || "the loan officer"} at GMCC
- Recipient: ${recipientLabel}${input.recipientEmail ? ` (${input.recipientEmail})` : ""}
- Property: ${input.propertyAddress || "property address not specified"}, listed at ${priceFormatted}
- GMCC Loan Program: ${input.programName || "GMCC program"}
- A PDF flier for this program will be attached to the email${researchBlock}

The loan officer's instructions: ${input.userPrompt}

Tone: Professional but warm and conversational — like a knowledgeable colleague reaching out, not a corporate mass email. Write like a real person, not a template.

Write a concise email (2–4 short paragraphs). Include an appropriate salutation (e.g. "Hi [Name],") at the top.
${input.hasSignature ? 'Do NOT include ANY closing sign-off, "Best regards", "Sincerely", "Best", "Thanks", signature block, name, title, phone, or company info at the end. End with your last content sentence or question. The loan officer\'s complete email signature and GMCC compliance disclaimer will be appended automatically — adding any sign-off would duplicate it.' : `Include a professional closing (e.g. "Best regards,\\n${input.loName || "the loan officer"}") at the bottom. Also include a brief professional signature block with the LO's name, title "Loan Officer", and company "GMCC (General Mortgage Capital Corporation)".`}

Respond ONLY with valid JSON in this exact format (no markdown, no code block):
{"subject":"...","body":"..."}

The body should be plain text with line breaks using \\n.`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.5, maxOutputTokens: 5000 },
      }),
      signal: AbortSignal.timeout(90_000),
    },
  );

  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(errBody.error?.message ?? `Gemini HTTP ${res.status}`);
  }

  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  const cleaned = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();

  let parsed: { subject: string; body: string };
  try {
    parsed = JSON.parse(cleaned) as { subject: string; body: string };
  } catch {
    throw new Error(`Failed to parse email draft — model returned invalid JSON: ${cleaned.slice(0, 120)}`);
  }

  if (!parsed.subject || !parsed.body) {
    throw new Error("Email draft missing subject or body");
  }

  return {
    subject: parsed.subject,
    body: input.hasSignature ? stripSignOff(parsed.body) : parsed.body,
  };
}

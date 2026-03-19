import { type NextRequest, NextResponse } from "next/server";
import { pyPost } from "@/lib/python-client";

export const runtime = "nodejs";
export const maxDuration = 60;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "";
const GEMINI_MODEL = "gemini-2.5-flash";
const CLOUD_FUNCTIONS_BASE = "https://us-central1-gmcc-66e1e.cloudfunctions.net";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProgramInput {
  name: string;
  tier_name?: string;
  product_id?: string; // for fetching unfilled flyer PDF
}

interface RequestBody {
  programs: ProgramInput[];
  listing: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fetch an unfilled (previewMode) PDF from the Cloud Function. */
async function fetchFlyerTemplate(
  productId: string,
  userId: string,
  authHeader: string,
): Promise<{ productId: string; base64: string } | null> {
  try {
    const res = await fetch(`${CLOUD_FUNCTIONS_BASE}/fillPdfFlier`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body: JSON.stringify({
        productId,
        data: { loanOfficer: { userId } },
        previewMode: true,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    // Convert to base64 for Gemini inline_data
    const bytes = new Uint8Array(buf);
    let binary = "";
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return { productId, base64: btoa(binary) };
  } catch {
    return null;
  }
}

/** Build text context from a program's JSON rules. */
function buildProgramContext(name: string, rules: Record<string, unknown>): string {
  const lines: string[] = [`## ${name}`];

  const notes = rules.general_notes as string[] | undefined;
  if (notes?.length) {
    lines.push("Program Notes:");
    for (const n of notes) lines.push(`- ${n}`);
  }

  const tiers = rules.tiers as Record<string, unknown>[] | undefined;
  if (tiers?.length) {
    for (const t of tiers) {
      const tierName = (t.tier_name as string) ?? "Tier";
      const add = (t.additional_rules ?? {}) as Record<string, unknown>;
      const desc = add.description as string | undefined;
      const incentive = add.cra_incentive as string | undefined;
      lines.push(`\nTier: ${tierName}`);
      if (desc) lines.push(`Description: ${desc}`);
      if (incentive) lines.push(`CRA Incentive: ${incentive}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  if (!GEMINI_API_KEY) {
    return NextResponse.json({ error: "AI not configured." }, { status: 503 });
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  const body = (await req.json().catch(() => null)) as RequestBody | null;
  if (!body?.programs?.length || !body.listing) {
    return NextResponse.json(
      { error: "programs and listing are required." },
      { status: 400 },
    );
  }

  const { programs, listing } = body;

  try {
    // 1. Fetch program rules from Flask
    const rulesRes = await pyPost<{
      success: boolean;
      rules: Record<string, Record<string, unknown>>;
    }>("/api/program-rules", {
      programs: programs.map((p) => p.name),
    });

    // 2. Fetch unfilled flyer PDFs in parallel (only for programs that have a productId)
    const userId = "preview@gmccloan.com"; // generic ID for preview mode
    const flyerPromises = programs
      .filter((p) => p.product_id && authHeader.startsWith("Bearer "))
      .map((p) => fetchFlyerTemplate(p.product_id!, userId, authHeader));
    const flyerResults = await Promise.all(flyerPromises);
    const flyerMap = new Map<string, string>(); // productId → base64
    for (const r of flyerResults) {
      if (r) flyerMap.set(r.productId, r.base64);
    }

    // 3. Build listing summary
    const listingSummary = Object.fromEntries(
      Object.entries(listing).filter(([k]) =>
        [
          "formattedAddress", "price", "propertyType", "state", "county",
          "zipCode", "bedrooms", "bathrooms", "squareFootage",
        ].includes(k),
      ),
    );

    // 4. Build Gemini request with text + inline PDF parts
    const programContexts = programs
      .map((p) => buildProgramContext(p.name, rulesRes.rules[p.name] ?? {}))
      .join("\n\n---\n\n");

    const textPrompt = `You are a mortgage marketing expert at GMCC (General Mortgage Capital Corporation). A loan officer wants to market the following programs together for a specific property.

**Property:**
${JSON.stringify(listingSummary, null, 2)}

**Program Rules:**
${programContexts}

${flyerMap.size > 0 ? `**Flyer Context:** ${flyerMap.size} program flyer PDF(s) are attached below. These are marketing templates — some fields show placeholders (e.g. loan officer name, property address) that get filled in for each client. Focus on the program descriptions, benefits, and key selling points shown in the flyers.\n` : ""}
**Instructions:**
Generate a unified marketing summary for a loan officer to use when pitching these ${programs.length} programs together.

For each program:
1. Write a compelling one-liner marketing hook (the kind you'd put in a subject line or opening pitch)
2. List 2-3 key selling points specific to this program

Then write a brief combined value proposition (2-3 sentences) explaining why this combination of programs makes the loan officer a strong partner for realtors.

**Tone:** Professional, persuasive, concise. Think marketing material, not legal documentation.
**Format:** Use markdown with headers for each program.`;

    // Build Gemini parts array
    const parts: Record<string, unknown>[] = [{ text: textPrompt }];

    // Add flyer PDFs as inline data
    for (const p of programs) {
      if (p.product_id && flyerMap.has(p.product_id)) {
        parts.push({
          inline_data: {
            mime_type: "application/pdf",
            data: flyerMap.get(p.product_id),
          },
        });
      }
    }

    // 5. Call Gemini
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { temperature: 0.6, maxOutputTokens: 8000 },
        }),
        signal: AbortSignal.timeout(45_000),
      },
    );

    if (!geminiRes.ok) {
      const err = (await geminiRes.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      return NextResponse.json(
        { error: `AI error: ${err.error?.message ?? geminiRes.status}` },
        { status: 502 },
      );
    }

    const data = (await geminiRes.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const summary = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

    if (!summary) {
      return NextResponse.json(
        { error: "AI returned an empty summary. Please try again." },
        { status: 502 },
      );
    }

    return NextResponse.json({
      summary,
      programs_used: programs.map((p) => p.name),
      flyers_included: [...flyerMap.keys()],
    });
  } catch (err) {
    console.error("[explain-multi] error:", err);
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Failed to generate summary: ${msg}` }, { status: 502 });
  }
}

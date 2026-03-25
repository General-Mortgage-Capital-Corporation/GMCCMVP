import { type NextRequest, NextResponse } from "next/server";
import {
  getCachedRealtorResearch,
  setCachedRealtorResearch,
  type AgentResearch,
} from "@/lib/redis-cache";

export const runtime = "nodejs";
export const maxDuration = 120;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "";
const GEMINI_MODEL = "gemini-2.5-flash";

export async function POST(req: NextRequest) {
  if (!GEMINI_API_KEY) {
    return NextResponse.json({ error: "AI not configured" }, { status: 503 });
  }

  const body = await req.json().catch(() => null);
  if (!body?.name && !body?.email && !body?.company) {
    return NextResponse.json({ error: "name, email, or company required" }, { status: 400 });
  }

  const name: string = body.name || "";
  const email: string = body.email || "";
  const company: string = body.company || "";
  const city: string = body.city || "";
  const state: string = body.state || "";
  const forceRefresh: boolean = body.forceRefresh === true;

  // Check cache first
  if (!forceRefresh) {
    const cached = await getCachedRealtorResearch(name, email, company);
    if (cached) {
      return NextResponse.json({ research: cached, cached: true });
    }
  }

  const searchTarget = name || email || company;
  const isCompanyOnly = !name && !email && !!company;
  const entityType = isCompanyOnly ? "real estate company/builder" : "real estate agent";

  const prompt = `Search for this ${entityType}: ${searchTarget}${company && !isCompanyOnly ? ` at ${company}` : ""}${city || state ? ` in ${[city, state].filter(Boolean).join(", ")}` : ""}.

Find their specialties, experience, reviews, and any personalizable details. Be honest if you can't find them. Return JSON only:
{"summary":"...","specialties":[],"yearsActive":null,"recentActivity":"Unknown","designations":[],"reviews":null,"linkedinSnippet":null,"personalHooks":[],"sources":[],"confidence":"low"}`;

  // Helper to parse Gemini response into AgentResearch
  function parseGeminiResponse(data: Record<string, unknown>): AgentResearch | null {
    const parts = (data.candidates as { content?: { parts?: { text?: string }[] } }[])?.[0]?.content?.parts ?? [];
    const text = parts.map((p) => p.text ?? "").join("").trim();
    if (!text) return null;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    try {
      return JSON.parse(jsonMatch[0]) as AgentResearch;
    } catch {
      return null;
    }
  }

  function sanitize(r: AgentResearch, hasSources: boolean): AgentResearch {
    return {
      summary: r.summary || "No information found.",
      specialties: Array.isArray(r.specialties) ? r.specialties : [],
      yearsActive: typeof r.yearsActive === "number" ? r.yearsActive : null,
      recentActivity: r.recentActivity || "Unknown",
      designations: Array.isArray(r.designations) ? r.designations : [],
      reviews: typeof r.reviews === "string" ? r.reviews : r.reviews ? JSON.stringify(r.reviews) : null,
      linkedinSnippet: typeof r.linkedinSnippet === "string" ? r.linkedinSnippet : r.linkedinSnippet ? JSON.stringify(r.linkedinSnippet) : null,
      personalHooks: Array.isArray(r.personalHooks) ? r.personalHooks.map((h) => typeof h === "string" ? h : JSON.stringify(h)) : [],
      sources: hasSources && Array.isArray(r.sources) ? r.sources.map((s) => typeof s === "string" ? s : JSON.stringify(s)) : [],
      confidence: ["high", "medium", "low"].includes(r.confidence) ? r.confidence : "low",
    };
  }

  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const headers = { "Content-Type": "application/json" };

  // Attempt 1: With google_search grounding (best quality, but can be slow/flaky)
  let research: AgentResearch | null = null;
  try {
    const res = await fetch(geminiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 3000 },
        tools: [{ google_search: {} }],
      }),
      signal: AbortSignal.timeout(110_000),
    });

    if (res.ok) {
      const data = await res.json();
      research = parseGeminiResponse(data);
    } else {
      const errBody = await res.json().catch(() => ({})) as { error?: { message?: string } };
      console.error("[realtor-research] Gemini search error:", errBody.error?.message ?? res.status);
    }
  } catch (err) {
    console.error("[realtor-research] Search attempt failed:", err instanceof Error ? err.message : "unknown");
  }

  // Attempt 2: Without google_search (faster, uses training data only)
  if (!research) {
    console.log("[realtor-research] Falling back to non-search model...");
    try {
      const res = await fetch(geminiUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 2000 },
        }),
        signal: AbortSignal.timeout(60_000),
      });

      if (res.ok) {
        const data = await res.json();
        research = parseGeminiResponse(data);
        // Mark as low confidence since no live search
        if (research) research.confidence = "low";
      }
    } catch (err) {
      console.error("[realtor-research] Fallback also failed:", err instanceof Error ? err.message : "unknown");
    }
  }

  if (!research) {
    return NextResponse.json({ error: "Research failed — Gemini unavailable" }, { status: 502 });
  }

  const sanitized = sanitize(research, true);
  await setCachedRealtorResearch(name, email, company, sanitized);
  return NextResponse.json({ research: sanitized, cached: false });
}

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
    // Filter to only parts with text (skip thought parts)
    const rawText = parts
      .filter((p: Record<string, unknown>) => typeof p.text === "string")
      .map((p: Record<string, unknown>) => p.text as string)
      .join("")
      .trim();
    if (!rawText) return null;
    // Strip markdown code blocks
    const text = rawText.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    try {
      return JSON.parse(jsonMatch[0]) as AgentResearch;
    } catch {
      // Try to fix truncated JSON by closing open braces/brackets
      let fixed = jsonMatch[0];
      const openBraces = (fixed.match(/\{/g) || []).length;
      const closeBraces = (fixed.match(/\}/g) || []).length;
      const openBrackets = (fixed.match(/\[/g) || []).length;
      const closeBrackets = (fixed.match(/\]/g) || []).length;
      // Remove trailing incomplete value (after last comma or colon)
      fixed = fixed.replace(/,\s*"[^"]*"?\s*:?\s*"?[^"]*$/, "");
      fixed = fixed.replace(/,\s*$/, "");
      for (let i = 0; i < openBrackets - closeBrackets; i++) fixed += "]";
      for (let i = 0; i < openBraces - closeBraces; i++) fixed += "}";
      try {
        return JSON.parse(fixed) as AgentResearch;
      } catch {
        return null;
      }
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
  const t1 = Date.now();
  try {
    const res = await fetch(geminiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 3000, thinkingConfig: { thinkingBudget: 0 } },
        tools: [{ google_search: {} }],
      }),
      signal: AbortSignal.timeout(110_000),
    });

    if (res.ok) {
      const data = await res.json();
      // Log raw response structure for debugging
      const rawParts = data.candidates?.[0]?.content?.parts ?? [];
      const partTypes = rawParts.map((p: Record<string, unknown>) => Object.keys(p).join(","));
      console.log(`[realtor-research] Gemini responded in ${Date.now() - t1}ms, parts: [${partTypes.join(" | ")}]`);
      research = parseGeminiResponse(data);
      if (research) {
        console.log(`[realtor-research] Search grounding parsed successfully`);
      } else {
        // Log what we got so we can debug parse failures
        const allText = rawParts.map((p: { text?: string }) => p.text ?? "").join("").slice(0, 200);
        console.error(`[realtor-research] Parse failed. Text preview: "${allText}"`);
      }
    } else {
      const errBody = await res.json().catch(() => ({})) as { error?: { message?: string } };
      console.error(`[realtor-research] Gemini search returned HTTP ${res.status} after ${Date.now() - t1}ms:`, errBody.error?.message ?? "no details");
    }
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : "unknown";
    console.error(`[realtor-research] Search attempt exception after ${Date.now() - t1}ms:`, msg);
  }

  // Attempt 2: Without google_search (faster, uses training data only)
  if (!research) {
    const t2 = Date.now();
    console.log("[realtor-research] Falling back to non-search model...");
    try {
      const res = await fetch(geminiUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 2000, thinkingConfig: { thinkingBudget: 0 } },
        }),
        signal: AbortSignal.timeout(60_000),
      });

      if (res.ok) {
        const data = await res.json();
        research = parseGeminiResponse(data);
        if (research) {
          research.confidence = "low";
          console.log(`[realtor-research] Fallback succeeded in ${Date.now() - t2}ms`);
        } else {
          const rawParts = data.candidates?.[0]?.content?.parts ?? [];
          const allText = rawParts.map((p: { text?: string }) => p.text ?? "").join("").slice(0, 200);
          console.error(`[realtor-research] Fallback parse failed. Text: "${allText}"`);
        }
      } else {
        console.error(`[realtor-research] Fallback HTTP ${res.status} after ${Date.now() - t2}ms`);
      }
    } catch (err) {
      console.error(`[realtor-research] Fallback exception after ${Date.now() - t2}ms:`, err instanceof Error ? err.message : "unknown");
    }
  }

  if (!research) {
    return NextResponse.json({ error: "Research failed — Gemini unavailable" }, { status: 502 });
  }

  const sanitized = sanitize(research, true);
  await setCachedRealtorResearch(name, email, company, sanitized);
  return NextResponse.json({ research: sanitized, cached: false });
}

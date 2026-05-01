import { type NextRequest, NextResponse } from "next/server";
import { rateLimit, getClientIp } from "@/lib/ratelimit";
import { verifyIdTokenWithEmail } from "@/lib/firestore-admin";
import type { PricingScenario, PricingResult, RateRow } from "@/types/pricing";

export const runtime = "nodejs";
export const maxDuration = 60;

const GEMINI_MODEL = "gemini-2.5-flash";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface PostBody {
  messages?: ChatMessage[];
  scenario?: PricingScenario;
  results?: PricingResult[];
  scenario_summary?: string;
  defaults_applied?: string[];
}

const SYSTEM_INSTRUCTION = `You are a senior pricing analyst helping a GMCC mortgage loan officer compare quotes across multiple pricing engines (Loannex, gmcc_processor for QM Jumbo, BWS for Buy-Without-Sell programs). The user is technical and time-pressured. They want answers, not preambles.

What you have access to:
- The borrower scenario (loan amount, FICO, LTV, occupancy, doc type, etc.)
- The list of fields that the aggregator filled with default values (defaults_applied) — these are fields the LO did NOT explicitly set, so the aggregator used "vanilla" assumptions like clean credit, no buydown, US citizen, etc.
- A SUMMARY of per-program results: best Loannex variant per family (with variant_count), full top-rate ladders for QM and BWS programs, and ineligibility reasons.

You also have function-calling tools to fetch deeper data on demand:
- get_program_full_details — full rate ladder + all conditions for ONE specific program row (use the exact program name).
- get_loannex_family_variants — all variants (mortgage products) under a Loannex family, with their headlines and top rates.
- search_by_product_type — find programs matching a product type like "30Y Fixed", "5/6 ARM", "7/6 ARM".

When to use tools:
- Use them ONLY when the user's question can't be answered from the summary above.
- Do NOT call tools just to be thorough — the summary covers the common cases (best rate, comparisons, ineligibility, conditions).
- DO call tools when: the user asks about a specific Loannex variant inside a family, asks for ALL rates at a specific rate point, asks to compare across product types in detail, or asks about a rate that's not in the top-N shown.

Hard rules:
- ONLY use numbers, programs, and reasons from data you've actually been given. NEVER invent rates, points, eligibility rules, or assumptions.
- When the user asks "best", "lowest", or "compare", quote EXACT rate, price (par=100.000), and cost/rebate points.
- For Loannex programs: many rows are different mortgage products (5/6 ARM, 7/6 ARM, 30Y Fixed, 15Y Fixed, etc.) under the same program family. Always name the specific product when quoting a Loannex rate.
- When the user asks about ineligibility, restate the reasons verbatim and translate any jargon.
- When the user asks "did it assume X?" or "what's assumed?", reference the defaults_applied list. Explain that any field not in defaults_applied was explicitly set by the LO.
- Use markdown for clarity (bullets, bold for headline numbers). No heading levels above ###. Typical responses are 3-8 lines.
- If the user asks about closing costs, MI, taxes, or anything not in the rate ladder, say so honestly: "the rate ladder doesn't include that — the LE will."`;

// ---------------------------------------------------------------------------
// Tool implementations — operate on the in-memory results array for this turn
// ---------------------------------------------------------------------------

interface ToolContext {
  results: PricingResult[];
}

function tool_get_program_full_details(args: { program_name: string }, ctx: ToolContext) {
  const target = args.program_name?.trim();
  if (!target) return { error: "program_name required" };
  const match =
    ctx.results.find((r) => r.program === target) ||
    ctx.results.find((r) => r.program.toLowerCase() === target.toLowerCase()) ||
    ctx.results.find((r) => r.program.toLowerCase().includes(target.toLowerCase()));
  if (!match) {
    return { error: `No program found matching "${args.program_name}"`, available: ctx.results.map((r) => r.program).slice(0, 30) };
  }
  return {
    program: match.program,
    engine: match.engine,
    status: match.status,
    headline: match.headline,
    rates: match.rates ?? [],
    conditions: match.conditions ?? [],
    reasons: match.reasons,
    error_code: match.error_code,
    error_message: match.error_message,
    rate_sheet_as_of: match.rate_sheet_as_of,
    stale_days: match.stale_days,
  };
}

function tool_get_loannex_family_variants(args: { family_name: string }, ctx: ToolContext) {
  const target = (args.family_name || "").toLowerCase().trim();
  if (!target) return { error: "family_name required" };
  const variants = ctx.results.filter((r) => {
    if (r.engine !== "loannex" || r.status !== "eligible") return false;
    const { family } = splitProgramName(r.program);
    return family.toLowerCase().includes(target) || target.includes(family.toLowerCase());
  });
  if (variants.length === 0) {
    const families = Array.from(
      new Set(
        ctx.results
          .filter((r) => r.engine === "loannex" && r.status === "eligible")
          .map((r) => splitProgramName(r.program).family),
      ),
    );
    return { error: `No Loannex family matching "${args.family_name}"`, available_families: families };
  }
  return {
    family_name: splitProgramName(variants[0].program).family,
    variant_count: variants.length,
    variants: variants.map((r) => ({
      program: r.program,
      product: splitProgramName(r.program).product,
      headline: r.headline,
      rates: (r.rates ?? []).slice().sort((a, b) => a.rate - b.rate).slice(0, 10),
      conditions: r.conditions ?? [],
    })),
  };
}

function tool_search_by_product_type(args: { product_type: string }, ctx: ToolContext) {
  const target = (args.product_type || "").toLowerCase().trim();
  if (!target) return { error: "product_type required" };
  const matches = ctx.results.filter((r) => {
    if (r.status !== "eligible") return false;
    return r.program.toLowerCase().includes(target);
  });
  return {
    product_type: args.product_type,
    match_count: matches.length,
    programs: matches.slice(0, 25).map((r) => ({
      program: r.program,
      engine: r.engine,
      headline: r.headline,
      top_rates: (r.rates ?? []).slice().sort((a, b) => a.rate - b.rate).slice(0, 3),
    })),
  };
}

const TOOL_DECLARATIONS = [
  {
    name: "get_program_full_details",
    description:
      "Return the full rate ladder, conditions, and metadata for ONE specific program result row. Use when you need rates not present in the summary.",
    parameters: {
      type: "object" as const,
      properties: {
        program_name: {
          type: "string" as const,
          description: "Exact or partial program name as it appears in the results (e.g. 'Cronus', 'Easy Choice — Full Documentation — 5/6 ARM (30 Yr. Term)').",
        },
      },
      required: ["program_name"],
    },
  },
  {
    name: "get_loannex_family_variants",
    description:
      "Return all variants (different mortgage products like 5/6 ARM, 7/6 ARM, 30Y Fixed) under a single Loannex program family, with their full rate ladders.",
    parameters: {
      type: "object" as const,
      properties: {
        family_name: {
          type: "string" as const,
          description: "The Loannex program family name (the part before the em-dash separator). Examples: 'Easy Choice', 'Onyx', 'DSCR'.",
        },
      },
      required: ["family_name"],
    },
  },
  {
    name: "search_by_product_type",
    description:
      "Find all eligible programs whose name contains a product type. Useful for cross-program comparison ('show me everything in 30Y Fixed').",
    parameters: {
      type: "object" as const,
      properties: {
        product_type: {
          type: "string" as const,
          description: "A product or term identifier. Examples: '30Y Fixed', '15Y Fixed', '5/6 ARM', '7/6 ARM', '10/6 ARM', 'DSCR', 'Interest Only'.",
        },
      },
      required: ["product_type"],
    },
  },
];

type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

function executeTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Record<string, unknown> {
  try {
    switch (name) {
      case "get_program_full_details":
        return tool_get_program_full_details(args as { program_name: string }, ctx);
      case "get_loannex_family_variants":
        return tool_get_loannex_family_variants(args as { family_name: string }, ctx);
      case "search_by_product_type":
        return tool_search_by_product_type(args as { product_type: string }, ctx);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function compactRate(row: RateRow): string {
  const cost =
    row.cost_points > 0
      ? `${row.cost_points.toFixed(3)} cost`
      : row.rebate_points > 0
        ? `${row.rebate_points.toFixed(3)} rebate`
        : "par";
  const targetMark = row.in_target_band ? " ★" : "";
  return `${row.rate.toFixed(3)}% @ ${row.price.toFixed(3)} (${cost}, ${row.lock_days}d)${targetMark}`;
}

function splitProgramName(name: string): { family: string; product: string } {
  const emdash = name.lastIndexOf(" — ");
  if (emdash > -1) return { family: name.slice(0, emdash).trim(), product: name.slice(emdash + 3).trim() };
  const parts = name.split(" - ");
  if (parts.length > 2) {
    const product = parts[parts.length - 1].trim();
    const family = parts.slice(0, -1).join(" - ").trim();
    return { family, product };
  }
  return { family: name, product: "" };
}

function summarizeResultsForLLM(
  results: PricingResult[],
  scenario: PricingScenario | undefined,
  scenarioSummary: string,
  defaultsApplied: string[],
): string {
  const lines: string[] = [];
  lines.push("=== SCENARIO ===");
  lines.push(scenarioSummary);
  if (scenario) {
    lines.push("Full scenario JSON:");
    lines.push(JSON.stringify(scenario, null, 2));
  }
  if (defaultsApplied.length > 0) {
    lines.push("");
    lines.push("=== DEFAULTS APPLIED BY AGGREGATOR ===");
    lines.push(
      "These fields were not explicitly set by the LO; the aggregator used conservative defaults (clean credit, no buydown, vanilla case):",
    );
    lines.push(defaultsApplied.map((d) => `- ${d}`).join("\n"));
  }
  lines.push("");
  lines.push("=== RESULTS ===");

  // Group Loannex by family so we don't blow the prompt with 350 rows
  const loannexEligible = results.filter((r) => r.engine === "loannex" && r.status === "eligible");
  const otherEligible = results.filter((r) => r.engine !== "loannex" && r.status === "eligible");

  // Loannex: per family, summarize best variant + variant count
  if (loannexEligible.length > 0) {
    const families = new Map<string, PricingResult[]>();
    for (const r of loannexEligible) {
      const { family } = splitProgramName(r.program);
      if (!families.has(family)) families.set(family, []);
      families.get(family)!.push(r);
    }
    lines.push(`-- Loannex: ${families.size} program families, ${loannexEligible.length} variants total --`);
    for (const [family, rows] of families) {
      // Best variant = lowest headline rate
      const sorted = rows.slice().sort((a, b) => (a.headline?.best_rate ?? 99) - (b.headline?.best_rate ?? 99));
      const best = sorted[0];
      const head = best.headline;
      lines.push(`• ${family} — variant_count: ${rows.length}`);
      if (head) {
        lines.push(`  best variant: ${best.program}`);
        lines.push(`    headline: ${head.best_rate.toFixed(3)}% / ${head.best_points.toFixed(3)} pts / ${head.best_lock_days}d lock`);
        const top = (best.rates ?? []).slice().sort((a, b) => a.rate - b.rate).slice(0, 5);
        if (top.length) lines.push(`    top rates: ${top.map(compactRate).join(" | ")}`);
      }
      if (rows.length > 1) {
        const otherProducts = sorted.slice(1, 5).map((r) => splitProgramName(r.program).product || r.program);
        lines.push(`  other products in family: ${otherProducts.join(", ")}${rows.length > 5 ? "…" : ""}`);
      }
    }
  }

  // QM Jumbo + BWS: full ladder (capped)
  for (const r of otherEligible) {
    const head = r.headline;
    lines.push(`• ${r.program} [${r.engine}] — ELIGIBLE`);
    if (head) lines.push(`  headline: ${head.best_rate.toFixed(3)}% / ${head.best_points.toFixed(3)} pts / ${head.best_lock_days}d`);
    const top = (r.rates ?? []).slice().sort((a, b) => a.rate - b.rate).slice(0, 8);
    if (top.length) lines.push(`  rates: ${top.map(compactRate).join(" | ")}`);
    if (r.conditions?.length) lines.push(`  conditions: ${r.conditions.join("; ")}`);
    if (r.stale_days != null && r.stale_days > 0) {
      lines.push(`  rate sheet ${r.stale_days}d stale (as of ${r.rate_sheet_as_of ?? "unknown"})`);
    }
  }

  // Ineligible / errors
  for (const r of results) {
    if (r.status === "ineligible") {
      lines.push(`• ${r.program} [${r.engine}] — INELIGIBLE: ${(r.reasons ?? []).join("; ")}`);
    } else if (r.status === "error") {
      lines.push(`• ${r.program} [${r.engine}] — ERROR (${r.error_code ?? "unknown"}): ${r.error_message ?? ""}`);
    } else if (r.status === "unavailable") {
      lines.push(`• ${r.program} [${r.engine}] — UNAVAILABLE`);
    }
  }
  return lines.join("\n");
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  if (!rateLimit(`pricing-chat:${ip}`, 30)) {
    return NextResponse.json(
      { error: "Rate limit exceeded." },
      { status: 429 },
    );
  }

  // Auth — same Firebase ID token check as the quote route. Without this,
  // anyone could hit /api/pricing/chat with arbitrary results[] payloads
  // and burn Gemini quota.
  const authHeader = req.headers.get("authorization") ?? "";
  const idToken = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : "";
  if (!idToken) {
    return NextResponse.json({ error: "Sign-in required." }, { status: 401 });
  }
  const verified = await verifyIdTokenWithEmail(idToken);
  if (!verified?.email) {
    return NextResponse.json({ error: "Your session expired. Sign in again." }, { status: 401 });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Chat is not configured." }, { status: 503 });
  }

  const body = (await req.json().catch(() => null)) as PostBody | null;
  if (!body?.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return NextResponse.json({ error: "messages[] required" }, { status: 400 });
  }
  if (!body.results || !Array.isArray(body.results)) {
    return NextResponse.json({ error: "results[] required" }, { status: 400 });
  }

  const summary = summarizeResultsForLLM(
    body.results,
    body.scenario,
    body.scenario_summary ?? "",
    body.defaults_applied ?? [],
  );

  const userMessages = body.messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-10);

  const contents: GeminiContent[] = userMessages.map((m) => ({
    role: m.role === "user" ? "user" : "model",
    parts: [{ text: m.content }],
  }));

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const ctx: ToolContext = { results: body.results };
  const MAX_TOOL_ROUNDS = 3;

  // Tool loop: model may call functions; we execute and feed back. Cap at
  // MAX_TOOL_ROUNDS rounds to avoid infinite tool-spam.
  let finalText = "";
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    let geminiRes: Response;
    try {
      geminiRes = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: {
            parts: [
              {
                text: `${SYSTEM_INSTRUCTION}\n\n--- PRICING DATA (read-only context) ---\n${summary}\n--- END DATA ---`,
              },
            ],
          },
          contents,
          tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 1500 },
        }),
        signal: AbortSignal.timeout(45_000),
      });
    } catch {
      return NextResponse.json({ error: "Chat service timed out." }, { status: 504 });
    }

    if (!geminiRes.ok) {
      const text = await geminiRes.text().catch(() => "");
      return NextResponse.json(
        { error: `Chat service error: ${text.slice(0, 200) || geminiRes.status}` },
        { status: 502 },
      );
    }

    const data = (await geminiRes.json().catch(() => null)) as
      | { candidates?: { content?: GeminiContent }[] }
      | null;
    const candidate = data?.candidates?.[0]?.content;
    if (!candidate) {
      return NextResponse.json({ error: "Empty response from chat service." }, { status: 502 });
    }

    const parts = candidate.parts ?? [];
    const functionCalls = parts.flatMap((p) =>
      "functionCall" in p ? [p.functionCall] : [],
    );
    const textParts = parts.flatMap((p) => ("text" in p ? [p.text] : []));

    if (functionCalls.length === 0) {
      finalText = textParts.join("\n").trim();
      break;
    }

    if (round === MAX_TOOL_ROUNDS) {
      // Hit the cap — return whatever text the model gave (likely empty),
      // or a graceful fallback so the UI isn't stuck.
      finalText =
        textParts.join("\n").trim() ||
        "I needed more data than I could fetch in one turn. Try rephrasing or expanding a program card to see the full ladder.";
      break;
    }

    // Append the model's tool-call turn, then a user turn with results.
    contents.push({ role: "model", parts });
    const responseParts: GeminiPart[] = functionCalls.map((call) => ({
      functionResponse: {
        name: call.name,
        response: executeTool(call.name, call.args ?? {}, ctx),
      },
    }));
    contents.push({ role: "user", parts: responseParts });
  }

  if (!finalText) {
    return NextResponse.json({ error: "Empty response from chat service." }, { status: 502 });
  }

  return NextResponse.json({ reply: finalText });
}

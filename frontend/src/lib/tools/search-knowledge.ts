import { tool } from "ai";
import { z } from "zod";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

// Directories
const KNOWLEDGE_DIR = join(process.cwd(), "..", "data", "knowledge");
const PROGRAMS_DIR = join(process.cwd(), "..", "data", "programs");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface KnowledgeChunk {
  source: string;
  heading: string;
  content: string;
}

interface ProgramTier {
  tier_name?: string;
  additional_rules?: {
    description?: string;
    cra_incentive?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface ProgramJson {
  program_name: string;
  qm_status?: string;
  general_notes?: string[];
  tiers?: ProgramTier[];
}

// ---------------------------------------------------------------------------
// Cache (loaded once per cold start)
// ---------------------------------------------------------------------------

let _cache: KnowledgeChunk[] | null = null;

function loadAllKnowledge(): KnowledgeChunk[] {
  if (_cache) return _cache;

  const chunks: KnowledgeChunk[] = [];

  // 1. Load markdown knowledge files (marketing guidance, objection handling, etc.)
  try {
    const mdFiles = readdirSync(KNOWLEDGE_DIR).filter((f) => f.endsWith(".md"));
    for (const file of mdFiles) {
      try {
        const content = readFileSync(join(KNOWLEDGE_DIR, file), "utf-8");
        const source = file.replace(".md", "");
        const sections = content.split(/^(#{1,3}\s+.+)$/m);
        let currentHeading = source;

        for (const section of sections) {
          const trimmed = section.trim();
          if (!trimmed) continue;
          if (trimmed.startsWith("#")) {
            currentHeading = trimmed.replace(/^#+\s*/, "");
          } else if (trimmed.length > 20) {
            chunks.push({ source: `guide: ${source}`, heading: currentHeading, content: trimmed });
          }
        }
      } catch (e) { console.warn(`[knowledge] Failed to read ${file}:`, e); }
    }
  } catch { /* knowledge dir may not exist */ }

  // 2. Load program JSON files — extract general_notes and tier descriptions
  try {
    const jsonFiles = readdirSync(PROGRAMS_DIR).filter((f) => f.endsWith(".json") && !f.includes("tract"));
    for (const file of jsonFiles) {
      try {
        const raw = readFileSync(join(PROGRAMS_DIR, file), "utf-8");
        const program = JSON.parse(raw) as ProgramJson;
        const name = program.program_name;

        // General notes as one chunk
        if (program.general_notes && program.general_notes.length > 0) {
          chunks.push({
            source: `program: ${name}`,
            heading: `${name} — General Notes`,
            content: program.general_notes.join("\n"),
          });
        }

        // QM status
        if (program.qm_status) {
          chunks.push({
            source: `program: ${name}`,
            heading: `${name} — QM Status`,
            content: `${name} is a ${program.qm_status} program.`,
          });
        }

        // Each tier's description and CRA incentive
        if (program.tiers) {
          for (const tier of program.tiers) {
            const parts: string[] = [];
            if (tier.tier_name) parts.push(`Tier: ${tier.tier_name}`);
            if (tier.additional_rules?.description) {
              parts.push(tier.additional_rules.description);
            }
            if (tier.additional_rules?.cra_incentive) {
              parts.push(`CRA Incentive: ${tier.additional_rules.cra_incentive}`);
            }
            // Include key eligibility facts
            const facts: string[] = [];
            if (tier.max_loan_amount) facts.push(`Max loan: $${(tier.max_loan_amount as number).toLocaleString()}`);
            if (tier.min_loan_amount) facts.push(`Min loan: $${(tier.min_loan_amount as number).toLocaleString()}`);
            if (tier.max_ltv) facts.push(`Max LTV: ${tier.max_ltv}%`);
            if (tier.min_fico) facts.push(`Min FICO: ${tier.min_fico}`);
            if (tier.max_dti) facts.push(`Max DTI: ${tier.max_dti}%`);
            if (facts.length > 0) parts.push(facts.join(", "));

            if (parts.length > 0) {
              chunks.push({
                source: `program: ${name}`,
                heading: `${name} — ${tier.tier_name ?? "Tier Details"}`,
                content: parts.join("\n"),
              });
            }
          }
        }
      } catch (e) { console.warn(`[knowledge] Failed to parse ${file}:`, e); }
    }
  } catch { /* programs dir may not exist */ }

  _cache = chunks;
  return chunks;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function searchChunks(query: string, topK: number = 8): KnowledgeChunk[] {
  const chunks = loadAllKnowledge();
  if (chunks.length === 0) return [];

  const queryTerms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2);

  const scored = chunks.map((chunk) => {
    const text = `${chunk.source} ${chunk.heading} ${chunk.content}`.toLowerCase();
    let score = 0;
    for (const term of queryTerms) {
      // Exact word boundary match scores higher
      const exactRegex = new RegExp(`\\b${term}\\b`, "gi");
      const exactMatches = text.match(exactRegex);
      if (exactMatches) score += exactMatches.length * 2;

      // Partial match
      const partialRegex = new RegExp(term, "gi");
      const partialMatches = text.match(partialRegex);
      if (partialMatches) score += partialMatches.length;
    }
    return { chunk, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((s) => s.chunk);
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const searchKnowledgeTool = tool({
  description:
    "Search the GMCC knowledge base for program details, selling points, CRA incentives, " +
    "eligibility rules, marketing guidance, objection handling, and program comparisons. " +
    "This searches BOTH program rule data (general notes, tier descriptions, incentives) " +
    "AND marketing guides (how to pitch, email tone, objection handling). " +
    "Use this when you need detailed information about any GMCC program or marketing advice.",
  inputSchema: z.object({
    query: z.string().describe(
      "What to search for — program name, feature, or topic. " +
      "Examples: 'DSCR program details', 'buy without sell first', 'CRA incentive jumbo', " +
      "'objection handling', 'how to pitch to realtors', 'Diamond CRA selling points'",
    ),
  }),
  execute: async ({ query }) => {
    const results = searchChunks(query);

    if (results.length === 0) {
      return {
        found: 0,
        message: "No matching knowledge found. Try different keywords.",
        results: [],
      };
    }

    return {
      found: results.length,
      results: results.map((r) => ({
        source: r.source,
        heading: r.heading,
        content: r.content.slice(0, 1500),
      })),
    };
  },
});

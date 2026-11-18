/**
 * Context hygiene for the marketing agent's tool loop.
 *
 * Long conversations (especially campaigns) accumulate large tool outputs —
 * 100-row search previews, match tables, research blobs — and every step
 * re-sends ALL of it to the model. That balloons cost and latency and
 * eventually degrades tool-calling quality.
 *
 * `pruneModelMessages` runs in `prepareStep`: the most recent tool results
 * stay verbatim (the model usually needs only what it just fetched); older
 * results above a size threshold are replaced with a short text stub. The
 * tool-call/tool-result pairing is preserved (Gemini rejects histories where
 * function calls and responses don't match up) — only the result PAYLOAD is
 * stubbed, never removed. Any server-side refs (datasetRef "ds-…",
 * campaign "cmp-…") found in a trimmed payload are kept in the stub, so the
 * datasetRef pipeline keeps working across the trim.
 */
import type { ModelMessage } from "ai";

/** Most recent tool results kept verbatim. */
const KEEP_RECENT_TOOL_RESULTS = 8;

/** Older results serialized larger than this get stubbed. */
const MAX_OLD_RESULT_CHARS = 1500;

/** Server-side handles worth preserving through a trim. */
const REF_RE = /\b(?:ds|cmp)-[a-z0-9]{4,}\b|\bflyer-[a-z0-9]+\b|\bcsv-[a-z0-9]+\b/gi;

function serializeOutput(output: unknown): string {
  try {
    return typeof output === "string" ? output : JSON.stringify(output) ?? "";
  } catch {
    return "";
  }
}

export function pruneModelMessages(messages: ModelMessage[]): ModelMessage[] {
  // Count tool results so we can keep the most recent N verbatim.
  let total = 0;
  for (const m of messages) {
    if (m.role === "tool" && Array.isArray(m.content)) {
      total += m.content.filter((p) => p.type === "tool-result").length;
    }
  }
  if (total <= KEEP_RECENT_TOOL_RESULTS) return messages;
  const cutoff = total - KEEP_RECENT_TOOL_RESULTS;

  let seen = 0;
  let anyChanged = false;
  const out = messages.map((m) => {
    if (m.role !== "tool" || !Array.isArray(m.content)) return m;
    let msgChanged = false;
    const content = m.content.map((p) => {
      if (p.type !== "tool-result") return p;
      const idx = seen++;
      if (idx >= cutoff) return p;

      const serialized = serializeOutput(p.output);
      if (serialized.length <= MAX_OLD_RESULT_CHARS) return p;

      const refs = [...new Set(serialized.match(REF_RE) ?? [])].slice(0, 6);
      msgChanged = true;
      return {
        ...p,
        output: {
          type: "text" as const,
          value:
            `[Older ${p.toolName} result trimmed to save context.` +
            (refs.length
              ? ` Server-side refs from it are still usable: ${refs.join(", ")}.`
              : "") +
            ` Re-run the tool if you need the details again.]`,
        },
      };
    });
    if (!msgChanged) return m;
    anyChanged = true;
    return { ...m, content } as ModelMessage;
  });

  return anyChanged ? out : messages;
}

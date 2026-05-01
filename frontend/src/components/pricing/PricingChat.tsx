"use client";

import { useEffect, useRef, useState } from "react";
import MarkdownText from "@/components/chat/MarkdownText";
import LoadingSpinner from "@/components/LoadingSpinner";
import type { PricingResult, PricingScenario } from "@/types/pricing";

interface Props {
  results: PricingResult[];
  scenario: PricingScenario;
  scenarioSummary: string;
  defaultsApplied?: string[];
}

interface ChatMsg {
  role: "user" | "assistant";
  content: string;
}

const STARTER_PROMPTS = [
  "Which program has the lowest rate at par?",
  "Which has the cheapest cost-to-buy-down to the lowest rate?",
  "Are there any conditions I should warn the borrower about?",
  "Why are the ineligible programs ineligible?",
];

export default function PricingChat({ results, scenario, scenarioSummary, defaultsApplied }: Props) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  // Reset chat when results change (new scenario submitted)
  useEffect(() => {
    setMessages([]);
    setError(null);
  }, [results]);

  async function send(prompt: string) {
    const trimmed = prompt.trim();
    if (!trimmed || loading) return;
    const next = [...messages, { role: "user" as const, content: trimmed }];
    setMessages(next);
    setInput("");
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/pricing/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: next,
          results,
          scenario,
          scenario_summary: scenarioSummary,
          defaults_applied: defaultsApplied ?? [],
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? `Chat failed (${res.status})`);
        setMessages(messages); // roll back
        return;
      }
      const data = (await res.json()) as { reply: string };
      setMessages([...next, { role: "assistant", content: data.reply }]);
    } catch {
      setError("Couldn't reach the chat service.");
      setMessages(messages);
    } finally {
      setLoading(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    void send(input);
  }

  const showStarters = messages.length === 0 && !loading;

  return (
    <div className="flex h-full min-h-0 flex-col rounded-lg border border-slate-200 bg-white">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white px-4 py-2.5">
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path
                d="M8 1.5l1.6 4.4 4.4 1.6-4.4 1.6L8 13.5l-1.6-4.4L2 7.5l4.4-1.6L8 1.5z"
                fill="currentColor"
              />
            </svg>
          </div>
          <div>
            <div className="text-sm font-semibold text-slate-900">Ask about these quotes</div>
            <div className="text-[0.7rem] text-slate-500">Grounded in the results above</div>
          </div>
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3">
        {showStarters && (
          <div className="space-y-2">
            <p className="text-xs leading-relaxed text-slate-500">
              I can compare programs, explain ineligibility, or summarize the trade-offs.
              Try a starter or type your own:
            </p>
            <div className="flex flex-col gap-1.5">
              {STARTER_PROMPTS.map((p) => (
                <button
                  key={p}
                  onClick={() => void send(p)}
                  className="group rounded-md border border-slate-200 bg-white px-3 py-2 text-left text-xs text-slate-700 transition-colors hover:border-violet-300 hover:bg-violet-50/50"
                >
                  <span className="font-medium text-violet-600 transition-colors group-hover:text-violet-700">
                    →
                  </span>{" "}
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div
            key={i}
            className={`mb-3 ${m.role === "user" ? "flex justify-end" : ""}`}
          >
            {m.role === "user" ? (
              <div className="max-w-[85%] rounded-lg rounded-br-sm bg-red-600 px-3 py-2 text-sm text-white">
                {m.content}
              </div>
            ) : (
              <div className="max-w-full text-sm text-slate-800">
                <MarkdownText className="text-sm leading-relaxed">
                  {m.content}
                </MarkdownText>
              </div>
            )}
          </div>
        ))}

        {loading && (
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <LoadingSpinner size="sm" />
            <span>Thinking…</span>
          </div>
        )}

        {error && (
          <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            {error}
          </div>
        )}
      </div>

      {/* Composer */}
      <form
        onSubmit={handleSubmit}
        className="border-t border-slate-100 bg-slate-50/50 px-3 py-2"
      >
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={loading}
            placeholder="Ask anything about these quotes…"
            className="flex-1 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-900 outline-none transition focus:border-violet-400 focus:ring-2 focus:ring-violet-100 disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="inline-flex items-center justify-center rounded-md bg-gradient-to-br from-violet-600 to-fuchsia-600 px-3 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path
                d="M2 8l12-6-4 14-2-6-6-2z"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </form>
    </div>
  );
}

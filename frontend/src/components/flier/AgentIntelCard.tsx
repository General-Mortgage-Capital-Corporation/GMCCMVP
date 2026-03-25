"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { AgentResearch } from "@/lib/redis-cache";

interface AgentIntelCardProps {
  realtorName: string;
  realtorEmail: string;
  realtorCompany: string;
  city?: string;
  state?: string;
  /** Called when research completes — parent uses this for AI email context */
  onResearchComplete?: (research: AgentResearch | null) => void;
}

export default function AgentIntelCard({
  realtorName,
  realtorEmail,
  realtorCompany,
  city,
  state,
  onResearchComplete,
}: AgentIntelCardProps) {
  const [research, setResearch] = useState<AgentResearch | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [cached, setCached] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  const doResearch = useCallback(async (forceRefresh = false) => {
    if (!realtorName && !realtorEmail && !realtorCompany) return;

    // Abort any in-flight request (handles React strict mode double-invoke)
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(false);
    try {
      const res = await fetch("/api/realtor-research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: realtorName,
          email: realtorEmail,
          company: realtorCompany,
          city,
          state,
          forceRefresh,
        }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!res.ok) throw new Error();
      const data = await res.json() as { research: AgentResearch; cached: boolean };
      if (controller.signal.aborted) return;
      setResearch(data.research);
      setCached(data.cached);
      setError(false);
      onResearchComplete?.(data.research);
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return;
      setError(true);
      onResearchComplete?.(null);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [realtorName, realtorEmail, realtorCompany, city, state, onResearchComplete]);

  useEffect(() => {
    doResearch();
    return () => { abortRef.current?.abort(); };
  }, [doResearch]);

  if (!realtorName && !realtorEmail && !realtorCompany) return null;

  const confidenceColor =
    research?.confidence === "high" ? "text-emerald-600" :
    research?.confidence === "medium" ? "text-amber-600" : "text-gray-400";

  return (
    <div className="rounded-lg border border-indigo-100 bg-indigo-50/40">
      {/* Header — always visible */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between px-3 py-2"
      >
        <div className="flex items-center gap-2">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="text-indigo-500">
            <circle cx="8" cy="5" r="3" stroke="currentColor" strokeWidth="1.3" />
            <path d="M2 14c0-3.3 2.7-6 6-6s6 2.7 6 6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
          <span className="text-xs font-medium text-indigo-700">Agent Intel</span>
          {loading && <span className="text-[0.65rem] text-indigo-400">Researching…</span>}
          {research && !loading && (
            <span className={`text-[0.65rem] font-medium ${confidenceColor}`}>
              {research.confidence} confidence
            </span>
          )}
          {cached && !loading && (
            <span className="text-[0.6rem] text-gray-400">(cached)</span>
          )}
          {error && !loading && <span className="text-[0.65rem] text-red-500">Research unavailable</span>}
        </div>
        <svg
          width="12" height="12" viewBox="0 0 16 16" fill="none"
          className={`text-indigo-400 transition-transform ${expanded ? "rotate-180" : ""}`}
        >
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {/* Expanded content */}
      {expanded && research && (
        <div className="border-t border-indigo-100 px-3 pb-3 pt-2 space-y-2">
          <p className="text-xs text-gray-700 leading-relaxed">{research.summary}</p>

          {(research.specialties.length > 0 || research.designations.length > 0) && (
            <div className="flex flex-wrap gap-1">
              {research.designations.map((d) => (
                <span key={d} className="rounded-full bg-indigo-100 px-2 py-0.5 text-[0.65rem] font-semibold text-indigo-700">
                  {d}
                </span>
              ))}
              {research.specialties.map((s) => (
                <span key={s} className="rounded-full bg-gray-100 px-2 py-0.5 text-[0.65rem] text-gray-600">
                  {s}
                </span>
              ))}
            </div>
          )}

          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[0.65rem]">
            {research.yearsActive != null && (
              <div><span className="text-gray-400">Experience:</span> <span className="text-gray-700">{research.yearsActive} years</span></div>
            )}
            {research.recentActivity !== "Unknown" && (
              <div><span className="text-gray-400">Activity:</span> <span className="text-gray-700">{research.recentActivity}</span></div>
            )}
            {research.reviews && (
              <div className="col-span-2"><span className="text-gray-400">Reviews:</span> <span className="text-gray-700">{typeof research.reviews === "string" ? research.reviews : JSON.stringify(research.reviews)}</span></div>
            )}
          </div>

          {research.linkedinSnippet && (
            <div className="rounded bg-white/60 px-2 py-1.5">
              <span className="text-[0.6rem] font-medium text-gray-400">LinkedIn:</span>
              <p className="text-[0.65rem] text-gray-600">{typeof research.linkedinSnippet === "string" ? research.linkedinSnippet : JSON.stringify(research.linkedinSnippet)}</p>
            </div>
          )}

          {research.personalHooks.length > 0 && (
            <div>
              <span className="text-[0.6rem] font-medium text-gray-400">Personalization hooks:</span>
              <ul className="mt-0.5 space-y-0.5">
                {research.personalHooks.map((h, i) => (
                  <li key={i} className="text-[0.65rem] text-gray-600">• {h}</li>
                ))}
              </ul>
            </div>
          )}

          <p className="text-[0.6rem] italic text-amber-600/70">AI-generated research may be inaccurate. Verify details before referencing in emails.</p>

          <div className="flex items-center justify-between pt-1">
            {research.sources.length > 0 && (
              <span className="text-[0.6rem] text-gray-400">
                {research.sources.length} source{research.sources.length !== 1 ? "s" : ""} found
              </span>
            )}
            <button
              type="button"
              onClick={() => doResearch(true)}
              disabled={loading}
              className="text-[0.65rem] text-indigo-500 hover:text-indigo-700 disabled:opacity-50"
            >
              {loading ? "Researching…" : "Re-research"}
            </button>
          </div>
        </div>
      )}

      {expanded && loading && !research && (
        <div className="border-t border-indigo-100 px-3 pb-3 pt-2 space-y-2">
          <div className="h-3 w-full animate-pulse rounded bg-indigo-100" />
          <div className="h-3 w-3/4 animate-pulse rounded bg-indigo-100 [animation-delay:100ms]" />
          <div className="flex gap-1">
            <div className="h-4 w-16 animate-pulse rounded-full bg-indigo-100 [animation-delay:200ms]" />
            <div className="h-4 w-20 animate-pulse rounded-full bg-indigo-100 [animation-delay:300ms]" />
          </div>
        </div>
      )}
    </div>
  );
}

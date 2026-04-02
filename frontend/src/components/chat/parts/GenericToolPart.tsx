"use client";

import { useState } from "react";

const TOOL_LABELS: Record<string, string> = {
  searchProperties: "Property Search",
  matchPrograms: "Program Matching",
  lookupPrograms: "Program Lookup",
  researchRealtor: "Realtor Research",
  draftEmail: "Email Draft",
  generateFlyer: "Flyer Generation",
  sendEmail: "Sending Email",
  recordFollowUp: "Follow-Up Scheduled",
  searchKnowledge: "Knowledge Search",
  queryAdmiral: "Admiral AI Advisor",
  webSearch: "Web Search",
  generateCsv: "CSV Export",
  searchByProgram: "Program Coverage",
  checkCRAEligibility: "CRA Eligibility Check",
  searchSentEmails: "Sent Email Search",
};

interface GenericToolPartProps {
  toolName: string;
  state: string;
  toolCallId: string;
  output?: unknown;
}

export default function GenericToolPart({ toolName, state, output }: GenericToolPartProps) {
  const [expanded, setExpanded] = useState(false);
  const label = TOOL_LABELS[toolName] ?? toolName;
  const isLoading = state === "input-streaming" || state === "input-available";
  const isDone = state === "output-available";

  return (
    <div className="my-2 rounded-lg border border-gray-200 bg-gray-50">
      <button
        type="button"
        onClick={() => isDone && setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-xs"
        disabled={!isDone}
      >
        {isLoading ? (
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-red-400" />
        ) : (
          <svg width="12" height="12" viewBox="0 0 16 16" className="text-green-500 shrink-0">
            <path d="M13.5 4.5L6 12 2.5 8.5" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
        <span className="font-medium text-gray-700">{label}</span>
        {isDone && (
          <svg
            width="10"
            height="10"
            viewBox="0 0 16 16"
            className={`ml-auto text-gray-400 transition-transform ${expanded ? "rotate-180" : ""}`}
          >
            <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" />
          </svg>
        )}
      </button>
      {expanded && isDone && output != null && (
        <div className="border-t border-gray-100 px-3 py-2">
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-[0.65rem] text-gray-600">
            {typeof output === "string" ? output : JSON.stringify(output, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

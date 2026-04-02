"use client";

import { useState } from "react";

interface EmailPreviewPartProps {
  toolName: string;
  state: string;
  output?: unknown;
}

export default function EmailPreviewPart({ toolName, state, output }: EmailPreviewPartProps) {
  const [expanded, setExpanded] = useState(false);
  const isLoading = state === "input-streaming" || state === "input-available";
  const isDone = state === "output-available";

  const label = toolName === "draftEmail" ? "Email Draft" : "Sending Email";
  const icon = toolName === "sendEmail" ? "✉" : "✎";

  if (isLoading) {
    return (
      <div className="my-2 rounded-lg border border-gray-200 bg-gray-50 p-3">
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-red-400" />
          {toolName === "draftEmail" ? "Drafting email…" : "Sending email…"}
        </div>
      </div>
    );
  }

  if (!isDone || !output) return null;

  const data = output as Record<string, unknown>;

  // Error case
  if (data.error) {
    return (
      <div className="my-2 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">
        {label} failed: {String(data.error)}
      </div>
    );
  }

  // sendEmail success
  if (toolName === "sendEmail" && data.success) {
    const sentTo = String(data.sentTo ?? "");
    const sentSubject = data.subject ? String(data.subject) : "";
    return (
      <div className="my-2 rounded-lg border border-green-200 bg-green-50 p-3">
        <div className="flex items-center gap-2 text-xs text-green-700">
          <svg width="12" height="12" viewBox="0 0 16 16" className="shrink-0">
            <path d="M13.5 4.5L6 12 2.5 8.5" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Email sent to {sentTo}
        </div>
        {sentSubject && (
          <p className="mt-1 text-[0.65rem] text-green-600">Subject: {sentSubject}</p>
        )}
      </div>
    );
  }

  // draftEmail result — show subject + expandable body
  const subject = data.subject ? String(data.subject) : undefined;
  const body = data.body ? String(data.body) : undefined;

  if (!subject && !body) return null;

  return (
    <div className="my-2 rounded-lg border border-gray-200 bg-white">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-xs"
      >
        <span className="text-sm">{icon}</span>
        <span className="font-medium text-gray-700">{label}</span>
        {subject && (
          <span className="ml-1 truncate text-gray-500">— {subject}</span>
        )}
        <svg
          width="10"
          height="10"
          viewBox="0 0 16 16"
          className={`ml-auto shrink-0 text-gray-400 transition-transform ${expanded ? "rotate-180" : ""}`}
        >
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" />
        </svg>
      </button>
      {expanded && body && (
        <div className="border-t border-gray-100 px-3 py-2">
          {subject && (
            <p className="mb-2 text-xs font-medium text-gray-700">Subject: {subject}</p>
          )}
          <div className="whitespace-pre-wrap text-xs text-gray-600 leading-relaxed">
            {body}
          </div>
        </div>
      )}
    </div>
  );
}

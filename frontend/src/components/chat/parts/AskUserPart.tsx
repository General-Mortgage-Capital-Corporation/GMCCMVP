"use client";

import { useState } from "react";
import type { GmccAgentUIMessage } from "@/lib/agents/gmcc-agent";
import type { useChat } from "@ai-sdk/react";
import MarkdownText from "../MarkdownText";

type AddToolOutputFn = ReturnType<typeof useChat<GmccAgentUIMessage>>["addToolOutput"];

type AskUserToolPart = Extract<
  GmccAgentUIMessage["parts"][number],
  { type: "tool-askUser" }
>;

interface AskUserPartProps {
  part: AskUserToolPart;
  addToolOutput: AddToolOutputFn;
}

export default function AskUserPart({ part, addToolOutput }: AskUserPartProps) {
  const [response, setResponse] = useState("");
  const [submitted, setSubmitted] = useState(false);

  function handleSubmit() {
    const trimmed = response.trim();
    if (!trimmed || submitted) return;
    setSubmitted(true);
    addToolOutput({
      tool: "askUser",
      toolCallId: part.toolCallId,
      output: trimmed,
    });
  }

  if (part.state === "input-streaming") {
    return (
      <div className="my-2 rounded-lg border border-blue-200 bg-blue-50 p-3">
        <p className="text-xs text-blue-600">Preparing question…</p>
      </div>
    );
  }

  if (part.state === "output-available") {
    return (
      <div className="my-2 rounded-lg border border-blue-200 bg-blue-50 p-3">
        <div className="text-xs font-medium text-blue-800">
          <MarkdownText>{part.input.question}</MarkdownText>
        </div>
        <p className="mt-1 text-xs text-blue-600">Your answer: {part.output}</p>
      </div>
    );
  }

  // state === "input-available"
  const question = part.state === "input-available" ? part.input.question : "";
  const context = part.state === "input-available" ? part.input.context : undefined;

  return (
    <div className="my-2 rounded-lg border border-blue-200 bg-blue-50 p-3">
      <div className="text-sm font-medium text-blue-800">
        <MarkdownText>{question}</MarkdownText>
      </div>
      {context && (
        <div className="mt-1 text-xs text-blue-600">
          <MarkdownText>{context}</MarkdownText>
        </div>
      )}
      <div className="mt-2 flex gap-2">
        <input
          type="text"
          value={response}
          onChange={(e) => setResponse(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleSubmit();
            }
          }}
          disabled={submitted}
          placeholder="Type your answer…"
          className="flex-1 rounded-md border border-blue-200 bg-white px-2 py-1.5 text-sm outline-none focus:border-blue-400 disabled:bg-gray-50"
        />
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!response.trim() || submitted}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          Submit
        </button>
      </div>
    </div>
  );
}

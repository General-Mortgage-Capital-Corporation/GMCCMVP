"use client";

import { useState } from "react";
import type { GmccAgentUIMessage } from "@/lib/agents/gmcc-agent";
import type { useChat } from "@ai-sdk/react";
import MarkdownText from "../MarkdownText";

type AddToolOutputFn = ReturnType<typeof useChat<GmccAgentUIMessage>>["addToolOutput"];

// Extract the confirmation tool part type from the message parts union
type ConfirmationToolPart = Extract<
  GmccAgentUIMessage["parts"][number],
  { type: "tool-askForConfirmation" }
>;

interface ConfirmationPartProps {
  part: ConfirmationToolPart;
  addToolOutput: AddToolOutputFn;
}

export default function ConfirmationPart({ part, addToolOutput }: ConfirmationPartProps) {
  const [responded, setResponded] = useState(false);

  function handleResponse(approved: boolean) {
    if (responded) return;
    setResponded(true);
    addToolOutput({
      tool: "askForConfirmation",
      toolCallId: part.toolCallId,
      output: approved ? "User approved." : "User rejected.",
    });
  }

  if (part.state === "input-streaming") {
    return (
      <div className="my-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
        <p className="text-xs text-amber-600">Preparing confirmation request…</p>
      </div>
    );
  }

  if (part.state === "output-available") {
    const wasApproved = part.output?.toLowerCase().includes("approved");
    return (
      <div className={`my-2 rounded-lg border p-3 ${wasApproved ? "border-green-200 bg-green-50" : "border-red-200 bg-red-50"}`}>
        <p className="text-xs font-medium text-gray-700">{part.input.action}</p>
        <p className="mt-1 text-xs text-gray-500">{wasApproved ? "Approved" : "Rejected"}</p>
      </div>
    );
  }

  // state === "input-available"
  return (
    <div className="my-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
      <p className="text-sm font-medium text-amber-800">
        {part.state === "input-available" ? part.input.action : "Confirm action"}
      </p>
      {part.state === "input-available" && part.input.details && (
        <div className="mt-1 text-xs text-amber-700">
          <MarkdownText>{part.input.details}</MarkdownText>
        </div>
      )}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => handleResponse(true)}
          disabled={responded}
          className="rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-green-700 disabled:opacity-50"
        >
          Approve
        </button>
        <button
          type="button"
          onClick={() => handleResponse(false)}
          disabled={responded}
          className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
        >
          Reject
        </button>
      </div>
    </div>
  );
}

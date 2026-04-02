"use client";

import { isToolUIPart, getToolName } from "ai";
import type { GmccAgentUIMessage } from "@/lib/agents/gmcc-agent";
import type { useChat } from "@ai-sdk/react";
import ConfirmationPart from "./parts/ConfirmationPart";
import AskUserPart from "./parts/AskUserPart";
import SearchResultsPart from "./parts/SearchResultsPart";
import MatchResultsPart from "./parts/MatchResultsPart";
import GenericToolPart from "./parts/GenericToolPart";
import EmailPreviewPart from "./parts/EmailPreviewPart";
import MarkdownText from "./MarkdownText";

type AddToolOutputFn = ReturnType<typeof useChat<GmccAgentUIMessage>>["addToolOutput"];

interface ChatMessageProps {
  message: GmccAgentUIMessage;
  addToolOutput: AddToolOutputFn;
}

export default function ChatMessage({ message, addToolOutput }: ChatMessageProps) {
  const isUser = message.role === "user";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[95%] rounded-xl px-3 py-2.5 text-sm leading-relaxed sm:max-w-[85%] sm:px-4 sm:py-3 ${
          isUser
            ? "bg-red-600 text-white"
            : "bg-gray-50 text-gray-800 border border-gray-100"
        }`}
      >
        {message.parts.map((part, i) => {
          const key = `${message.id}-${i}`;

          if (part.type === "text") {
            if (!part.text) return null;
            return isUser ? (
              <div key={key} className="whitespace-pre-wrap">
                {part.text}
              </div>
            ) : (
              <MarkdownText key={key}>{part.text}</MarkdownText>
            );
          }

          if (part.type === "tool-askForConfirmation") {
            return (
              <ConfirmationPart
                key={key}
                part={part}
                addToolOutput={addToolOutput}
              />
            );
          }

          if (part.type === "tool-askUser") {
            return (
              <AskUserPart
                key={key}
                part={part}
                addToolOutput={addToolOutput}
              />
            );
          }

          if (part.type === "tool-searchProperties") {
            return <SearchResultsPart key={key} part={part} />;
          }

          if (part.type === "tool-matchPrograms") {
            return <MatchResultsPart key={key} part={part} />;
          }

          // Generic fallback for all other tools
          if (isToolUIPart(part)) {
            const toolName = getToolName(part);
            const output = part.state === "output-available" ? part.output : undefined;

            // Email tools get a dedicated preview component
            if (toolName === "draftEmail" || toolName === "sendEmail") {
              return (
                <EmailPreviewPart
                  key={key}
                  toolName={toolName}
                  state={part.state}
                  output={output}
                />
              );
            }

            return (
              <GenericToolPart
                key={key}
                toolName={toolName}
                state={part.state}
                toolCallId={part.toolCallId}
                output={output}
              />
            );
          }

          return null;
        })}
      </div>
    </div>
  );
}

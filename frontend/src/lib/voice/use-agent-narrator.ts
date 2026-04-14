"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef } from "react";
import { isToolUIPart, getToolName } from "ai";
import type { TTSEngine } from "./tts-engine";
import {
  summarizeToolStart,
  summarizeToolResult,
  summarizeToolError,
} from "./summarize-for-speech";

interface UIMessageLike {
  id: string;
  role: string;
  parts: any[];
}

interface PartSnapshot {
  type: string;
  state?: string;
  textLength?: number;
}

/**
 * Strip markdown formatting to produce clean spoken text.
 * Removes **, *, #, [], (), bullet points, etc.
 */
function stripMarkdown(text: string): string {
  return text
    .replace(/#{1,6}\s+/g, "")           // headers
    .replace(/\*\*([^*]+)\*\*/g, "$1")   // bold
    .replace(/\*([^*]+)\*/g, "$1")       // italic
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links
    .replace(/^[-*•]\s+/gm, "")          // bullet points
    .replace(/^\d+\.\s+/gm, "")          // numbered lists
    .replace(/`([^`]+)`/g, "$1")         // inline code
    .replace(/\n{2,}/g, ". ")            // paragraph breaks → period
    .replace(/\n/g, " ")                 // remaining newlines
    .replace(/\s{2,}/g, " ")             // collapse whitespace
    .trim();
}

/**
 * Condense agent text into a spoken summary.
 * If short enough, speak as-is (after stripping markdown).
 * If long, take the first 2-3 sentences.
 */
function condensForSpeech(text: string): string {
  const clean = stripMarkdown(text);
  if (!clean) return "";

  // If short enough, speak all of it
  if (clean.length <= 200) return clean;

  // Take first 2-3 sentences
  const sentences = clean.match(/[^.!?]+[.!?]+/g);
  if (sentences && sentences.length > 0) {
    const first3 = sentences.slice(0, 3).join(" ").trim();
    if (first3.length > 20) return first3;
  }

  // Fallback: first 200 chars + ellipsis
  return clean.slice(0, 200).replace(/\s+\S*$/, "") + "...";
}

/**
 * Smart narrator that watches the agent's streaming message parts and
 * speaks intelligent summaries via TTS.
 *
 * What it speaks:
 * - Tool starting: "Searching for properties near Fremont..."
 * - Tool completed: "Found 23 listings, prices from 850K to 1.4M"
 * - Tool errored: "Property search ran into an error"
 * - askUser question: reads the question aloud for hands-free
 * - Agent text: condensed summary (strips markdown, first 2-3 sentences)
 */
export function useAgentNarrator(
  messages: UIMessageLike[],
  status: string,
  tts: TTSEngine,
  enabled: boolean,
) {
  const narratedRef = useRef<Set<string>>(new Set());
  const prevSnapshotsRef = useRef<Map<string, PartSnapshot>>(new Map());

  useEffect(() => {
    if (!enabled) return;

    const narrated = narratedRef.current;
    const prevSnapshots = prevSnapshotsRef.current;

    // Only process the last assistant message
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    if (!lastAssistant) return;

    lastAssistant.parts.forEach((part: any, partIdx: number) => {
      const partKey = `${lastAssistant.id}-${partIdx}`;
      const prev = prevSnapshots.get(partKey);
      const currentState = part.state as string | undefined;

      // ── Tool parts ──────────────────────────────────────────────────
      if (isToolUIPart(part)) {
        const toolName = getToolName(part);

        // Tool started
        if (
          !prev &&
          (currentState === "input-streaming" || currentState === "input-available")
        ) {
          const key = `${partKey}-start`;
          if (!narrated.has(key)) {
            narrated.add(key);
            tts.speak(summarizeToolStart(toolName, part.input));
          }
        }

        // Tool completed successfully
        if (currentState === "output-available" && prev?.state !== "output-available") {
          const key = `${partKey}-done`;
          if (!narrated.has(key)) {
            narrated.add(key);
            tts.speak(summarizeToolResult(toolName, part.output));
          }
        }

        // Tool errored
        if (currentState === "output-error" && prev?.state !== "output-error") {
          const key = `${partKey}-error`;
          if (!narrated.has(key)) {
            narrated.add(key);
            tts.speak(summarizeToolError(toolName, part.errorText ?? ""));
          }
        }

        // askUser — read the question aloud
        if (
          toolName === "askUser" &&
          currentState === "input-available" &&
          prev?.state !== "input-available"
        ) {
          const key = `${partKey}-askuser`;
          if (!narrated.has(key)) {
            narrated.add(key);
            const inp = part.input as any;
            const question = inp?.question;
            if (question) {
              tts.speak("The agent has a question: " + stripMarkdown(question));
            }
          }
        }

        // askForConfirmation — read the confirmation prompt
        if (
          toolName === "askForConfirmation" &&
          currentState === "input-available" &&
          prev?.state !== "input-available"
        ) {
          const key = `${partKey}-confirm`;
          if (!narrated.has(key)) {
            narrated.add(key);
            const inp = part.input as any;
            const action = inp?.action || inp?.question || "";
            tts.speak("The agent wants your confirmation: " + stripMarkdown(action));
          }
        }
      }

      // ── Text parts — condensed speech summary ───────────────────────
      else if (part.type === "text" && part.text) {
        // Only speak when text is finalized (done state or status is ready)
        const isDone = part.state === "done" || (!part.state && status === "ready");
        const wasDone = prev?.state === "done";

        if (isDone && !wasDone) {
          const key = `${partKey}-text`;
          if (!narrated.has(key)) {
            narrated.add(key);
            const summary = condensForSpeech(part.text);
            if (summary) tts.speak(summary);
          }
        }
      }

      // Update snapshot
      prevSnapshots.set(partKey, {
        type: part.type,
        state: currentState,
        textLength: part.type === "text" ? (part.text?.length ?? 0) : undefined,
      });
    });
  }, [messages, status, tts, enabled]);

  // Clear state on unmount
  useEffect(() => {
    return () => {
      narratedRef.current.clear();
      prevSnapshotsRef.current.clear();
    };
  }, []);
}

"use client";

import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithToolCalls,
  isToolUIPart,
  getToolName,
} from "ai";
import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import ChatMessage from "./ChatMessage";
import ConversationSidebar from "./ConversationSidebar";
import { useAuth } from "@/contexts/AuthContext";
import { getSignatureHtml } from "@/lib/signature-store";
import { getLOInfo } from "@/lib/lo-info-store";
import { useSpeechRecognition } from "@/lib/voice/use-speech-recognition";
import { createTTSEngine } from "@/lib/voice/tts-engine";
import { useAgentNarrator } from "@/lib/voice/use-agent-narrator";
import type { GmccAgentUIMessage } from "@/lib/agents/gmcc-agent";
import { trackEvent } from "@/lib/posthog";

const SUGGESTED_PROMPTS = [
  "Find CRA-eligible properties near 90037 and check which programs they qualify for",
  "What GMCC programs are available in Orange County, CA?",
  "Search for properties near downtown Los Angeles and match them against all programs",
  "How many active listings are there in Miami-Dade County?",
];

interface ConversationMeta {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
}

type HistoryErrorAction = "retry-index" | "retry-conversation" | "retry-save" | "retry-delete";

interface HistoryErrorState {
  message: string;
  action?: HistoryErrorAction;
  convId?: string;
}

function generateConvId(): string {
  return `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function ChatTab() {
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const { user, getIdToken, getMsalAccessToken } = useAuth();
  const userEmailRef = useRef<string | null>(user?.email ?? null);
  const getIdTokenRef = useRef(getIdToken);
  const getMsalAccessTokenRef = useRef(getMsalAccessToken);

  // Sidebar toggle
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // Multi-conversation state
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const activeConvIdRef = useRef<string>(generateConvId());
  const [activeConvId, setActiveConvIdState] = useState(activeConvIdRef.current);
  const [initDone, setInitDone] = useState(false);
  const [historyError, setHistoryError] = useState<HistoryErrorState | null>(null);

  useEffect(() => {
    userEmailRef.current = user?.email ?? null;
    getIdTokenRef.current = getIdToken;
    getMsalAccessTokenRef.current = getMsalAccessToken;
  }, [user?.email, getIdToken, getMsalAccessToken]);

  function setActiveConvId(id: string) {
    activeConvIdRef.current = id;
    setActiveConvIdState(id);
  }

  // Transport with auth headers
  const [transport] = useState(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        headers: async () => {
          const headers: Record<string, string> = {};
          const idToken = await getIdTokenRef.current();
          if (idToken) headers["Authorization"] = `Bearer ${idToken}`;
          const msalToken = await getMsalAccessTokenRef.current(["Mail.Send"]).catch(() => null);
          if (msalToken) headers["X-MSAL-Token"] = msalToken;
          if (userEmailRef.current) headers["X-User-Email"] = userEmailRef.current;
          // Pass email signature for server-side email sending
          const sig = getSignatureHtml();
          if (sig) headers["X-Email-Signature"] = btoa(unescape(encodeURIComponent(sig)));
          // Pass LO profile info so the agent knows the user's name/title/NMLS
          const lo = getLOInfo();
          if (lo.name) headers["X-LO-Info"] = btoa(unescape(encodeURIComponent(JSON.stringify(lo))));
          return headers;
        },
      }),
  );

  const { messages, sendMessage, setMessages, addToolOutput, status, stop, error } =
    useChat<GmccAgentUIMessage>({
      transport,
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    });
  const lastSaveAttemptRef = useRef<{ msgs: typeof messages; convId: string } | null>(null);

  // ── Voice mode (STT + TTS narrator) ──────────────────────────────────────
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [ttsSpeaking, setTtsSpeaking] = useState(false);
  const tts = useMemo(() => createTTSEngine(), []);

  // Track current values in refs so STT callback always sees latest
  const statusRef = useRef(status);
  statusRef.current = status;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const addToolOutputRef = useRef(addToolOutput);
  addToolOutputRef.current = addToolOutput;

  // STT: mic → text → routes to pending askUser/askForConfirmation or sendMessage
  const stt = useSpeechRecognition((finalText) => {
    const text = finalText.trim();
    if (!text) return;

    // Check for a pending askUser or askForConfirmation tool call
    const lastAssistant = [...messagesRef.current].reverse().find((m) => m.role === "assistant");
    if (lastAssistant) {
      for (const part of lastAssistant.parts) {
        if (!isToolUIPart(part) || part.state !== "input-available") continue;
        const toolName = getToolName(part);

        if (toolName === "askUser") {
          addToolOutputRef.current({ tool: "askUser", toolCallId: part.toolCallId, output: text });
          return;
        }
        if (toolName === "askForConfirmation") {
          const lower = text.toLowerCase();
          const approved = lower.includes("yes") || lower.includes("approve") || lower.includes("confirm") || lower.includes("go ahead");
          addToolOutputRef.current({
            tool: "askForConfirmation",
            toolCallId: part.toolCallId,
            output: approved ? "User approved." : "User rejected.",
          });
          return;
        }
      }
    }

    // No pending tool calls — send as regular chat message
    if (statusRef.current === "ready") {
      sendMessage({ text });
    }
  });

  // TTS narrator: watches agent messages and speaks status updates
  useAgentNarrator(messages, status, tts, voiceEnabled);

  // Pause STT while TTS is speaking (so the agent's voice isn't picked up as input)
  useEffect(() => {
    tts.onSpeakingChange((speaking) => {
      setTtsSpeaking(speaking);
      if (speaking && stt.isListening) {
        stt.stop();
      }
      // Auto-resume listening after TTS finishes (if voice mode is still on)
      if (!speaking && voiceEnabled && !stt.isListening) {
        stt.start();
      }
    });
  }, [tts, stt, voiceEnabled]);

  // Sync TTS enabled state
  useEffect(() => {
    tts.setEnabled(voiceEnabled);
    if (!voiceEnabled && stt.isListening) stt.stop();
  }, [voiceEnabled, tts, stt]);

  const clearHistoryError = useCallback(() => setHistoryError(null), []);

  /** Build auth headers for chat history API calls. */
  const getHistoryHeaders = useCallback(async (extra?: Record<string, string>) => {
    const headers: Record<string, string> = {};
    const email = userEmailRef.current;
    if (email) headers["X-User-Email"] = email;
    const idToken = await getIdTokenRef.current();
    if (idToken) headers["Authorization"] = `Bearer ${idToken}`;
    return { ...headers, ...extra };
  }, []);

  // ── Helper: fetch conversation list ───────────────────────────────────────

  const fetchIndex = useCallback(async () => {
    const email = userEmailRef.current;
    if (!email) return [];
    try {
      const r = await fetch("/api/chat/history", {
        headers: await getHistoryHeaders(),
      });
      if (!r.ok) {
        throw new Error(`Failed to load conversation list (${r.status})`);
      }
      const data = await r.json();
      const convs = (data.conversations ?? []) as ConversationMeta[];
      setConversations(convs);
      clearHistoryError();
      return convs;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load conversation list";
      console.error("[chat] Failed to load index:", err);
      setHistoryError({ message, action: "retry-index" });
      return [];
    }
  }, [clearHistoryError, getHistoryHeaders]);

  // ── Helper: fetch messages for a conversation ─────────────────────────────

  const fetchMessages = useCallback(
    async (convId: string) => {
      const email = userEmailRef.current;
      if (!email) return;
      try {
        const r = await fetch(`/api/chat/history?id=${encodeURIComponent(convId)}`, {
          headers: await getHistoryHeaders(),
        });
        if (!r.ok) {
          throw new Error(`Failed to load conversation (${r.status})`);
        }
        const data = await r.json();
        if (Array.isArray(data.messages) && data.messages.length > 0) {
          setMessages(data.messages);
        } else {
          throw new Error("Could not load this conversation. It may have expired — try again or start a new chat.");
        }
        clearHistoryError();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to load conversation";
        console.error("[chat] Failed to load conversation:", err);
        setHistoryError({ message, action: "retry-conversation", convId });
      }
    },
    [setMessages, clearHistoryError, getHistoryHeaders],
  );

  // ── Init: load index + most recent conversation ───────────────────────────

  useEffect(() => {
    if (!userEmailRef.current || initDone) return;
    setInitDone(true);

    fetchIndex().then((convs) => {
      if (convs.length > 0) {
        setActiveConvId(convs[0].id);
        fetchMessages(convs[0].id);
      }
    });
  }, [user?.email, initDone, fetchIndex, fetchMessages]);

  // ── Select a conversation from sidebar ────────────────────────────────────

  const handleSelectConversation = useCallback(
    (convId: string) => {
      if (convId === activeConvIdRef.current) return;
      setActiveConvId(convId);
      fetchMessages(convId);
    },
    [fetchMessages],
  );

  // ── Save conversation (debounced) ─────────────────────────────────────────

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const saveConversation = useCallback(
    (msgs: typeof messages, convId: string) => {
      const email = userEmailRef.current;
      if (!email || msgs.length === 0) return;
      lastSaveAttemptRef.current = { msgs, convId };

      const firstUserMsg = msgs.find((m) => m.role === "user");
      const title =
        firstUserMsg?.parts?.find(
          (p): p is { type: "text"; text: string } => p.type === "text",
        )?.text?.slice(0, 60) ?? "New conversation";

      getHistoryHeaders({ "Content-Type": "application/json" }).then((hdrs) =>
      fetch("/api/chat/history", {
        method: "POST",
        headers: hdrs,
        body: JSON.stringify({ messages: msgs, conversationId: convId, title }),
      }))
        .then((r) => {
          if (!r.ok) {
            throw new Error(`Failed to save conversation (${r.status})`);
          }
          clearHistoryError();
          return r;
        })
        .then(() => {
          setConversations((prev) => {
            const meta: ConversationMeta = {
              id: convId,
              title,
              updatedAt: Date.now(),
              messageCount: msgs.length,
            };
            const filtered = prev.filter((c) => c.id !== convId);
            return [meta, ...filtered].slice(0, 20);
          });
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : "Failed to save conversation";
          console.error("[chat] Failed to save conversation:", err);
          setHistoryError({ message, action: "retry-save", convId });
        });
    },
    [clearHistoryError, getHistoryHeaders],
  );

  useEffect(() => {
    if (!userEmailRef.current || messages.length === 0) return;
    if (status !== "ready") return;

    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(
      () => saveConversation(messages, activeConvIdRef.current),
      500,
    );

    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [messages, status, saveConversation]);

  // ── New chat ──────────────────────────────────────────────────────────────

  const handleNewChat = useCallback(() => {
    setActiveConvId(generateConvId());
    setMessages([]);
    clearHistoryError();
  }, [setMessages]);

  const deleteConversationRemote = useCallback(
    async (convId: string) => {
      const email = userEmailRef.current;
      if (!email) return;

      const r = await fetch(`/api/chat/history?id=${encodeURIComponent(convId)}`, {
        method: "DELETE",
        headers: await getHistoryHeaders(),
      });
      if (!r.ok) {
        throw new Error(`Failed to delete conversation (${r.status})`);
      }
      clearHistoryError();
    },
    [clearHistoryError, getHistoryHeaders],
  );

  // ── Delete conversation ───────────────────────────────────────────────────

  const handleDelete = useCallback(
    (convId: string) => {
      const email = userEmailRef.current;
      if (!email) return;

      // Switch away first if deleting active conversation
      if (activeConvIdRef.current === convId) {
        handleNewChat();
      }

      // Remove from UI only after remote succeeds
      deleteConversationRemote(convId)
        .then(() => {
          setConversations((prev) => prev.filter((c) => c.id !== convId));
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : "Failed to delete conversation";
          console.error("[chat] Failed to delete conversation:", err);
          setHistoryError({ message, action: "retry-delete", convId });
        });
    },
    [handleNewChat, deleteConversationRemote],
  );

  const retryHistoryAction = useCallback(() => {
    if (!historyError) return;

    if (historyError.action === "retry-index") {
      void fetchIndex();
      return;
    }
    if (historyError.action === "retry-conversation") {
      const convId = historyError.convId ?? activeConvIdRef.current;
      void fetchMessages(convId);
      return;
    }
    if (historyError.action === "retry-save") {
      const lastSave = lastSaveAttemptRef.current;
      if (lastSave) {
        saveConversation(lastSave.msgs, lastSave.convId);
      }
      return;
    }
    if (historyError.action === "retry-delete" && historyError.convId) {
      void deleteConversationRemote(historyError.convId).catch((err) => {
        const message = err instanceof Error ? err.message : "Failed to delete conversation";
        setHistoryError({ message, action: "retry-delete", convId: historyError.convId });
      });
    }
  }, [historyError, fetchIndex, fetchMessages, saveConversation, deleteConversationRemote]);

  // ── Submit message ────────────────────────────────────────────────────────

  function handleSubmit(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    trackEvent("agent_message_sent", { messageLength: trimmed.length });
    sendMessage({ text: trimmed });
    setInput("");
  }

  // ── Auto-recovery ─────────────────────────────────────────────────────────

  const retryCount = useRef(0);
  const lastPartsSnapshot = useRef("");
  const stallTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentSnapshot = messages.map((m) => `${m.id}:${m.parts.length}`).join("|");

  // Auto-retry on error — only once, and only if not already a retry message
  useEffect(() => {
    if (status === "error" && messages.length > 0 && retryCount.current < 1) {
      const lastMsg = messages[messages.length - 1];
      const lastText = lastMsg?.parts?.[0];
      if (
        lastMsg?.role === "user" &&
        lastText &&
        "text" in lastText &&
        lastText.text === "Continue from where you left off."
      ) {
        return;
      }
      // Don't auto-retry if there are pending tool calls without results —
      // retrying would just cause AI_MissingToolResultsError again
      const hasPendingToolCalls = messages.some(
        (m) => m.role === "assistant" && m.parts.some(
          (p) => isToolUIPart(p) && p.state !== "output-available" && p.state !== "output-error",
        ),
      );
      if (hasPendingToolCalls) return;

      const timer = setTimeout(() => {
        retryCount.current += 1;
        sendMessage({ text: "Continue from where you left off." });
      }, 2000);
      return () => clearTimeout(timer);
    }
    if (status === "ready") {
      retryCount.current = 0;
    }
  }, [status, messages, sendMessage]);

  // Stall detection — stop the stream but do NOT auto-send a retry.
  // The user will see the "Continue" button instead.
  useEffect(() => {
    if (stallTimer.current) clearTimeout(stallTimer.current);
    const isProcessingNow = status === "streaming" || status === "submitted";

    if (isProcessingNow && messages.length > 0) {
      if (currentSnapshot !== lastPartsSnapshot.current) {
        lastPartsSnapshot.current = currentSnapshot;
      }
      stallTimer.current = setTimeout(() => {
        console.warn("[chat] Stream stalled for 120s — stopping");
        stop();
      }, 120_000);
    }

    return () => {
      if (stallTimer.current) clearTimeout(stallTimer.current);
    };
  }, [currentSnapshot, status, messages.length, stop]);

  // ── Auto-scroll ───────────────────────────────────────────────────────────

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const isProcessing = status === "streaming" || status === "submitted";

  return (
    <div className="flex h-[calc(100vh-12rem)] overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm sm:h-[calc(100vh-10rem)]">
      {/* Sidebar — collapsible on desktop, hidden on mobile */}
      <div
        className={`hidden transition-all duration-200 sm:block ${
          sidebarOpen ? "w-56" : "w-0"
        } overflow-hidden`}
      >
        <ConversationSidebar
          conversations={conversations}
          activeId={activeConvId}
          onSelect={handleSelectConversation}
          onNew={handleNewChat}
          onDelete={handleDelete}
        />
      </div>

      {/* Main chat area */}
      <div className="flex flex-1 flex-col min-w-0">
        {/* Header bar */}
        <div className="flex items-center gap-2 border-b border-gray-100 px-3 py-1.5">
          {/* Sidebar toggle (desktop) */}
          <button
            type="button"
            onClick={() => setSidebarOpen((v) => !v)}
            className="hidden rounded p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 sm:block"
            title={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              {sidebarOpen ? (
                <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              ) : (
                <path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              )}
            </svg>
          </button>

          {/* Voice mode toggle */}
          {stt.isSupported && (
            <button
              type="button"
              onClick={() => setVoiceEnabled((v) => !v)}
              className={`flex items-center gap-1 rounded-md px-2 py-1 text-[0.65rem] font-medium transition-colors ${
                voiceEnabled
                  ? "bg-red-50 text-red-700 border border-red-200"
                  : "text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              }`}
              title={voiceEnabled ? "Disable voice mode" : "Enable voice mode"}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                {voiceEnabled ? (
                  <>
                    <path d="M8 1a3 3 0 0 0-3 3v4a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                    <path d="M13 8a5 5 0 0 1-4 4.9V15h2v1H5v-1h2v-2.1A5 5 0 0 1 3 8h1a4 4 0 0 0 8 0h1z" />
                  </>
                ) : (
                  <path d="M8 1a3 3 0 0 0-3 3v4a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3zm5 7a5 5 0 0 1-4 4.9V15h2v1H5v-1h2v-2.1A5 5 0 0 1 3 8h1a4 4 0 0 0 8 0h1z" opacity="0.4" />
                )}
              </svg>
              {voiceEnabled ? "Voice On" : "Voice"}
            </button>
          )}

          <span className="flex-1 text-xs text-gray-400 truncate">
            {messages.length > 0
              ? `${messages.filter((m) => m.role === "user").length} messages`
              : "New conversation"}
          </span>

          {/* Mobile: New Chat button */}
          <button
            type="button"
            onClick={handleNewChat}
            disabled={isProcessing}
            className="rounded-md border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-500 hover:bg-gray-50 disabled:opacity-40 sm:hidden"
          >
            New Chat
          </button>
        </div>

        {/* Messages area */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
          {historyError && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
              <div className="flex flex-wrap items-center gap-2">
                <span>{historyError.message}</span>
                {historyError.action && (
                  <button
                    type="button"
                    onClick={retryHistoryAction}
                    className="rounded-md border border-amber-300 bg-white px-2 py-0.5 text-xs font-medium text-amber-800 hover:bg-amber-100"
                  >
                    Retry
                  </button>
                )}
                <button
                  type="button"
                  onClick={clearHistoryError}
                  className="rounded-md border border-amber-300 bg-white px-2 py-0.5 text-xs font-medium text-amber-800 hover:bg-amber-100"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}

          {messages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-6 text-center">
              <div>
                <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-red-100">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="text-red-600">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" fill="currentColor" />
                  </svg>
                </div>
                <h2 className="text-lg font-semibold text-gray-900">
                  GMCC AI Marketing Assistant
                </h2>
                <p className="mt-1 text-sm text-gray-500">
                  Search properties, check program eligibility, and automate marketing — all in one conversation.
                </p>
              </div>
              <div className="grid w-full max-w-lg gap-2">
                {SUGGESTED_PROMPTS.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => handleSubmit(prompt)}
                    className="rounded-lg border border-gray-200 px-4 py-3 text-left text-sm text-gray-700 transition-colors hover:border-red-200 hover:bg-red-50"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((message) => (
              <ChatMessage
                key={message.id}
                message={message}
                addToolOutput={addToolOutput}
              />
            ))
          )}

          {isProcessing && (
            <div className="flex items-center gap-2 text-xs text-gray-400">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-red-400" />
              {status === "submitted" ? "Thinking…" : "Working…"}
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
              {retryCount.current > 0 && retryCount.current < 2 ? (
                <span className="flex items-center gap-2">
                  <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-400" />
                  Hit a snag — automatically resuming…
                </span>
              ) : (
                error.message || "Something went wrong. Please try again."
              )}
            </div>
          )}
        </div>

        {/* Input bar */}
        <div className="border-t border-gray-100 p-4">
          {/* Interim speech transcript */}
          {stt.isListening && stt.transcript && (
            <div className="mb-2 flex items-center gap-2 text-xs text-gray-400">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-red-400" />
              <span className="italic">{stt.transcript}</span>
            </div>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSubmit(input);
            }}
            className="flex gap-2"
          >
            {/* Skip TTS button (voice mode, visible when agent is speaking) */}
            {voiceEnabled && ttsSpeaking && (
              <button
                type="button"
                onClick={() => tts.stop()}
                className="shrink-0 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-100"
                title="Skip agent speech"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" className="inline mr-1 -mt-0.5">
                  <path d="M3 2h3v12H3zM10 2h3v12h-3z" />
                </svg>
                Skip
              </button>
            )}
            {/* Mic button (voice mode) */}
            {voiceEnabled && stt.isSupported && (
              <button
                type="button"
                onClick={() => stt.isListening ? stt.stop() : stt.start()}
                disabled={isProcessing && !ttsSpeaking}
                className={`shrink-0 rounded-lg px-3 py-2 transition-colors ${
                  stt.isListening
                    ? "bg-red-100 text-red-600 border border-red-300"
                    : "bg-gray-100 text-gray-500 border border-gray-200 hover:bg-gray-200"
                } disabled:opacity-40`}
                title={stt.isListening ? "Stop listening" : "Start speaking"}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 1a3 3 0 0 0-3 3v4a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                  <path d="M13 8a5 5 0 0 1-4 4.9V15h2v1H5v-1h2v-2.1A5 5 0 0 1 3 8h1a4 4 0 0 0 8 0h1z" />
                </svg>
              </button>
            )}
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit(input);
                }
              }}
              placeholder={voiceEnabled && stt.isListening ? "Listening… speak now" : "Ask me to find properties, check programs, or market to realtors…"}
              disabled={isProcessing}
              rows={1}
              className="flex-1 resize-none rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 outline-none transition-colors focus:border-red-300 focus:ring-1 focus:ring-red-200 disabled:bg-gray-50 disabled:text-gray-400"
              style={{
                minHeight: "40px",
                maxHeight: "120px",
                fieldSizing: "content" as unknown as undefined,
              }}
            />
            {isProcessing ? (
              <button
                type="button"
                onClick={() => { stop(); tts.stop(); }}
                className="shrink-0 rounded-lg bg-gray-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-700"
              >
                Stop
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim()}
                className="shrink-0 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Send
              </button>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}

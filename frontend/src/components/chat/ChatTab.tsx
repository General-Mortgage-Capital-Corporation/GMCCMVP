"use client";

import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithToolCalls,
} from "ai";
import { useState, useRef, useEffect, useCallback } from "react";
import ChatMessage from "./ChatMessage";
import ConversationSidebar from "./ConversationSidebar";
import { useAuth } from "@/contexts/AuthContext";
import { getSignatureHtml } from "@/lib/signature-store";
import type { GmccAgentUIMessage } from "@/lib/agents/gmcc-agent";

const SUGGESTED_PROMPTS = [
  "Find CRA-eligible properties near 90210 and check which programs they qualify for",
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
    sendMessage({ text: trimmed });
    setInput("");
  }

  // ── Auto-recovery ─────────────────────────────────────────────────────────

  const retryCount = useRef(0);
  const lastPartsSnapshot = useRef("");
  const stallTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentSnapshot = messages.map((m) => `${m.id}:${m.parts.length}`).join("|");

  useEffect(() => {
    if (status === "error" && messages.length > 0 && retryCount.current < 2) {
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
      const timer = setTimeout(() => {
        retryCount.current += 1;
        sendMessage({ text: "Continue from where you left off." });
      }, 1500);
      return () => clearTimeout(timer);
    }
    if (status === "ready") {
      retryCount.current = 0;
    }
  }, [status, messages, sendMessage]);

  useEffect(() => {
    if (stallTimer.current) clearTimeout(stallTimer.current);
    const isProcessingNow = status === "streaming" || status === "submitted";

    if (isProcessingNow && messages.length > 0) {
      if (currentSnapshot !== lastPartsSnapshot.current) {
        lastPartsSnapshot.current = currentSnapshot;
      }
      stallTimer.current = setTimeout(() => {
        if (retryCount.current < 2) {
          retryCount.current += 1;
          stop();
          setTimeout(() => {
            sendMessage({ text: "Continue from where you left off." });
          }, 1000);
        }
      }, 90_000);
    }

    return () => {
      if (stallTimer.current) clearTimeout(stallTimer.current);
    };
  }, [currentSnapshot, status, messages.length, stop, sendMessage]);

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
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSubmit(input);
            }}
            className="flex gap-2"
          >
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit(input);
                }
              }}
              placeholder="Ask me to find properties, check programs, or market to realtors…"
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
                onClick={stop}
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

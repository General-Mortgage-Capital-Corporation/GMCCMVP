"use client";

import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { emailRequest } from "@/lib/msal-config";
import { getSignatureHtml, hasSignature, buildHtmlBodyWithSignature } from "@/lib/signature-store";
import LoadingSpinner from "@/components/LoadingSpinner";
import type { FollowUpListItem } from "@/types/follow-up";
import { trackEvent } from "@/lib/posthog";

type ViewTab = "follow-ups" | "sent" | "replied";

interface FollowUpDashboardProps {
  onClose: () => void;
}

export default function FollowUpDashboard({ onClose }: FollowUpDashboardProps) {
  const { getIdToken, getMsalAccessToken } = useAuth();
  const [pendingItems, setPendingItems] = useState<FollowUpListItem[]>([]);
  const [sentItems, setSentItems] = useState<FollowUpListItem[]>([]);
  const [repliedItems, setRepliedItems] = useState<FollowUpListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState<string | null>(null);
  const [viewTab, setViewTab] = useState<ViewTab>("follow-ups");
  const [clearing, setClearing] = useState(false);

  // Inline compose state
  const [composingId, setComposingId] = useState<string | null>(null);
  const [composeSubject, setComposeSubject] = useState("");
  const [composeBody, setComposeBody] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendSuccess, setSendSuccess] = useState<string | null>(null);

  const fetchItems = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getIdToken();
      if (!token) { setError("Please sign in."); return; }
      const headers = { Authorization: `Bearer ${token}` };

      const [pendingRes, noFollowUpRes, autoSentRes, allRepliedRes, dismissedRes] = await Promise.all([
        fetch("/api/follow-up/list?status=pending", { headers }),
        fetch("/api/follow-up/list?status=no-followup", { headers }),
        fetch("/api/follow-up/list?status=sent", { headers }),
        fetch("/api/follow-up/list?status=all-replied", { headers }),
        fetch("/api/follow-up/list?status=dismissed", { headers }),
      ]);

      const parse = async (res: Response) =>
        res.ok ? ((await res.json()) as { items: FollowUpListItem[] }).items : [];

      const pending = await parse(pendingRes);
      const noFollowUp = await parse(noFollowUpRes);
      const autoSent = await parse(autoSentRes);
      const allReplied = await parse(allRepliedRes);
      const dismissed = await parse(dismissedRes);

      setPendingItems(pending);
      // "Sent" tab: emails without follow-up (no reply) + auto-sent + dismissed
      setSentItems([...noFollowUp, ...autoSent, ...dismissed].sort((a, b) => (b.sentAt ?? 0) - (a.sentAt ?? 0)));
      // "Replied" tab: all emails with replies (with or without follow-ups)
      setRepliedItems(allReplied);
    } catch {
      setError("Could not load emails.");
    } finally {
      setLoading(false);
    }
  }, [getIdToken]);

  useEffect(() => { fetchItems(); }, [fetchItems]);

  async function handleDismiss(id: string) {
    setDismissing(id);
    try {
      const token = await getIdToken();
      if (!token) return;
      const res = await fetch("/api/follow-up/dismiss", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ id }),
      });
      if (res.ok) {
        trackEvent("follow_up_dismissed");
        setPendingItems((prev) => prev.filter((i) => i.id !== id));
      }
    } finally {
      setDismissing(null);
    }
  }

  async function handleClearAll() {
    if (!confirm("Delete all sent emails and follow-ups from the dashboard? This cannot be undone.")) return;
    setClearing(true);
    try {
      const token = await getIdToken();
      if (!token) return;
      const res = await fetch("/api/follow-up/list", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        setPendingItems([]);
        setSentItems([]);
        setRepliedItems([]);
      }
    } finally {
      setClearing(false);
    }
  }

  function startCompose(item: FollowUpListItem) {
    setComposingId(item.id);
    setComposeSubject(item.followUp?.draftSubject || `Re: ${item.subject}`);
    setComposeBody(item.followUp?.draftBody || "");
    setSendError(null);
    setSendSuccess(null);
  }

  async function handleSendFollowUp(item: FollowUpListItem) {
    if (sending) return;
    if (!composeSubject.trim() || !composeBody.trim()) {
      setSendError("Subject and body are required.");
      return;
    }
    setSending(true);
    setSendError(null);
    try {
      const msalToken = await getMsalAccessToken(emailRequest.scopes);
      if (!msalToken) { setSendError("Could not get email permission."); return; }

      const sig = getSignatureHtml();
      const useHtml = !!sig;
      const emailBody = useHtml
        ? { contentType: "HTML" as const, content: buildHtmlBodyWithSignature(composeBody, sig) }
        : { contentType: "Text" as const, content: composeBody };

      // Get threading IDs for same-thread reply
      let threadHeaders: Record<string, unknown>[] | undefined;
      try {
        const idToken = await getIdToken();
        const threadRes = await fetch("/api/follow-up/thread-ids", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) },
          body: JSON.stringify({ userEmail: item.userEmail, subject: item.subject, recipientEmail: item.recipientEmail }),
        });
        if (threadRes.ok) {
          const { threadIds } = await threadRes.json() as { threadIds: { conversationId: string; internetMessageId: string } | null };
          if (threadIds) {
            threadHeaders = [
              { name: "In-Reply-To", value: threadIds.internetMessageId },
              { name: "References", value: threadIds.internetMessageId },
            ];
          }
        }
      } catch { /* send without threading */ }

      const message: Record<string, unknown> = {
        subject: composeSubject,
        body: emailBody,
        toRecipients: [{ emailAddress: { address: item.recipientEmail, name: item.recipientName || undefined } }],
        ...(threadHeaders ? { internetMessageHeaders: threadHeaders } : {}),
      };

      const res = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${msalToken}` },
        body: JSON.stringify({ message, saveToSentItems: true }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({})) as { error?: { message?: string } };
        setSendError(errData.error?.message ?? "Failed to send.");
        return;
      }

      trackEvent("follow_up_sent", { recipient: item.recipientEmail });

      // Dismiss the follow-up
      const idToken = await getIdToken();
      if (idToken) {
        fetch("/api/follow-up/dismiss", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
          body: JSON.stringify({ id: item.id }),
        }).catch(() => {});
      }

      setSendSuccess(`Sent to ${item.recipientName || item.recipientEmail}!`);
      setPendingItems((prev) => prev.filter((i) => i.id !== item.id));
      setTimeout(() => { setComposingId(null); setSendSuccess(null); }, 2000);
    } catch {
      setSendError("Failed to send.");
    } finally {
      setSending(false);
    }
  }

  function formatDate(ms: number) {
    return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  function daysUntil(ms: number) {
    const d = Math.ceil((ms - Date.now()) / (24 * 60 * 60 * 1000));
    if (d <= 0) return "Due now";
    return `In ${d}d`;
  }

  function statusBadge(item: FollowUpListItem) {
    const fu = item.followUp;
    if (item.hasReply || fu?.status === "replied") {
      return <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">Agent Replied</span>;
    }
    if (!fu) {
      return <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">Sent</span>;
    }
    switch (fu.status) {
      case "sent":
        return <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">Auto-sent</span>;
      case "dismissed":
        return <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">Stopped</span>;
      default:
        return fu.mode === "auto-send"
          ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">Auto-send</span>
          : <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">Remind</span>;
    }
  }

  const renderItem = (item: FollowUpListItem, showActions: boolean) => {
    const hasDraft = !!item.followUp?.draftSubject;
    const isDue = showActions && (item.followUp?.scheduledAt ?? 0) <= Date.now();
    const isAutoSend = item.followUp?.mode === "auto-send";
    const isComposing = composingId === item.id;
    const hasReplyFlag = item.hasReply || item.followUp?.status === "replied";

    return (
      <div
        key={item.id}
        className={`rounded-lg border p-4 ${
          isDue ? "border-red-200 bg-red-50/50" : hasReplyFlag ? "border-emerald-200 bg-emerald-50/30" : "border-gray-200 bg-white"
        }`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-gray-900">
              {item.recipientName || item.recipientEmail}
              <span className="ml-1.5 text-xs font-normal text-gray-400">{item.recipientType}</span>
            </p>
            <p className="mt-0.5 truncate text-xs text-gray-500">
              {item.propertyAddress || "No address"}
              {item.programNames?.length > 0 && ` — ${item.programNames.join(", ")}`}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {statusBadge(item)}
            {showActions && item.followUp && (
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                isDue ? "bg-red-100 text-red-700" : "bg-gray-100 text-gray-600"
              }`}>
                {daysUntil(item.followUp.scheduledAt ?? 0)}
              </span>
            )}
          </div>
        </div>

        <p className="mt-2 text-xs text-gray-400">
          Sent {formatDate(item.sentAt)}: &quot;{item.subject}&quot;
          {item.followUp && item.followUp.reminderCount > 0 && (
            <span className="ml-1 text-gray-300">
              ({item.followUp.reminderCount} follow-up{item.followUp.reminderCount > 1 ? "s" : ""})
            </span>
          )}
        </p>

        {hasDraft && !isComposing && (
          <div className="mt-2 rounded border border-blue-100 bg-blue-50/50 p-2.5">
            <p className="text-xs font-medium text-blue-800">
              {item.followUp?.status === "sent" ? "Auto-sent follow-up" : "AI Draft Ready"}
            </p>
            <p className="mt-0.5 text-xs text-blue-700">&quot;{item.followUp!.draftSubject}&quot;</p>
            <p className="mt-0.5 line-clamp-2 text-xs text-blue-600">{item.followUp!.draftBody}</p>
          </div>
        )}

        {/* Inline compose */}
        {isComposing && (
          <div className="mt-3 space-y-2 rounded-lg border border-gray-200 bg-white p-3">
            {sendSuccess ? (
              <div className="rounded border border-emerald-200 bg-emerald-50 p-3 text-center">
                <p className="text-xs font-medium text-emerald-700">{sendSuccess}</p>
              </div>
            ) : (
              <>
                <div>
                  <label className="mb-0.5 block text-[0.65rem] font-medium uppercase tracking-wide text-gray-400">To</label>
                  <p className="text-xs text-gray-700">{item.recipientName} ({item.recipientEmail})</p>
                </div>
                <div>
                  <label className="mb-0.5 block text-[0.65rem] font-medium uppercase tracking-wide text-gray-400">Subject</label>
                  <input type="text" value={composeSubject} onChange={(e) => setComposeSubject(e.target.value)}
                    className="w-full rounded border border-gray-200 px-2.5 py-1.5 text-xs text-gray-800 focus:outline-none focus:ring-2 focus:ring-red-400" />
                </div>
                <div>
                  <label className="mb-0.5 block text-[0.65rem] font-medium uppercase tracking-wide text-gray-400">Body</label>
                  <textarea value={composeBody} onChange={(e) => setComposeBody(e.target.value)} rows={5}
                    className="w-full rounded border border-gray-200 px-2.5 py-1.5 text-xs text-gray-800 focus:outline-none focus:ring-2 focus:ring-red-400 resize-y" />
                </div>
                {hasSignature() && <p className="text-[0.6rem] text-gray-400">Your email signature will be appended.</p>}
                {sendError && <p className="text-xs text-red-600">{sendError}</p>}
                <div className="flex items-center gap-2">
                  <button onClick={() => handleSendFollowUp(item)} disabled={sending}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50">
                    {sending && <LoadingSpinner size="sm" />}
                    {sending ? "Sending…" : "Send Follow-up"}
                  </button>
                  <button onClick={() => setComposingId(null)} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
                </div>
              </>
            )}
          </div>
        )}

        {/* Actions for pending follow-ups */}
        {showActions && !isComposing && (
          <div className="mt-3 flex items-center gap-2">
            {!isAutoSend && (
              <button onClick={() => startCompose(item)}
                className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-700">
                {hasDraft ? "Review & Send" : "Write Follow-up"}
              </button>
            )}
            {isAutoSend && (
              <span className="text-xs text-amber-600">
                Will auto-send {isDue ? "soon" : `on ${formatDate(item.followUp?.scheduledAt ?? 0)}`}
              </span>
            )}
            <button onClick={() => handleDismiss(item.id)} disabled={dismissing === item.id}
              className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50 disabled:opacity-50">
              {dismissing === item.id ? "..." : "Stop"}
            </button>
          </div>
        )}
      </div>
    );
  };

  const currentItems = viewTab === "follow-ups" ? pendingItems : viewTab === "sent" ? sentItems : repliedItems;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="relative flex w-full max-w-xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3.5">
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold text-gray-800">Email Dashboard</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleClearAll}
              disabled={clearing}
              className="rounded px-2 py-1 text-[0.65rem] font-medium text-red-500 transition-colors hover:bg-red-50 disabled:opacity-50"
            >
              {clearing ? "Clearing..." : "Clear All"}
            </button>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M12 4L4 12M4 4l8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
          </div>
        </div>

        {/* AI Disclaimer Banner */}
        <div className="border-b border-amber-200 bg-amber-50 px-5 py-2">
          <p className="text-[0.65rem] text-amber-700">
            <strong>AI-powered follow-ups:</strong> Auto-send uses AI to draft and send emails on your behalf. Review AI drafts carefully before enabling auto-send. You can always stop a sequence from this dashboard.
          </p>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-100 px-5">
          {([
            ["follow-ups", "Follow-ups", pendingItems.length],
            ["sent", "Sent", sentItems.length],
            ["replied", "Replied", repliedItems.length],
          ] as [ViewTab, string, number][]).map(([key, label, count]) => (
            <button
              key={key}
              onClick={() => setViewTab(key)}
              className={`border-b-2 px-3 py-2.5 text-xs font-medium transition-colors ${
                viewTab === key ? "border-red-600 text-red-600" : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              {label}{count > 0 ? ` (${count})` : ""}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="max-h-[60vh] overflow-y-auto p-5">
          {loading && (
            <div className="flex items-center justify-center py-8">
              <LoadingSpinner size="md" />
            </div>
          )}

          {error && <p className="py-4 text-center text-sm text-red-600">{error}</p>}

          {!loading && !error && currentItems.length === 0 && (
            <div className="py-8 text-center">
              <p className="text-sm text-gray-500">
                {viewTab === "follow-ups" ? "No pending follow-ups." :
                 viewTab === "sent" ? "No sent emails recorded yet." :
                 "No replies detected yet."}
              </p>
              {viewTab === "follow-ups" && (
                <p className="mt-1 text-xs text-gray-400">
                  Enable &quot;Follow up&quot; when sending an email to schedule automatic follow-ups or reminders.
                </p>
              )}
              {viewTab === "sent" && (
                <p className="mt-1 text-xs text-gray-400">
                  All emails sent to realtors and borrowers will appear here.
                </p>
              )}
              {viewTab === "replied" && (
                <p className="mt-1 text-xs text-gray-400">
                  When a realtor or borrower replies, it will be detected automatically.
                </p>
              )}
            </div>
          )}

          {!loading && currentItems.length > 0 && (
            <div className="space-y-3">
              {currentItems.map((item) => renderItem(item, viewTab === "follow-ups"))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

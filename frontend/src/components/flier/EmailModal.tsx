"use client";

import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/contexts/AuthContext";
import LoadingSpinner from "@/components/LoadingSpinner";
import { emailRequest } from "@/lib/msal-config";
import { getSignatureHtml, hasSignature, buildHtmlBodyWithSignature } from "@/lib/signature-store";
import SignatureFixModal from "@/components/SignatureFixModal";
import { trackEvent } from "@/lib/posthog";
import FollowUpToggle from "@/components/FollowUpToggle";
import AgentIntelCard from "./AgentIntelCard";
import type { RealtorInfo } from "./FlierButton";

type RecipientTab = "myself" | "realtor" | "borrower";

interface EmailModalProps {
  programName: string;
  productId: string;
  propertyAddress?: string;
  listingPrice?: number;
  realtorInfo: RealtorInfo;
  onClose: () => void;
  /** Resolves to a PDF blob — called lazily on Send */
  fetchPdf: () => Promise<Blob | null>;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    blob.arrayBuffer().then((buf) => {
      const bytes = new Uint8Array(buf);
      let binary = "";
      const CHUNK = 8192;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
      }
      resolve(btoa(binary));
    }).catch(reject);
  });
}

function autoPropertyBody(
  programName: string,
  propertyAddress: string,
  listingPrice: number | undefined,
  realtorName: string,
): string {
  const price = listingPrice ? `$${listingPrice.toLocaleString()}` : "N/A";
  return [
    "Saving this for my records — flagging this property as a potential match for the " + programName + " program.",
    "",
    "Property Details:",
    `  • Address: ${propertyAddress || "N/A"}`,
    `  • Listing Price: ${price}`,
    `  • Program: ${programName}`,
    ...(realtorName ? [`  • Listing Agent: ${realtorName}`] : []),
    "",
    "The program flyer is attached for quick reference.",
  ].join("\n");
}

export default function EmailModal({
  programName,
  productId,
  propertyAddress,
  listingPrice,
  realtorInfo,
  onClose,
  fetchPdf,
}: EmailModalProps) {
  const { user, signIn, getMsalAccessToken, getIdToken } = useAuth();

  const [tab, setTab] = useState<RecipientTab>("realtor");
  const [toEmail, setToEmail] = useState("");
  const [toName, setToName] = useState("");
  const [ccEmail, setCcEmail] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [sentWithSig, setSentWithSig] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [followUpEnabled, setFollowUpEnabled] = useState(false);
  const [followUpDays, setFollowUpDays] = useState(3);
  const [followUpMode, setFollowUpMode] = useState<"remind" | "auto-send">("remind");
  const [agentResearch, setAgentResearch] = useState<string | null>(null);
  const [sigFixOpen, setSigFixOpen] = useState(false);
  const [sigOk, setSigOk] = useState(() => hasSignature());

  const loName = user?.displayName || user?.email || "Loan Officer";

  // Populate fields when tab, user, or realtor info changes
  // Using primitive fields from realtorInfo to avoid object-reference instability
  const realtorEmail = realtorInfo.email;
  const realtorName = realtorInfo.name;
  useEffect(() => {
    setError(null);
    setSent(false);
    setCcEmail("");
    if (tab === "myself") {
      setToEmail(user?.email ?? "");
      setToName(loName);
      setSubject(`Property Flyer: ${propertyAddress ?? programName}`);
      setBody(autoPropertyBody(programName, propertyAddress ?? "", listingPrice, realtorName));
    } else if (tab === "realtor") {
      setToEmail(realtorEmail);
      setToName(realtorName);
      setSubject("");
      setBody("");
    } else {
      setToEmail("");
      setToName("");
      setSubject("");
      setBody("");
    }
  }, [tab, user, realtorEmail, realtorName]); // eslint-disable-line react-hooks/exhaustive-deps

  const generateEmail = useCallback(async (prompt: string, researchOverride?: string | null) => {
    setAiLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/suggest-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipientType: tab,
          userPrompt: prompt,
          programName,
          propertyAddress,
          listingPrice: listingPrice ? String(listingPrice) : undefined,
          realtorName: realtorInfo.name,
          realtorEmail: realtorInfo.email,
          loName,
          hasSignature: hasSignature(),
          realtorResearch: researchOverride !== undefined ? researchOverride : agentResearch,
        }),
      });
      const data = await res.json() as { subject?: string; body?: string; error?: string };
      if (!res.ok || data.error) {
        setError(data.error ?? "AI suggestion failed.");
        return;
      }
      if (data.subject) setSubject(data.subject);
      if (data.body) setBody(data.body);
    } catch {
      setError("AI suggestion failed. Please try again.");
    } finally {
      setAiLoading(false);
    }
  }, [tab, programName, propertyAddress, listingPrice, realtorInfo, loName, agentResearch]);

  async function handleAiSuggest() {
    if (!aiPrompt.trim()) return;
    await generateEmail(aiPrompt);
  }

  // Auto-generate email when research completes for realtor tab
  const handleResearchComplete = useCallback((research: import("@/lib/redis-cache").AgentResearch | null) => {
    if (research) {
      const summary = [
        research.summary,
        research.specialties.length > 0 ? `Specialties: ${research.specialties.join(", ")}` : "",
        (typeof research.reviews === "string" ? research.reviews : "") || "",
        research.personalHooks.length > 0 ? `Hooks: ${research.personalHooks.join("; ")}` : "",
      ].filter(Boolean).join("\n");
      setAgentResearch(summary);
    }
  }, []);

  // Single-program email: no auto-generate, user prompts themselves
  // Research is still available and passed to AI when user does prompt

  async function handleSend() {
    if (sending) return; // guard against double-submission
    if (!hasSignature()) { setSigFixOpen(true); return; }
    if (!toEmail.trim()) { setError("Recipient email is required."); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toEmail.trim())) { setError("Invalid email address."); return; }
    if (!subject.trim()) { setError("Subject is required."); return; }

    setError(null);
    setSending(true);

    try {
      // Ensure signed in
      if (!user) await signIn();

      // Fetch MSAL token and generate PDF in parallel
      const [msalToken, pdfBlob] = await Promise.all([
        getMsalAccessToken(emailRequest.scopes),
        fetchPdf(),
      ]);

      if (!msalToken) {
        setError("Could not get email permission. Please sign in again.");
        return;
      }
      if (!pdfBlob) return; // fetchPdf sets its own error

      const base64Pdf = await blobToBase64(pdfBlob);
      const fileName = `${productId}-flyer.pdf`;

      // Build email body — append signature if the user has one saved
      const sig = getSignatureHtml();
      const useHtml = !!sig;
      setSentWithSig(useHtml);
      const emailBody = useHtml
        ? { contentType: "HTML" as const, content: buildHtmlBodyWithSignature(body, sig) }
        : { contentType: "Text" as const, content: body };

      const message: Record<string, unknown> = {
        subject,
        body: emailBody,
        toRecipients: [
          { emailAddress: { address: toEmail.trim(), name: toName.trim() || undefined } },
        ],
        ...(ccEmail.trim() ? { ccRecipients: [{ emailAddress: { address: ccEmail.trim() } }] } : {}),
        attachments: [
          {
            "@odata.type": "#microsoft.graph.fileAttachment",
            name: fileName,
            contentType: "application/pdf",
            contentBytes: base64Pdf,
          },
        ],
      };

      const res = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${msalToken}`,
        },
        body: JSON.stringify({ message, saveToSentItems: true }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({})) as { error?: { message?: string } };
        setError(errData.error?.message ?? "Failed to send email.");
        return;
      }

      setSent(true);
      trackEvent("email_sent", { recipientType: tab, program: programName, property: propertyAddress });

      // Record all sent emails (fire and forget)
      if (tab !== "myself") {
        const idToken = await getIdToken().catch(() => null);
        if (idToken) {
          fetch("/api/follow-up/record", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${idToken}`,
            },
            body: JSON.stringify({
              recipientEmail: toEmail.trim(),
              recipientName: toName.trim(),
              recipientType: tab,
              subject,
              body,
              propertyAddress,
              programNames: [programName],
              followUpDays: followUpEnabled ? followUpDays : null,
              followUpMode: followUpEnabled ? followUpMode : null,
              userEmail: user?.email,
            }),
          }).catch(() => console.warn("[email-record] Recording failed (non-critical)"));
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send email.");
    } finally {
      setSending(false);
    }
  }

  const tabs: { id: RecipientTab; label: string }[] = [
    { id: "realtor", label: "Send to Realtor" },
    { id: "borrower", label: "Send to Borrower" },
    { id: "myself", label: "Send to Myself" },
  ];

  const showNameField = tab !== "myself";

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="relative flex w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3.5">
          <span className="text-base font-semibold text-gray-800">
            Email Flyer — {programName}
          </span>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-full bg-gray-100 text-gray-500 hover:bg-gray-200"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M12 4L4 12M4 4l8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="overflow-y-auto max-h-[80vh]">
          {/* Tabs */}
          <div className="flex border-b border-gray-100 px-5 pt-3">
            {tabs.map(({ id, label }) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`mr-4 border-b-2 pb-2 text-sm font-medium transition-colors ${
                  tab === id
                    ? "border-red-600 text-red-600"
                    : "border-transparent text-gray-500 hover:text-gray-700"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="space-y-3 p-5">
            {sent ? (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-center">
                <div className="text-2xl mb-1">✓</div>
                <p className="text-base font-medium text-emerald-800">Email sent successfully!</p>
                <p className="text-sm text-emerald-600 mt-0.5">
                  Sent to {toEmail}{ccEmail.trim() ? ` (CC: ${ccEmail.trim()})` : ""}{sentWithSig ? " — with your signature attached" : ""}.
                </p>
                <button
                  onClick={onClose}
                  className="mt-3 rounded-md bg-emerald-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-emerald-700"
                >
                  Close
                </button>
              </div>
            ) : (
              <>
                {/* Recipient fields */}
                <div className="space-y-2">
                  {showNameField && (
                    <div>
                      <label className="mb-0.5 block text-xs font-medium uppercase tracking-wide text-gray-500">
                        Recipient Name
                      </label>
                      <input
                        type="text"
                        value={toName}
                        onChange={(e) => setToName(e.target.value)}
                        placeholder={tab === "realtor" ? "Realtor name" : "Borrower name"}
                        className="w-full rounded-md border border-gray-200 px-3.5 py-2 text-base text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-400"
                      />
                    </div>
                  )}
                  <div>
                    <label className="mb-0.5 block text-xs font-medium uppercase tracking-wide text-gray-500">
                      To Email
                    </label>
                    <input
                      type="email"
                      value={toEmail}
                      onChange={(e) => setToEmail(e.target.value)}
                      readOnly={tab === "myself"}
                      placeholder="recipient@example.com"
                      className={`w-full rounded-md border border-gray-200 px-3.5 py-2 text-base text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-400 ${
                        tab === "myself" ? "bg-gray-50 text-gray-500" : ""
                      }`}
                    />
                  </div>
                  {tab !== "myself" && (
                    <div>
                      <label className="mb-0.5 block text-xs font-medium uppercase tracking-wide text-gray-500">
                        CC <span className="normal-case font-normal text-gray-400">(optional)</span>
                      </label>
                      <input
                        type="email"
                        value={ccEmail}
                        onChange={(e) => setCcEmail(e.target.value)}
                        placeholder="cc@example.com"
                        className="w-full rounded-md border border-gray-200 px-3.5 py-2 text-base text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-400"
                      />
                    </div>
                  )}

                  {/* Agent Intel — auto-research when realtor tab is active */}
                  {tab === "realtor" && (realtorInfo.name || realtorInfo.email || realtorInfo.company) && (
                    <AgentIntelCard
                      realtorName={realtorInfo.name}
                      realtorEmail={realtorInfo.email}
                      realtorCompany={realtorInfo.company}
                      onResearchComplete={handleResearchComplete}
                    />
                  )}

                  <div>
                    <label className="mb-0.5 block text-xs font-medium uppercase tracking-wide text-gray-500">
                      Subject
                    </label>
                    <input
                      type="text"
                      value={subject}
                      onChange={(e) => setSubject(e.target.value)}
                      placeholder="Email subject"
                      className="w-full rounded-md border border-gray-200 px-3.5 py-2 text-base text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-400"
                    />
                  </div>
                  <div>
                    <label className="mb-0.5 block text-xs font-medium uppercase tracking-wide text-gray-500">
                      Body
                    </label>
                    <textarea
                      value={body}
                      onChange={(e) => setBody(e.target.value)}
                      rows={8}
                      placeholder="Email body..."
                      className="w-full rounded-md border border-gray-200 px-3.5 py-2 text-base leading-relaxed text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-400 resize-y"
                    />
                  </div>
                </div>

                {/* AI Assist — not shown for "myself" (auto-generated) */}
                {tab !== "myself" && (
                  <div className="rounded-lg border border-violet-200 bg-violet-50 p-3 space-y-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-violet-700">
                      AI Assist — Gemini
                    </p>
                    <p className="text-sm text-violet-600">
                      Describe how you'd like the email written (tone, focus, length, etc.)
                    </p>
                    <div className="flex gap-2">
                      <textarea
                        value={aiPrompt}
                        onChange={(e) => { setAiPrompt(e.target.value); e.target.style.height = "auto"; e.target.style.height = e.target.scrollHeight + "px"; }}
                        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleAiSuggest(); } }}
                        placeholder={
                          tab === "realtor"
                            ? 'e.g. "Short intro, highlight the grant benefit"'
                            : 'e.g. "Friendly, explain the program briefly"'
                        }
                        rows={1}
                        className="flex-1 resize-none rounded-md border border-violet-200 bg-white px-3 py-2 text-sm text-gray-700 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-violet-400"
                      />
                      <button
                        onClick={handleAiSuggest}
                        disabled={aiLoading || !aiPrompt.trim()}
                        className="inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-40"
                      >
                        {aiLoading ? <LoadingSpinner size="sm" /> : null}
                        {aiLoading ? "Generating…" : "Generate"}
                      </button>
                    </div>
                    {(subject || body) && !aiLoading && (
                      <p className="text-[0.65rem] text-violet-500">
                        Subject and body updated above — edit freely before sending.
                      </p>
                    )}
                  </div>
                )}

                {/* Attachment indicator */}
                <div className="flex items-center gap-2 rounded-md border border-gray-100 bg-gray-50 px-3.5 py-2.5 text-sm text-gray-500">
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                    <path d="M3 2h10v12H3V2z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                    <path d="M5 6h6M5 9h6M5 12h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                  <span>{productId}-flyer.pdf will be attached</span>
                </div>

                {/* Signature status */}
                {sigOk ? (
                  <div className="flex items-center justify-between rounded-md border border-emerald-100 bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-700">
                    <div className="flex items-center gap-2">
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                        <path d="M13.3 4.3L6 11.6 2.7 8.3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      Your signature + company disclaimer will be attached
                    </div>
                    <button
                      onClick={() => setSigFixOpen(true)}
                      className="rounded border border-emerald-200 bg-white px-2.5 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50 transition-colors"
                    >
                      Review
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between rounded-md border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
                    <div className="flex items-center gap-2">
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                        <path d="M8 1a7 7 0 100 14A7 7 0 008 1zM7 4h2v5H7V4zm0 6h2v2H7v-2z" fill="currentColor" />
                      </svg>
                      Email signature required.
                    </div>
                    <button
                      onClick={() => setSigFixOpen(true)}
                      className="rounded bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-700 transition-colors"
                    >
                      Fix
                    </button>
                  </div>
                )}

                {error && (
                  <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
                    {error}
                  </p>
                )}

                {/* Actions */}
                <div className="flex items-center justify-between pt-1">
                  {tab !== "myself" ? (
                    <FollowUpToggle
                      enabled={followUpEnabled}
                      days={followUpDays}
                      mode={followUpMode}
                      onToggle={setFollowUpEnabled}
                      onDaysChange={setFollowUpDays}
                      onModeChange={setFollowUpMode}
                    />
                  ) : <div />}
                  <div className="flex items-center gap-3">
                    <button
                      onClick={onClose}
                      className="text-sm text-gray-400 hover:text-gray-600"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleSend}
                      disabled={sending}
                      className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-5 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                    >
                      {sending && <LoadingSpinner size="sm" />}
                      {sending ? "Sending…" : "Send Email"}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    {sigFixOpen && (
        <SignatureFixModal
          onClose={() => setSigFixOpen(false)}
          onSaved={() => { setSigOk(true); setSigFixOpen(false); setError(null); }}
        />
      )}
    </div>
  );
}

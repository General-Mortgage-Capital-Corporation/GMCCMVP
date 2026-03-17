"use client";

import { useState, useEffect } from "react";
import { useAuth } from "@/contexts/AuthContext";
import LoadingSpinner from "@/components/LoadingSpinner";
import { emailRequest } from "@/lib/msal-config";
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
  const { user, signIn, getMsalAccessToken } = useAuth();

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
  const [error, setError] = useState<string | null>(null);

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

  async function handleAiSuggest() {
    if (!aiPrompt.trim()) return;
    setAiLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/suggest-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipientType: tab,
          userPrompt: aiPrompt,
          programName,
          propertyAddress,
          listingPrice: listingPrice ? String(listingPrice) : undefined,
          realtorName: realtorInfo.name,
          realtorEmail: realtorInfo.email,
          loName,
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
  }

  async function handleSend() {
    if (sending) return; // guard against double-submission
    if (!toEmail.trim()) { setError("Recipient email is required."); return; }
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

      // Build Graph sendMail payload
      const message: Record<string, unknown> = {
        subject,
        body: {
          contentType: "Text",
          content: body,
        },
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
        className="relative flex w-full max-w-lg flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3.5">
          <span className="text-sm font-semibold text-gray-800">
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
                className={`mr-4 border-b-2 pb-2 text-xs font-medium transition-colors ${
                  tab === id
                    ? "border-blue-600 text-blue-600"
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
                <p className="text-sm font-medium text-emerald-800">Email sent successfully!</p>
                <p className="text-xs text-emerald-600 mt-0.5">
                  Sent to {toEmail}{ccEmail.trim() ? ` (CC: ${ccEmail.trim()})` : ""} — check your Sent folder.
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
                      <label className="mb-0.5 block text-[0.7rem] font-medium uppercase tracking-wide text-gray-500">
                        Recipient Name
                      </label>
                      <input
                        type="text"
                        value={toName}
                        onChange={(e) => setToName(e.target.value)}
                        placeholder={tab === "realtor" ? "Realtor name" : "Borrower name"}
                        className="w-full rounded-md border border-gray-200 px-3 py-1.5 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-400"
                      />
                    </div>
                  )}
                  <div>
                    <label className="mb-0.5 block text-[0.7rem] font-medium uppercase tracking-wide text-gray-500">
                      To Email
                    </label>
                    <input
                      type="email"
                      value={toEmail}
                      onChange={(e) => setToEmail(e.target.value)}
                      readOnly={tab === "myself"}
                      placeholder="recipient@example.com"
                      className={`w-full rounded-md border border-gray-200 px-3 py-1.5 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-400 ${
                        tab === "myself" ? "bg-gray-50 text-gray-500" : ""
                      }`}
                    />
                  </div>
                  {tab !== "myself" && (
                    <div>
                      <label className="mb-0.5 block text-[0.7rem] font-medium uppercase tracking-wide text-gray-500">
                        CC <span className="normal-case font-normal text-gray-400">(optional)</span>
                      </label>
                      <input
                        type="email"
                        value={ccEmail}
                        onChange={(e) => setCcEmail(e.target.value)}
                        placeholder="cc@example.com"
                        className="w-full rounded-md border border-gray-200 px-3 py-1.5 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-400"
                      />
                    </div>
                  )}
                  <div>
                    <label className="mb-0.5 block text-[0.7rem] font-medium uppercase tracking-wide text-gray-500">
                      Subject
                    </label>
                    <input
                      type="text"
                      value={subject}
                      onChange={(e) => setSubject(e.target.value)}
                      placeholder="Email subject"
                      className="w-full rounded-md border border-gray-200 px-3 py-1.5 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-400"
                    />
                  </div>
                  <div>
                    <label className="mb-0.5 block text-[0.7rem] font-medium uppercase tracking-wide text-gray-500">
                      Body
                    </label>
                    <textarea
                      value={body}
                      onChange={(e) => setBody(e.target.value)}
                      rows={6}
                      placeholder="Email body..."
                      className="w-full rounded-md border border-gray-200 px-3 py-1.5 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-400 resize-y"
                    />
                  </div>
                </div>

                {/* AI Assist — not shown for "myself" (auto-generated) */}
                {tab !== "myself" && (
                  <div className="rounded-lg border border-violet-200 bg-violet-50 p-3 space-y-2">
                    <p className="text-[0.7rem] font-semibold uppercase tracking-wide text-violet-700">
                      AI Assist — Gemini
                    </p>
                    <p className="text-xs text-violet-600">
                      Describe how you'd like the email written (tone, focus, length, etc.)
                    </p>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={aiPrompt}
                        onChange={(e) => setAiPrompt(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") handleAiSuggest(); }}
                        placeholder={
                          tab === "realtor"
                            ? 'e.g. "Short intro, highlight the grant benefit"'
                            : 'e.g. "Friendly, explain the program briefly"'
                        }
                        className="flex-1 rounded-md border border-violet-200 bg-white px-2.5 py-1.5 text-xs text-gray-700 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-violet-400"
                      />
                      <button
                        onClick={handleAiSuggest}
                        disabled={aiLoading || !aiPrompt.trim()}
                        className="inline-flex items-center gap-1 rounded-md bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-700 disabled:opacity-40"
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
                <div className="flex items-center gap-2 rounded-md border border-gray-100 bg-gray-50 px-3 py-2 text-xs text-gray-500">
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                    <path d="M3 2h10v12H3V2z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                    <path d="M5 6h6M5 9h6M5 12h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                  <span>{productId}-flyer.pdf will be attached</span>
                </div>

                {error && (
                  <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
                    {error}
                  </p>
                )}

                {/* Actions */}
                <div className="flex items-center justify-end gap-3 pt-1">
                  <button
                    onClick={onClose}
                    className="text-xs text-gray-400 hover:text-gray-600"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSend}
                    disabled={sending}
                    className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    {sending && <LoadingSpinner size="sm" />}
                    {sending ? "Sending…" : "Send Email"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

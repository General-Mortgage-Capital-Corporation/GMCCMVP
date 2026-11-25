"use client";

/**
 * "Preview whole email": the message exactly as the send would post it to
 * Graph — envelope, the rendered HTML body (greeting, body, embedded flyers,
 * signature, disclaimer) and every attachment, each openable.
 *
 * It renders the SAME message object the send uses (lib/email/message-preview.ts
 * only swaps cid: image references for data: URLs so the browser can show
 * them). The body runs in a sandboxed iframe with scripts off.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import LoadingSpinner from "@/components/LoadingSpinner";
import {
  formatBytes,
  formatRecipients,
  previewDocument,
  summarizeAttachments,
  totalAttachmentBytes,
  type PreviewableMessage,
} from "@/lib/email/message-preview";

function base64ToBlob(b64: string, type: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

/** Types safe to open as a same-origin blob tab. Anything else (HTML, SVG…)
 *  would run script in the app's origin, so it's downloaded instead. */
const OPENABLE = /^(application\/pdf|image\/(png|jpe?g|gif|webp))$/i;

function openAttachment(b64: string, type: string, name: string) {
  const openable = OPENABLE.test(type);
  const url = URL.createObjectURL(base64ToBlob(b64, openable ? type : "application/octet-stream"));
  const w = openable ? window.open(url, "_blank", "noopener") : null;
  if (!w) {
    // Pop-up blocked: download instead.
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 py-1.5 text-sm">
      <span className="w-16 shrink-0 text-xs font-medium uppercase tracking-wide text-gray-400 pt-0.5">{label}</span>
      <span className="min-w-0 break-words text-gray-800">{children}</span>
    </div>
  );
}

export default function EmailPreviewModal({
  message,
  from,
  loading = false,
  error,
  notes = [],
  warnings = [],
  controls,
  onClose,
  onSend,
  sending = false,
  sendLabel = "Send Email",
}: {
  /** The exact Graph message the send will post (null while it's being built). */
  message: PreviewableMessage | null;
  /** The sender, shown as From (the LO's mailbox). */
  from?: string;
  loading?: boolean;
  error?: string | null;
  /** Plain-English notes about how this send goes out (flyer delivery, fallbacks…). */
  notes?: string[];
  /** Things the LO should look at before sending (shown in amber). */
  warnings?: string[];
  /** Extra controls shown above the body (e.g. the desk's flyer option). */
  controls?: ReactNode;
  onClose: () => void;
  /** Omit to show a preview without a Send button. */
  onSend?: () => void;
  sending?: boolean;
  sendLabel?: string;
}) {
  const [width, setWidth] = useState<"desktop" | "phone">("desktop");
  const [height, setHeight] = useState(480);
  const frame = useRef<HTMLIFrameElement | null>(null);

  const doc = useMemo(() => (message ? previewDocument(message) : ""), [message]);
  const attachments = useMemo(() => (message ? summarizeAttachments(message) : []), [message]);
  const files = attachments.map((a, i) => ({ ...a, i })).filter((a) => !a.inline || !a.referenced);
  const shown = attachments.filter((a) => a.inline && a.referenced);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !sending && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, sending]);

  // Fit the iframe to its content (same-origin sandbox, scripts still off).
  const fit = () => {
    // body, not documentElement: the latter never reports less than the iframe's own height.
    const b = frame.current?.contentDocument?.body;
    if (b) setHeight(Math.max(240, b.scrollHeight + 4));
  };
  useEffect(() => {
    const t = setTimeout(fit, 250); // images decode after load
    return () => clearTimeout(t);
  }, [doc, width]);

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-3 sm:p-4" onClick={() => !sending && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Email preview"
        className="relative flex max-h-[94vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-gray-200 px-5 py-3.5">
          <div className="min-w-0">
            <div className="text-base font-semibold text-gray-800">Preview</div>
            <div className="text-xs text-gray-500">Exactly what the recipient will get — nothing has been sent.</div>
          </div>
          <div className="flex items-center gap-2">
            <div className="hidden rounded-lg bg-gray-100 p-0.5 text-xs sm:flex" role="group" aria-label="Preview width">
              {(["desktop", "phone"] as const).map((w) => (
                <button
                  key={w}
                  type="button"
                  onClick={() => setWidth(w)}
                  className={`rounded-md px-2.5 py-1 font-medium capitalize transition-colors ${width === w ? "bg-white text-gray-800 shadow-sm" : "text-gray-500 hover:text-gray-700"}`}
                >
                  {w}
                </button>
              ))}
            </div>
            <button
              onClick={onClose}
              disabled={sending}
              aria-label="Close preview"
              className="flex h-7 w-7 items-center justify-center rounded-full bg-gray-100 text-gray-500 hover:bg-gray-200 disabled:opacity-50"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M12 4L4 12M4 4l8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {controls && <div className="border-b border-gray-100 px-5 py-3">{controls}</div>}

          {loading || !message ? (
            <div className="flex flex-col items-center justify-center gap-3 px-5 py-16 text-sm text-gray-500">
              {error ? (
                <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>
              ) : (
                <>
                  <LoadingSpinner size="md" />
                  Building the email (flyers included)…
                </>
              )}
            </div>
          ) : (
            <>
              {/* Envelope */}
              <div className="border-b border-gray-100 px-5 py-2">
                {from && <Row label="From">{from}</Row>}
                <Row label="To">{formatRecipients(message.toRecipients) || <span className="text-red-600">No recipient</span>}</Row>
                {message.ccRecipients?.length ? <Row label="CC">{formatRecipients(message.ccRecipients)}</Row> : null}
                <Row label="Subject">
                  <span className="font-semibold">{message.subject || <span className="text-red-600">(no subject)</span>}</span>
                </Row>
              </div>

              {/* Attachments */}
              <div className="border-b border-gray-100 px-5 py-3">
                <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-gray-400">
                  Attachments
                  {message.attachments?.length ? (
                    <span className="ml-2 font-normal normal-case text-gray-400">({formatBytes(totalAttachmentBytes(message))} total)</span>
                  ) : null}
                </div>
                {files.length === 0 ? (
                  <p className="text-sm text-gray-500">None{shown.length ? " — the flyer is shown in the body below." : "."}</p>
                ) : (
                  <ul className="flex flex-wrap gap-2">
                    {files.map((a) => {
                      const raw = message.attachments![a.i];
                      return (
                        <li key={a.i}>
                          <button
                            type="button"
                            onClick={() => openAttachment(raw.contentBytes, raw.contentType, a.name)}
                            className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-sm text-gray-700 hover:border-gray-300 hover:bg-white"
                            title="Open"
                          >
                            <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-gray-400">
                              <path d="M14.5 9.5l-5.3 5.3a3.5 3.5 0 01-5-5l6-6a2.3 2.3 0 013.3 3.3l-6 6a1.2 1.2 0 01-1.7-1.7l5.3-5.3" />
                            </svg>
                            <span className="max-w-[16rem] truncate font-medium">{a.name}</span>
                            <span className="text-xs text-gray-400">{formatBytes(a.bytes)}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {shown.length > 0 && files.length > 0 && (
                  <p className="mt-1.5 text-xs text-gray-500">
                    {shown.length} flyer image{shown.length > 1 ? "s" : ""} shown in the body ({formatBytes(shown.reduce((n, a) => n + a.bytes, 0))}).
                  </p>
                )}
              </div>

              {notes.length + warnings.length > 0 && (
                <div className="space-y-1 border-b border-gray-100 px-5 py-2.5">
                  {notes.map((n) => (
                    <p key={n} className="text-xs text-gray-600">{n}</p>
                  ))}
                  {warnings.map((n) => (
                    <p key={n} className="text-xs font-medium text-amber-700">{n}</p>
                  ))}
                </div>
              )}

              {/* Body */}
              <div className="bg-gray-100 px-3 py-4 sm:px-5">
                <div className="mx-auto overflow-hidden rounded-lg bg-white shadow-sm ring-1 ring-gray-200 transition-[max-width] duration-200" style={{ maxWidth: width === "phone" ? 390 : 720 }}>
                  <iframe
                    ref={frame}
                    title="Email body"
                    srcDoc={doc}
                    sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
                    onLoad={fit}
                    className="block w-full border-0"
                    style={{ height }}
                  />
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 border-t border-gray-200 px-5 py-3">
          <button onClick={onClose} disabled={sending} className="text-sm text-gray-500 hover:text-gray-700 disabled:opacity-50">
            Back to edit
          </button>
          {onSend && (
            <button
              onClick={onSend}
              disabled={sending || loading || !message}
              className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-5 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
            >
              {sending && <LoadingSpinner size="sm" />}
              {sending ? "Sending…" : sendLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

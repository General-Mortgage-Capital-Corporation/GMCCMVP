/**
 * Previewing an outbound email exactly as it will be sent.
 *
 * Every send path builds a Graph `message` (subject, body, recipients,
 * attachments) and posts it to sendMail. The preview takes THAT object — the
 * one the send would post — and renders it; nothing is rebuilt or
 * approximated. The only change is for display: inline images referenced by
 * `cid:` (embedded flyers) become data: URLs, because a browser can't resolve
 * cid references the way a mail client does.
 *
 * Pure module — no imports, so it runs under `node --test` as-is.
 */

export interface PreviewRecipient {
  emailAddress: { address: string; name?: string };
}

export interface PreviewAttachment {
  name: string;
  contentType: string;
  /** base64 */
  contentBytes: string;
  isInline?: boolean;
  contentId?: string;
}

/** The parts of a Graph message the preview reads. */
export interface PreviewableMessage {
  subject: string;
  body: { contentType: "HTML" | "Text"; content: string };
  toRecipients?: PreviewRecipient[];
  ccRecipients?: PreviewRecipient[];
  attachments?: PreviewAttachment[];
}

export interface AttachmentSummary {
  name: string;
  contentType: string;
  /** Decoded size in bytes. */
  bytes: number;
  /** Shown in the body (cid image) rather than listed as a file. */
  inline: boolean;
  /** Referenced by the body (an inline image the reader actually sees). */
  referenced: boolean;
}

/** Decoded byte length of a base64 string. */
export function base64Bytes(b64: string): number {
  const s = (b64 || "").replace(/\s+/g, "");
  if (!s) return 0;
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return Math.floor((s.length * 3) / 4) - pad;
}

/** "312 KB", "1.4 MB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Body HTML with every `cid:<contentId>` that has an inline attachment swapped for a data: URL. */
export function inlineCidImages(html: string, attachments: PreviewAttachment[] = []): string {
  let out = html;
  for (const a of attachments) {
    if (!a.isInline || !a.contentId) continue;
    const re = new RegExp(`cid:${escapeRe(a.contentId)}(?=["'\\s)>])`, "g");
    out = out.replace(re, `data:${a.contentType};base64,${a.contentBytes}`);
  }
  return out;
}

/** What the reader gets as files and inline images, in send order. */
export function summarizeAttachments(message: PreviewableMessage): AttachmentSummary[] {
  const html = message.body.contentType === "HTML" ? message.body.content : "";
  return (message.attachments ?? []).map((a) => ({
    name: a.name,
    contentType: a.contentType,
    bytes: base64Bytes(a.contentBytes),
    inline: !!a.isInline,
    referenced: !!a.isInline && !!a.contentId && html.includes(`cid:${a.contentId}`),
  }));
}

/** Total size of the sendMail payload's attachments (what counts against Graph's 4 MB). */
export function totalAttachmentBytes(message: PreviewableMessage): number {
  return (message.attachments ?? []).reduce((n, a) => n + base64Bytes(a.contentBytes), 0);
}

/**
 * A standalone HTML document of the body, for a sandboxed iframe's srcdoc.
 * Links open in a new tab; a plain-text body is shown the way mail clients
 * show text (pre-wrapped, escaped).
 */
export function previewDocument(message: PreviewableMessage): string {
  const inner =
    message.body.contentType === "HTML"
      ? inlineCidImages(message.body.content, message.attachments)
      : `<div style="white-space:pre-wrap;font-family:Consolas,'Courier New',monospace;font-size:14px;color:#222">${escapeHtml(message.body.content)}</div>`;
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<base target="_blank">` +
    `<style>html,body{margin:0;background:#fff}body{padding:20px 22px;word-wrap:break-word}img{max-width:100%}</style>` +
    `</head><body>${inner}</body></html>`
  );
}

/** "Jane Doe <jane@x.com>" for each recipient. */
export function formatRecipients(list: PreviewRecipient[] = []): string {
  return list
    .map((r) => (r.emailAddress.name ? `${r.emailAddress.name} <${r.emailAddress.address}>` : r.emailAddress.address))
    .join(", ");
}

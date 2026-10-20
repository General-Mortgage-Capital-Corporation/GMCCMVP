/**
 * What can honestly be said about a flyer in an outbound email.
 *
 * Two facts drive everything here:
 *
 * 1. Graph `sendMail` takes ONE JSON body of at most 4 MB, attachments
 *    included (base64 inflates a file by a third). Anything bigger needs a
 *    draft + upload session, which requires the Mail.ReadWrite application
 *    permission — the GMCC app registration only has Mail.Read + Mail.Send.
 *    Program flyers from fillPdfFlier run 1.8–3.9 MB, so some of them can
 *    never be attached this way. They are LINKED instead (the portal serves a
 *    personalized copy), and the email says so.
 *
 * 2. The email body is written before the send. If the body says "attached"
 *    and nothing is attached, the LO has promised a realtor something that
 *    never arrived. `mentionsAttachment` lets the send path refuse that.
 *
 * Pure module — no imports, so it runs under `node --test` as-is.
 */

/** Largest base64 payload we put inline in a sendMail body. */
export const MAX_INLINE_ATTACHMENT_BASE64 = 3_600_000;

/** No automated email to the same address twice within this window. */
export const RECIPIENT_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

export const PORTAL_BASE = "https://mlo.joingmcc.com";

export type FlyerDelivery = "attached" | "linked" | "none";

const ATTACH_RE = /\b(?:attach(?:ed|ing|ment|ments)?|enclosed|enclosure)\b/i;

/** True when the text promises an attachment ("please find attached…"). */
export function mentionsAttachment(body: string): boolean {
  return ATTACH_RE.test(body || "");
}

/** Attach inline when it fits, otherwise link. */
export function deliveryForSize(base64Length: number): "attached" | "linked" {
  return base64Length <= MAX_INLINE_ATTACHMENT_BASE64 ? "attached" : "linked";
}

/**
 * The LO's personalized flyer on the portal (company-branded when the NMLS
 * is unknown — the portal falls back to the house identity).
 */
export function portalFlyerUrl(productId: string, loNmls?: string | null): string {
  const nmls = String(loNmls ?? "").replace(/\D/g, "") || "gmcc";
  return `${PORTAL_BASE}/api/public/programs/${encodeURIComponent(nmls)}/flyers/${encodeURIComponent(productId)}?style=standard`;
}

export function flyerLinkLine(url: string): string {
  return `Program flyer (PDF): ${url}`;
}

/** Body text with the flyer link added after the last paragraph. */
export function appendFlyerLink(body: string, url: string): string {
  const trimmed = (body || "").replace(/\s+$/, "");
  return `${trimmed}\n\n${flyerLinkLine(url)}`;
}

export function kb(base64Length: number): number {
  return Math.round((base64Length * 0.75) / 1024);
}

/** One phrase for tool results and status reports. */
export function describeFlyerDelivery(delivery: FlyerDelivery, opts: { sizeKB?: number; reason?: string } = {}): string {
  if (delivery === "attached") return `attached${opts.sizeKB ? ` (${Math.round(opts.sizeKB / 102.4) / 10} MB PDF)` : ""}`;
  if (delivery === "linked") return `linked, not attached${opts.reason ? ` (${opts.reason})` : ""}`;
  return `no flyer${opts.reason ? ` (${opts.reason})` : ""}`;
}

export function daysAgo(ts: number, now = Date.now()): number {
  return Math.max(0, Math.floor((now - ts) / (24 * 60 * 60 * 1000)));
}

/**
 * Showing a flyer inside the email body instead of attaching it.
 *
 * Email clients can't display a PDF in a message, so an embedded flyer is a
 * JPEG of its first page (see flyer-image.ts), carried in the message as an
 * inline attachment and referenced by cid. Hosted images would be blocked by
 * Outlook's "download pictures" prompt; inline ones just show.
 *
 * The cap is on what fits a readable email: up to five flyers in the body
 * (2026-11-23, was two), two per row; anything else the LO includes goes as a
 * PDF attachment or a link. With more than one shown, each image is rendered
 * at the two-column size with a byte budget (embedImageSpec) so five still fit
 * Graph's single-message limit.
 *
 * Pure apart from flyerImageFromBlob (browser only, called from the modals).
 */
import { MAX_ATTACH_BYTES, MAX_INLINE_ATTACHMENT_BASE64 } from "./attachment-policy.ts";

export const MAX_EMBEDDED_FLYERS = 5;

/** Width the flyer displays at. Rendered at twice this so small print stays sharp. */
export const EMBED_DISPLAY_WIDTH = 600;

export interface FlyerImage {
  base64: string;
  width: number;
  height: number;
}

export interface EmbeddedFlyer extends FlyerImage {
  /** Product id. */
  id: string;
  /** Program name, used for the alt text. */
  title: string;
  /** The PDF behind the image, when there is a public link to it. */
  pdfUrl?: string;
}

function slug(id: string): string {
  return id.replace(/[^a-zA-Z0-9-]+/g, "-");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function flyerContentId(id: string): string {
  return `flyer-${slug(id)}@gmccloan.com`;
}

/** Width of each flyer when two sit side by side (two columns plus a gap fill 600). */
export const PAIR_DISPLAY_WIDTH = 294;

/** A single flyer image's size limit (also the old two-flyer size). */
const SINGLE_IMAGE_MAX_BYTES = 900 * 1024;

/**
 * Render size for each flyer image when `count` flyers are shown in the body:
 * one fills the column at 2x; several sit two per row, so 2x the column width
 * is all they need, and they share ~60% of the message budget.
 */
export function embedImageSpec(count: number): { width: number; maxBytes: number } {
  if (count <= 1) return { width: EMBED_DISPLAY_WIDTH * 2, maxBytes: SINGLE_IMAGE_MAX_BYTES };
  return {
    width: PAIR_DISPLAY_WIDTH * 2,
    maxBytes: Math.min(450 * 1024, Math.floor((MAX_ATTACH_BYTES * 0.6) / count)),
  };
}

/** The render spec for a requested per-image byte budget (the jpeg route's maxBytes). */
export function imageSpecForBytes(maxBytes?: number): { width: number; maxBytes: number } {
  if (!maxBytes || !Number.isFinite(maxBytes) || maxBytes >= SINGLE_IMAGE_MAX_BYTES) return embedImageSpec(1);
  return { width: PAIR_DISPLAY_WIDTH * 2, maxBytes: Math.max(120 * 1024, Math.floor(maxBytes)) };
}
const PAIR_GAP = 12;

function flyerCell(f: EmbeddedFlyer, width: number): string {
  const height = Math.round((f.height * width) / f.width);
  const alt = escapeHtml(`${f.title} flyer`);
  const img =
    `<img src="cid:${flyerContentId(f.id)}" alt="${alt}" width="${width}" height="${height}" ` +
    `style="display:block;width:100%;max-width:${width}px;height:auto;border:0;outline:none;text-decoration:none">`;
  const href = f.pdfUrl ? escapeHtml(f.pdfUrl) : null;
  return (
    `<table role="presentation" width="${width}" cellpadding="0" cellspacing="0" border="0" ` +
    `style="width:100%;max-width:${width}px;border-collapse:collapse">` +
    `<tr><td style="padding:0">${href ? `<a href="${href}" style="text-decoration:none">${img}</a>` : img}</td></tr>` +
    (href
      ? `<tr><td style="padding:6px 0 0;font-size:12px;line-height:16px;color:#666"><a href="${href}" style="color:#666">View or print the PDF</a></td></tr>`
      : "") +
    `</table>`
  );
}

/**
 * The flyers as email HTML. One flyer fills the 600px column; two sit side by
 * side. Tables with explicit width attributes are what Outlook on Windows
 * respects (the [if mso] table keeps the pair in one row there); width:100% +
 * height:auto lets every other client shrink the images, and on a phone too
 * narrow for both the pair wraps to one under the other.
 */
export function flyerImagesHtml(flyers: EmbeddedFlyer[]): string {
  if (flyers.length === 0) return "";
  const outer = (inner: string) =>
    `<table role="presentation" width="${EMBED_DISPLAY_WIDTH}" cellpadding="0" cellspacing="0" border="0" ` +
    `style="width:100%;max-width:${EMBED_DISPLAY_WIDTH}px;border-collapse:collapse;margin:20px 0 0">` +
    `<tr><td style="padding:0;font-size:0;line-height:0">${inner}</td></tr></table>`;
  if (flyers.length === 1) return outer(flyerCell(flyers[0], EMBED_DISPLAY_WIDTH));

  const rows: string[] = [];
  for (let i = 0; i < flyers.length; i += 2) {
    const pair = flyers.slice(i, i + 2);
    const columns = pair.map((f, j) => {
      const pad = j === 0 ? `0 ${PAIR_GAP / 2}px ${PAIR_GAP}px 0` : `0 0 ${PAIR_GAP}px ${PAIR_GAP / 2}px`;
      return (
        `<div style="display:inline-block;width:100%;max-width:${PAIR_DISPLAY_WIDTH + PAIR_GAP / 2}px;vertical-align:top">` +
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse">` +
        `<tr><td style="padding:${pad}">${flyerCell(f, PAIR_DISPLAY_WIDTH)}</td></tr></table></div>`
      );
    });
    rows.push(
      `<!--[if mso]><table role="presentation" width="${EMBED_DISPLAY_WIDTH}" cellpadding="0" cellspacing="0" border="0"><tr>` +
        `<td width="${EMBED_DISPLAY_WIDTH / 2}" valign="top"><![endif]-->` +
        columns.join(`<!--[if mso]></td><td width="${EMBED_DISPLAY_WIDTH / 2}" valign="top"><![endif]-->`) +
        `<!--[if mso]></td></tr></table><![endif]-->`,
    );
  }
  return outer(rows.join(""));
}

/** The image as a Graph attachment the body can reference by cid. */
export function inlineFlyerAttachment(f: EmbeddedFlyer) {
  return {
    "@odata.type": "#microsoft.graph.fileAttachment" as const,
    name: `${slug(f.id)}-flyer.jpg`,
    contentType: "image/jpeg",
    contentBytes: f.base64,
    isInline: true,
    contentId: flyerContentId(f.id),
  };
}

/** Which flyers start out embedded: the first ones, up to the cap. */
export function defaultEmbedIds(ids: string[]): string[] {
  return ids.slice(0, MAX_EMBEDDED_FLYERS);
}

/** Turn one flyer on or off; turning one on past the cap is ignored. */
export function toggleEmbedId(current: string[], id: string): string[] {
  if (current.includes(id)) return current.filter((x) => x !== id);
  return current.length >= MAX_EMBEDDED_FLYERS ? current : [...current, id];
}

/**
 * Which PDFs still fit Graph's single-request limit after what's already on
 * the message. Earlier items win; the rest have to go as links.
 */
export function splitByBudget<T extends { base64: string }>(
  pdfs: T[],
  usedBase64: number,
): { fit: T[]; overflow: T[] } {
  const fit: T[] = [];
  const overflow: T[] = [];
  let used = usedBase64;
  for (const pdf of pdfs) {
    if (used + pdf.base64.length <= MAX_INLINE_ATTACHMENT_BASE64) {
      fit.push(pdf);
      used += pdf.base64.length;
    } else {
      overflow.push(pdf);
    }
  }
  return { fit, overflow };
}

/** Room kept for the optional program-summary attachment. */
const SUMMARY_RESERVE_BYTES = 64 * 1024;
/** No PDF is asked to shrink below this; one that can't fit is linked. */
const MIN_PDF_SHARE_BYTES = 300 * 1024;

/**
 * How big each attached PDF may be so that all of them fit in one message
 * next to the flyers shown in the body. Flyers over it are shrunk to fit.
 */
export function pdfShareBytes(flyerCount: number, embeddedCount: number): number {
  const pdfCount = Math.max(1, flyerCount - embeddedCount);
  const room = MAX_ATTACH_BYTES - (embeddedCount ? embeddedCount * embedImageSpec(embeddedCount).maxBytes : 0) - SUMMARY_RESERVE_BYTES;
  return Math.max(MIN_PDF_SHARE_BYTES, Math.floor(room / pdfCount));
}

/** Plain-English count of what a send carried: "2 shown in the email, 1 attached". */
export function describeFlyerCounts(counts: { embedded: number; attached: number; linked: number; failed?: number }): string {
  const parts = [
    counts.embedded ? `${counts.embedded} flyer${counts.embedded > 1 ? "s" : ""} shown in the email` : "",
    counts.attached ? `${counts.attached} attached as PDF` : "",
    counts.linked ? `${counts.linked} linked (too large to attach)` : "",
    counts.failed ? `${counts.failed} could not be generated and was left out` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "no flyers";
}

/** Browser only: a rendered flyer JPEG as base64 plus its pixel size. */
export async function flyerImageFromBlob(
  blob: Blob,
  toBase64: (b: Blob) => Promise<string>,
): Promise<FlyerImage> {
  const bitmap = await createImageBitmap(blob);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return { base64: await toBase64(blob), ...size };
}

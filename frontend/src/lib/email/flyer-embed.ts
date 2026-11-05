/**
 * Showing a flyer inside the email body instead of attaching it.
 *
 * Email clients can't display a PDF in a message, so an embedded flyer is a
 * JPEG of its first page (see flyer-image.ts), carried in the message as an
 * inline attachment and referenced by cid. Hosted images would be blocked by
 * Outlook's "download pictures" prompt; inline ones just show.
 *
 * The cap is on what fits a readable email: at most two flyers in the body,
 * anything else the LO includes goes as a PDF attachment or a link.
 *
 * Pure apart from flyerImageFromBlob (browser only, called from the modals).
 */
import { MAX_INLINE_ATTACHMENT_BASE64 } from "./attachment-policy.ts";

export const MAX_EMBEDDED_FLYERS = 2;

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

/**
 * The flyers as email HTML. A table with explicit width and height attributes
 * is what Outlook on Windows respects; width:100% + height:auto is what lets
 * every other client shrink the image to fit a phone.
 */
export function flyerImagesHtml(flyers: EmbeddedFlyer[]): string {
  return flyers
    .map((f) => {
      const height = Math.round((f.height * EMBED_DISPLAY_WIDTH) / f.width);
      const alt = escapeHtml(`${f.title} flyer`);
      const img =
        `<img src="cid:${flyerContentId(f.id)}" alt="${alt}" width="${EMBED_DISPLAY_WIDTH}" height="${height}" ` +
        `style="display:block;width:100%;max-width:${EMBED_DISPLAY_WIDTH}px;height:auto;border:0;outline:none;text-decoration:none">`;
      const href = f.pdfUrl ? escapeHtml(f.pdfUrl) : null;
      return (
        `<table role="presentation" width="${EMBED_DISPLAY_WIDTH}" cellpadding="0" cellspacing="0" border="0" ` +
        `style="width:100%;max-width:${EMBED_DISPLAY_WIDTH}px;border-collapse:collapse;margin:20px 0 0">` +
        `<tr><td style="padding:0">${href ? `<a href="${href}" style="text-decoration:none">${img}</a>` : img}</td></tr>` +
        (href
          ? `<tr><td style="padding:6px 0 0;font-size:12px;color:#666"><a href="${href}" style="color:#666">View or print the PDF</a></td></tr>`
          : "") +
        `</table>`
      );
    })
    .join("\n");
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

/** Turn one flyer on or off; turning on a third is ignored. */
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

/**
 * Making a flyer PDF small enough to attach (server only).
 *
 * Graph's sendMail takes one request of at most 4 MB, and program flyers from
 * fillPdfFlier run 3-6 MB, mostly full-resolution photos. Rather than link a
 * flyer that is too big, each page is redrawn as a JPEG at print resolution
 * and wrapped in a new PDF: about 400-700 KB, the same page size, and it
 * prints cleanly. The text is no longer selectable, so a PDF that already fits
 * is left exactly as it is.
 */
import { jpegPagesToPdf, type JpegPage } from "./flyer-pdf-pages.ts";
import { MAX_ATTACH_BYTES } from "./attachment-policy.ts";

/** Tried in order until one fits: print quality first. */
const STEPS = [
  { dpi: 200, quality: 82 },
  { dpi: 150, quality: 75 },
  { dpi: 110, quality: 68 },
];

async function renderPages(pdf: Uint8Array, dpi: number, quality: number): Promise<JpegPage[]> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { createCanvas } = await import("@napi-rs/canvas");
  // pdf.js detaches the buffer it is given, so hand it a copy.
  const task = getDocument({ data: new Uint8Array(pdf), disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  try {
    const doc = await task.promise;
    const pages: JpegPage[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const size = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: dpi / 72 });
      const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
      const context = canvas.getContext("2d");
      context.fillStyle = "#ffffff"; // JPEG has no transparency
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({
        canvasContext: context as unknown as CanvasRenderingContext2D,
        canvas: canvas as unknown as HTMLCanvasElement,
        viewport,
      }).promise;
      pages.push({
        widthPt: size.width,
        heightPt: size.height,
        widthPx: canvas.width,
        heightPx: canvas.height,
        jpeg: canvas.toBuffer("image/jpeg", quality),
      });
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

/**
 * The flyer as it should be attached: unchanged when it is at most maxBytes,
 * otherwise the best-quality image version that fits. When even the smallest
 * version is too big, that one comes back anyway and the caller links instead.
 */
export async function attachableFlyerPdf(
  pdf: Uint8Array,
  maxBytes: number = MAX_ATTACH_BYTES,
): Promise<{ pdf: Uint8Array; compacted: boolean }> {
  if (pdf.byteLength <= maxBytes) return { pdf, compacted: false };
  let smallest: Uint8Array | null = null;
  for (const step of STEPS) {
    const out = jpegPagesToPdf(await renderPages(pdf, step.dpi, step.quality));
    if (!smallest || out.byteLength < smallest.byteLength) smallest = out;
    if (out.byteLength <= maxBytes) return { pdf: out, compacted: true };
  }
  return smallest && smallest.byteLength < pdf.byteLength ? { pdf: smallest, compacted: true } : { pdf, compacted: false };
}

/** Same, for callers holding base64; never throws (the original comes back on failure). */
export async function attachableFlyerBase64(base64: string, maxBytes?: number): Promise<string> {
  try {
    const { pdf, compacted } = await attachableFlyerPdf(new Uint8Array(Buffer.from(base64, "base64")), maxBytes);
    return compacted ? Buffer.from(pdf).toString("base64") : base64;
  } catch (err) {
    console.error("[flyer-pdf-compact] could not shrink the flyer:", err);
    return base64;
  }
}

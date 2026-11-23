/**
 * Page 1 of a flyer PDF as a JPEG for embedding in an email body (server only).
 *
 * Fonts are drawn as paths so nothing depends on fonts installed on the server.
 * Size comes from embedImageSpec: one flyer at 2x the 600px column; several
 * at 2x the two-column width with a smaller byte budget, so up to five fit
 * inside Graph's 4 MB message limit.
 */
import { embedImageSpec, type FlyerImage } from "./flyer-embed.ts";

export async function renderFlyerImage(
  pdf: Uint8Array,
  spec: { width: number; maxBytes: number } = embedImageSpec(1),
): Promise<FlyerImage> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { createCanvas } = await import("@napi-rs/canvas");

  // pdf.js detaches the buffer it is given, so hand it a copy.
  const task = getDocument({
    data: new Uint8Array(pdf),
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  try {
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const scale = spec.width / page.getViewport({ scale: 1 }).width;
    const viewport = page.getViewport({ scale });
    const width = Math.round(viewport.width);
    const height = Math.round(viewport.height);

    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff"; // JPEG has no transparency
    context.fillRect(0, 0, width, height);
    await page.render({
      canvasContext: context as unknown as CanvasRenderingContext2D,
      canvas: canvas as unknown as HTMLCanvasElement,
      viewport,
    }).promise;

    let jpeg = canvas.toBuffer("image/jpeg", 80);
    for (const q of [65, 50, 40]) {
      if (jpeg.length <= spec.maxBytes) break;
      jpeg = canvas.toBuffer("image/jpeg", q);
    }
    return { base64: jpeg.toString("base64"), width, height };
  } finally {
    await task.destroy();
  }
}

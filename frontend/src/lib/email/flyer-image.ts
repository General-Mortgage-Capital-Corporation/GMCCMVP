/**
 * Page 1 of a flyer PDF as a JPEG for embedding in an email body (server only).
 *
 * Fonts are drawn as paths so nothing depends on fonts installed on the server.
 * A 3-6 MB flyer comes out around 200 KB, so two fit well inside Graph's 4 MB
 * message limit.
 */
import { EMBED_DISPLAY_WIDTH, type FlyerImage } from "./flyer-embed.ts";

const RENDER_WIDTH = EMBED_DISPLAY_WIDTH * 2;
const TARGET_MAX_BYTES = 900 * 1024;

export async function renderFlyerImage(pdf: Uint8Array): Promise<FlyerImage> {
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
    const scale = RENDER_WIDTH / page.getViewport({ scale: 1 }).width;
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
    if (jpeg.length > TARGET_MAX_BYTES) jpeg = canvas.toBuffer("image/jpeg", 60);
    return { base64: jpeg.toString("base64"), width, height };
  } finally {
    await task.destroy();
  }
}

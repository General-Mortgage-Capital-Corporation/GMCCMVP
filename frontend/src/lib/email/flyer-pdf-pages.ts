/**
 * A PDF built from page images (pure: Buffer only, runs under `node --test`).
 *
 * Used to shrink a flyer that is too big to attach (see flyer-pdf-compact.ts):
 * each page becomes one JPEG drawn over the whole page, at the page's
 * original size in points, so it prints the same size as the original.
 */

export interface JpegPage {
  /** Page size in PDF points (1/72 inch). */
  widthPt: number;
  heightPt: number;
  /** Image size in pixels. */
  widthPx: number;
  heightPx: number;
  /** Baseline RGB JPEG bytes. */
  jpeg: Uint8Array;
}

function num(n: number): string {
  return String(Math.round(n * 100) / 100);
}

export function jpegPagesToPdf(pages: JpegPage[]): Buffer {
  if (pages.length === 0) throw new Error("jpegPagesToPdf: no pages");

  // Object numbers: 1 catalog, 2 page tree, then page / contents / image per page.
  const pageObj = (i: number) => 3 + i * 3;
  const objects: Buffer[] = [];
  const add = (body: string | Buffer[]) =>
    objects.push(typeof body === "string" ? Buffer.from(body, "latin1") : Buffer.concat(body));

  add("<< /Type /Catalog /Pages 2 0 R >>");
  add(`<< /Type /Pages /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  pages.forEach((p, i) => {
    const n = pageObj(i);
    const w = num(p.widthPt);
    const h = num(p.heightPt);
    add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] ` +
        `/Resources << /XObject << /Im0 ${n + 2} 0 R >> >> /Contents ${n + 1} 0 R >>`,
    );
    const draw = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
    add(`<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`);
    add([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${p.widthPx} /Height ${p.heightPx} ` +
          `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`,
        "latin1",
      ),
      Buffer.from(p.jpeg),
      Buffer.from("\nendstream", "latin1"),
    ]);
  });

  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  let offset = chunks[0].length;
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(offset);
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, "latin1"), body, Buffer.from("\nendobj\n", "latin1")]);
    chunks.push(chunk);
    offset += chunk.length;
  });
  const xref =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("") +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, "latin1"));
  return Buffer.concat(chunks);
}

// node --test src/lib/email/flyer-pdf-pages.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { jpegPagesToPdf } from "./flyer-pdf-pages.ts";

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const page = { widthPt: 816.96, heightPt: 1057.92, widthPx: 1702, heightPx: 2204, jpeg };

test("each page draws its image over the original page size", () => {
  const pdf = jpegPagesToPdf([page, page]).toString("latin1");
  assert.ok(pdf.startsWith("%PDF-1.4"));
  assert.ok(pdf.trimEnd().endsWith("%%EOF"));
  assert.ok(pdf.includes("/Count 2"));
  assert.equal((pdf.match(/\/MediaBox \[0 0 816.96 1057.92\]/g) ?? []).length, 2);
  assert.ok(pdf.includes("/Width 1702 /Height 2204"));
  assert.ok(pdf.includes("/Filter /DCTDecode /Length 4"));
  assert.ok(pdf.includes("q 816.96 0 0 1057.92 0 0 cm /Im0 Do Q"));
});

test("the xref offsets point at each object", () => {
  const buf = jpegPagesToPdf([page]);
  const text = buf.toString("latin1");
  const start = Number(text.match(/startxref\n(\d+)/)![1]);
  assert.ok(text.slice(start).startsWith("xref\n0 6\n"));
  const offsets = [...text.slice(start).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  assert.equal(offsets.length, 5);
  offsets.forEach((o, i) => assert.ok(text.slice(o).startsWith(`${i + 1} 0 obj\n`)));
});

test("no pages is an error", () => {
  assert.throws(() => jpegPagesToPdf([]));
});

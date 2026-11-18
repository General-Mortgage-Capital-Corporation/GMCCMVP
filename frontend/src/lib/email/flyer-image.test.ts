// node --test src/lib/email/flyer-image.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { renderFlyerImage } from "./flyer-image.ts";

// A one-page, letter-size PDF with a filled rectangle. pdf.js rebuilds the
// cross-reference table when it isn't there.
const PDF = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R>>endobj
4 0 obj<</Length 27>>stream
1 0 0 rg 0 0 300 300 re f
endstream endobj
trailer<</Root 1 0 R>>
%%EOF`;

test("renders page 1 as a JPEG at twice the display width, same proportions", async () => {
  const image = await renderFlyerImage(new TextEncoder().encode(PDF));
  assert.equal(image.width, 1200);
  assert.equal(image.height, Math.round((792 * 1200) / 612));
  const bytes = Buffer.from(image.base64, "base64");
  assert.deepEqual([...bytes.subarray(0, 3)], [0xff, 0xd8, 0xff]);
});

test("a file that isn't a PDF rejects, so callers can fall back", async () => {
  await assert.rejects(renderFlyerImage(new TextEncoder().encode("not a pdf")));
});

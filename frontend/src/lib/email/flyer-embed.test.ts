// node --test src/lib/email/flyer-embed.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { MAX_ATTACH_BYTES, MAX_INLINE_ATTACHMENT_BASE64 } from "./attachment-policy.ts";
import {
  EMBED_DISPLAY_WIDTH,
  defaultEmbedIds,
  describeFlyerCounts,
  flyerContentId,
  flyerImagesHtml,
  inlineFlyerAttachment,
  PAIR_DISPLAY_WIDTH,
  pdfShareBytes,
  embedImageSpec,
  imageSpecForBytes,
  splitByBudget,
  toggleEmbedId,
} from "./flyer-embed.ts";

const flyer = { id: "buy-without-sell-first", title: "Buy <Without> Sell", base64: "AAAA", width: 1200, height: 1554 };

test("the image references the inline attachment and scales on every client", () => {
  const html = flyerImagesHtml([flyer]);
  assert.ok(html.includes(`src="cid:${flyerContentId(flyer.id)}"`));
  assert.ok(html.includes(`width="${EMBED_DISPLAY_WIDTH}" height="777"`));
  assert.ok(html.includes("width:100%"));
  assert.ok(html.includes("height:auto"));
});

test("alt text and links are escaped", () => {
  const html = flyerImagesHtml([{ ...flyer, pdfUrl: `https://x.test/a?b=1&c="d"` }]);
  assert.ok(html.includes('alt="Buy &lt;Without&gt; Sell flyer"'));
  assert.ok(html.includes('href="https://x.test/a?b=1&amp;c=&quot;d&quot;"'));
  assert.ok(!html.includes('c="d"'));
});

test("the PDF link is only there when a PDF URL is known", () => {
  assert.ok(!flyerImagesHtml([flyer]).includes("View or print"));
  assert.ok(flyerImagesHtml([{ ...flyer, pdfUrl: "https://x.test/f" }]).includes("View or print the PDF"));
});

test("the inline attachment matches the cid in the body", () => {
  const a = inlineFlyerAttachment(flyer);
  assert.equal(a.isInline, true);
  assert.equal(a.contentId, flyerContentId(flyer.id));
  assert.equal(a.contentType, "image/jpeg");
});

test("up to five flyers are embedded by default", () => {
  assert.deepEqual(defaultEmbedIds(["a", "b", "c", "d", "e", "f"]), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(toggleEmbedId(["a", "b", "c", "d", "e"], "f"), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(toggleEmbedId(["a", "b"], "a"), ["b"]);
  assert.deepEqual(toggleEmbedId(["b"], "c"), ["b", "c"]);
});

test("five shown flyers fit one message", () => {
  const spec = embedImageSpec(5);
  assert.ok(spec.width < embedImageSpec(1).width);
  assert.ok(5 * spec.maxBytes + 64 * 1024 <= MAX_ATTACH_BYTES);
  assert.deepEqual(imageSpecForBytes(undefined), embedImageSpec(1));
  assert.equal(imageSpecForBytes(spec.maxBytes).maxBytes, spec.maxBytes);
});

test("PDFs past the size limit are split off, counting what is already on the message", () => {
  const big = { id: "big", base64: "x".repeat(MAX_INLINE_ATTACHMENT_BASE64 - 100) };
  const small = { id: "small", base64: "x".repeat(50) };
  const large = { id: "large", base64: "x".repeat(200) };
  const { fit, overflow } = splitByBudget([big, large, small], 0);
  assert.deepEqual(fit.map((p) => p.id), ["big", "small"]);
  assert.deepEqual(overflow.map((p) => p.id), ["large"]);
  assert.deepEqual(splitByBudget([small], MAX_INLINE_ATTACHMENT_BASE64).overflow, [small]);
});

test("counts read plainly", () => {
  assert.equal(describeFlyerCounts({ embedded: 2, attached: 1, linked: 0 }), "2 flyers shown in the email, 1 attached as PDF");
  assert.equal(describeFlyerCounts({ embedded: 0, attached: 0, linked: 0 }), "no flyers");
});

test("two flyers sit side by side, each half the width, kept in one row on Outlook", () => {
  const html = flyerImagesHtml([flyer, { ...flyer, id: "universe", title: "Universe" }]);
  assert.equal((html.match(/<img /g) ?? []).length, 2);
  assert.equal((html.match(/display:inline-block/g) ?? []).length, 2);
  assert.ok(html.includes(`width="${PAIR_DISPLAY_WIDTH}" height="${Math.round((1554 * PAIR_DISPLAY_WIDTH) / 1200)}"`));
  assert.ok(html.includes("<!--[if mso]><table"));
  assert.ok(html.includes(`<td width="${EMBED_DISPLAY_WIDTH / 2}" valign="top">`));
  assert.ok(html.includes(`src="cid:${flyerContentId("universe")}"`));
});

test("one flyer still fills the column", () => {
  const html = flyerImagesHtml([flyer]);
  assert.ok(!html.includes("inline-block"));
  assert.equal(flyerImagesHtml([]), "");
});

test("attached PDFs share what is left after the shown flyers", () => {
  assert.equal(pdfShareBytes(1, 0), MAX_ATTACH_BYTES - 64 * 1024);
  assert.ok(pdfShareBytes(4, 2) < pdfShareBytes(3, 2));
  assert.ok(pdfShareBytes(4, 2) * 2 + 2 * embedImageSpec(2).maxBytes <= MAX_ATTACH_BYTES);
  assert.equal(pdfShareBytes(20, 0), 300 * 1024);
});

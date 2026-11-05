// node --test src/lib/email/flyer-embed.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { MAX_INLINE_ATTACHMENT_BASE64 } from "./attachment-policy.ts";
import {
  EMBED_DISPLAY_WIDTH,
  defaultEmbedIds,
  describeFlyerCounts,
  flyerContentId,
  flyerImagesHtml,
  inlineFlyerAttachment,
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

test("at most two flyers can be embedded", () => {
  assert.deepEqual(defaultEmbedIds(["a", "b", "c"]), ["a", "b"]);
  assert.deepEqual(toggleEmbedId(["a", "b"], "c"), ["a", "b"]);
  assert.deepEqual(toggleEmbedId(["a", "b"], "a"), ["b"]);
  assert.deepEqual(toggleEmbedId(["b"], "c"), ["b", "c"]);
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

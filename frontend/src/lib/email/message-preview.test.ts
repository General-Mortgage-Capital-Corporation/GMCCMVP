// node --test src/lib/email/message-preview.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  base64Bytes,
  formatBytes,
  formatRecipients,
  inlineCidImages,
  previewDocument,
  summarizeAttachments,
  totalAttachmentBytes,
  type PreviewableMessage,
} from "./message-preview.ts";
import { flyerImagesHtml, inlineFlyerAttachment } from "./flyer-embed.ts";

const flyer = { id: "gmcc-ocean", title: "Ocean", base64: "AAEC", width: 1200, height: 1553, pdfUrl: "https://x/y.pdf" };

test("base64Bytes decodes padding exactly", () => {
  assert.equal(base64Bytes(""), 0);
  assert.equal(base64Bytes(Buffer.from("a").toString("base64")), 1);
  assert.equal(base64Bytes(Buffer.from("ab").toString("base64")), 2);
  assert.equal(base64Bytes(Buffer.from("abc").toString("base64")), 3);
  assert.equal(base64Bytes(Buffer.alloc(12345).toString("base64")), 12345);
});

test("formatBytes", () => {
  assert.equal(formatBytes(500), "500 B");
  assert.equal(formatBytes(300 * 1024), "300 KB");
  assert.equal(formatBytes(1.5 * 1024 * 1024), "1.5 MB");
});

test("embedded flyer cid becomes a data URL; nothing else in the body changes", () => {
  const html = `<p>Hi</p>${flyerImagesHtml([flyer])}<p>sig</p>`;
  const att = inlineFlyerAttachment(flyer);
  const out = inlineCidImages(html, [att]);
  assert.ok(!out.includes("cid:"));
  assert.ok(out.includes(`src="data:image/jpeg;base64,${flyer.base64}"`));
  assert.equal(out.replace(`data:image/jpeg;base64,${flyer.base64}`, `cid:${att.contentId}`), html);
});

test("non-inline attachments never touch the body", () => {
  const html = `<img src="cid:x@y">`;
  assert.equal(inlineCidImages(html, [{ name: "a.pdf", contentType: "application/pdf", contentBytes: "AA==", contentId: "x@y" }]), html);
});

test("summarizeAttachments lists files and inline images with sizes", () => {
  const msg: PreviewableMessage = {
    subject: "s",
    body: { contentType: "HTML", content: flyerImagesHtml([flyer]) },
    attachments: [
      inlineFlyerAttachment(flyer),
      { name: "GMCC-Ocean.pdf", contentType: "application/pdf", contentBytes: Buffer.alloc(2048).toString("base64") },
    ],
  };
  const s = summarizeAttachments(msg);
  assert.deepEqual(s.map((a) => [a.name, a.inline, a.referenced]), [["gmcc-ocean-flyer.jpg", true, true], ["GMCC-Ocean.pdf", false, false]]);
  assert.equal(s[1].bytes, 2048);
  assert.equal(totalAttachmentBytes(msg), 2048 + 3);
});

test("plain-text body is escaped and pre-wrapped", () => {
  const doc = previewDocument({ subject: "s", body: { contentType: "Text", content: "a <b>\nline" } });
  assert.ok(doc.includes("a &lt;b&gt;\nline"));
  assert.ok(doc.includes("white-space:pre-wrap"));
  assert.ok(doc.includes('<base target="_blank">'));
});

test("formatRecipients", () => {
  assert.equal(
    formatRecipients([{ emailAddress: { address: "a@x.com", name: "Ann" } }, { emailAddress: { address: "b@x.com" } }]),
    "Ann <a@x.com>, b@x.com",
  );
});

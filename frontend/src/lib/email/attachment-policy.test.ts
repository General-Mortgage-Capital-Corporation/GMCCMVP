// node --test src/lib/email/attachment-policy.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_INLINE_ATTACHMENT_BASE64,
  appendFlyerLink,
  deliveryForSize,
  describeFlyerDelivery,
  mentionsAttachment,
  portalFlyerUrl,
} from "./attachment-policy.ts";

test("mentionsAttachment catches the phrases the drafts actually use", () => {
  for (const s of [
    "Please find attached the program flyer.",
    "I've attached a one-page overview.",
    "See the attachment for details",
    "Enclosed is the flyer",
  ]) assert.equal(mentionsAttachment(s), true, s);
  for (const s of ["Here is a link to the flyer below.", "I'd love to connect this week.", ""]) {
    assert.equal(mentionsAttachment(s), false, s);
  }
});

test("flyers that fit Graph's 4 MB sendMail body attach; bigger ones link", () => {
  // Real sizes from fillPdfFlier (base64 = bytes × 4/3).
  const bankStatement = Math.ceil((1_784_808 * 4) / 3);
  const thunder = Math.ceil((2_341_275 * 4) / 3);
  const universe = Math.ceil((3_888_924 * 4) / 3);
  assert.equal(deliveryForSize(bankStatement), "attached");
  assert.equal(deliveryForSize(thunder), "attached");
  assert.equal(deliveryForSize(universe), "linked");
  assert.equal(deliveryForSize(MAX_INLINE_ATTACHMENT_BASE64 + 1), "linked");
});

test("portal flyer link is personalized by NMLS and company-branded without one", () => {
  assert.equal(
    portalFlyerUrl("universe", "288699"),
    "https://mlo.joingmcc.com/api/public/programs/288699/flyers/universe?style=standard",
  );
  assert.match(portalFlyerUrl("dscr", undefined), /programs\/gmcc\/flyers\/dscr/);
  assert.match(portalFlyerUrl("dscr", "NMLS# 12-34"), /programs\/1234\//);
});

test("appendFlyerLink adds one line after the body", () => {
  const out = appendFlyerLink("Hi Ada,\n\nQuick note.\n\n", "https://x/y.pdf");
  assert.equal(out, "Hi Ada,\n\nQuick note.\n\nProgram flyer (PDF): https://x/y.pdf");
});

test("describeFlyerDelivery never calls a linked or missing flyer attached", () => {
  assert.equal(describeFlyerDelivery("attached", { sizeKB: 1743 }), "attached (1.7 MB PDF)");
  assert.equal(describeFlyerDelivery("linked", { reason: "3.9 MB is over Outlook's attachment limit" }), "linked, not attached (3.9 MB is over Outlook's attachment limit)");
  assert.equal(describeFlyerDelivery("none", { reason: "no flyer template" }), "no flyer (no flyer template)");
});

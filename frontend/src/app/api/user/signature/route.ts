/**
 * GET/PUT/DELETE /api/user/signature — server-side copy of the signed-in
 * user's email signature (Firestore `userSettings/{emailKey}`).
 *
 * The server copy is the source of truth for the AI agent (the chat route
 * reads it directly), fixing the two localStorage failure modes: signatures
 * not roaming across devices, and image-heavy signatures overflowing the
 * request-header path. PUT rejects placeholder content ("Your Name",
 * "NMLS# _______") so a half-filled preset can never satisfy the
 * signature-required gate.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth, unauthorized } from "@/lib/require-auth";
import {
  getStoredSignature,
  setStoredSignature,
  clearStoredSignature,
  sanitizeSignatureHtml,
  MAX_SIGNATURE_HTML_LENGTH,
} from "@/lib/signature-server";
import {
  findSignaturePlaceholder,
  isSignatureContentEmpty,
} from "@/lib/signature-store";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth) return unauthorized();
  const signatureHtml = await getStoredSignature(auth.email);
  return NextResponse.json({ signatureHtml });
}

export async function PUT(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth) return unauthorized();

  const body = (await req.json().catch(() => ({}))) as { signatureHtml?: unknown };
  const raw = typeof body.signatureHtml === "string" ? body.signatureHtml : "";
  if (!raw.trim()) {
    return NextResponse.json({ error: "signatureHtml required" }, { status: 400 });
  }
  if (raw.length > MAX_SIGNATURE_HTML_LENGTH) {
    return NextResponse.json(
      { error: "Signature is too large — use a smaller image (under ~500 KB)." },
      { status: 413 },
    );
  }

  const sanitized = sanitizeSignatureHtml(raw);
  if (isSignatureContentEmpty(sanitized)) {
    return NextResponse.json(
      { error: "Signature is empty — add your name, title, and contact info." },
      { status: 422 },
    );
  }
  const placeholder = findSignaturePlaceholder(sanitized);
  if (placeholder) {
    return NextResponse.json(
      {
        error: `Signature still contains the placeholder "${placeholder}" — replace it with your real information before saving.`,
      },
      { status: 422 },
    );
  }

  const ok = await setStoredSignature(auth.email, sanitized);
  if (!ok) {
    return NextResponse.json({ error: "Storage unavailable" }, { status: 503 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth) return unauthorized();
  const ok = await clearStoredSignature(auth.email);
  return NextResponse.json({ ok });
}

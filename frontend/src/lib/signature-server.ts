/**
 * Server-side email signature storage — Firestore `userSettings/{emailKey}`.
 *
 * Why this exists: signatures previously lived ONLY in browser localStorage,
 * which caused both failure modes LOs reported:
 *   - "saved but not detected": localStorage doesn't roam across devices or
 *     browsers, and the chat agent received the signature via a request header
 *     that silently blew Vercel's header-size cap when the signature contained
 *     an embedded image.
 *   - "not saved but detected": the editor used to auto-persist a placeholder
 *     preset on mount.
 *
 * The server copy is now the source of truth for the AI agent (the chat route
 * reads it directly by the authenticated user's email). localStorage remains a
 * client-side cache for the flier modals, synced on login by
 * `use-signature-sync.ts`.
 */
import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getDb } from "@/lib/firestore-admin";

const COLLECTION = "userSettings";

// Firestore doc hard limit is 1 MiB; leave headroom for the other fields.
export const MAX_SIGNATURE_HTML_LENGTH = 900_000;

function docKey(email: string): string {
  return Buffer.from(email.trim().toLowerCase(), "utf8")
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\//g, "_")
    .replace(/\+/g, "-");
}

/** Strip script tags and inline event handlers before storing/sending. */
export function sanitizeSignatureHtml(raw: string): string {
  return raw
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/\bon\w+\s*=\s*["'][^"']*["']/gi, "");
}

export async function getStoredSignature(email: string): Promise<string | null> {
  const db = getDb();
  if (!db || !email) return null;
  try {
    const snap = await db.collection(COLLECTION).doc(docKey(email)).get();
    if (!snap.exists) return null;
    const html = snap.data()?.signatureHtml;
    return typeof html === "string" && html.trim() ? html : null;
  } catch {
    return null;
  }
}

export async function setStoredSignature(
  email: string,
  signatureHtml: string,
): Promise<boolean> {
  const db = getDb();
  if (!db || !email) return false;
  await db.collection(COLLECTION).doc(docKey(email)).set(
    {
      email: email.trim().toLowerCase(),
      signatureHtml,
      signatureUpdatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  return true;
}

export async function clearStoredSignature(email: string): Promise<boolean> {
  const db = getDb();
  if (!db || !email) return false;
  await db.collection(COLLECTION).doc(docKey(email)).set(
    {
      signatureHtml: FieldValue.delete(),
      signatureUpdatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  return true;
}

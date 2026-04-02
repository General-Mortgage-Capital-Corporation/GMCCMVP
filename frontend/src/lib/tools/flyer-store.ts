/**
 * Temporary in-memory store for generated PDFs and CSVs.
 * Keeps binary data out of the conversation context (which would blow token limits).
 * The generateFlyer/generateCsv tools store here, sendEmail retrieves.
 * Entries auto-expire after 30 minutes.
 */

import { randomBytes } from "crypto";

const store = new Map<string, { base64: string; createdAt: number }>();
const TTL_MS = 30 * 60 * 1000; // 30 minutes

export function storePdf(base64: string): string {
  cleanup();
  const id = `pdf-${randomBytes(6).toString("hex")}`;
  store.set(id, { base64, createdAt: Date.now() });
  return id;
}

export function getPdf(id: string): string | null {
  const entry = store.get(id);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > TTL_MS) {
    store.delete(id);
    return null;
  }
  return entry.base64;
}

function cleanup() {
  const now = Date.now();
  for (const [id, entry] of store) {
    if (now - entry.createdAt > TTL_MS) store.delete(id);
  }
}

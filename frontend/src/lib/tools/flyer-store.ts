/**
 * Server-durable store for agent-generated binary artifacts (PDFs, CSVs).
 *
 * Keeps binary payloads out of the conversation context (which would blow
 * token limits) and out of the client (which shouldn't need to handle base64
 * blobs to render a simple download button).
 *
 * The generateFlyer / generateCsv tools write here; sendEmail and the
 * /api/chat/download route read from here.
 *
 * Storage: backed by the shared redis-cache layer (Upstash in prod, local
 * JSON file in dev). This survives Next.js HMR and works across Vercel
 * Fluid Compute instances, which a module-level Map cannot.
 *
 * Entries TTL: 30 minutes. Max size per entry: 5 MB.
 */

import { randomBytes } from "crypto";
import { getAgentArtifact, setAgentArtifact } from "@/lib/redis-cache";

export type StoredKind = "pdf" | "csv";

const MAX_ENTRY_BYTES = 5 * 1024 * 1024; // 5MB per entry

interface StoreEntry {
  kind: StoredKind;
  base64: string;
  filename?: string;
}

/** Store a binary artifact and return its reference ID. */
export async function storeArtifact(
  kind: StoredKind,
  base64: string,
  filename?: string,
): Promise<string> {
  // ~75% of base64 length = actual byte size
  if (base64.length > MAX_ENTRY_BYTES) {
    throw new Error(
      `${kind.toUpperCase()} too large (${Math.round(base64.length / 1024)}KB). Max is 5MB.`,
    );
  }
  const id = `${kind}-${randomBytes(6).toString("hex")}`;
  await setAgentArtifact(id, { kind, base64, filename });
  return id;
}

/** Get a full entry (kind + base64 + filename) by ID, or null if missing/expired. */
export async function getArtifact(id: string): Promise<StoreEntry | null> {
  return (await getAgentArtifact(id)) as StoreEntry | null;
}

// ── Back-compat shims — existing callers (generateFlyer, sendEmail) use
// these. Kept so the refactor stays mechanical. New code should use
// storeArtifact / getArtifact directly.

/** @deprecated Use storeArtifact("pdf", base64) instead. */
export async function storePdf(base64: string): Promise<string> {
  return storeArtifact("pdf", base64);
}

/** @deprecated Use getArtifact(id) and read entry.base64. */
export async function getPdf(id: string): Promise<string | null> {
  const entry = await getArtifact(id);
  return entry ? entry.base64 : null;
}

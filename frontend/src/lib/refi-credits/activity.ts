/**
 * Activity log writer + paginated reader.
 *
 * One entry per discrete user action — unlocking 25 properties' emails writes
 * 25 entries, not 1. The user-facing history page lists these in reverse
 * chronological order.
 *
 * Always writes to users/{email}/refiFinderActivity even for buffer-allowlisted
 * users (we still want per-user history; the drewFromBuffer flag distinguishes
 * the funding source).
 */

import { FieldValue } from "firebase-admin/firestore";
import { getDb } from "@/lib/firestore-admin";
import type { ActivityAction, ActivityEntry } from "./types";

interface LogActivityInput {
  email: string;
  action: ActivityAction;
  propertyId: string;
  propertyAddress: string;
  creditsUsed: { contact?: number; property?: number };
  propertyRadarRef: string;
  drewFromBuffer: boolean;
  balanceAfter: { contact: number; property: number };
  /** Required for action: "unlock_failed". */
  failureReason?: string;
}

export async function logActivity(input: LogActivityInput): Promise<string> {
  const db = getDb();
  if (!db) throw new Error("[refi-credits/activity] Firestore not initialized");

  const normalized = input.email.toLowerCase();
  const ref = db
    .collection(`users/${normalized}/refiFinderActivity`)
    .doc();

  const payload: Record<string, unknown> = {
    ts: FieldValue.serverTimestamp(),
    action: input.action,
    propertyId: input.propertyId,
    propertyAddress: input.propertyAddress,
    creditsUsed: input.creditsUsed,
    propertyRadarRef: input.propertyRadarRef,
    drewFromBuffer: input.drewFromBuffer,
    balanceAfter: input.balanceAfter,
  };
  if (input.action === "unlock_failed" && input.failureReason) {
    payload.failureReason = input.failureReason;
  }
  await ref.set(payload);
  return ref.id;
}

/**
 * Paginated reader for the user-facing history page.
 *
 * Cursor is the activity doc id. Pass `null` on the first call; the response's
 * `nextCursor` (if present) goes into the next call's `cursor`.
 */
export async function listActivity(opts: {
  email: string;
  pageSize?: number;
  cursor?: string | null;
}): Promise<{
  entries: Array<ActivityEntry & { id: string }>;
  nextCursor: string | null;
}> {
  const db = getDb();
  if (!db) throw new Error("[refi-credits/activity] Firestore not initialized");

  const normalized = opts.email.toLowerCase();
  const pageSize = clampPageSize(opts.pageSize);
  let query: FirebaseFirestore.Query = db
    .collection(`users/${normalized}/refiFinderActivity`)
    .orderBy("ts", "desc")
    .limit(pageSize + 1);

  if (opts.cursor) {
    const cursorSnap = await db
      .doc(`users/${normalized}/refiFinderActivity/${opts.cursor}`)
      .get();
    if (cursorSnap.exists) {
      query = query.startAfter(cursorSnap);
    }
  }

  const snap = await query.get();
  const docs = snap.docs.slice(0, pageSize);
  const hasMore = snap.docs.length > pageSize;

  const entries = docs.map((d) => ({
    id: d.id,
    ...(d.data() as ActivityEntry),
  }));

  return {
    entries,
    nextCursor: hasMore ? docs[docs.length - 1].id : null,
  };
}

function clampPageSize(requested: number | undefined): number {
  if (!requested || requested < 1) return 50;
  return Math.min(requested, 100);
}

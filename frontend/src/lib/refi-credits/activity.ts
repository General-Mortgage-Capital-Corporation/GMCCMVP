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
  /** Set on successful unlock_email / unlock_text — the actual contact value. */
  revealedValue?: string;
  /** Owner name when available — sourced from the search row. */
  ownerName?: string;
  /** Mark this as cache-served (cross-LO Redis hit) so History can show a
   *  "cached · no charge" badge. Caller is responsible for the corresponding
   *  refund + zeroed creditsUsed. */
  fromCache?: boolean;
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
  if (
    (input.action === "unlock_failed" ||
      input.action === "refund_skipped_rollover") &&
    input.failureReason
  ) {
    payload.failureReason = input.failureReason;
  }
  if (input.revealedValue) {
    payload.revealedValue = input.revealedValue;
  }
  if (input.ownerName) {
    payload.ownerName = input.ownerName;
  }
  if (input.fromCache) {
    payload.fromCache = true;
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

/**
 * Admin-managed allowlist for flagged email addresses.
 *
 * Model (per product owner, 2026-08-10): LOs can NO LONGER self-override a
 * flagged deliverability result. Instead, an address that Bouncer flags
 * (risky / unknown — or even undeliverable, if an admin insists) is blocked at
 * send time, and the LO is told to request approval (APPROVAL_REQUEST_CONTACT).
 * An admin approves the address here; once on the allowlist it sends for
 * EVERYONE — verifyDeliverability short-circuits to `deliverable` for it, so no
 * per-send override is needed and no Bouncer credit is spent.
 *
 * Storage: Firestore `approvedEmails/{cacheKey}`. SERVER-ONLY.
 */
import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getDb } from "@/lib/firestore-admin";

const COLLECTION = "approvedEmails";

// Emails allowed to manage the allowlist. Comma-separated env override; a small
// hardcoded default keeps the tool reachable even before the env is set (same
// pattern as REFI_FINDER_ALLOWED_EMAILS).
const DEFAULT_ADMINS = ["naitik.poddar@gmccloan.com"];

export function isApprovalAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  const env = (process.env.EMAIL_APPROVAL_ADMINS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const admins = env.length ? env : DEFAULT_ADMINS;
  return admins.includes(email.trim().toLowerCase());
}

// Local copies of the deliverability helpers to avoid a circular import
// (email-deliverability.ts imports isEmailApproved from here).
function normalizeEmail(s: string): string {
  return s.trim().toLowerCase();
}
function cacheKey(normalizedEmail: string): string {
  return Buffer.from(normalizedEmail, "utf8")
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\//g, "_")
    .replace(/\+/g, "-");
}

export interface ApprovedEmail {
  email: string;
  approvedBy: string;
  approvedAt: number | null;
  note: string | null;
  /** The deliverability status the address had when it was approved. */
  originalStatus: string | null;
}

/** True if `email` is on the admin allowlist. */
export async function isEmailApproved(email: string): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  try {
    const snap = await db.collection(COLLECTION).doc(cacheKey(normalized)).get();
    return snap.exists;
  } catch {
    return false;
  }
}

export async function approveEmail(
  email: string,
  approvedBy: string,
  opts?: { note?: string | null; originalStatus?: string | null },
): Promise<{ ok: boolean; email: string }> {
  const db = getDb();
  if (!db) return { ok: false, email: "" };
  const normalized = normalizeEmail(email);
  if (!normalized) return { ok: false, email: "" };
  await db
    .collection(COLLECTION)
    .doc(cacheKey(normalized))
    .set(
      {
        email: normalized,
        approvedBy,
        approvedAt: FieldValue.serverTimestamp(),
        note: opts?.note ?? null,
        originalStatus: opts?.originalStatus ?? null,
      },
      { merge: true },
    );
  return { ok: true, email: normalized };
}

export async function revokeEmail(email: string): Promise<{ ok: boolean }> {
  const db = getDb();
  if (!db) return { ok: false };
  const normalized = normalizeEmail(email);
  if (!normalized) return { ok: false };
  await db.collection(COLLECTION).doc(cacheKey(normalized)).delete();
  return { ok: true };
}

export async function listApprovedEmails(): Promise<ApprovedEmail[]> {
  const db = getDb();
  if (!db) return [];
  const snap = await db.collection(COLLECTION).get();
  return snap.docs
    .map((d) => {
      const x = d.data() as Record<string, unknown>;
      const approvedAt = x.approvedAt as { toMillis?: () => number } | undefined;
      return {
        email: String(x.email ?? ""),
        approvedBy: String(x.approvedBy ?? ""),
        approvedAt: approvedAt?.toMillis ? approvedAt.toMillis() : null,
        note: (x.note as string) ?? null,
        originalStatus: (x.originalStatus as string) ?? null,
      };
    })
    .sort((a, b) => (b.approvedAt ?? 0) - (a.approvedAt ?? 0));
}

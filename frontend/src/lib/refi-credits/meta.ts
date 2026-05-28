/**
 * meta/refiFinder reader with per-instance memoization.
 *
 * Read on every gating decision + every deduction, so we cache for a short
 * window (60s) inside one Lambda. Tighter than the bufferAllowlist's user-
 * facing 10min cache in lib/refi-access — internal ops only.
 */

import { getDb } from "@/lib/firestore-admin";
import type { RefiMeta } from "./types";

const META_DOC_PATH = "meta/refiFinder";
const CACHE_TTL_MS = 60 * 1000;

let _cache: { value: RefiMeta; expiresAt: number } | null = null;

export async function getRefiMeta(): Promise<RefiMeta> {
  const now = Date.now();
  if (_cache && _cache.expiresAt > now) return _cache.value;

  const db = getDb();
  if (!db) throw new Error("[refi-credits/meta] Firestore Admin not initialized");

  const snap = await db.doc(META_DOC_PATH).get();
  if (!snap.exists) {
    throw new Error(`[refi-credits/meta] ${META_DOC_PATH} does not exist`);
  }
  const data = snap.data() as Partial<RefiMeta>;
  const value: RefiMeta = {
    bufferAllowlist: (data.bufferAllowlist ?? []).map((e) => e.toLowerCase()),
    planAnniversary: data.planAnniversary ?? 1,
    currentCycleId: data.currentCycleId ?? "",
  };
  if (!value.currentCycleId) {
    throw new Error(
      "[refi-credits/meta] meta/refiFinder.currentCycleId is empty — MLO portal cron should have set this",
    );
  }
  _cache = { value, expiresAt: now + CACHE_TTL_MS };
  return value;
}

/** Test-only — flush memoization. Not exported via barrel. */
export function _resetMetaCacheForTests(): void {
  _cache = null;
}

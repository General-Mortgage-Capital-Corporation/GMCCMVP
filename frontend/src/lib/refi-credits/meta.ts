/**
 * meta/refiFinder reader with per-instance memoization.
 *
 * Read on every gating decision + every deduction, so we cache for a short
 * window (60s) inside one Lambda. Tighter than the bufferAllowlist's user-
 * facing 10min cache in lib/refi-access — internal ops only.
 */

import { getDb } from "@/lib/firestore-admin";
import type { RefiMeta } from "./types";
import { computeCycleId } from "./cycle";

const META_DOC_PATH = "meta/refiFinder";
const CACHE_TTL_MS = 60 * 1000;

let _cache: { value: RefiMeta; expiresAt: number } | null = null;

/**
 * Reads meta/refiFinder + computes the live cycle ID. We DO NOT read
 * meta.currentCycleId from Firestore — that field is recomputed here on
 * every call so no cron is needed to roll it on planAnniversary.
 */
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
  const planAnniversary = data.planAnniversary ?? 1;
  const value: RefiMeta = {
    bufferAllowlist: (data.bufferAllowlist ?? []).map((e) => e.toLowerCase()),
    planAnniversary,
    // Derived, not read. Reflects whichever cycle we're in TODAY based on
    // planAnniversary; rolls automatically when the anniversary passes.
    currentCycleId: computeCycleId(planAnniversary),
  };
  _cache = { value, expiresAt: now + CACHE_TTL_MS };
  return value;
}

/** Test-only — flush memoization. Not exported via barrel. */
export function _resetMetaCacheForTests(): void {
  _cache = null;
}

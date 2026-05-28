/**
 * Resolves which credit pool a user deducts from.
 *
 *   user.email ∈ meta/refiFinder.bufferAllowlist  →  creditPacks/company_buffer
 *   else                                          →  users/{email}/creditPacks/refi_finder
 *
 * The bufferAllowlist holds internal users (dev + managerial) who get their
 * unlocks paid from the company PropertyRadar pool instead of paying $100/mo.
 *
 * Per-user subscription state is NOT checked here — that's resolveSubscription()'s
 * job. resolvePool only answers "which doc do I touch?". A user who is on
 * neither the allowlist nor has a subscription will still get a `personal`
 * poolRef from this function; the deduction transaction will then fail with
 * InsufficientCreditsError because the doc has 0/0 balance (or doesn't exist).
 * That's the correct surface for "this user needs to subscribe."
 */

import { getRefiMeta } from "./meta";
import type { ResolvedPool } from "./types";

export async function resolvePool(email: string): Promise<ResolvedPool> {
  const normalized = email.toLowerCase();
  const meta = await getRefiMeta();
  const onAllowlist = meta.bufferAllowlist.includes(normalized);
  if (onAllowlist) {
    return { poolRef: "creditPacks/company_buffer", drewFromBuffer: true };
  }
  return {
    poolRef: `users/${normalized}/creditPacks/refi_finder`,
    drewFromBuffer: false,
  };
}

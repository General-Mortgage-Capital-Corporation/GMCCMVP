/**
 * Refi Finder access control.
 *
 * Three-tier model (matches future subscription system):
 *   - "anonymous"      → not signed in; gate the whole tab
 *   - "no_access"      → signed in but email isn't on the allowlist; show
 *                        "coming soon" + future subscription pitch
 *   - "has_access"     → email allowlisted; full functionality
 *
 * Allowlist sources (any match grants access):
 *   1. REFI_FINDER_ALLOWED_EMAILS — comma-separated explicit emails
 *      (escape hatch for individuals not in the group)
 *   2. REFI_FINDER_ALLOWED_DOMAINS — comma-separated email domains
 *   3. REFI_FINDER_GROUP_ID (or REFI_FINDER_GROUP_MAIL) — Microsoft 365
 *      group membership, resolved live via Graph (cached 10 min)
 *
 * Backend Next.js routes call `requireRefiAccess(req)` at the top; it
 * verifies the Firebase ID token and checks the allowlist. Returns the
 * caller's email (the trusted identity) or throws an AccessError that
 * the route handler converts to a 401/403 response.
 *
 * The frontend pre-flights `/api/refi/access` once on mount to know
 * which UI to render. Backend gating is the real security boundary;
 * the frontend check is for UX only.
 */

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { verifyIdTokenWithEmail } from "@/lib/firestore-admin";
import { isEmailInRefiGroup } from "@/lib/graph-groups";

export type RefiAccessTier = "anonymous" | "no_access" | "has_access";

export class AccessError extends Error {
  status: number;
  tier: RefiAccessTier;
  constructor(message: string, status: number, tier: RefiAccessTier) {
    super(message);
    this.name = "AccessError";
    this.status = status;
    this.tier = tier;
  }
}

function allowedEmailSet(): Set<string> {
  const raw = process.env.REFI_FINDER_ALLOWED_EMAILS ?? "";
  return new Set(
    raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  );
}

function allowedDomainSet(): Set<string> {
  const raw = process.env.REFI_FINDER_ALLOWED_DOMAINS ?? "";
  return new Set(
    raw.split(",").map((s) => s.trim().toLowerCase().replace(/^@/, "")).filter(Boolean),
  );
}

/**
 * Static allowlist check (env vars only — no Graph call). Used as a fast
 * pre-check before the async group lookup; also covers escape-hatch
 * individuals who aren't in the AD group.
 */
export function emailMatchesStaticAllowlist(email: string | null | undefined): boolean {
  if (!email) return false;
  const e = email.toLowerCase().trim();
  if (!e) return false;
  if (allowedEmailSet().has(e)) return true;
  const domain = e.split("@")[1];
  if (domain && allowedDomainSet().has(domain)) return true;
  return false;
}

/**
 * Full access check: static allowlist OR Microsoft 365 group membership.
 * Async because the group check goes through Graph (cached, but still a
 * network call on cache miss).
 */
export async function emailHasRefiAccess(email: string | null | undefined): Promise<boolean> {
  if (!email) return false;
  if (emailMatchesStaticAllowlist(email)) return true;
  try {
    return await isEmailInRefiGroup(email);
  } catch (err) {
    console.warn("[refi-access] group check failed, falling back to allowlist only", err);
    return false;
  }
}

/**
 * Verify the request's bearer token AND check the allowlist. Returns the
 * caller's email. Throws AccessError on any failure (caller converts to
 * HTTP status).
 *
 * **Phase 4 of the credit-system migration**: the env-var allowlist
 * (REFI_FINDER_ALLOWED_EMAILS / REFI_FINDER_GROUP_ID) is no longer the gate.
 * Any signed-in user passes this check; the real gate is now the subscription
 * + bufferAllowlist enforced inside each unlock endpoint via resolveSubscription
 * (see lib/refi-credits/subscription.ts and the /api/refi/unlock-* routes).
 *
 * We keep this function exported so the legacy /api/refi/{search,unlock-contact,
 * preview,presets,quota,access} routes continue to compile and verify auth.
 * Those routes never charge credits — they were the old free-tier path. The
 * credit-deducting routes (/api/refi/unlock-search, /unlock-contact-paid)
 * don't use withRefiAccess; they call resolveSubscription directly.
 *
 * emailHasRefiAccess() is still exported for callers (e.g. the legacy
 * /api/refi/access route) that want to know whether the env-var allowlist
 * would have granted access. It's no longer load-bearing.
 */
export async function requireRefiAccess(req: NextRequest): Promise<string> {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    throw new AccessError("Not signed in.", 401, "anonymous");
  }
  const token = authHeader.replace("Bearer ", "");
  let verified: { email: string } | null = null;
  try {
    verified = await verifyIdTokenWithEmail(token);
  } catch {
    throw new AccessError("Invalid token.", 401, "anonymous");
  }
  if (!verified?.email) {
    throw new AccessError("Token missing email claim.", 401, "anonymous");
  }
  // Old allowlist check intentionally removed — Phase 4 of the credit-system
  // migration. Any signed-in user gets through this checkpoint; subscription
  // and bufferAllowlist gating happens inside the credit-deducting routes.
  return verified.email;
}

/** Convenience: wrap a route handler so it returns the proper HTTP error
 *  when access is denied, otherwise hands the verified email to `handler`. */
export async function withRefiAccess<T>(
  req: NextRequest,
  handler: (email: string) => Promise<NextResponse<T> | NextResponse>,
): Promise<NextResponse> {
  try {
    const email = await requireRefiAccess(req);
    return await handler(email);
  } catch (err) {
    if (err instanceof AccessError) {
      return NextResponse.json(
        { success: false, error: err.message, tier: err.tier },
        { status: err.status },
      );
    }
    throw err;
  }
}

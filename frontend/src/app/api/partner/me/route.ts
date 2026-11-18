import { type NextRequest, NextResponse } from "next/server";
import { requireAuth, unauthorized } from "@/lib/require-auth";
import { getPartnerContext } from "@/lib/partner-server";

/**
 * GET /api/partner/me — the signed-in partner's own record (as saved by
 * their LO in the portal) plus the LO's display identity. Feeds prefills:
 * flyer realtor info, the header greeting, PostHog person properties.
 * Partner-only — an LO calling this has no partner record to return.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const caller = await requireAuth(req, { allowPartner: true });
  if (!caller) return unauthorized();
  if (caller.role !== "partner") {
    return NextResponse.json({ error: "Partner sessions only" }, { status: 403 });
  }

  try {
    const ctx = await getPartnerContext(caller.mloEmail!, caller.partnerId);
    if (!ctx) {
      return NextResponse.json(
        { error: "Your partner access is no longer active." },
        { status: 403 },
      );
    }
    return NextResponse.json(ctx);
  } catch (err) {
    console.error("[partner/me]", err);
    return NextResponse.json({ error: "Failed to load partner profile" }, { status: 500 });
  }
}

/**
 * GET /api/cron/agent-campaigns — background drainer for mass marketing
 * campaigns created by the AI agent's runMarketingCampaign tool (every 5 min).
 *
 * The tool processes what fits in its inline budget; everything else lands
 * here. Sends use Graph APPLICATION credentials and drafts use the server's
 * Gemini key, so no user token is needed — campaigns finish even after the LO
 * closes the tab. Also retries campaigns blocked on a missing signature
 * (processCampaign re-checks the live signature each run) and expires
 * campaigns stuck without progress for 7 days.
 */
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firestore-admin";
import { rateLimit, getClientIp } from "@/lib/ratelimit";
import {
  processCampaign,
  cancelCampaign,
  CAMPAIGNS_COLLECTION,
  type CampaignDoc,
} from "@/lib/campaigns/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const STALE_MS = 7 * 24 * 60 * 60 * 1000;

export async function GET(req: NextRequest) {
  // Same auth pattern as /api/cron/follow-ups: Bearer CRON_SECRET when set,
  // else rate-limited. Idempotent — rows only send once (status flips to
  // 'sent' and is persisted after every batch).
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers.get("Authorization");
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  } else {
    const ip = getClientIp(req);
    if (!(await rateLimit(`cron-agent-campaigns:${ip}`, 5))) {
      return NextResponse.json({ error: "Rate limit exceeded." }, { status: 429 });
    }
    console.warn("[cron/agent-campaigns] CRON_SECRET not configured — unauthenticated trigger from", ip);
  }

  const db = getDb();
  if (!db) return NextResponse.json({ error: "Firestore not configured" }, { status: 503 });

  const snap = await db
    .collection(CAMPAIGNS_COLLECTION)
    .where("status", "in", ["running", "blocked"])
    .get();

  const campaigns = snap.docs
    .map((d) => d.data() as CampaignDoc)
    .sort((a, b) => a.createdAt - b.createdAt);

  // Shared time budget across all active campaigns, oldest first.
  const deadline = Date.now() + 240_000;
  const results: { id: string; status: string; sent: number; remaining: number }[] = [];

  for (const campaign of campaigns) {
    if (Date.now() >= deadline) break;

    // Expire campaigns that have made no progress in a week (e.g. blocked on
    // a signature that never got fixed) so they don't run forever.
    if (Date.now() - campaign.updatedAt > STALE_MS) {
      await cancelCampaign(campaign);
      results.push({ id: campaign.id, status: "cancelled (stale)", sent: campaign.totals.sent, remaining: 0 });
      continue;
    }

    // A blocked campaign re-enters 'running' if its precondition now passes —
    // processCampaign re-checks the live signature and re-blocks if not.
    if (campaign.status === "blocked") campaign.status = "running";

    const remaining = await processCampaign(campaign, deadline);
    results.push({
      id: campaign.id,
      status: campaign.status,
      sent: campaign.totals.sent,
      remaining,
    });
  }

  return NextResponse.json({
    processed: results.length,
    active: campaigns.length,
    results,
  });
}

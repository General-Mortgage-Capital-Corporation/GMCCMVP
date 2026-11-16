/**
 * Daily Desk API (LOs only).
 *
 *   GET                                   → { settings, day, popular, stats, limits }   (never builds)
 *   POST { action: "build", recentSearches? }   → builds today's batch on first call, else returns it
 *   POST { action: "send", itemIds: string[] | "all" }
 *   POST { action: "skip", itemId, reason }
 *   POST { action: "edit", itemId, subject, body }
 *   POST { action: "retry", itemId }
 *   POST { action: "more" }                     → replace skipped cards, up to the batch size
 *   POST { action: "settings", areaInputs?, batchSize?, priceMin?, priceMax?, preferredPrograms?, instructions?, rebuild? }
 */
import { NextResponse, type NextRequest } from "next/server";
import { requireAuth, unauthorized } from "@/lib/require-auth";
import {
  DeskSendError,
  buildToday,
  editItem,
  getDay,
  getSettings,
  popularForStates,
  resetToday,
  retryItem,
  saveSettings,
  sendItems,
  skipItem,
  topUp,
  weekStats,
  type DeskCaller,
} from "@/lib/daily-desk/server";
import { DEFAULT_BATCH_SIZE, MAX_AREAS, MAX_BATCH_SIZE } from "@/lib/daily-desk/select";
import { getStoredSignature } from "@/lib/signature-server";
import { findSignaturePlaceholder, isSignatureContentEmpty } from "@/lib/signature-store";

export const runtime = "nodejs";
export const maxDuration = 300;

function loInfo(req: NextRequest): { name?: string; nmls?: string; title?: string } {
  const h = req.headers.get("X-LO-Info") ?? "";
  if (!h) return {};
  try {
    const v = JSON.parse(decodeURIComponent(escape(atob(h))));
    const clean = (s: unknown) => (typeof s === "string" ? s.replace(/[\n\r]/g, " ").slice(0, 100) : undefined);
    return { name: clean(v.name), nmls: clean(v.nmls), title: clean(v.title) };
  } catch {
    return {};
  }
}

async function caller(req: NextRequest): Promise<DeskCaller | null> {
  const auth = await requireAuth(req);
  if (!auth) return null;
  const token = (req.headers.get("Authorization") ?? "").slice("Bearer ".length).trim();
  const lo = loInfo(req);
  return { uid: auth.uid, email: auth.email, idToken: token, loName: lo.name, loNmls: lo.nmls, loTitle: lo.title };
}

const LIMITS = { defaultBatch: DEFAULT_BATCH_SIZE, maxBatch: MAX_BATCH_SIZE, maxAreas: MAX_AREAS };

export async function GET(req: NextRequest) {
  const c = await caller(req);
  if (!c) return unauthorized();
  try {
    const [settings, day, stats, signature] = await Promise.all([getSettings(c), getDay(c.email), weekStats(c), getStoredSignature(c.email)]);
    const signatureOk = !!signature && !isSignatureContentEmpty(signature) && !findSignaturePlaceholder(signature);
    const states = [...new Set([...(day?.items ?? []).map((i) => i.listing.state), ...settings.areas.map((a) => a.state ?? "")].filter(Boolean))];
    const popular = await popularForStates(states.length ? states : []);
    return NextResponse.json({ settings, day, stats, popular, signatureOk, limits: LIMITS });
  } catch (err) {
    console.error("[daily-desk] GET failed", err);
    return NextResponse.json({ error: "Couldn't load your Today list." }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const c = await caller(req);
  if (!c) return unauthorized();
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = String(body.action ?? "");
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  try {
    switch (action) {
      case "build": {
        const recent = Array.isArray(body.recentSearches) ? body.recentSearches.map(String).slice(0, 10) : [];
        return NextResponse.json({ day: await buildToday(c, recent) });
      }
      case "more":
        return NextResponse.json({ day: await topUp(c) });
      case "send": {
        const ids = body.itemIds === "all" ? "all" : Array.isArray(body.itemIds) ? body.itemIds.map(String).slice(0, MAX_BATCH_SIZE * 2) : [];
        if (ids !== "all" && !ids.length) return NextResponse.json({ error: "Nothing to send." }, { status: 400 });
        return NextResponse.json(await sendItems(c, ids));
      }
      case "skip":
        return NextResponse.json({ day: await skipItem(c, str(body.itemId), str(body.reason)) });
      case "edit":
        return NextResponse.json({ day: await editItem(c, str(body.itemId), str(body.subject), str(body.body)) });
      case "retry":
        return NextResponse.json({ day: await retryItem(c, str(body.itemId)) });
      case "settings": {
        const settings = await saveSettings(c, {
          ...(Array.isArray(body.areaInputs) ? { areaInputs: body.areaInputs.map(String) } : {}),
          ...(body.batchSize !== undefined ? { batchSize: Number(body.batchSize) } : {}),
          ...(body.priceMin !== undefined ? { priceMin: body.priceMin as number | null } : {}),
          ...(body.priceMax !== undefined ? { priceMax: body.priceMax as number | null } : {}),
          ...(Array.isArray(body.preferredPrograms) ? { preferredPrograms: body.preferredPrograms.map(String) } : {}),
          ...(body.instructions !== undefined ? { instructions: str(body.instructions) } : {}),
        });
        if (body.rebuild) await resetToday(c);
        return NextResponse.json({ settings, day: await getDay(c.email) });
      }
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (err) {
    if (err instanceof DeskSendError) return NextResponse.json({ error: err.message }, { status: 409 });
    const msg = err instanceof Error ? err.message : "Something went wrong.";
    console.error(`[daily-desk] ${action} failed`, err);
    // Mutations raise user-facing messages; anything else gets a generic one.
    const userFacing = /wasn't found|isn't in today|already handled|Only (unsent|failed)/.test(msg);
    return NextResponse.json({ error: userFacing ? msg : "Something went wrong — please try again." }, { status: userFacing ? 409 : 500 });
  }
}

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
  DeskLimitError,
  DeskSendError,
  buildToday,
  editItem,
  getDay,
  getSettings,
  popularForStates,
  resetToday,
  retryItem,
  reprogramItem,
  PROPERTY_TYPES,
  saveSettings,
  sendItems,
  skipItem,
  topUp,
  weekStats,
  type DeskCaller,
} from "@/lib/daily-desk/server";
import { DEFAULT_BATCH_SIZE, DESK_LANGUAGES, MAX_AREAS, MAX_BATCH_SIZE, RADIUS_OPTIONS, type DeskArea, type DeskFlyerMode, type DeskTone } from "@/lib/daily-desk/select";
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

/** A typed area ("95112", "San Jose, CA") or a "near me" point {lat, lng, radiusMi, place}. */
function areaInput(v: unknown): string | DeskArea {
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return { lat: Number(o.lat), lng: Number(o.lng), radiusMi: Number(o.radiusMi), place: typeof o.place === "string" ? o.place.slice(0, 60) : undefined, label: "" };
  }
  return String(v ?? "");
}

const LIMITS = { defaultBatch: DEFAULT_BATCH_SIZE, maxBatch: MAX_BATCH_SIZE, maxAreas: MAX_AREAS, radiusOptions: RADIUS_OPTIONS, languages: DESK_LANGUAGES, propertyTypes: PROPERTY_TYPES };

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
      case "program":
        return NextResponse.json({ day: await reprogramItem(c, str(body.itemId), str(body.program)) });
      case "retry":
        return NextResponse.json({ day: await retryItem(c, str(body.itemId)) });
      case "settings": {
        const settings = await saveSettings(c, {
          ...(Array.isArray(body.areaInputs) ? { areaInputs: body.areaInputs.slice(0, 6).map(areaInput) } : {}),
          ...(body.batchSize !== undefined ? { batchSize: Number(body.batchSize) } : {}),
          ...(body.priceMin !== undefined ? { priceMin: body.priceMin as number | null } : {}),
          ...(body.priceMax !== undefined ? { priceMax: body.priceMax as number | null } : {}),
          ...(Array.isArray(body.preferredPrograms) ? { preferredPrograms: body.preferredPrograms.map(String) } : {}),
          ...(body.instructions !== undefined ? { instructions: str(body.instructions) } : {}),
          ...(body.programMode !== undefined ? { programMode: body.programMode === "only" ? "only" : "prefer" } : {}),
          ...(body.domMin !== undefined ? { domMin: body.domMin as number | null } : {}),
          ...(body.domMax !== undefined ? { domMax: body.domMax as number | null } : {}),
          ...(Array.isArray(body.propertyTypes) ? { propertyTypes: body.propertyTypes.map(String) } : {}),
          ...(body.bedsMin !== undefined ? { bedsMin: body.bedsMin as number | null } : {}),
          ...(body.tone !== undefined ? { tone: str(body.tone) as DeskTone } : {}),
          ...(body.language !== undefined ? { language: str(body.language) } : {}),
          ...(body.flyerMode !== undefined ? { flyerMode: str(body.flyerMode) as DeskFlyerMode } : {}),
          ...(body.followUpDays !== undefined ? { followUpDays: body.followUpDays as number | null } : {}),
          ...(body.ccSelf !== undefined ? { ccSelf: body.ccSelf !== false } : {}),
        });
        if (body.rebuild) await resetToday(c);
        return NextResponse.json({ settings, day: await getDay(c.email) });
      }
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (err) {
    if (err instanceof DeskSendError) return NextResponse.json({ error: err.message }, { status: 409 });
    if (err instanceof DeskLimitError) return NextResponse.json({ error: err.message }, { status: 429 });
    const msg = err instanceof Error ? err.message : "Something went wrong.";
    console.error(`[daily-desk] ${action} failed`, err);
    // Mutations raise user-facing messages; anything else gets a generic one.
    const userFacing = /wasn't found|isn't in today|already handled|Only (unsent|failed)|isn't eligible/.test(msg);
    return NextResponse.json({ error: userFacing ? msg : "Something went wrong — please try again." }, { status: userFacing ? 409 : 500 });
  }
}

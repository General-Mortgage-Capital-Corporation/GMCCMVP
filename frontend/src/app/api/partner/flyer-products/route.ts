import { type NextRequest, NextResponse } from "next/server";
import { requireAuth, unauthorized } from "@/lib/require-auth";
import { getDb } from "@/lib/firestore-admin";

/**
 * GET /api/partner/flyer-products — the flyer template catalog for the
 * partner Flyers tab.
 *
 * Reads the SAME `mortgage_products` Firestore collection the MLO portal's
 * Media Hub renders from, so a template updated in the portal shows up here
 * with no sync step. Only listing metadata is returned — rendering goes
 * through /api/generate-flier, and the Cloud Function resolves the PDF
 * template itself.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ProductListing = {
  id: string;
  name: string;
  description: string;
  category: string;
  groups: { group: string; subgroup: string | null; order: number }[];
  thumbnailUrl: string | null;
  /** Which optional field groups this template can render. */
  inputs: string[];
};

// Small in-memory cache — the catalog changes rarely and the tab refetches
// on every mount.
let _cache: { at: number; products: ProductListing[] } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function GET(req: NextRequest) {
  const caller = await requireAuth(req, { allowPartner: true });
  if (!caller) return unauthorized();

  if (_cache && Date.now() - _cache.at < CACHE_TTL_MS) {
    return NextResponse.json({ products: _cache.products });
  }

  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: "Not configured" }, { status: 500 });
  }
  try {
    const snap = await db.collection("mortgage_products").get();
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    const products: ProductListing[] = snap.docs
      .map((doc) => {
        const d = doc.data() as Record<string, unknown>;
        const groups = Array.isArray(d.groups)
          ? (d.groups as Record<string, unknown>[]).map((g) => ({
              group: str(g.group),
              subgroup: str(g.subgroup) || null,
              order: typeof g.order === "number" ? g.order : 0,
            }))
          : [];
        return {
          id: doc.id,
          name: str(d.displayName) || doc.id,
          description: str(d.description),
          category: str(d.category) || "Uncategorized",
          groups,
          thumbnailUrl: str(d.thumbnailUrl) || null,
          inputs: Array.isArray(d.inputs) ? (d.inputs as string[]).filter((i) => typeof i === "string") : [],
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    _cache = { at: Date.now(), products };
    return NextResponse.json({ products });
  } catch (err) {
    console.error("[partner/flyer-products]", err);
    return NextResponse.json({ error: "Failed to load flyer templates" }, { status: 500 });
  }
}

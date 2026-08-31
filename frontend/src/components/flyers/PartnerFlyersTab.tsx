"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { authedFetch } from "@/lib/authed-fetch";
import { trackEvent } from "@/lib/posthog";
import LoadingSpinner from "@/components/LoadingSpinner";

/**
 * Partner Flyers tab — the property-search counterpart of the MLO portal's
 * Media Hub flyer builder, for partners who have no portal access.
 *
 * Templates come from the shared `mortgage_products` Firestore collection
 * (via /api/partner/flyer-products), so anything updated in the portal is
 * live here immediately. Rendering goes through /api/generate-flier, which
 * pins the flyer to the OWNING LO's branding server-side; the partner's own
 * saved info (name, license, phone, email) fills the realtor panel and stays
 * editable per-flyer.
 */

type Product = {
  id: string;
  name: string;
  description: string;
  category: string;
  thumbnailUrl: string | null;
  inputs: string[];
};

type PartnerCtx = {
  partner: { name: string; email: string; phone: string; license: string };
  mlo: { email: string; name: string };
};

type RealtorDraft = { name: string; phone: string; email: string; nmls: string };

/** "GMCC Buy Without Sell First" → "Buy Without Sell First" — every row
 *  starting with the company name reads as noise in a list of 25. */
function displayTitle(name: string): string {
  return name.replace(/^GMCC\s+(CRA:\s*)?/i, "").trim() || name;
}

/** Two-letter monogram from the meaningful words of the program name. */
function monogram(name: string): string {
  const words = displayTitle(name)
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** Deterministic tasteful gradient per program so tiles are telling-apart-able
 *  without being loud. Same name → same color, always. */
const TILE_GRADIENTS = [
  "from-red-500 to-rose-600",
  "from-indigo-500 to-blue-600",
  "from-teal-500 to-emerald-600",
  "from-amber-500 to-orange-600",
  "from-violet-500 to-purple-600",
  "from-sky-500 to-cyan-600",
  "from-slate-500 to-gray-600",
  "from-fuchsia-500 to-pink-600",
] as const;

function tileGradient(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return TILE_GRADIENTS[h % TILE_GRADIENTS.length];
}

export default function PartnerFlyersTab() {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [ctx, setCtx] = useState<PartnerCtx | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Product | null>(null);
  const [category, setCategory] = useState<string>("All");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [prodRes, meRes] = await Promise.all([
          authedFetch("/api/partner/flyer-products"),
          authedFetch("/api/partner/me"),
        ]);
        if (cancelled) return;
        if (!prodRes.ok) throw new Error("Couldn't load flyer templates.");
        const prod = (await prodRes.json()) as { products: Product[] };
        setProducts(prod.products);
        if (meRes.ok) {
          setCtx((await meRes.json()) as PartnerCtx);
        }
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : "Couldn't load flyer templates.");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const categories = useMemo(
    () => ["All", ...[...new Set((products ?? []).map((p) => p.category))].sort()],
    [products],
  );
  const visible = useMemo(
    () => (products ?? []).filter((p) => category === "All" || p.category === category),
    [products, category],
  );

  if (loadError) {
    return <p className="py-8 text-center text-sm text-red-600">{loadError}</p>;
  }
  if (products === null) {
    return (
      <div className="flex items-center justify-center py-12">
        <LoadingSpinner size="md" />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-5">
        <h2 className="text-base font-semibold text-gray-900">Program Flyers</h2>
        <p className="mt-1 text-sm text-gray-500">
          Pick a program below to build a co-branded flyer
          {ctx ? ` with ${ctx.mlo.name}` : ""} — add a property and your contact
          info, then preview or download the PDF.
        </p>
      </div>

      {selected ? (
        <FlyerBuilder
          product={selected}
          ctx={ctx}
          onBack={() => setSelected(null)}
        />
      ) : (
        <div>
          {categories.length > 2 && (
            <div className="mb-4 flex flex-wrap gap-1.5">
              {categories.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCategory(c)}
                  className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                    category === c
                      ? "bg-red-600 text-white"
                      : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
          )}
          <div className="grid gap-2 sm:grid-cols-2">
            {visible.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setSelected(p)}
                className="group flex items-center gap-3 rounded-xl border border-gray-200 bg-white p-3 text-left shadow-sm transition-all hover:border-red-300 hover:shadow-md"
              >
                <span
                  className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br text-sm font-bold text-white ${tileGradient(p.name)}`}
                >
                  {monogram(p.name)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-gray-900 group-hover:text-red-700">
                    {displayTitle(p.name)}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-gray-500">
                    {p.description || p.category}
                  </span>
                </span>
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 16 16"
                  fill="none"
                  className="shrink-0 text-gray-300 transition-all group-hover:translate-x-0.5 group-hover:text-red-400"
                >
                  <path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            ))}
          </div>
          {visible.length === 0 && (
            <p className="py-8 text-center text-sm text-gray-400">
              No flyer templates are available right now.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function FlyerBuilder({
  product,
  ctx,
  onBack,
}: {
  product: Product;
  ctx: PartnerCtx | null;
  onBack: () => void;
}) {
  const [address, setAddress] = useState("");
  const [price, setPrice] = useState("");
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [realtor, setRealtor] = useState<RealtorDraft>({
    name: ctx?.partner.name ?? "",
    phone: ctx?.partner.phone ?? "",
    email: ctx?.partner.email ?? "",
    nmls: ctx?.partner.license ?? "",
  });
  const [busy, setBusy] = useState<"preview" | "download" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const fetchListingPhoto = useCallback(async (addr: string) => {
    if (!addr.trim()) return;
    setPhotoBusy(true);
    try {
      const res = await authedFetch(`/api/zillow-photos?address=${encodeURIComponent(addr)}`);
      if (res.ok) {
        const data = (await res.json()) as { photos?: string[] };
        setPhotoUrl(data.photos?.[0] ?? null);
      }
    } catch {
      /* photo is optional — the template's stock image covers a miss */
    } finally {
      setPhotoBusy(false);
    }
  }, []);

  async function generate(kind: "preview" | "download") {
    setBusy(kind);
    setError(null);
    try {
      const res = await authedFetch("/api/generate-flier", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: product.id,
          // Pinned to the owning LO server-side for partner sessions; the
          // value here is a required-field placeholder, not the authority.
          userId: ctx?.mlo.email ?? "partner",
          ...(address.trim() ? { address: address.trim() } : {}),
          ...(price.trim() ? { listingPrice: price.replace(/[^0-9.]/g, "") } : {}),
          ...(photoUrl ? { propertyImage: photoUrl } : {}),
          ...(realtor.name.trim() ? { realtorName: realtor.name.trim() } : {}),
          ...(realtor.phone.trim() ? { realtorPhone: realtor.phone.trim() } : {}),
          ...(realtor.email.trim() ? { realtorEmail: realtor.email.trim() } : {}),
          ...(realtor.nmls.trim() ? { realtorNmls: realtor.nmls.trim() } : {}),
        }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
        throw new Error(err.detail ?? err.error ?? "Flyer generation failed.");
      }
      const blob = await res.blob();
      trackEvent(kind === "preview" ? "flyer_previewed" : "flyer_downloaded", {
        program: product.name,
        productId: product.id,
        surface: "partner_flyers_tab",
      });
      if (kind === "preview") {
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        setPreviewUrl(URL.createObjectURL(blob));
      } else {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${product.id}-flyer.pdf`;
        a.click();
        URL.revokeObjectURL(a.href);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Flyer generation failed.");
    } finally {
      setBusy(null);
    }
  }

  const inputCls =
    "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-red-300 focus:ring-1 focus:ring-red-200";

  return (
    <div>
      <button
        type="button"
        onClick={onBack}
        className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-gray-700"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        All templates
      </button>

      <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
        {/* Template reference card */}
        <div className="h-fit overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="flex items-center gap-3 p-3">
            <span
              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br text-sm font-bold text-white ${tileGradient(product.name)}`}
            >
              {monogram(product.name)}
            </span>
            <p className="text-sm font-semibold text-gray-900">{displayTitle(product.name)}</p>
          </div>
          {product.description && (
            <p className="px-3 pb-3 text-xs leading-snug text-gray-500">{product.description}</p>
          )}
          {product.thumbnailUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={product.thumbnailUrl}
              alt="Template layout"
              className="w-full border-t border-gray-100 bg-gray-50 object-cover"
            />
          )}
        </div>

        {/* Form */}
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700">
              Property address <span className="font-normal text-gray-400">· optional</span>
            </label>
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              onBlur={() => void fetchListingPhoto(address)}
              placeholder="123 Main St, San Jose, CA 95112"
              className={inputCls}
            />
            <div className="mt-1.5 flex items-center gap-2 text-[11px] text-gray-500">
              {photoBusy ? (
                <span>Looking for a listing photo…</span>
              ) : photoUrl ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={photoUrl} alt="" className="h-8 w-12 rounded object-cover ring-1 ring-gray-200" />
                  <span>Listing photo found — it&apos;ll appear on the flyer.</span>
                  <button
                    type="button"
                    onClick={() => setPhotoUrl(null)}
                    className="font-medium text-red-500 hover:underline"
                  >
                    remove
                  </button>
                </>
              ) : address.trim() ? (
                <span>No listing photo found — the template&apos;s default image will be used.</span>
              ) : (
                <span>Leave blank for a general program flyer without a property.</span>
              )}
            </div>
          </div>

          <div className="max-w-[200px]">
            <label className="mb-1 block text-xs font-medium text-gray-700">
              Listing price <span className="font-normal text-gray-400">· optional</span>
            </label>
            <input
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="850000"
              inputMode="numeric"
              className={inputCls}
            />
          </div>

          <div>
            <p className="mb-2 text-xs font-medium text-gray-700">
              Your info on the flyer
            </p>
            <div className="grid grid-cols-2 gap-3">
              <input
                value={realtor.name}
                onChange={(e) => setRealtor((r) => ({ ...r, name: e.target.value }))}
                placeholder="Name"
                className={inputCls}
              />
              <input
                value={realtor.nmls}
                onChange={(e) => setRealtor((r) => ({ ...r, nmls: e.target.value }))}
                placeholder="DRE / NMLS #"
                className={inputCls}
              />
              <input
                value={realtor.phone}
                onChange={(e) => setRealtor((r) => ({ ...r, phone: e.target.value }))}
                placeholder="Phone"
                className={inputCls}
              />
              <input
                value={realtor.email}
                onChange={(e) => setRealtor((r) => ({ ...r, email: e.target.value }))}
                placeholder="Email"
                className={inputCls}
              />
            </div>
            <p className="mt-1 text-[11px] text-gray-400">
              Pre-filled from what your loan officer saved — edits here apply to this flyer only.
            </p>
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={() => void generate("preview")}
              disabled={!!busy}
              className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-700 disabled:opacity-50"
            >
              {busy === "preview" && <LoadingSpinner size="sm" />}
              Preview flyer
            </button>
            <button
              type="button"
              onClick={() => void generate("download")}
              disabled={!!busy}
              className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:opacity-50"
            >
              {busy === "download" && <LoadingSpinner size="sm" />}
              Download PDF
            </button>
          </div>
        </div>
      </div>

      {/* Preview modal */}
      {previewUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setPreviewUrl(null)}
        >
          <div
            className="flex h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-gray-200 px-4 py-2.5">
              <p className="text-sm font-semibold text-gray-900">{product.name}</p>
              <button
                type="button"
                onClick={() => setPreviewUrl(null)}
                className="p-1 text-gray-400 hover:text-gray-600"
                aria-label="Close preview"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path d="M12 4L4 12M4 4l8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            <iframe src={previewUrl} className="w-full flex-1" title="Flyer preview" />
          </div>
        </div>
      )}
    </div>
  );
}

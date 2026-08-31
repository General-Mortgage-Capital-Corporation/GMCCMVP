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

export default function PartnerFlyersTab() {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [ctx, setCtx] = useState<PartnerCtx | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Product | null>(null);

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

  const byCategory = useMemo(() => {
    const map = new Map<string, Product[]>();
    for (const p of products ?? []) {
      const list = map.get(p.category) ?? [];
      list.push(p);
      map.set(p.category, list);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [products]);

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
        <div className="space-y-6">
          {byCategory.map(([category, list]) => (
            <section key={category}>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">
                {category}
              </h3>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {list.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setSelected(p)}
                    className="group overflow-hidden rounded-xl border border-gray-200 bg-white text-left shadow-sm transition-all hover:border-red-300 hover:shadow-md"
                  >
                    {p.thumbnailUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={p.thumbnailUrl}
                        alt=""
                        loading="lazy"
                        className="aspect-[3/4] w-full bg-gray-50 object-cover object-top"
                      />
                    ) : (
                      <div className="flex aspect-[3/4] w-full items-center justify-center bg-gray-50 text-gray-300">
                        <svg width="32" height="32" viewBox="0 0 16 16" fill="none">
                          <path d="M3 2h10v12H3V2z" stroke="currentColor" strokeWidth="1.2" />
                          <path d="M5 6h6M5 9h6M5 12h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                        </svg>
                      </div>
                    )}
                    <div className="p-2.5">
                      <p className="truncate text-xs font-semibold text-gray-900 group-hover:text-red-700">
                        {p.name}
                      </p>
                      {p.description && (
                        <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-gray-500">
                          {p.description}
                        </p>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            </section>
          ))}
          {products.length === 0 && (
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
        {/* Template preview card */}
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
          {product.thumbnailUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={product.thumbnailUrl} alt="" className="w-full bg-gray-50 object-cover" />
          ) : (
            <div className="flex aspect-[3/4] items-center justify-center bg-gray-50 text-gray-300 text-xs">
              No preview
            </div>
          )}
          <div className="p-3">
            <p className="text-sm font-semibold text-gray-900">{product.name}</p>
            {product.description && (
              <p className="mt-1 text-xs leading-snug text-gray-500">{product.description}</p>
            )}
          </div>
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

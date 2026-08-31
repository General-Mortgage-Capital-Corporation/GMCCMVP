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

/**
 * Turn a product description into a short human summary.
 *
 * Some descriptions are raw text dumps of the whole flyer PDF — program
 * pitch, then licensing/disclosure boilerplate, addresses, and URLs. The
 * pitch always comes first, so cut at the first legal/contact marker, then
 * strip inline boilerplate and cap at a word boundary.
 */
const LEGAL_MARKERS =
  /\b(additional conditions|nmls|dre[\s#:]|cfl:|disclosures|licensed by|licensing|department of|www\.|https?:\/\/|email:|ph:)/i;

function cleanDescription(d: string): string {
  let text = d;
  const cut = text.search(LEGAL_MARKERS);
  if (cut > 0) text = text.slice(0, cut);
  text = text
    .replace(/programs? are subject to change[^.;]*[.;]?/gi, "")
    .replace(/all loans? are subject to (underwriting|credit)[^.;]*[.;]?/gi, "")
    .replace(/\s+/g, " ")
    .replace(/[\s,;|\-–]+$/, "")
    .trim();
  if (text.length > 200) {
    const clipped = text.slice(0, 200);
    text = clipped.slice(0, Math.max(clipped.lastIndexOf(" "), 160)).trimEnd() + "…";
  }
  return text;
}

export default function PartnerFlyersTab() {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [ctx, setCtx] = useState<PartnerCtx | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Product | null>(null);
  const [query, setQuery] = useState("");

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

  // Grouped by category — the categories describe the AUDIENCE ("Community
  // lending", "Self employed borrowers"), which is exactly how a partner
  // thinks about picking a flyer. Search filters across name + description
  // and drops empty sections.
  const sections = useMemo(() => {
    const q = query.trim().toLowerCase();
    const map = new Map<string, Product[]>();
    for (const p of products ?? []) {
      if (
        q &&
        !p.name.toLowerCase().includes(q) &&
        !p.description.toLowerCase().includes(q) &&
        !p.category.toLowerCase().includes(q)
      ) {
        continue;
      }
      const list = map.get(p.category) ?? [];
      list.push(p);
      map.set(p.category, list);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [products, query]);

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
          <div className="relative mb-5 max-w-xs">
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
            >
              <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
              <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search programs…"
              className="w-full rounded-full border border-gray-200 bg-gray-50 py-2 pl-9 pr-4 text-sm outline-none transition-colors placeholder:text-gray-400 focus:border-red-200 focus:bg-white focus:ring-2 focus:ring-red-100"
            />
          </div>

          <div className="space-y-6">
            {sections.map(([cat, list]) => (
              <section key={cat}>
                <div className="mb-1.5 flex items-center gap-2 px-3">
                  <span className="h-1.5 w-1.5 rounded-full bg-red-600/80" />
                  <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-gray-500">
                    {cat}
                  </h3>
                  <span className="h-px flex-1 bg-gray-100" />
                </div>
                <div className="grid md:grid-cols-2 xl:grid-cols-3">
                  {list.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setSelected(p)}
                      className="group relative rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-red-50/70"
                    >
                      <span className="absolute bottom-2.5 left-0 top-2.5 w-0.5 rounded-full bg-red-600 opacity-0 transition-opacity group-hover:opacity-100" />
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-medium text-gray-900 group-hover:text-red-700">
                          {displayTitle(p.name)}
                        </span>
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 16 16"
                          fill="none"
                          className="shrink-0 -translate-x-1 text-red-400 opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100"
                        >
                          <path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-gray-500">
                        {cleanDescription(p.description) || "Program flyer"}
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>

          {sections.length === 0 && (
            <p className="py-8 text-center text-sm text-gray-400">
              {query.trim()
                ? "No programs match your search."
                : "No flyer templates are available right now."}
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
          <div className="p-3.5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-red-600">
              {product.category}
            </p>
            <p className="mt-1 text-sm font-semibold text-gray-900">{displayTitle(product.name)}</p>
            {cleanDescription(product.description) && (
              <p className="mt-1 line-clamp-3 text-xs leading-snug text-gray-500">
                {cleanDescription(product.description)}
              </p>
            )}
          </div>
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

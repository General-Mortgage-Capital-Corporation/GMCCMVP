"use client";

import { useState, useRef, useCallback } from "react";
import AddressAutocomplete from "@/components/AddressAutocomplete";
import LoadingSpinner from "@/components/LoadingSpinner";
import { formatPrice, formatCurrency, formatPhoneInput } from "@/lib/utils";
import PhotoCarousel from "@/components/PhotoCarousel";
import { CensusPanel, SectionTitle, GridItem } from "@/components/shared/PropertyPanels";
import { ProgramCard, IneligiblePrograms, EditRealtorPanel } from "@/components/shared/ProgramCards";
import { type RealtorInfo, programHasFlyer, sortByHighlightOrder, PROGRAM_CONFIG } from "@/components/flier/FlierButton";
import MultiSummaryModal from "@/components/flier/MultiSummaryModal";
import MultiEmailModal from "@/components/flier/MultiEmailModal";
import LoanComparisonFlyer from "./LoanComparisonFlyer";
import { useAuth } from "@/contexts/AuthContext";
import { trackEvent } from "@/lib/posthog";
import type {
  AutocompleteSuggestion,
  CensusData,
  ProgramResult,
  RentCastListing,
  SearchResponse,
} from "@/types";

// ---------------------------------------------------------------------------
// Zillow photo cache (sessionStorage)
// ---------------------------------------------------------------------------

const PHOTO_CACHE_PREFIX = "gmcc_zillow_photos:";

function getCachedPhotos(address: string): string[] | null {
  try {
    const raw = sessionStorage.getItem(PHOTO_CACHE_PREFIX + address);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch { /* ignore */ }
  return null;
}

function setCachedPhotos(address: string, photos: string[]) {
  if (photos.length === 0) return;
  try {
    sessionStorage.setItem(PHOTO_CACHE_PREFIX + address, JSON.stringify(photos));
  } catch { /* quota exceeded */ }
}

// ---------------------------------------------------------------------------
// CRA Check Tab — Full property detail page
// ---------------------------------------------------------------------------

export default function CRACheckTab() {
  const { user, signIn, getIdToken } = useAuth();

  // Search state
  const [address, setAddress] = useState("");
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const activePlaceId = useRef<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Result state
  const [census, setCensus] = useState<CensusData | null>(null);
  const [programs, setPrograms] = useState<ProgramResult[]>([]);
  const [listing, setListing] = useState<RentCastListing | null>(null);
  const [searchedAddress, setSearchedAddress] = useState("");

  // Photo state
  const [zillowPhotos, setZillowPhotos] = useState<string[]>([]);
  const [photosLoading, setPhotosLoading] = useState(false);
  const [photosError, setPhotosError] = useState<string | undefined>(undefined);

  // Realtor / image state
  const [realtorInfo, setRealtorInfo] = useState<RealtorInfo>({
    name: "", phone: "", email: "", nmls: "", company: "",
  });
  const [editRealtorOpen, setEditRealtorOpen] = useState(false);
  const [propertyImage, setPropertyImage] = useState<string | undefined>(undefined);
  const [fileUploadError, setFileUploadError] = useState<string | undefined>(undefined);
  const uploadImgRef = useRef<HTMLInputElement>(null);

  // Multi-select state
  const [selectedPrograms, setSelectedPrograms] = useState<Set<string>>(new Set());
  const [showSummaryModal, setShowSummaryModal] = useState(false);
  const [showMultiEmailModal, setShowMultiEmailModal] = useState(false);
  const [multiSummary, setMultiSummary] = useState("");
  const [preResearch, setPreResearch] = useState<string | null>(null);

  // Prefetch coordinates from Google Places
  async function prefetchCoords(placeId: string) {
    activePlaceId.current = placeId;
    try {
      const geo = await fetch(`/api/place-details?place_id=${encodeURIComponent(placeId)}`).then(
        (r) => r.json() as Promise<{ lat: number | null; lng: number | null }>,
      );
      if (activePlaceId.current !== placeId) return;
      if (geo.lat != null && geo.lng != null) {
        setCoords({ lat: geo.lat, lng: geo.lng });
      }
    } catch { /* non-critical */ }
  }

  // Fetch Zillow photos — abort stale requests when a new search starts
  const photoCtrl = useRef<AbortController | null>(null);

  function fetchPhotos(addr: string) {
    // Abort any in-flight photo fetch
    photoCtrl.current?.abort();
    const ctrl = new AbortController();
    photoCtrl.current = ctrl;

    const cached = getCachedPhotos(addr);
    if (cached) {
      setZillowPhotos(cached);
      return;
    }
    setPhotosLoading(true);
    fetch(`/api/zillow-photos?address=${encodeURIComponent(addr)}`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((data: { photos?: string[] }) => {
        if (ctrl.signal.aborted) return;
        const photos = data.photos ?? [];
        setZillowPhotos(photos);
        setCachedPhotos(addr, photos);
      })
      .catch((err) => { if (err?.name !== "AbortError") setPhotosError("Could not load photos"); })
      .finally(() => { if (!ctrl.signal.aborted) setPhotosLoading(false); });
  }

  // Main search handler
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!address.trim()) return;
    setLoading(true);
    setError(null);
    setCensus(null);
    setPrograms([]);
    setListing(null);
    setSearchedAddress(address);
    setSelectedPrograms(new Set());
    setMultiSummary("");
    setShowSummaryModal(false);
    setShowMultiEmailModal(false);
    setZillowPhotos([]);
    setPhotosLoading(false);
    setPhotosError(undefined);
    setPropertyImage(undefined);
    setEditRealtorOpen(false);

    trackEvent("cra_check", { address: address.trim() });

    try {
      // Step 1: Try to find the property in RentCast for full details
      let rentcastListing: RentCastListing | null = null;
      try {
        const searchParams = new URLSearchParams({
          query: address,
          search_type: "specific",
          radius: "1",
        });
        if (coords) {
          searchParams.set("lat", String(coords.lat));
          searchParams.set("lng", String(coords.lng));
        }
        const searchRes = await fetch(`/api/search?${searchParams}`);
        if (!searchRes.ok) throw new Error("Search failed");
        const searchData = (await searchRes.json()) as SearchResponse;
        if (searchData.success && searchData.listings.length > 0) {
          // Use the first (best) match — sorted by distance from the
          // searched address. The improved normalizeAddress (5-digit street
          // number preservation + unit designator normalization) now makes
          // the exact_match flag much more reliable, but we still use
          // listings[0] even when exact_match is false because the closest
          // result is usually the correct property under a slightly
          // different RentCast formatting.
          rentcastListing = searchData.listings[0];
        }
      } catch {
        // RentCast lookup failed — continue with address-only matching
      }

      // Step 2: Run program matching (sends to Python backend)
      const matchPayload = rentcastListing ?? {
        formattedAddress: address,
        ...(coords ? { latitude: coords.lat, longitude: coords.lng } : {}),
      };

      const matchRes = await fetch("/api/match-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([matchPayload]),
      });
      if (!matchRes.ok) throw new Error("Match request failed");
      const matchData = await matchRes.json();

      if (!matchData.success || !matchData.results?.[0]) {
        setError("Could not check this address. Please try again.");
        return;
      }

      const result = matchData.results[0];
      setCensus(result.census_data ?? null);
      setPrograms(result.programs ?? []);

      // Build listing object for components
      const finalListing: RentCastListing = {
        ...(rentcastListing ?? {}),
        formattedAddress: address,
        ...(coords ? { latitude: coords.lat, longitude: coords.lng } : {}),
        matchData: { programs: result.programs ?? [] },
        censusData: result.census_data ?? null,
      };
      setListing(finalListing);

      // Pre-fill realtor info from listing agent
      if (rentcastListing?.listingAgent) {
        const agent = rentcastListing.listingAgent;
        const office = rentcastListing.listingOffice ?? {};
        setRealtorInfo({
          name: agent.name ?? "",
          phone: formatPhoneInput(agent.phone ?? ""),
          email: agent.email ?? "",
          nmls: "",
          company: office.name ?? "",
        });
      }

      // Step 3: Fetch Zillow photos in parallel (non-blocking)
      fetchPhotos(address);
    } catch {
      setError("Request failed. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  // Multi-select helpers
  const toggleProgramSelect = useCallback((name: string) => {
    setSelectedPrograms((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  // Fetch filled PDF for email attachments
  const fetchPdfForProduct = useCallback(
    async (productId: string): Promise<Blob | null> => {
      try {
        let email = user?.email;
        let idToken: string | null = null;
        if (!email) {
          const freshUser = await signIn();
          email = freshUser.email;
          idToken = freshUser.idToken;
        } else {
          idToken = await getIdToken();
        }
        if (!idToken) return null;
        const res = await fetch("/api/generate-flier", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
          body: JSON.stringify({
            productId,
            userId: email,
            ...(listing?.formattedAddress ? { address: listing.formattedAddress } : {}),
            ...(listing?.price ? { listingPrice: String(listing.price) } : {}),
            ...(realtorInfo.name ? { realtorName: realtorInfo.name } : {}),
            ...(realtorInfo.phone ? { realtorPhone: realtorInfo.phone } : {}),
            ...(realtorInfo.email ? { realtorEmail: realtorInfo.email } : {}),
            ...(realtorInfo.nmls ? { realtorNmls: realtorInfo.nmls } : {}),
            ...(realtorInfo.company ? { realtorCompany: realtorInfo.company } : {}),
            ...(propertyImage
              ? { propertyImage }
              : zillowPhotos.length > 0
                ? { propertyImage: zillowPhotos[0] }
                : {}),
          }),
        });
        if (!res.ok) return null;
        return await res.blob();
      } catch { return null; }
    },
    [user, signIn, getIdToken, listing, realtorInfo, propertyImage, zillowPhotos],
  );

  // Derived state
  const eligible = sortByHighlightOrder(programs.filter((p) => p.status !== "Ineligible" && !p.is_secondary));
  const ineligible = programs.filter((p) => p.status === "Ineligible" && !p.is_secondary);
  const secondary = programs.filter((p) => p.is_secondary);
  const selectablePrograms = [
    ...eligible,
    ...secondary.filter((p) => p.status !== "Ineligible"),
  ];
  const selectedEntries = selectablePrograms
    .filter((p) => selectedPrograms.has(p.program_name))
    .map((p) => ({
      name: p.program_name,
      tier_name: p.best_tier ?? undefined,
      product_id: PROGRAM_CONFIG[p.program_name]?.productId,
    }));

  const hasResults = census || programs.length > 0;
  const hasPropertyData = listing && (listing.price || listing.propertyType);

  return (
    <div className="relative">
      {/* ═══ Search Bar ═══ */}
      {/* Stacks vertically on mobile, inline on desktop */}
      <form onSubmit={handleSubmit} className="flex flex-col gap-3 sm:flex-row">
        <div className="flex-1">
          <AddressAutocomplete
            value={address}
            onChange={(v) => { setAddress(v); setCoords(null); activePlaceId.current = null; }}
            onSelect={(s: AutocompleteSuggestion) => {
              setAddress(s.text);
              setCoords(null);
              if (s.place_id) prefetchCoords(s.place_id);
            }}
            placeholder="Enter a property address..."
          />
        </div>
        <button
          type="submit"
          disabled={loading || !address.trim()}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-red-600 px-6 py-2.5 text-sm font-medium text-white transition hover:bg-red-700 disabled:opacity-50 sm:w-auto"
        >
          {loading && <LoadingSpinner size="sm" />}
          {loading ? "Checking..." : "Check Address"}
        </button>
      </form>

      {error && (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
          {error}
        </div>
      )}

      {/* ═══ Results ═══ */}
      {hasResults && listing && (
        <div className="mt-6 space-y-6">
          {/* ── Photo Carousel ── */}
          <PhotoCarousel
            photos={zillowPhotos}
            loading={photosLoading}
            error={photosError}
            hasPropertyImage={!!propertyImage}
            onSelectForFlyer={(url) => setPropertyImage(url)}
          />

          {/* ── Header: Address + Price ── */}
          <div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h2 className="text-2xl font-bold tracking-tight text-gray-900 sm:text-3xl">
                  {listing.price ? formatPrice(listing.price) : "Price Not Available"}
                </h2>
                <p className="mt-1 text-base text-gray-500">{searchedAddress}</p>
              </div>
              {listing.status && (
                <span className="inline-flex self-start rounded-full bg-blue-100 px-3 py-1 text-xs font-semibold text-blue-800 sm:self-auto">
                  {listing.status}
                </span>
              )}
            </div>
          </div>

          {/* ── Property Details + Census Side by Side ── */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            {/* Left: Property Details */}
            <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
              <div className="mb-4 text-xs font-semibold uppercase tracking-widest text-gray-400">
                Property Details
              </div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-4">
                <GridItem label="Type" value={listing.propertyType ?? "N/A"} />
                <GridItem label="Bedrooms" value={listing.bedrooms != null ? String(listing.bedrooms) : "N/A"} />
                <GridItem label="Bathrooms" value={listing.bathrooms != null ? String(listing.bathrooms) : "N/A"} />
                <GridItem label="Square Footage" value={listing.squareFootage ? listing.squareFootage.toLocaleString() + " sq ft" : "N/A"} />
                <GridItem label="Lot Size" value={listing.lotSize ? listing.lotSize.toLocaleString() + " sq ft" : "N/A"} />
                <GridItem label="Year Built" value={listing.yearBuilt ? String(listing.yearBuilt) : "N/A"} />
                <GridItem label="HOA Fee" value={listing.hoa?.fee ? "$" + listing.hoa.fee.toLocaleString() + "/mo" : "N/A"} />
                <GridItem label="Days on Market" value={listing.daysOnMarket != null ? listing.daysOnMarket + " days" : "N/A"} />
                {listing.lastSalePrice != null && (
                  <GridItem label="Last Sale Price" value={formatPrice(listing.lastSalePrice)} />
                )}
                {listing.lastSaleDate && (
                  <GridItem label="Last Sale Date" value={listing.lastSaleDate.slice(0, 10)} />
                )}
                {listing.pricePerSquareFoot != null && (
                  <GridItem label="Price / Sq Ft" value={`$${listing.pricePerSquareFoot.toLocaleString()}`} />
                )}
                {listing.taxAssessedValue != null && (
                  <GridItem label="Tax Assessed Value" value={formatCurrency(listing.taxAssessedValue)} />
                )}
                <GridItem label="County" value={listing.county ?? "N/A"} />
                <GridItem label="MLS #" value={listing.mlsNumber ?? "N/A"} />
              </div>

              {!hasPropertyData && (
                <p className="mt-2 text-xs italic text-gray-400">
                  Detailed property data not available from RentCast for this address.
                </p>
              )}
            </div>

            {/* Right: Census / CRA Data */}
            {census ? (
              <CensusPanel census={census} />
            ) : (
              <div className="rounded-xl border border-sky-200 bg-sky-50 p-5">
                <div className="mb-1 text-xs font-semibold uppercase tracking-widest text-sky-700">
                  MSA / Census Tract Data
                </div>
                <p className="text-sm italic text-gray-500">
                  Census data unavailable for this address.
                </p>
              </div>
            )}
          </div>

          {/* ── Toolbar: Photo Upload + Realtor Edit ── */}
          {programs.length > 0 && (
            <div className="flex flex-wrap items-center gap-3">
              {/* Property image upload */}
              <input
                ref={uploadImgRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  if (file.size > 2 * 1024 * 1024) {
                    setFileUploadError("Image must be under 2 MB.");
                    return;
                  }
                  setFileUploadError(undefined);
                  const reader = new FileReader();
                  reader.onload = () => setPropertyImage(reader.result as string);
                  reader.readAsDataURL(file);
                  e.target.value = "";
                }}
              />
              {propertyImage ? (
                <div className="flex items-center gap-1.5">
                  <img src={propertyImage} alt="Property" className="h-8 w-12 rounded object-cover ring-1 ring-gray-300" />
                  <button
                    onClick={() => uploadImgRef.current?.click()}
                    className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-gray-200 text-gray-500 hover:bg-gray-300"
                    title="Replace flyer image"
                  >
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                      <path d="M11 2l3 3-9 9H2v-3L11 2z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                    </svg>
                  </button>
                  <button
                    onClick={() => setPropertyImage(undefined)}
                    className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-gray-200 text-gray-500 hover:bg-gray-300"
                    title="Remove image"
                  >
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                      <path d="M12 4L4 12M4 4l8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => uploadImgRef.current?.click()}
                  className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50"
                  title={zillowPhotos.length > 0 ? "Override with your own photo" : "Upload property photo for flyer"}
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                    <rect x="1" y="3" width="14" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
                    <circle cx="5.5" cy="7.5" r="1.5" stroke="currentColor" strokeWidth="1.2" />
                    <path d="M1 11l4-3 3 2.5 2.5-2 4.5 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                  </svg>
                  {zillowPhotos.length > 0 ? "Upload Custom Photo" : "Upload Property Photo"}
                </button>
              )}
              {fileUploadError && (
                <span className="text-[0.7rem] text-red-500">{fileUploadError}</span>
              )}
              <button
                onClick={() => setEditRealtorOpen((v) => !v)}
                className="inline-flex items-center gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-100"
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                  <path d="M11 2l3 3-9 9H2v-3L11 2z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                </svg>
                {editRealtorOpen ? "Hide Realtor Info" : "Edit Realtor Info"}
              </button>
            </div>
          )}

          {/* Realtor edit panel */}
          {editRealtorOpen && (
            <EditRealtorPanel realtorInfo={realtorInfo} onChange={setRealtorInfo} />
          )}

          {/* ═══ Matching Programs ═══ */}
          {programs.length > 0 && (
            <div>
              <div className="mb-4 flex items-center justify-between">
                <SectionTitle>Matching Programs</SectionTitle>
                {selectablePrograms.length > 1 && (
                  <div className="flex items-center gap-2 text-xs">
                    <button
                      onClick={() => setSelectedPrograms(new Set(selectablePrograms.map((p) => p.program_name)))}
                      className="text-gray-500 hover:text-gray-700"
                    >
                      Select all
                    </button>
                    {selectedPrograms.size > 0 && (
                      <button
                        onClick={() => setSelectedPrograms(new Set())}
                        className="text-gray-500 hover:text-gray-700"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                )}
              </div>

              {eligible.length === 0 && ineligible.length === 0 && secondary.length === 0 && (
                <p className="text-sm italic text-gray-400">
                  No matching GMCC programs found for this property.
                </p>
              )}

              {eligible.length > 0 && (
                <div className="space-y-2">
                  <div className="mb-1 flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-gray-700">GMCC Highlighted Programs</h3>
                    <span className="rounded-full bg-red-50 px-2 py-0.5 text-[0.65rem] font-medium text-red-600">
                      {eligible.length}
                    </span>
                  </div>
                  {eligible.map((prog) => (
                    <ProgramCard
                      key={prog.program_name}
                      program={prog}
                      listing={listing}
                      realtorInfo={realtorInfo}
                      propertyImage={propertyImage}
                      selected={selectedPrograms.has(prog.program_name)}
                      onToggleSelect={() => toggleProgramSelect(prog.program_name)}
                    />
                  ))}
                </div>
              )}

              {ineligible.length > 0 && (
                <div className={eligible.length > 0 ? "mt-4" : ""}>
                  <IneligiblePrograms programs={ineligible} />
                </div>
              )}

              {secondary.length > 0 && (
                <div className="mt-6">
                  <div className="mb-3 flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-gray-700">Additional Programs</h3>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[0.65rem] font-medium text-slate-500">
                      {secondary.length}
                    </span>
                  </div>
                  {(() => {
                    const secEligible = secondary
                      .filter((p) => p.status !== "Ineligible")
                      .sort((a, b) => Number(programHasFlyer(b.program_name)) - Number(programHasFlyer(a.program_name)));
                    const secIneligible = secondary.filter((p) => p.status === "Ineligible");
                    return (
                      <div className="space-y-2">
                        {secEligible.map((prog) => (
                          <ProgramCard
                            key={prog.program_name}
                            program={prog}
                            listing={listing}
                            realtorInfo={realtorInfo}
                            propertyImage={propertyImage}
                            selected={selectedPrograms.has(prog.program_name)}
                            onToggleSelect={() => toggleProgramSelect(prog.program_name)}
                          />
                        ))}
                        {secIneligible.length > 0 && (
                          <div className={secEligible.length > 0 ? "mt-3" : ""}>
                            <IneligiblePrograms programs={secIneligible} />
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>
          )}

          {/* ═══ Home Financing Options Flyer Builder ═══ */}
          <LoanComparisonFlyer
            listing={listing}
            census={census}
            realtorInfo={realtorInfo}
            propertyImage={propertyImage}
            zillowPhotos={zillowPhotos}
          />
        </div>
      )}

      {/* ═══ Floating Multi-Select Action Bar ═══ */}
      {selectedPrograms.size > 0 && listing && (
        <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-gray-200 bg-white/95 px-6 py-3 shadow-lg backdrop-blur-sm">
          <div className="mx-auto flex max-w-4xl items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="rounded-full bg-red-100 px-3 py-1 text-xs font-semibold text-red-700">
                {selectedPrograms.size} program{selectedPrograms.size > 1 ? "s" : ""} selected
              </span>
              <button
                onClick={() => setSelectedPrograms(new Set(selectablePrograms.map((p) => p.program_name)))}
                className="text-xs text-gray-500 hover:text-gray-700"
              >
                Select all
              </button>
              <button
                onClick={() => setSelectedPrograms(new Set())}
                className="text-xs text-gray-500 hover:text-gray-700"
              >
                Clear
              </button>
            </div>

            <div className="flex items-center gap-2">
              <button
                disabled
                className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-4 py-2 text-sm font-medium text-gray-400 cursor-not-allowed"
                title="Pricing comparison engine coming soon"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  <path d="M6 2v12M10 2v12" stroke="currentColor" strokeWidth="1" strokeLinecap="round" opacity="0.5" />
                </svg>
                Compare Pricing
                <span className="rounded bg-gray-200 px-1.5 py-0.5 text-[0.6rem] font-semibold uppercase leading-none tracking-wider text-gray-500">Soon</span>
              </button>
              <button
                onClick={() => setShowSummaryModal(true)}
                className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-red-700"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <path d="M3 2h10v12H3V2z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                  <path d="M5 6h6M5 9h6M5 12h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
                Summary &amp; Email
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ Multi-program Summary Modal ═══ */}
      {showSummaryModal && selectedEntries.length > 0 && listing && (
        <MultiSummaryModal
          programs={selectedEntries}
          listing={listing as unknown as Record<string, unknown>}
          authToken={null}
          realtorName={realtorInfo.name}
          realtorEmail={realtorInfo.email}
          realtorCompany={realtorInfo.company}
          onClose={() => setShowSummaryModal(false)}
          onComposeEmail={(summary: string, research: string | null) => {
            setMultiSummary(summary);
            setPreResearch(research);
            setShowSummaryModal(false);
            setShowMultiEmailModal(true);
          }}
        />
      )}

      {/* ═══ Multi-program Email Modal ═══ */}
      {showMultiEmailModal && selectedEntries.length > 0 && listing && (
        <MultiEmailModal
          programs={selectedEntries}
          summary={multiSummary}
          propertyAddress={listing.formattedAddress}
          listingPrice={listing.price}
          realtorInfo={realtorInfo}
          preResearch={preResearch}
          onClose={() => setShowMultiEmailModal(false)}
          onBackToSummary={() => {
            setShowMultiEmailModal(false);
            setShowSummaryModal(true);
          }}
          fetchPdf={fetchPdfForProduct}
        />
      )}
    </div>
  );
}

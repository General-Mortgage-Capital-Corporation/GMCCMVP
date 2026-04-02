"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  RentCastListing,
  ProgramResult,
} from "@/types";
import {
  formatPrice,
  formatPhone,
  formatPhoneInput,
} from "@/lib/utils";
import { useAuth } from "@/contexts/AuthContext";
import { type RealtorInfo, programHasFlyer, sortByHighlightOrder, PROGRAM_CONFIG } from "@/components/flier/FlierButton";
import MultiSummaryModal from "@/components/flier/MultiSummaryModal";
import MultiEmailModal from "@/components/flier/MultiEmailModal";
import PhotoCarousel from "./PhotoCarousel";
import { CensusPanel, SectionTitle, GridItem } from "./shared/PropertyPanels";
import { ProgramCard, IneligiblePrograms, EditRealtorPanel } from "./shared/ProgramCards";

// ---------------------------------------------------------------------------
// Zillow photo cache (sessionStorage, survives modal close / page nav)
// ---------------------------------------------------------------------------
const PHOTO_CACHE_PREFIX = "gmcc_zillow_photos:";

function getCachedPhotos(address: string): string[] | null {
  try {
    const raw = sessionStorage.getItem(PHOTO_CACHE_PREFIX + address);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Only return cache hit if there are actual photos (don't cache failures)
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch { /* ignore */ }
  return null;
}

function setCachedPhotos(address: string, photos: string[]) {
  // Don't cache empty results — they may have been caused by rate limits or errors
  if (photos.length === 0) return;
  try {
    sessionStorage.setItem(PHOTO_CACHE_PREFIX + address, JSON.stringify(photos));
  } catch { /* quota exceeded — ignore */ }
}

/** Clear any stale empty caches from previous failed sessions */
function clearEmptyPhotoCache() {
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(PHOTO_CACHE_PREFIX)) {
        const val = sessionStorage.getItem(key);
        if (val === "[]") toRemove.push(key);
      }
    }
    toRemove.forEach((k) => sessionStorage.removeItem(k));
  } catch { /* ignore */ }
}

// Run once on module load to clean up stale caches
if (typeof window !== "undefined") clearEmptyPhotoCache();

// Shared components imported from ./shared/PropertyPanels and ./shared/ProgramCards

// ---------------------------------------------------------------------------
// Main modal
// ---------------------------------------------------------------------------

interface PropertyModalProps {
  listing: RentCastListing | null;
  onClose: () => void;
}

export default function PropertyModal({ listing, onClose }: PropertyModalProps) {
  const { user, signIn, getIdToken } = useAuth();
  const overlayRef = useRef<HTMLDivElement>(null);
  const uploadImgRef = useRef<HTMLInputElement>(null);
  const [editRealtorOpen, setEditRealtorOpen] = useState(false);
  const [propertyImage, setPropertyImage] = useState<string | undefined>(undefined);
  const [fileUploadError, setFileUploadError] = useState<string | undefined>(undefined);
  const [realtorInfo, setRealtorInfo] = useState<RealtorInfo>({
    name: "",
    phone: "",
    email: "",
    nmls: "",
    company: "",
  });
  const [selectedPrograms, setSelectedPrograms] = useState<Set<string>>(new Set());
  const [showSummaryModal, setShowSummaryModal] = useState(false);
  const [showMultiEmailModal, setShowMultiEmailModal] = useState(false);
  const [multiSummary, setMultiSummary] = useState<string>("");
  const [preResearch, setPreResearch] = useState<string | null>(null);

  // Zillow photo state
  const [zillowPhotos, setZillowPhotos] = useState<string[]>([]);
  const [photosLoading, setPhotosLoading] = useState(false);
  const [photosError, setPhotosError] = useState<string | undefined>(undefined);

  // Reset state whenever a new listing is opened
  useEffect(() => {
    if (!listing) return;
    const agent = listing.listingAgent ?? {};
    const office = listing.listingOffice ?? {};
    setRealtorInfo({
      name: agent.name ?? "",
      phone: formatPhoneInput(agent.phone ?? ""),
      email: agent.email ?? "",
      nmls: "",
      company: office.name ?? "",
    });
    setEditRealtorOpen(false);
    setPropertyImage(undefined);
    setFileUploadError(undefined);
    setSelectedPrograms(new Set());
    setMultiSummary("");
    setShowSummaryModal(false);
    setShowMultiEmailModal(false);
    setZillowPhotos([]);
    setPhotosLoading(false);
    setPhotosError(undefined);

    // Fetch Zillow photos (check cache first)
    const address = listing.formattedAddress;
    if (!address) return;

    const cached = getCachedPhotos(address);
    if (cached) {
      setZillowPhotos(cached);
      // Auto-set primary photo for flyer if no user upload
      if (cached.length > 0) setPropertyImage(undefined); // will use Zillow photo via carousel
      return;
    }

    let cancelled = false;
    setPhotosLoading(true);
    fetch(`/api/zillow-photos?address=${encodeURIComponent(address)}`)
      .then((r) => r.json())
      .then((data: { photos?: string[]; primaryPhoto?: string }) => {
        if (cancelled) return;
        const photos = data.photos ?? [];
        setZillowPhotos(photos);
        setCachedPhotos(address, photos);
      })
      .catch(() => {
        if (!cancelled) setPhotosError("Could not load photos");
      })
      .finally(() => {
        if (!cancelled) setPhotosLoading(false);
      });

    return () => { cancelled = true; };
  // Use address as primary key — every listing has a unique address.
  // listing?.id can be undefined for some RentCast results, causing the effect to not re-fire.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listing?.formattedAddress]);

  useEffect(() => {
    if (!listing) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [listing, onClose]);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === overlayRef.current) onClose();
    },
    [onClose],
  );

  // Multi-select helpers
  const toggleProgramSelect = useCallback((name: string) => {
    setSelectedPrograms((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  /** Fetch a flyer PDF for a specific productId (used by MultiEmailModal). */
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
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${idToken}`,
          },
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
      } catch {
        return null;
      }
    },
    [user, signIn, getIdToken, listing, realtorInfo, propertyImage, zillowPhotos],
  );

  if (!listing) return null;

  const programs: ProgramResult[] = listing.matchData?.programs ?? [];
  const census = listing.censusData;
  const eligible = sortByHighlightOrder(programs.filter((p) => p.status !== "Ineligible" && !p.is_secondary));
  const ineligible = programs.filter((p) => p.status === "Ineligible" && !p.is_secondary);
  const secondary = programs.filter((p) => p.is_secondary);

  // All selectable programs (eligible + secondary that aren't ineligible)
  const selectablePrograms = [
    ...eligible,
    ...secondary.filter((p) => p.status !== "Ineligible"),
  ];

  // Build selected program entries for modals
  const selectedEntries = selectablePrograms
    .filter((p) => selectedPrograms.has(p.program_name))
    .map((p) => ({
      name: p.program_name,
      tier_name: p.best_tier ?? undefined,
      product_id: PROGRAM_CONFIG[p.program_name]?.productId,
    }));

  const agent = listing.listingAgent ?? {};
  const office = listing.listingOffice ?? {};
  const builder = listing.builder ?? {};
  const hoa = listing.hoa ?? {};

  let contactBlock: React.ReactNode = null;
  if (agent.name || agent.phone || agent.email) {
    contactBlock = (
      <div className="rounded-lg bg-gray-50 p-4">
        <div className="mb-1.5 font-semibold text-gray-900">{agent.name ?? "Agent"}</div>
        <div className="space-y-0.5 text-sm text-gray-600">
          {agent.phone && <div>Phone: {formatPhone(agent.phone)}</div>}
          {agent.email && <div>Email: {agent.email}</div>}
          {agent.website && (
            <div>
              Website:{" "}
              <a href={agent.website} target="_blank" rel="noopener noreferrer" className="text-red-600 hover:underline">
                {agent.website}
              </a>
            </div>
          )}
        </div>
      </div>
    );
  } else if (builder.name) {
    contactBlock = (
      <div className="rounded-lg bg-gray-50 p-4">
        <div className="mb-1.5 font-semibold text-gray-900">{builder.name} (Builder)</div>
        <div className="space-y-0.5 text-sm text-gray-600">
          {builder.phone && <div>Phone: {formatPhone(builder.phone)}</div>}
          {builder.development && <div>Development: {builder.development}</div>}
          {builder.website && (
            <div>
              Website:{" "}
              <a href={builder.website} target="_blank" rel="noopener noreferrer" className="text-red-600 hover:underline">
                {builder.website}
              </a>
            </div>
          )}
        </div>
      </div>
    );
  } else {
    contactBlock = (
      <div className="rounded-lg bg-gray-50 p-4 text-sm text-gray-500">
        No contact information available
      </div>
    );
  }

  return (
    <div
      ref={overlayRef}
      onClick={handleOverlayClick}
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/50 p-4 backdrop-blur-sm"
    >
      <div className="relative my-auto flex max-h-[90vh] w-full max-w-full flex-col rounded-xl bg-white shadow-2xl sm:max-w-4xl">
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute right-3 top-3 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-gray-100 text-gray-500 transition-colors hover:bg-gray-200 sm:right-4 sm:top-4 sm:h-8 sm:w-8"
          aria-label="Close"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M12 4L4 12M4 4l8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>

        <div className="min-h-0 flex-1 overflow-y-auto rounded-t-xl">
          {/* ── Photo carousel (Zillow) ── */}
          <PhotoCarousel
            photos={zillowPhotos}
            loading={photosLoading}
            error={photosError}
            hasPropertyImage={!!propertyImage}
            onSelectForFlyer={(url) => {
              // Convert the Zillow CDN URL to a usable property image
              // We store the URL directly — the flyer generator will handle it
              setPropertyImage(url);
            }}
          />

          <div className="space-y-5 p-6">
            {/* ── Header ── */}
            <div className="pr-8">
              <div className="text-3xl font-bold tracking-tight text-gray-900">
                {formatPrice(listing.price)}
              </div>
              <div className="mt-1 text-base text-gray-600">
                {listing.formattedAddress ?? "Address unavailable"}
              </div>
            </div>

            {/* ── MSA / Census panel ── */}
            {census ? (
              <CensusPanel census={census} />
            ) : (
              <div className="rounded-xl border border-sky-200 bg-sky-50 p-4">
                <div className="mb-1 text-xs font-semibold uppercase tracking-widest text-sky-700">
                  MSA / Census Tract Data
                </div>
                <p className="text-sm italic text-gray-500">
                  Census data unavailable for this property.
                </p>
              </div>
            )}

            {/* ── Matching Programs ── */}
            <div>
              <div className="mb-3 flex flex-col gap-2 border-b border-gray-200 pb-2 sm:flex-row sm:items-center sm:justify-between">
                <span className="text-xs font-semibold uppercase tracking-widest text-gray-400">
                  Matching Programs
                </span>
                {eligible.length > 0 && (
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
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
                      <div className="flex items-center gap-1">
                        <img src={propertyImage} alt="Property" className="h-7 w-10 rounded object-cover ring-1 ring-gray-300" />
                        <button
                          onClick={() => uploadImgRef.current?.click()}
                          className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-gray-200 text-gray-500 hover:bg-gray-300"
                          title="Replace flyer image"
                        >
                          <svg width="8" height="8" viewBox="0 0 16 16" fill="none">
                            <path d="M11 2l3 3-9 9H2v-3L11 2z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                          </svg>
                        </button>
                        <button
                          onClick={() => setPropertyImage(undefined)}
                          className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-gray-200 text-gray-500 hover:bg-gray-300"
                          title="Remove image"
                        >
                          <svg width="8" height="8" viewBox="0 0 16 16" fill="none">
                            <path d="M12 4L4 12M4 4l8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                          </svg>
                        </button>
                      </div>
                    ) : (
                      <div className="flex flex-col items-end gap-0.5">
                        <button
                          onClick={() => uploadImgRef.current?.click()}
                          className="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50"
                          title={zillowPhotos.length > 0 ? "Override with your own photo" : "Upload property photo for flyer"}
                        >
                          <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                            <rect x="1" y="3" width="14" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
                            <circle cx="5.5" cy="7.5" r="1.5" stroke="currentColor" strokeWidth="1.2" />
                            <path d="M1 11l4-3 3 2.5 2.5-2 4.5 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                          </svg>
                          {zillowPhotos.length > 0 ? "Upload Custom Photo" : "Upload Property Photo"}
                        </button>
                        {fileUploadError && (
                          <span className="text-[0.7rem] text-red-500">{fileUploadError}</span>
                        )}
                      </div>
                    )}
                    <button
                      onClick={() => setEditRealtorOpen((v) => !v)}
                      className="inline-flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-100"
                    >
                      <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                        <path
                          d="M11 2l3 3-9 9H2v-3L11 2z"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinejoin="round"
                        />
                      </svg>
                      {editRealtorOpen ? "Hide Realtor Info" : "Edit Realtor Info"}
                    </button>
                  </div>
                )}
              </div>

              {/* Realtor edit panel */}
              {editRealtorOpen && (
                <div className="mb-4">
                  <EditRealtorPanel realtorInfo={realtorInfo} onChange={setRealtorInfo} />
                </div>
              )}

              {!listing.matchData && (
                <p className="text-sm italic text-gray-400">Match data not yet available.</p>
              )}

              {listing.matchData && eligible.length === 0 && (
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
                    <h3 className="text-sm font-semibold text-gray-700">Community Lending Programs</h3>
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

            {/* ── Property Details ── */}
            <div>
              <SectionTitle>Property Details</SectionTitle>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <GridItem label="Type" value={listing.propertyType ?? "N/A"} />
                <GridItem label="Bedrooms" value={listing.bedrooms != null ? String(listing.bedrooms) : "N/A"} />
                <GridItem label="Bathrooms" value={listing.bathrooms != null ? String(listing.bathrooms) : "N/A"} />
                <GridItem label="Square Footage" value={listing.squareFootage ? listing.squareFootage.toLocaleString() + " sq ft" : "N/A"} />
                <GridItem label="Lot Size" value={listing.lotSize ? listing.lotSize.toLocaleString() + " sq ft" : "N/A"} />
                <GridItem label="Year Built" value={listing.yearBuilt ? String(listing.yearBuilt) : "N/A"} />
                <GridItem label="HOA Fee" value={hoa.fee ? "$" + hoa.fee.toLocaleString() + "/mo" : "N/A"} />
                <GridItem label="Status" value={listing.status ?? "N/A"} />
              </div>
            </div>

            {/* ── Listing Information ── */}
            <div>
              <SectionTitle>Listing Information</SectionTitle>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <GridItem label="Listed Date" value={listing.listedDate ? listing.listedDate.slice(0, 10) : "N/A"} />
                <GridItem label="Days on Market" value={listing.daysOnMarket != null ? listing.daysOnMarket + " days" : "N/A"} />
                <GridItem label="MLS Number" value={listing.mlsNumber ?? "N/A"} />
                <GridItem label="Last Updated" value={listing.lastSeenDate ? listing.lastSeenDate.slice(0, 10) : "N/A"} />
              </div>
            </div>

            {/* ── Location ── */}
            <div>
              <SectionTitle>Location</SectionTitle>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <GridItem label="City" value={listing.city ?? "N/A"} />
                <GridItem label="State" value={listing.state ?? "N/A"} />
                <GridItem label="Zip Code" value={listing.zipCode ?? "N/A"} />
                <GridItem label="County" value={listing.county ?? "N/A"} />
              </div>
            </div>

            {/* ── Contact Information ── */}
            <div>
              <SectionTitle>Contact Information</SectionTitle>
              {contactBlock}
              {office.name && (
                <div className="mt-3 rounded-lg bg-gray-50 p-4">
                  <div className="mb-1.5 font-semibold text-gray-900">{office.name} (Office)</div>
                  <div className="space-y-0.5 text-sm text-gray-600">
                    {office.phone && <div>Phone: {formatPhone(office.phone)}</div>}
                    {office.email && <div>Email: {office.email}</div>}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── Floating multi-select action bar (outside scroll container) ── */}
        {selectedPrograms.size > 0 && (
          <div className="shrink-0 border-t border-gray-200 bg-white px-6 py-3 rounded-b-xl">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-semibold text-red-700">
                  {selectedPrograms.size} selected
                </span>
                <button
                  onClick={() => {
                    const all = new Set(selectablePrograms.map((p) => p.program_name));
                    setSelectedPrograms(all);
                  }}
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

              <button
                onClick={() => setShowSummaryModal(true)}
                className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700"
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                  <path d="M3 2h10v12H3V2z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                  <path d="M5 6h6M5 9h6M5 12h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
                Summary &amp; Email
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Multi-program summary modal ── */}
      {showSummaryModal && selectedEntries.length > 0 && (
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

      {/* ── Multi-program email modal ── */}
      {showMultiEmailModal && selectedEntries.length > 0 && (
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

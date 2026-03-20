"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import DOMPurify from "dompurify";
import type {
  RentCastListing,
  ProgramResult,
  CensusData,
  CriterionResult,
  CriterionStatus,
} from "@/types";
import {
  formatPrice,
  formatNumber,
  formatCurrency,
  formatPct,
  formatPhone,
  formatPhoneInput,
  renderSimpleMarkdown,
} from "@/lib/utils";
import { getExplanation } from "@/lib/api";
import LoadingSpinner from "./LoadingSpinner";
import { useAuth } from "@/contexts/AuthContext";
import FlierButton, { type RealtorInfo, programHasFlyer, PROGRAM_CONFIG } from "@/components/flier/FlierButton";
import MultiSummaryModal from "@/components/flier/MultiSummaryModal";
import MultiEmailModal from "@/components/flier/MultiEmailModal";
import PhotoCarousel from "./PhotoCarousel";

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

// ---------------------------------------------------------------------------
// Criterion status icons
// ---------------------------------------------------------------------------

function StatusIcon({ status }: { status: CriterionStatus }) {
  if (status === "pass") {
    return (
      <span className="mt-0.5 shrink-0 text-emerald-500">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M13.3 4.3L6 11.6 2.7 8.3" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    );
  }
  if (status === "fail") {
    return (
      <span className="mt-0.5 shrink-0 text-red-500">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M12 4L4 12M4 4l8 8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
      </span>
    );
  }
  return (
    <span className="mt-0.5 shrink-0 text-slate-400">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.8" />
        <path d="M6.5 6a1.5 1.5 0 013 0c0 1-1.5 1-1.5 2M8 11h.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </span>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-3 border-b border-gray-200 pb-2 text-xs font-semibold uppercase tracking-widest text-gray-400">
      {children}
    </div>
  );
}

function GridItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-gray-500">{label}</span>
      <span className="text-[0.9375rem] font-medium text-gray-900">{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MSA / Census panel
// ---------------------------------------------------------------------------

function demoPct(count: number | undefined, total: number | undefined): string {
  if (count == null || !total) return "";
  return ` (${((count / total) * 100).toFixed(0)}%)`;
}

function CensusPanel({ census }: { census: CensusData }) {
  const incomeLevel = census.tract_income_level ?? "N/A";
  const isLmi = ["low", "moderate"].includes(incomeLevel.toLowerCase());

  const minorityPct = census.tract_minority_pct;
  const isMMCT = minorityPct != null && minorityPct > 50;

  const majorityAaHp = census.majority_aa_hp;
  const majorityText =
    majorityAaHp === true ? "Yes" : majorityAaHp === false ? "No" : "N/A";

  const total = census.total_population;

  const tractMsaRatio =
    census.tract_to_msa_ratio != null
      ? census.tract_to_msa_ratio.toFixed(1) + "%"
      : "N/A";

  return (
    <div className="rounded-xl border border-sky-200 bg-sky-50 p-5">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-widest text-sky-700">
          MSA / Census Tract Data
        </span>
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
            isLmi ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-700"
          }`}
        >
          {incomeLevel} Income
        </span>
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
            isMMCT ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-700"
          }`}
        >
          {isMMCT ? "In-MMCT" : "Not MMCT"}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
        {[
          { label: "MSA/MD Code", value: census.msa_code ?? "Non-Metro" },
          { label: "MSA Name", value: census.msa_name && census.msa_name !== "N/A" ? census.msa_name : "Rural / Non-Metropolitan" },
          { label: "Tract Income Level", value: incomeLevel },
          { label: "Tract Minority %", value: formatPct(minorityPct) },
          { label: "Majority AA/HP", value: majorityText },
          { label: "Total Population", value: formatNumber(total) },
          {
            label: "Hispanic Population",
            value: formatNumber(census.hispanic_population) + demoPct(census.hispanic_population, total),
          },
          {
            label: "Black Population",
            value: formatNumber(census.black_population) + demoPct(census.black_population, total),
          },
          {
            label: "Asian Population",
            value: formatNumber(census.asian_population) + demoPct(census.asian_population, total),
          },
          { label: "FFIEC MSA MFI", value: formatCurrency(census.ffiec_mfi) },
          { label: "Tract MFI", value: formatCurrency(census.tract_mfi) },
          { label: "Tract / MSA Ratio", value: tractMsaRatio },
        ].map(({ label, value }) => (
          <div key={label} className="flex flex-col gap-0.5">
            <span className="text-[0.75rem] text-sky-600/80">{label}</span>
            <span className="text-[0.875rem] font-medium text-sky-900">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Criteria grid
// ---------------------------------------------------------------------------
function CriteriaGrid({ criteria }: { criteria: CriterionResult[] }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {criteria.map((c, idx) => (
        <div key={`${c.criterion}-${idx}`} className="flex items-start gap-1.5">
          <StatusIcon status={c.status} />
          <div>
            <div className="text-xs uppercase tracking-wide text-gray-400">
              {c.criterion.replace(/_/g, " ")}
            </div>
            <div className="text-[0.8125rem] text-gray-700">{c.detail}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Talking points
// ---------------------------------------------------------------------------
function TalkingPoints({
  program,
  listing,
}: {
  program: ProgramResult;
  listing: RentCastListing;
}) {
  const [explanation, setExplanation] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleExplain = async () => {
    if (explanation || loading) return;
    setLoading(true);
    try {
      const res = await getExplanation(
        program.program_name,
        listing,
        program.best_tier ?? "",
      );
      setExplanation(res.explanation ?? "No explanation available.");
    } catch {
      setExplanation("Failed to generate talking points.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mt-3">
      {!explanation && !loading && (
        <button
          onClick={handleExplain}
          className="inline-flex items-center gap-1.5 rounded-md border border-transparent bg-red-50 px-3 py-1.5 text-[0.8125rem] font-medium text-red-600 transition-colors hover:border-red-300"
        >
          Get Talking Points
        </button>
      )}
      {loading && (
        <div className="flex items-center gap-2 text-xs text-red-600">
          <LoadingSpinner size="sm" />
          <span>Loading...</span>
        </div>
      )}
      {explanation && (
        <div
          className="mt-2 rounded-lg bg-gray-50 p-3 text-[0.875rem] leading-relaxed text-gray-700"
          dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(renderSimpleMarkdown(explanation)) }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Program card — action buttons inline in header, expand for criteria details
// ---------------------------------------------------------------------------
function ProgramCard({
  program,
  listing,
  realtorInfo,
  propertyImage,
  selected,
  onToggleSelect,
}: {
  program: ProgramResult;
  listing: RentCastListing;
  realtorInfo: RealtorInfo;
  propertyImage?: string;
  selected?: boolean;
  onToggleSelect?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const tier =
    program.matching_tiers.find((t) => t.tier_name === program.best_tier) ??
    program.matching_tiers[0];

  const isDiamond = program.program_name === "GMCC Diamond CRA";

  return (
    <div
      className={`overflow-hidden rounded-lg border ${
        selected ? "border-red-300 ring-1 ring-red-200" : expanded ? "border-gray-300" : "border-gray-200"
      } bg-white`}
    >
      {/* Header row */}
      <div
        className="flex w-full cursor-pointer items-center gap-3 px-4 py-3.5 transition-colors hover:bg-gray-50"
        onClick={() => setExpanded((v) => !v)}
      >
        {/* Multi-select checkbox */}
        {onToggleSelect && (
          <input
            type="checkbox"
            checked={!!selected}
            onChange={(e) => { e.stopPropagation(); onToggleSelect(); }}
            onClick={(e) => e.stopPropagation()}
            className="h-4 w-4 shrink-0 rounded border-gray-300 text-red-600 focus:ring-red-500 cursor-pointer"
            title="Select for multi-program summary / email"
          />
        )}
        {/* Name + beta badge */}
        <span className="min-w-0 flex-1 text-[0.9375rem] font-semibold text-gray-900">
          {program.program_name}
          {isDiamond && (
            <span className="ml-2 rounded-full bg-violet-100 px-1.5 py-0.5 text-[0.65rem] font-bold uppercase tracking-wide text-violet-700">
              Beta
            </span>
          )}
        </span>

        {/* Eligibility badge */}
        <span
          className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${
            program.status === "Eligible"
              ? "bg-emerald-100 text-emerald-800"
              : "bg-amber-100 text-amber-700"
          }`}
        >
          {program.status}
        </span>

        {/* Flyer action buttons */}
        <FlierButton
          programName={program.program_name}
          propertyAddress={listing.formattedAddress}
          listingPrice={listing.price}
          realtorInfo={realtorInfo}
          propertyImage={propertyImage}
        />

        {/* Expand chevron */}
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          className={`shrink-0 text-gray-400 transition-transform ${expanded ? "rotate-90" : ""}`}
        >
          <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>

      {/* Expanded body: criteria + talking points */}
      {expanded && (
        <div className="border-t border-gray-100 px-4 pb-4 pt-3">
          {isDiamond && (
            <div className="mb-3 rounded-md border border-violet-200 bg-violet-50 p-2.5 text-xs text-violet-700">
              Beta — Tract eligibility list may be outdated.{" "}
              <a
                href="https://hub.collateralanalytics.com/correspondentsearch"
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold underline hover:text-violet-900"
                onClick={(e) => e.stopPropagation()}
              >
                Double-check this property&apos;s eligibility here
              </a>{" "}
              before proceeding.
            </div>
          )}
          {tier && <CriteriaGrid criteria={tier.criteria} />}
          <TalkingPoints program={program} listing={listing} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ineligible programs
// ---------------------------------------------------------------------------
function IneligiblePrograms({ programs }: { programs: ProgramResult[] }) {
  return (
    <details className="group">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium text-gray-500 hover:text-gray-700">
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          className="transition-transform group-open:rotate-90"
        >
          <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Ineligible Programs ({programs.length})
      </summary>

      <div className="mt-3 space-y-2 pl-1">
        {programs.map((prog) => {
          const failedCriteria = prog.matching_tiers.flatMap((t) =>
            t.criteria.filter((c) => c.status === "fail"),
          );
          return (
            <div
              key={prog.program_name}
              className="rounded-lg border border-red-100 bg-red-50 px-4 py-3"
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-gray-800">{prog.program_name}</span>
                <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                  Ineligible
                </span>
              </div>
              {failedCriteria.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {failedCriteria.map((c, idx) => (
                    <li key={`${c.criterion}-${idx}`} className="flex items-start gap-1.5 text-xs text-gray-600">
                      <StatusIcon status="fail" />
                      <span>
                        <span className="font-medium capitalize">
                          {c.criterion.replace(/_/g, " ")}:
                        </span>{" "}
                        {c.detail}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Edit Realtor panel
// ---------------------------------------------------------------------------
function EditRealtorPanel({
  realtorInfo,
  onChange,
}: {
  realtorInfo: RealtorInfo;
  onChange: (info: RealtorInfo) => void;
}) {
  const fields: { key: keyof RealtorInfo; label: string; placeholder: string }[] = [
    { key: "name", label: "Name", placeholder: "Realtor name" },
    { key: "phone", label: "Phone", placeholder: "(xxx) xxx-xxxx" },
    { key: "email", label: "Email", placeholder: "Email address" },
    { key: "nmls", label: "NMLS #", placeholder: "NMLS license number" },
    { key: "company", label: "Company", placeholder: "Brokerage / company" },
  ];

  function handleChange(key: keyof RealtorInfo, raw: string) {
    onChange({ ...realtorInfo, [key]: key === "phone" ? formatPhoneInput(raw) : raw });
  }

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
      <p className="mb-3 text-xs text-amber-700">
        Auto-filled from listing agent data. Edit or clear fields as needed before generating a flyer.
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {fields.map(({ key, label, placeholder }) => (
          <div key={key} className="flex flex-col gap-0.5">
            <label className="text-[0.7rem] font-medium text-amber-800 uppercase tracking-wide">
              {label}
            </label>
            <input
              type="text"
              value={realtorInfo[key]}
              placeholder={placeholder}
              onChange={(e) => handleChange(key, e.target.value)}
              className="rounded border border-amber-200 bg-white px-2 py-1.5 text-xs text-gray-700 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-amber-400"
            />
          </div>
        ))}
      </div>
    </div>
  );
}

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
  const eligible = programs.filter((p) => p.status !== "Ineligible" && !p.is_secondary);
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
      <div className="relative my-auto flex max-h-[90vh] w-full max-w-full flex-col rounded-xl bg-white shadow-2xl sm:max-w-3xl">
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute right-4 top-4 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-gray-100 text-gray-500 transition-colors hover:bg-gray-200"
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
                    <h3 className="text-sm font-semibold text-gray-700">Additional Program Matches</h3>
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
          onClose={() => setShowSummaryModal(false)}
          onComposeEmail={(summary: string) => {
            setMultiSummary(summary);
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

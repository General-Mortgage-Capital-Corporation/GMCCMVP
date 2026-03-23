"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";

import SearchForm from "@/components/search/SearchForm";
import FilterChips from "@/components/search/FilterChips";
import PriceRangeFilter from "@/components/search/PriceRangeFilter";
import PropertyGrid from "@/components/property/PropertyGrid";
import ProgramSelector from "@/components/program/ProgramSelector";
import MarketingSearchForm from "@/components/marketing/MarketingSearchForm";
import MarketingTable from "@/components/marketing/MarketingTable";
import MarketingFilters from "@/components/marketing/MarketingFilters";
import CRACheckTab from "@/components/cra/CRACheckTab";
import SignInButton from "@/components/auth/SignInButton";
import SettingsModal from "@/components/SettingsModal";
import PropertyModal from "@/components/PropertyModal";
import Pagination from "@/components/Pagination";
import LoadingSpinner from "@/components/LoadingSpinner";

import { useAuth } from "@/contexts/AuthContext";
import { useSearch } from "@/hooks/useSearch";
import { usePagination } from "@/hooks/usePagination";

import {
  fetchPrograms,
  fetchProgramLocations,
  programSearchStream,
  marketingSearchStream,
  matchBatch,
  ApiError,
} from "@/lib/api";
import { listingPassesChipFilters, formatPrice } from "@/lib/utils";

import type { RentCastListing, ProgramLocationEntry } from "@/types";
import type { ChipFilter } from "@/lib/utils";
import type { SortBy } from "@/components/property/PropertyGrid";
import { sortListings } from "@/components/property/PropertyGrid";
import type { MkSortColumn, MkSortDir } from "@/components/marketing/MarketingTable";

type ActiveTab = "find" | "program" | "marketing" | "cra";

const PER_PAGE = 12;

export default function Home() {
  const { user, signIn } = useAuth();
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<ActiveTab>("cra");
  const [modalListing, setModalListing] = useState<RentCastListing | null>(null);
  const [programs, setPrograms] = useState<string[]>([]);
  const [programLocations, setProgramLocations] = useState<ProgramLocationEntry[]>([]);

  // Shared chip filters + sort + price range
  const [chipFilters, setChipFilters] = useState<Set<ChipFilter>>(new Set());
  const [sortBy, setSortBy] = useState<SortBy>("days-asc");
  const [priceMin, setPriceMin] = useState<number | null>(null);
  const [priceMax, setPriceMax] = useState<number | null>(null);

  // Reset price range when tab changes or new search starts
  const resetPriceRange = useCallback(() => { setPriceMin(null); setPriceMax(null); }, []);

  // ── Find Properties tab ──────────────────────────────────────────────────
  const findSearch = useSearch();

  // Price range filter helper
  const passesPrice = useCallback((l: RentCastListing) => {
    if (priceMin == null && priceMax == null) return true;
    const p = l.price ?? 0;
    if (priceMin != null && p < priceMin) return false;
    if (priceMax != null && p > priceMax) return false;
    return true;
  }, [priceMin, priceMax]);

  const filteredFindListings = useMemo(
    () => sortListings(
      findSearch.listings.filter((l) => listingPassesChipFilters(l, chipFilters) && passesPrice(l)),
      sortBy,
    ),
    [findSearch.listings, chipFilters, sortBy, passesPrice],
  );

  const findPagination = usePagination(filteredFindListings, PER_PAGE);

  // ── Search by Program tab ────────────────────────────────────────────────
  const [progListings, setProgListings] = useState<RentCastListing[]>([]);
  const [progLoading, setProgLoading] = useState(false);
  const [progError, setProgError] = useState<string | null>(null);

  const filteredProgListings = useMemo(
    () => sortListings(
      progListings.filter((l) => listingPassesChipFilters(l, chipFilters) && passesPrice(l)),
      sortBy,
    ),
    [progListings, chipFilters, sortBy, passesPrice],
  );

  const progPagination = usePagination(filteredProgListings, PER_PAGE);

  // ── Marketing tab ────────────────────────────────────────────────────────
  const [mkListings, setMkListings] = useState<RentCastListing[]>([]);
  const [mkLoading, setMkLoading] = useState(false);
  const [mkError, setMkError] = useState<string | null>(null);
  const [mkProgress, setMkProgress] = useState<{ processed: number; total: number } | null>(null);
  const [mkSortCol, setMkSortCol] = useState<MkSortColumn>("days");
  const [mkSortDir, setMkSortDir] = useState<MkSortDir>("asc");
  const [mkProgramFilters, setMkProgramFilters] = useState<string[]>([]);
  const [mkTypeFilters, setMkTypeFilters] = useState<string[]>([]);
  const [mkFailedCount, setMkFailedCount] = useState(0);
  const [mkRetrying, setMkRetrying] = useState(false);

  const filteredMkListings = useMemo(() => {
    return mkListings.filter((l) => {
      if (!listingPassesChipFilters(l, chipFilters)) return false;
      if (!passesPrice(l)) return false;
      if (
        mkProgramFilters.length > 0 &&
        !mkProgramFilters.some((name) =>
          l.matchData?.programs.some(
            (p) => p.program_name === name && p.status !== "Ineligible",
          ),
        )
      )
        return false;
      if (mkTypeFilters.length > 0 && !mkTypeFilters.includes(l.propertyType ?? ""))
        return false;
      return true;
    });
  }, [mkListings, chipFilters, mkProgramFilters, mkTypeFilters, passesPrice]);

  // Separate abort controllers per tab so they don't interfere
  const progSearchCtrl = useRef<AbortController | null>(null);
  const mkSearchCtrl = useRef<AbortController | null>(null);

  // ── Bootstrap ────────────────────────────────────────────────────────────
  useEffect(() => {
    fetchPrograms()
      .then((r) => setPrograms(r.programs))
      .catch(() => {});
    fetchProgramLocations()
      .then((r) => setProgramLocations(r.programs))
      .catch(() => {});
  }, []);

  // ── Stats ─────────────────────────────────────────────────────────────────
  const statsListings =
    activeTab === "find"
      ? filteredFindListings
      : activeTab === "program"
        ? filteredProgListings
        : filteredMkListings;

  const stats = useMemo(() => {
    if (statsListings.length === 0) return null;
    const prices = statsListings.map((l) => l.price ?? 0).filter((p) => p > 0);
    const avgPrice = prices.length
      ? prices.reduce((a, b) => a + b, 0) / prices.length
      : 0;
    const minPrice = prices.length ? Math.min(...prices) : 0;
    const maxPrice = prices.length ? Math.max(...prices) : 0;
    const doms = statsListings.map((l) => l.daysOnMarket ?? 0).filter((d) => d > 0);
    const avgDom = doms.length
      ? Math.round(doms.reduce((a, b) => a + b, 0) / doms.length)
      : 0;
    return { total: statsListings.length, avgPrice, minPrice, maxPrice, avgDom };
  }, [statsListings]);

  // ── Handlers ─────────────────────────────────────────────────────────────
  function handleTabChange(tab: ActiveTab) {
    setActiveTab(tab);
    setChipFilters(new Set());
    setSortBy("days-asc");
  }

  async function handleFindSearch(params: {
    query: string;
    searchType: "area" | "specific";
    radius: number;
    selectedPrograms: string[];
    lat?: number;
    lng?: number;
  }) {
    setChipFilters(new Set());
    await findSearch.search({
      query: params.query,
      searchType: params.searchType,
      radius: params.radius,
      programs: params.selectedPrograms,
      lat: params.lat,
      lng: params.lng,
    });
  }

  async function handleProgramSearch(params: {
    program: string;
    countyFips: string;
    city?: string;
  }) {
    progSearchCtrl.current?.abort();
    const ctrl = new AbortController();
    progSearchCtrl.current = ctrl;

    setProgError(null);
    setProgLoading(true);
    setProgListings([]);
    setChipFilters(new Set());
    resetPriceRange();
    try {
      for await (const event of programSearchStream(params, ctrl.signal)) {
        if (event.type === "batch") {
          if (event.listings.length > 0) {
            setProgListings((prev) => [...prev, ...event.listings]);
          }
        } else if (event.type === "done") {
          break;
        } else if (event.type === "error") {
          setProgError(event.error);
          break;
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setProgError(
        err instanceof ApiError ? err.message : "Search failed. Please try again.",
      );
    } finally {
      if (progSearchCtrl.current === ctrl) setProgLoading(false);
    }
  }

  async function handleMarketingSearch(params: {
    countyFips: string;
    city?: string;
  }) {
    mkSearchCtrl.current?.abort();
    const ctrl = new AbortController();
    mkSearchCtrl.current = ctrl;

    setMkError(null);
    setMkLoading(true);
    setMkListings([]);
    setMkProgress(null);
    setMkProgramFilters([]);
    setMkTypeFilters([]);
    setChipFilters(new Set());
    resetPriceRange();
    setMkFailedCount(0);
    try {
      let failedInSearch = 0;
      for await (const event of marketingSearchStream(params, ctrl.signal)) {
        if (event.type === "start") {
          setMkProgress({ processed: 0, total: event.total_in_county });
        } else if (event.type === "batch") {
          const batchFailed = event.listings.filter((l) => l._matchFailed).length;
          failedInSearch += batchFailed;
          setMkFailedCount(failedInSearch);
          setMkListings((prev) => [...prev, ...event.listings]);
          setMkProgress((prev) =>
            prev ? { ...prev, processed: event.processed } : null,
          );
        } else if (event.type === "done") {
          break;
        } else if (event.type === "error") {
          setMkError(event.error);
          break;
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setMkError(
        err instanceof ApiError ? err.message : "Search failed. Please try again.",
      );
    } finally {
      if (mkSearchCtrl.current === ctrl) {
        setMkLoading(false);
        setMkProgress(null);
      }
    }
  }

  async function handleMkRetry() {
    const failed = mkListings.filter((l) => l._matchFailed);
    if (failed.length === 0) return;
    setMkRetrying(true);
    try {
      const res = await matchBatch(failed);
      if (res.success && res.results) {
        setMkListings((prev) => {
          const next = [...prev];
          let ri = 0;
          for (let i = 0; i < next.length; i++) {
            if (!next[i]._matchFailed) continue;
            const r = res.results[ri];
            ri++;
            if (r) {
              next[i] = {
                ...next[i],
                matchData: { programs: r.programs },
                censusData: r.census_data,
                _matchFailed: undefined,
              };
            }
          }
          const remaining = next.filter((l) => l._matchFailed).length;
          setMkFailedCount(remaining);
          return next;
        });
      }
    } catch {
      // Retry failed silently -- user can try again
    } finally {
      setMkRetrying(false);
    }
  }

  function handleMkSort(col: MkSortColumn) {
    if (mkSortCol === col) {
      setMkSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setMkSortCol(col);
      setMkSortDir("desc");
    }
  }

  const openModal = useCallback(
    (listing: RentCastListing) => {
      const all = [...findSearch.listings, ...progListings, ...mkListings];
      const enriched = listing.id
        ? (all.find((l) => l.id === listing.id) ?? listing)
        : listing;
      setModalListing(enriched);
    },
    [findSearch.listings, progListings, mkListings],
  );

  // Derived booleans
  const hasResults =
    activeTab === "find"
      ? findSearch.listings.length > 0 || findSearch.loading
      : activeTab === "program"
        ? progListings.length > 0 || progLoading
        : activeTab === "marketing"
          ? mkListings.length > 0 || mkLoading
          : false;

  const currentError =
    activeTab === "find"
      ? findSearch.error
      : activeTab === "program"
        ? progError
        : activeTab === "marketing"
          ? mkError
          : null;

  const showFilterBar = activeTab !== "marketing" && hasResults;

  const resultCount =
    activeTab === "find"
      ? filteredFindListings.length
      : activeTab === "program"
        ? filteredProgListings.length
        : filteredMkListings.length;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="sticky top-0 z-30 border-b border-gray-200 bg-white/95 backdrop-blur-sm">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <img src="/gmcc-logo.png" alt="GMCC" className="h-8 w-8 shrink-0" />
            <h1 className="truncate text-lg font-bold tracking-tight text-gray-900 sm:text-xl">
              GMCC Property Search
            </h1>
            <span className="hidden shrink-0 rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-700 sm:inline-flex">
              Sale Listings
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSettingsOpen(true)}
              className="flex h-8 w-8 items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
              title="Settings"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M6.5 1.5h3l.4 1.8.7.3 1.6-.9 2.1 2.1-.9 1.6.3.7 1.8.4v3l-1.8.4-.3.7.9 1.6-2.1 2.1-1.6-.9-.7.3-.4 1.8h-3l-.4-1.8-.7-.3-1.6.9-2.1-2.1.9-1.6-.3-.7L1.5 9.5v-3l1.8-.4.3-.7-.9-1.6 2.1-2.1 1.6.9.7-.3z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.3" />
              </svg>
            </button>
            <SignInButton />
          </div>
        </div>
      </header>

      {/* Sign-in nudge banner */}
      {!user && !bannerDismissed && (
        <div className="border-b border-red-100 bg-red-50">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-2.5">
            <p className="text-sm text-red-700">
              <span className="font-medium">Sign in with Outlook</span> to email flyers and save your work.
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => { signIn().catch(() => {}); }}
                className="rounded-md bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700 transition-colors"
              >
                Sign in
              </button>
              <button
                onClick={() => setBannerDismissed(true)}
                className="text-red-400 hover:text-red-600 transition-colors"
                aria-label="Dismiss"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <path d="M12 4L4 12M4 4l8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}

      <main className="mx-auto max-w-6xl px-4 py-6">
        {/* ── Search card ── */}
        <div className="mb-6 rounded-2xl border border-gray-200 bg-white shadow-sm">
          {/* Tab bar */}
          <div className="overflow-x-auto border-b border-gray-100">
            <nav className="flex whitespace-nowrap px-2">
              {(
                [
                  ["cra", "CRA Address Fast Check"],
                  ["marketing", "Massive Marketing"],
                  ["find", "Marketing/GPS Radius Check"],
                  ["program", "Market by Program Check"],
                ] as [ActiveTab, string][]
              ).map(([tab, label]) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => handleTabChange(tab)}
                  className={`border-b-2 px-4 py-3 text-sm font-medium transition-colors ${
                    activeTab === tab
                      ? "border-red-600 text-red-600"
                      : "border-transparent text-gray-500 hover:text-gray-700"
                  }`}
                >
                  {label}
                </button>
              ))}
            </nav>
          </div>

          {/* Tab content */}
          <div className="p-5">
            {activeTab === "find" && (
              <SearchForm
                programs={programs}
                onSearch={handleFindSearch}
                loading={findSearch.loading}
              />
            )}
            {activeTab === "program" && (
              <ProgramSelector
                programLocations={programLocations}
                onSearch={handleProgramSearch}
                loading={progLoading}
              />
            )}
            {activeTab === "marketing" && (
              <MarketingSearchForm
                programLocations={programLocations}
                onSearch={handleMarketingSearch}
                loading={mkLoading}
              />
            )}
            {activeTab === "cra" && <CRACheckTab />}
          </div>
        </div>

        {/* Error banner */}
        {currentError && (
          <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
            {currentError}
          </div>
        )}

        {/* Notice banner (e.g. "not an active listing, showing nearby") */}
        {activeTab === "find" && findSearch.notice && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {findSearch.notice}
          </div>
        )}

        {/* ── Results section ── */}
        {hasResults && (
          <>
            {/* Stats bar */}
            {stats && (
              <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[
                  { label: "Properties", value: stats.total.toString() },
                  { label: "Avg Price", value: formatPrice(stats.avgPrice) },
                  {
                    label: "Price Range",
                    value: `${formatPrice(stats.minPrice)} – ${formatPrice(stats.maxPrice)}`,
                  },
                  { label: "Avg DOM", value: `${stats.avgDom} days` },
                ].map(({ label, value }) => (
                  <div
                    key={label}
                    className="rounded-xl border border-gray-200 bg-white px-4 py-3 shadow-sm"
                  >
                    <p className="text-xs text-gray-500">{label}</p>
                    <p className="mt-0.5 text-sm font-semibold text-gray-900">{value}</p>
                  </div>
                ))}
              </div>
            )}

            {/* Marketing filters */}
            {activeTab === "marketing" && mkListings.length > 0 && (
              <div className="mb-4 rounded-xl border border-gray-200 bg-white p-3 shadow-sm">
                <MarketingFilters
                  listings={mkListings}
                  programFilters={mkProgramFilters}
                  typeFilters={mkTypeFilters}
                  chipFilters={chipFilters}
                  priceMin={priceMin}
                  priceMax={priceMax}
                  onProgramFilters={setMkProgramFilters}
                  onTypeFilters={setMkTypeFilters}
                  onChipFilter={setChipFilters}
                  onPriceRange={(newMin, newMax) => { setPriceMin(newMin); setPriceMax(newMax); }}
                />
              </div>
            )}

            {/* Filter + sort bar (find / program tabs) */}
            {showFilterBar && (
              <div className="mb-4 space-y-3 rounded-xl border border-gray-200 bg-white px-4 py-3 shadow-sm">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">Filters</span>
                  <FilterChips
                    active={chipFilters}
                    onChange={setChipFilters}
                    showPriceRanges={false}
                  />
                </div>

                {/* Price range slider */}
                {(() => {
                  const allPrices = (activeTab === "find" ? findSearch.listings : progListings)
                    .map((l) => l.price ?? 0);
                  return allPrices.filter((p) => p > 0).length >= 2 ? (
                    <PriceRangeFilter
                      prices={allPrices}
                      min={priceMin}
                      max={priceMax}
                      onChange={(newMin, newMax) => { setPriceMin(newMin); setPriceMax(newMax); }}
                    />
                  ) : null;
                })()}

                <div className="flex w-full items-center gap-3 sm:ml-auto sm:w-auto">
                  {/* Matching eligibility indicator (Find tab) */}
                  {activeTab === "find" && findSearch.matchLoading && (
                    <div className="flex items-center gap-1.5 text-xs text-red-600">
                      <LoadingSpinner size="sm" />
                      <span>Checking eligibility…</span>
                    </div>
                  )}
                  {/* Streaming progress indicator (Program tab) */}
                  {activeTab === "program" && progLoading && progListings.length > 0 && (
                    <div className="flex items-center gap-1.5 text-xs text-red-600">
                      <LoadingSpinner size="sm" />
                      <span>Finding more matches…</span>
                    </div>
                  )}

                  {/* Result count */}
                  <span className="text-xs text-gray-400">{resultCount} properties</span>

                  {/* Sort select */}
                  <select
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value as SortBy)}
                    className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs text-gray-700 focus:outline-none focus:ring-2 focus:ring-red-500"
                  >
                    <option value="days-asc">Sort: Days on Market ↑</option>
                    <option value="days-desc">Sort: Days on Market ↓</option>
                    <option value="price-asc">Sort: Price ↑</option>
                    <option value="price-desc">Sort: Price ↓</option>
                    <option value="distance">Sort: Distance</option>
                    <option value="best-match">Sort: Best Match</option>
                  </select>
                </div>
              </div>
            )}

            {/* ── Find Properties ── */}
            {activeTab === "find" && (
              <>
                <PropertyGrid
                  listings={findPagination.paginatedItems}
                  loading={findSearch.loading}
                  onCardClick={openModal}
                  sortBy={sortBy}
                  onSortChange={setSortBy}
                />
                {findPagination.totalPages > 1 && (
                  <Pagination
                    currentPage={findPagination.currentPage}
                    totalPages={findPagination.totalPages}
                    onPageChange={findPagination.setPage}
                  />
                )}
              </>
            )}

            {/* ── Search by Program ── */}
            {activeTab === "program" && (
              <>
                <PropertyGrid
                  listings={progPagination.paginatedItems}
                  loading={progLoading}
                  onCardClick={openModal}
                  sortBy={sortBy}
                />
                {progPagination.totalPages > 1 && (
                  <Pagination
                    currentPage={progPagination.currentPage}
                    totalPages={progPagination.totalPages}
                    onPageChange={progPagination.setPage}
                  />
                )}
              </>
            )}

            {/* ── Massive Marketing ── */}
            {activeTab === "marketing" && (
              <>
                {mkLoading && (
                  <div className="flex flex-col items-center gap-2 py-8">
                    <LoadingSpinner size="lg" />
                    <p className="text-sm text-gray-500">
                      {mkProgress
                        ? `Matching ${mkProgress.processed.toLocaleString()} / ${mkProgress.total.toLocaleString()} properties…`
                        : "Fetching properties…"}
                    </p>
                  </div>
                )}
                {!mkLoading && mkFailedCount > 0 && (
                  <div className="mb-4 flex items-center gap-3 rounded-lg border border-orange-200 bg-orange-50 px-4 py-3 text-sm text-orange-700">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="shrink-0">
                      <path d="M8 1.5l6.5 12H1.5L8 1.5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                      <path d="M8 6v3M8 11.5v.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                    </svg>
                    <span>
                      <strong>{mkFailedCount}</strong> {mkFailedCount === 1 ? "property" : "properties"} could not be matched.
                    </span>
                    <button
                      onClick={handleMkRetry}
                      disabled={mkRetrying}
                      className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-orange-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-orange-700 disabled:opacity-50"
                    >
                      {mkRetrying ? (
                        <>
                          <LoadingSpinner size="sm" />
                          Retrying…
                        </>
                      ) : (
                        <>
                          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                            <path d="M2 8a6 6 0 0110.89-3.48M14 2v4h-4M14 8a6 6 0 01-10.89 3.48M2 14v-4h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                          Retry failed
                        </>
                      )}
                    </button>
                  </div>
                )}
                {mkListings.length > 0 && (
                  <MarketingTable
                    listings={filteredMkListings}
                    sortColumn={mkSortCol}
                    sortDir={mkSortDir}
                    onSort={handleMkSort}
                    onRowClick={openModal}
                  />
                )}
              </>
            )}
          </>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-gray-200 bg-white py-4 text-center text-xs text-gray-400">
        Listing data provided by RentCast API &bull; Census data from FFIEC &bull; GMCC Program Matching
      </footer>

      {/* Modals */}
      <PropertyModal listing={modalListing} onClose={() => setModalListing(null)} />
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

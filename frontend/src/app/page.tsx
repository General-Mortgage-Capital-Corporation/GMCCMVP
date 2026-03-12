"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";

import SearchForm from "@/components/search/SearchForm";
import FilterChips from "@/components/search/FilterChips";
import PropertyGrid from "@/components/property/PropertyGrid";
import ProgramSelector from "@/components/program/ProgramSelector";
import MarketingSearchForm from "@/components/marketing/MarketingSearchForm";
import MarketingTable from "@/components/marketing/MarketingTable";
import MarketingFilters from "@/components/marketing/MarketingFilters";
import CRACheckTab from "@/components/cra/CRACheckTab";
import PropertyModal from "@/components/PropertyModal";
import Pagination from "@/components/Pagination";
import LoadingSpinner from "@/components/LoadingSpinner";

import { useSearch } from "@/hooks/useSearch";
import { usePagination } from "@/hooks/usePagination";

import {
  fetchPrograms,
  fetchProgramLocations,
  programSearchStream,
  marketingSearchStream,
  ApiError,
} from "@/lib/api";
import { listingPassesChipFilters, formatPrice } from "@/lib/utils";

import type { RentCastListing, ProgramLocationEntry } from "@/types";
import type { ChipFilter } from "@/lib/utils";
import type { SortBy } from "@/components/property/PropertyGrid";
import type { MkSortColumn, MkSortDir } from "@/components/marketing/MarketingTable";

type ActiveTab = "find" | "program" | "marketing" | "cra";

const PER_PAGE = 12;

export default function Home() {
  const [activeTab, setActiveTab] = useState<ActiveTab>("cra");
  const [modalListing, setModalListing] = useState<RentCastListing | null>(null);
  const [programs, setPrograms] = useState<string[]>([]);
  const [programLocations, setProgramLocations] = useState<ProgramLocationEntry[]>([]);

  // Shared chip filters + sort
  const [chipFilters, setChipFilters] = useState<Set<ChipFilter>>(new Set());
  const [sortBy, setSortBy] = useState<SortBy>("distance");

  // ── Find Properties tab ──────────────────────────────────────────────────
  const findSearch = useSearch();

  const filteredFindListings = useMemo(
    () => findSearch.listings.filter((l) => listingPassesChipFilters(l, chipFilters)),
    [findSearch.listings, chipFilters],
  );

  const findPagination = usePagination(filteredFindListings, PER_PAGE);

  // ── Search by Program tab ────────────────────────────────────────────────
  const [progListings, setProgListings] = useState<RentCastListing[]>([]);
  const [progLoading, setProgLoading] = useState(false);
  const [progError, setProgError] = useState<string | null>(null);

  const filteredProgListings = useMemo(
    () => progListings.filter((l) => listingPassesChipFilters(l, chipFilters)),
    [progListings, chipFilters],
  );

  const progPagination = usePagination(filteredProgListings, PER_PAGE);

  // ── Marketing tab ────────────────────────────────────────────────────────
  const [mkListings, setMkListings] = useState<RentCastListing[]>([]);
  const [mkLoading, setMkLoading] = useState(false);
  const [mkError, setMkError] = useState<string | null>(null);
  const [mkProgress, setMkProgress] = useState<{ processed: number; total: number } | null>(null);
  const [mkSortCol, setMkSortCol] = useState<MkSortColumn>("price");
  const [mkSortDir, setMkSortDir] = useState<MkSortDir>("desc");
  const [mkProgramFilter, setMkProgramFilter] = useState("");
  const [mkTypeFilter, setMkTypeFilter] = useState("");

  const filteredMkListings = useMemo(() => {
    return mkListings.filter((l) => {
      if (!listingPassesChipFilters(l, chipFilters)) return false;
      if (
        mkProgramFilter &&
        !l.matchData?.programs.some(
          (p) => p.program_name === mkProgramFilter && p.status !== "Ineligible",
        )
      )
        return false;
      if (mkTypeFilter && l.propertyType !== mkTypeFilter) return false;
      return true;
    });
  }, [mkListings, chipFilters, mkProgramFilter, mkTypeFilter]);

  // Shared abort controller — cancels any running program/marketing stream
  const activeSearchCtrl = useRef<AbortController | null>(null);

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
    setSortBy("distance");
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
    activeSearchCtrl.current?.abort();
    const ctrl = new AbortController();
    activeSearchCtrl.current = ctrl;

    setProgError(null);
    setProgLoading(true);
    setProgListings([]);
    setChipFilters(new Set());
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
      if (activeSearchCtrl.current === ctrl) setProgLoading(false);
    }
  }

  async function handleMarketingSearch(params: {
    countyFips: string;
    city?: string;
  }) {
    activeSearchCtrl.current?.abort();
    const ctrl = new AbortController();
    activeSearchCtrl.current = ctrl;

    setMkError(null);
    setMkLoading(true);
    setMkListings([]);
    setMkProgress(null);
    setMkProgramFilter("");
    setMkTypeFilter("");
    setChipFilters(new Set());
    try {
      for await (const event of marketingSearchStream(params, ctrl.signal)) {
        if (event.type === "start") {
          setMkProgress({ processed: 0, total: event.total_in_county });
        } else if (event.type === "batch") {
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
      if (activeSearchCtrl.current === ctrl) {
        setMkLoading(false);
        setMkProgress(null);
      }
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
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold tracking-tight text-gray-900">
              GMCC Property Search
            </h1>
            <span className="rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-700">
              Sale Listings
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">
        {/* ── Search card ── */}
        <div className="mb-6 rounded-2xl border border-gray-200 bg-white shadow-sm">
          {/* Tab bar */}
          <div className="border-b border-gray-100">
            <nav className="flex px-2">
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
                      ? "border-blue-600 text-blue-600"
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
          <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-700">
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
                  programFilter={mkProgramFilter}
                  typeFilter={mkTypeFilter}
                  chipFilters={chipFilters}
                  onProgramFilter={setMkProgramFilter}
                  onTypeFilter={setMkTypeFilter}
                  onChipFilter={setChipFilters}
                />
              </div>
            )}

            {/* Filter + sort bar (find / program tabs) */}
            {showFilterBar && (
              <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3 shadow-sm">
                <FilterChips
                  active={chipFilters}
                  onChange={setChipFilters}
                  showPriceRanges={activeTab === "program"}
                />

                <div className="ml-auto flex items-center gap-3">
                  {/* Matching eligibility indicator (Find tab) */}
                  {activeTab === "find" && findSearch.matchLoading && (
                    <div className="flex items-center gap-1.5 text-xs text-blue-600">
                      <LoadingSpinner size="sm" />
                      <span>Checking eligibility…</span>
                    </div>
                  )}
                  {/* Streaming progress indicator (Program tab) */}
                  {activeTab === "program" && progLoading && progListings.length > 0 && (
                    <div className="flex items-center gap-1.5 text-xs text-blue-600">
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
                    className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="distance">Sort: Distance</option>
                    <option value="price-asc">Sort: Price ↑</option>
                    <option value="price-desc">Sort: Price ↓</option>
                    <option value="days-asc">Sort: Newest</option>
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

      {/* Modal */}
      <PropertyModal listing={modalListing} onClose={() => setModalListing(null)} />
    </div>
  );
}

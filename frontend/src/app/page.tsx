"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";

import SearchForm from "@/components/search/SearchForm";
import ProgramSelector from "@/components/program/ProgramSelector";
import MarketingSearchForm from "@/components/marketing/MarketingSearchForm";
import MarketingTable from "@/components/marketing/MarketingTable";
import MarketingFilters from "@/components/marketing/MarketingFilters";
import CRACheckTab from "@/components/cra/CRACheckTab";
import SignInButton from "@/components/auth/SignInButton";
import SettingsModal from "@/components/SettingsModal";
import FollowUpDashboard from "@/components/FollowUpDashboard";
import ChatTab from "@/components/chat/ChatTab";
import dynamic from "next/dynamic";
const PropertyModal = dynamic(() => import("@/components/PropertyModal"), { ssr: false });
import LoadingSpinner from "@/components/LoadingSpinner";

import { useAuth } from "@/contexts/AuthContext";
import { useSearch } from "@/hooks/useSearch";

import {
  fetchPrograms,
  fetchProgramLocations,
  programSearchStream,
  marketingSearchStream,
  matchBatch,
  ApiError,
} from "@/lib/api";
import { listingPassesChipFilters, formatPrice, EXCLUDED_PROPERTY_TYPES } from "@/lib/utils";

import type { RentCastListing, ProgramLocationEntry } from "@/types";
import type { ChipFilter } from "@/lib/utils";
import type { MkSortColumn, MkSortDir } from "@/components/marketing/MarketingTable";

type ActiveTab = "find" | "program" | "marketing" | "cra" | "chat";

function excludeTypes(listing: RentCastListing) {
  return !EXCLUDED_PROPERTY_TYPES.has(listing.propertyType ?? "");
}

export default function Home() {
  const { user, signIn, getIdToken } = useAuth();
  const [bannerDismissed, setBannerDismissed] = useState(false);
  // Announcement banner for the AI Marketing Agent.
  //
  // Behavior: shows on up to AGENT_ANNOUNCE_MAX_VIEWS page loads, then hides
  // itself so LOs get multiple chances to notice it without it becoming
  // permanent noise. Explicit × dismiss OR visiting the chat tab hides it
  // immediately and forever (on that browser).
  //
  // Persisted under a versioned localStorage key so bumping
  // AGENT_ANNOUNCE_VERSION will reset the counter and re-announce to
  // everyone later on.
  const AGENT_ANNOUNCE_VERSION = "v1";
  const AGENT_ANNOUNCE_KEY = `gmcc-announce-agent-${AGENT_ANNOUNCE_VERSION}`;
  const AGENT_ANNOUNCE_MAX_VIEWS = 5;
  const [agentAnnounceVisible, setAgentAnnounceVisible] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [followUpOpen, setFollowUpOpen] = useState(false);
  const [followUpCount, setFollowUpCount] = useState(0);
  const [activeTab, setActiveTab] = useState<ActiveTab>("cra");
  const [modalListing, setModalListing] = useState<RentCastListing | null>(null);
  const [programs, setPrograms] = useState<string[]>([]);
  const [programLocations, setProgramLocations] = useState<ProgramLocationEntry[]>([]);

  // Shared chip filters + price range
  const [chipFilters, setChipFilters] = useState<Set<ChipFilter>>(new Set());
  const [priceMin, setPriceMin] = useState<number | null>(null);
  const [priceMax, setPriceMax] = useState<number | null>(null);

  // Sort state per tab (all tabs now use MarketingTable-style sorting)
  const [findSortCol, setFindSortCol] = useState<MkSortColumn>("days");
  const [findSortDir, setFindSortDir] = useState<MkSortDir>("asc");
  const [progSortCol, setProgSortCol] = useState<MkSortColumn>("days");
  const [progSortDir, setProgSortDir] = useState<MkSortDir>("asc");

  // Reset price range when tab changes or new search starts
  const resetPriceRange = useCallback(() => { setPriceMin(null); setPriceMax(null); }, []);

  // ── Find Properties tab ──────────────────────────────────────────────────
  const findSearch = useSearch();
  const [findProgramFilters, setFindProgramFilters] = useState<string[]>([]);
  const [findTypeFilters, setFindTypeFilters] = useState<string[]>([]);

  // Price range filter helper
  const passesPrice = useCallback((l: RentCastListing) => {
    if (priceMin == null && priceMax == null) return true;
    const p = l.price ?? 0;
    if (priceMin != null && p < priceMin) return false;
    if (priceMax != null && p > priceMax) return false;
    return true;
  }, [priceMin, priceMax]);

  const filteredFindListings = useMemo(() => {
    return findSearch.listings.filter((l) => {
      if (!excludeTypes(l)) return false;
      if (!listingPassesChipFilters(l, chipFilters)) return false;
      if (!passesPrice(l)) return false;
      if (
        findProgramFilters.length > 0 &&
        !findProgramFilters.some((name) =>
          l.matchData?.programs.some(
            (p) => p.program_name === name && p.status !== "Ineligible",
          ),
        )
      ) return false;
      if (findTypeFilters.length > 0 && !findTypeFilters.includes(l.propertyType ?? ""))
        return false;
      return true;
    });
  }, [findSearch.listings, chipFilters, passesPrice, findProgramFilters, findTypeFilters]);

  // ── Search by Program tab ────────────────────────────────────────────────
  const [progListings, setProgListings] = useState<RentCastListing[]>([]);
  const [progLoading, setProgLoading] = useState(false);
  const [progError, setProgError] = useState<string | null>(null);
  const [progTypeFilters, setProgTypeFilters] = useState<string[]>([]);

  const filteredProgListings = useMemo(() => {
    return progListings.filter((l) => {
      if (!excludeTypes(l)) return false;
      if (!listingPassesChipFilters(l, chipFilters)) return false;
      if (!passesPrice(l)) return false;
      if (progTypeFilters.length > 0 && !progTypeFilters.includes(l.propertyType ?? ""))
        return false;
      return true;
    });
  }, [progListings, chipFilters, passesPrice, progTypeFilters]);

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
      if (!excludeTypes(l)) return false;
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

  // Load AI agent announcement state from localStorage on mount.
  //
  // Storage format (string):
  //   "dismissed"     → user explicitly closed or visited chat; never show.
  //   "<integer>"     → number of times shown so far. Show again iff < MAX.
  //   (no value)      → first ever visit; show and record "1".
  //
  // This effect runs once on mount, counts this page load as a view if the
  // banner is still eligible, and writes the incremented count back.
  useEffect(() => {
    try {
      const stored = localStorage.getItem(AGENT_ANNOUNCE_KEY);
      if (stored === "dismissed") {
        setAgentAnnounceVisible(false);
        return;
      }
      const views = stored ? parseInt(stored, 10) : 0;
      if (Number.isNaN(views) || views >= AGENT_ANNOUNCE_MAX_VIEWS) {
        setAgentAnnounceVisible(false);
        return;
      }
      // Eligible — show it and count this view.
      setAgentAnnounceVisible(true);
      localStorage.setItem(AGENT_ANNOUNCE_KEY, String(views + 1));
    } catch {
      // localStorage blocked → keep banner hidden rather than flashing it on
      // every page load with no way to remember a dismissal.
      setAgentAnnounceVisible(false);
    }
    // AGENT_ANNOUNCE_KEY / MAX_VIEWS are stable constants derived from
    // literals above — intentionally omitted from deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Permanently dismiss the announcement once the user actually opens the
  // chat tab — they've discovered it, no reason to keep nagging.
  useEffect(() => {
    if (activeTab === "chat" && agentAnnounceVisible) {
      setAgentAnnounceVisible(false);
      try { localStorage.setItem(AGENT_ANNOUNCE_KEY, "dismissed"); } catch { /* ignore */ }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, agentAnnounceVisible]);

  function dismissAgentAnnouncement() {
    setAgentAnnounceVisible(false);
    try { localStorage.setItem(AGENT_ANNOUNCE_KEY, "dismissed"); } catch { /* ignore */ }
  }

  // ── Follow-up notification count ───────────────────────────────────────
  const refreshFollowUpCount = useCallback(async () => {
    const token = await getIdToken().catch(() => null);
    if (!token) { setFollowUpCount(0); return; }
    try {
      const res = await fetch("/api/follow-up/count", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json() as { due: number; pending: number };
        setFollowUpCount(data.pending);
      }
    } catch { /* ignore */ }
  }, [getIdToken]);

  useEffect(() => {
    if (user) refreshFollowUpCount();
  }, [user, refreshFollowUpCount]);

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
    setFindProgramFilters([]);
    setFindTypeFilters([]);
    resetPriceRange();
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
    setProgTypeFilters([]);
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

  function handleFindSort(col: MkSortColumn) {
    if (findSortCol === col) {
      setFindSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setFindSortCol(col);
      setFindSortDir("desc");
    }
  }

  function handleProgSort(col: MkSortColumn) {
    if (progSortCol === col) {
      setProgSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setProgSortCol(col);
      setProgSortDir("desc");
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
            {user && (
              <button
                onClick={() => setFollowUpOpen(true)}
                className="relative flex items-center gap-1.5 rounded-full border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors"
                title="Email Dashboard"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="shrink-0">
                  <rect x="1" y="3" width="14" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
                  <path d="M1 5l7 5 7-5" stroke="currentColor" strokeWidth="1.3" />
                </svg>
                <span className="hidden sm:inline">Email Dashboard</span>
                {followUpCount > 0 && (
                  <span className="flex h-4 min-w-[16px] items-center justify-center rounded-full bg-red-600 px-1 text-[0.6rem] font-bold text-white">
                    {followUpCount > 99 ? "99+" : followUpCount}
                  </span>
                )}
              </button>
            )}
            <button
              onClick={() => setSettingsOpen(true)}
              className="flex h-10 w-10 items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors sm:h-8 sm:w-8"
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

      {/* AI Marketing Agent announcement banner */}
      {agentAnnounceVisible && (
        <div className="border-b border-blue-100 bg-gradient-to-r from-blue-50 to-indigo-50">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-2.5">
            <div className="flex min-w-0 items-center gap-2 sm:gap-3">
              <span className="inline-flex shrink-0 items-center rounded-full bg-blue-600 px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-wide text-white">
                New
              </span>
              <p className="min-w-0 text-sm text-blue-900">
                <span className="font-semibold">AI Marketing Agent</span>
                <span className="hidden sm:inline">
                  {" "}— describe what you want and it searches, matches programs, drafts emails, and attaches flyers for you. Try it in the{" "}
                  <span className="font-medium">AI Agent</span> tab.
                </span>
                <span className="sm:hidden"> is live in the AI Agent tab.</span>
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <a
                href="https://youtu.be/e2KjpPjIjmQ"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md border border-blue-300 bg-white px-3 py-1.5 text-xs font-medium text-blue-700 transition-colors hover:bg-blue-100"
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                  <path d="M5 3.5v9l7-4.5-7-4.5z" />
                </svg>
                <span className="hidden sm:inline">Watch demo</span>
                <span className="sm:hidden">Demo</span>
              </a>
              <button
                onClick={() => handleTabChange("chat")}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-700"
              >
                Try it
              </button>
              <button
                onClick={dismissAgentAnnouncement}
                className="p-2 text-blue-400 transition-colors hover:text-blue-600"
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
                className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 transition-colors"
              >
                Sign in
              </button>
              <button
                onClick={() => setBannerDismissed(true)}
                className="p-2 text-red-400 hover:text-red-600 transition-colors"
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
                  ["chat", "AI Agent", "AI Marketing Agent"],
                  ["cra", "CRA Check", "CRA Address Fast Check"],
                  ["marketing", "Marketing", "Massive Marketing"],
                  ["find", "GPS Radius", "Marketing/GPS Radius Check"],
                  ["program", "By Program", "Market by Program Check"],
                ] as [ActiveTab, string, string][]
              ).map(([tab, shortLabel, fullLabel]) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => handleTabChange(tab)}
                  className={`border-b-2 px-3 py-3 text-sm font-medium transition-colors sm:px-4 ${
                    activeTab === tab
                      ? "border-red-600 text-red-600"
                      : "border-transparent text-gray-500 hover:text-gray-700"
                  }`}
                >
                  {/* Shorter labels on mobile to prevent tab overflow */}
                  <span className="sm:hidden">{shortLabel}</span>
                  <span className="hidden sm:inline">{fullLabel}</span>
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
            {/* ChatTab stays mounted but hidden to preserve conversation state */}
            <div className={activeTab === "chat" ? "" : "hidden"}>
              <ChatTab />
            </div>
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

            {/* Filters (consistent MarketingFilters for all result tabs) */}
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
            {activeTab === "find" && findSearch.listings.length > 0 && (
              <div className="mb-4 rounded-xl border border-gray-200 bg-white p-3 shadow-sm">
                <MarketingFilters
                  listings={findSearch.listings}
                  programFilters={findProgramFilters}
                  typeFilters={findTypeFilters}
                  chipFilters={chipFilters}
                  priceMin={priceMin}
                  priceMax={priceMax}
                  onProgramFilters={setFindProgramFilters}
                  onTypeFilters={setFindTypeFilters}
                  onChipFilter={setChipFilters}
                  onPriceRange={(newMin, newMax) => { setPriceMin(newMin); setPriceMax(newMax); }}
                />
                {findSearch.matchLoading && (
                  <div className="mt-2 flex items-center gap-1.5 text-xs text-red-600">
                    <LoadingSpinner size="sm" />
                    <span>Checking eligibility…</span>
                  </div>
                )}
              </div>
            )}
            {activeTab === "program" && progListings.length > 0 && (
              <div className="mb-4 rounded-xl border border-gray-200 bg-white p-3 shadow-sm">
                <MarketingFilters
                  listings={progListings}
                  programFilters={[]}
                  typeFilters={progTypeFilters}
                  chipFilters={chipFilters}
                  priceMin={priceMin}
                  priceMax={priceMax}
                  onProgramFilters={() => {}}
                  onTypeFilters={setProgTypeFilters}
                  onChipFilter={setChipFilters}
                  onPriceRange={(newMin, newMax) => { setPriceMin(newMin); setPriceMax(newMax); }}
                  hidePrograms
                />
                {progLoading && progListings.length > 0 && (
                  <div className="mt-2 flex items-center gap-1.5 text-xs text-red-600">
                    <LoadingSpinner size="sm" />
                    <span>Finding more matches…</span>
                  </div>
                )}
              </div>
            )}

            {/* ── Find Properties ── */}
            {activeTab === "find" && (
              <>
                {findSearch.loading && filteredFindListings.length === 0 && (
                  <div className="flex flex-col items-center gap-2 py-8">
                    <LoadingSpinner size="lg" />
                    <p className="text-sm text-gray-500">Fetching properties…</p>
                  </div>
                )}
                {filteredFindListings.length > 0 ? (
                  <MarketingTable
                    listings={filteredFindListings}
                    sortColumn={findSortCol}
                    sortDir={findSortDir}
                    onSort={handleFindSort}
                    onRowClick={openModal}
                  />
                ) : !findSearch.loading && findSearch.listings.length > 0 && (
                  <p className="py-12 text-center text-sm text-gray-400">No properties match your current filters.</p>
                )}
              </>
            )}

            {/* ── Search by Program ── */}
            {activeTab === "program" && (
              <>
                {progLoading && filteredProgListings.length === 0 && (
                  <div className="flex flex-col items-center gap-2 py-8">
                    <LoadingSpinner size="lg" />
                    <p className="text-sm text-gray-500">Fetching properties…</p>
                  </div>
                )}
                {filteredProgListings.length > 0 ? (
                  <MarketingTable
                    listings={filteredProgListings}
                    sortColumn={progSortCol}
                    sortDir={progSortDir}
                    onSort={handleProgSort}
                    onRowClick={openModal}
                  />
                ) : !progLoading && progListings.length > 0 && (
                  <p className="py-12 text-center text-sm text-gray-400">No properties match your current filters.</p>
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
      {followUpOpen && (
        <FollowUpDashboard
          onClose={() => { setFollowUpOpen(false); refreshFollowUpCount(); }}
        />
      )}
    </div>
  );
}

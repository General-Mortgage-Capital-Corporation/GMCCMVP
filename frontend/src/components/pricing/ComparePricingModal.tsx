"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import LoadingSpinner from "@/components/LoadingSpinner";
import { useAuth } from "@/contexts/AuthContext";
import { trackEvent } from "@/lib/posthog";
import { formatPrice } from "@/lib/utils";
import {
  buildScenario,
  summarizeScenario,
  validateScenario,
  type ScenarioInputs,
} from "@/lib/pricing/scenario";
import { loadScenarioInputs, saveScenarioInputs } from "@/lib/pricing/storage";
import type {
  EngineProgram,
  PricingResult,
  PricingScenario,
  QuoteApiResponse,
} from "@/types/pricing";

/**
 * Engines surfaced in the UI right now.
 *
 * Buy-Without-Sell ("bws") is temporarily hidden — leave the implementation
 * in place but don't request or render it. To re-enable, add "bws" back to
 * this list (and ideally re-test the new BWS per-variant response shape).
 */
const ENABLED_ENGINES: EngineProgram[] = ["loannex", "qm_jumbo"];
import type { RentCastListing } from "@/types";
import ScenarioForm from "./ScenarioForm";
import EngineResults from "./EngineResults";
import PricingChat from "./PricingChat";

interface Props {
  /** Property context — at minimum we need state, price, propertyType, county. */
  listing: Pick<
    RentCastListing,
    "state" | "price" | "propertyType" | "county" | "formattedAddress"
  > | null;
  onClose: () => void;
}

/**
 * Two-phase modal:
 *   - "scenario" phase: full-screen form, focus on inputs. Single CTA: Get quotes.
 *   - "results"  phase: compact summary bar + results + chat. "Edit scenario"
 *                       returns to scenario phase (with prior results stashed).
 */
type Phase = "scenario" | "results";

export default function ComparePricingModal({ listing, onClose }: Props) {
  const { user, signIn, getIdToken } = useAuth();
  const overlayRef = useRef<HTMLDivElement>(null);

  const [inputs, setInputs] = useState<ScenarioInputs>(() => loadScenarioInputs());
  useEffect(() => {
    saveScenarioInputs(inputs);
  }, [inputs]);

  const [phase, setPhase] = useState<Phase>("scenario");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<PricingResult[] | null>(null);
  const [submittedScenario, setSubmittedScenario] = useState<PricingScenario | null>(null);
  const [scenarioSummary, setScenarioSummary] = useState<string>("");
  const [defaultsApplied, setDefaultsApplied] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const draftScenario = useMemo(() => buildScenario(listing, inputs), [listing, inputs]);
  const validationError = useMemo(() => validateScenario(draftScenario), [draftScenario]);
  const hasResults = !!results;

  // ESC to close (doesn't fire while loading)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !loading) onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [loading, onClose]);

  const onOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === overlayRef.current && !loading) onClose();
    },
    [loading, onClose],
  );

  const handleSubmit = useCallback(async () => {
    if (validationError) {
      setError(validationError);
      return;
    }
    setLoading(true);
    setError(null);

    try {
      let idToken = await getIdToken();
      if (!idToken) {
        const fresh = await signIn();
        idToken = fresh.idToken;
      }
      if (!idToken) {
        setError("Sign-in required to compare pricing.");
        return;
      }

      trackEvent("pricing_quote_request", {
        state: draftScenario.state,
        loan_amount: draftScenario.loan_amount,
        loan_purpose: draftScenario.loan_purpose,
        occupancy: draftScenario.occupancy,
        doc_type: draftScenario.doc_type,
      });

      const res = await fetch("/api/pricing/quote", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          scenario: draftScenario,
          programs: ENABLED_ENGINES,
        }),
      });
      const data = (await res.json()) as QuoteApiResponse;
      if (!data.success) {
        setError(data.error);
        return;
      }
      setResults(data.results);
      setSubmittedScenario(draftScenario);
      setScenarioSummary(data.scenario_summary || summarizeScenario(draftScenario));
      setDefaultsApplied(data.defaults_applied ?? []);
      setPhase("results");
      trackEvent("pricing_quote_received", {
        eligible_count: data.results.filter((r) => r.status === "eligible").length,
        total_count: data.results.length,
      });
    } catch {
      setError("Could not reach the pricing service.");
    } finally {
      setLoading(false);
    }
  }, [draftScenario, getIdToken, signIn, validationError]);

  const headerSummary = listing?.formattedAddress
    ? `${listing.formattedAddress}${listing.price ? ` · ${formatPrice(listing.price)}` : ""}`
    : "Pricing comparison";

  return (
    <div
      ref={overlayRef}
      onClick={onOverlayClick}
      className="fixed inset-0 z-[60] flex items-center justify-center overflow-y-auto bg-black/60 p-3 backdrop-blur-sm sm:p-6"
    >
      <div className="relative my-auto flex max-h-[94vh] w-full max-w-7xl flex-col overflow-hidden rounded-2xl bg-slate-50 shadow-2xl">
        {/* ── Header ── */}
        <Header
          summary={headerSummary}
          phase={phase}
          onClose={onClose}
          loading={loading}
        />

        {phase === "scenario" ? (
          <ScenarioPhase
            inputs={inputs}
            onChange={setInputs}
            listingPrice={listing?.price ?? null}
            state={listing?.state ?? null}
            onSubmit={handleSubmit}
            onCancel={hasResults ? () => setPhase("results") : undefined}
            loading={loading}
            error={error}
            validationError={validationError}
            hasResults={hasResults}
            user={!!user}
          />
        ) : (
          <ResultsPhase
            scenarioSummary={scenarioSummary}
            results={results!}
            submittedScenario={submittedScenario!}
            defaultsApplied={defaultsApplied}
            enabledEngines={ENABLED_ENGINES}
            onEdit={() => {
              setError(null);
              setPhase("scenario");
            }}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header — shared across phases
// ---------------------------------------------------------------------------

function Header({
  summary,
  phase,
  loading,
  onClose,
}: {
  summary: string;
  phase: Phase;
  loading: boolean;
  onClose: () => void;
}) {
  return (
    <div className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-200 bg-white px-5 py-4">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-red-500 to-rose-600 text-white shadow-sm">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <path d="M6 2v12M10 2v12" stroke="currentColor" strokeWidth="1" strokeLinecap="round" opacity="0.5" />
            </svg>
          </div>
          <h2 className="truncate text-lg font-bold tracking-tight text-slate-900">
            Compare Pricing
          </h2>
          <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wider text-violet-700">
            Beta
          </span>
          <StepIndicator phase={phase} />
        </div>
        <p className="mt-0.5 truncate text-xs text-slate-500">{summary}</p>
      </div>
      <button
        onClick={onClose}
        disabled={loading}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500 transition-colors hover:bg-slate-200 disabled:opacity-50"
        aria-label="Close"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M12 4L4 12M4 4l8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

function StepIndicator({ phase }: { phase: Phase }) {
  return (
    <div className="ml-auto hidden items-center gap-1.5 text-[0.65rem] font-medium text-slate-400 sm:flex">
      <span className={phase === "scenario" ? "text-slate-900" : ""}>1. Scenario</span>
      <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
        <path d="M5 4l5 4-5 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className={phase === "results" ? "text-slate-900" : ""}>2. Results</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase 1: Scenario — full body, focused form
// ---------------------------------------------------------------------------

function ScenarioPhase({
  inputs,
  onChange,
  listingPrice,
  state,
  onSubmit,
  onCancel,
  loading,
  error,
  validationError,
  hasResults,
  user,
}: {
  inputs: ScenarioInputs;
  onChange: (next: ScenarioInputs) => void;
  listingPrice: number | null;
  state: string | null;
  onSubmit: () => void;
  onCancel?: () => void;
  loading: boolean;
  error: string | null;
  validationError: string | null;
  hasResults: boolean;
  user: boolean;
}) {
  return (
    <>
      {/* Form area — scrollable */}
      <div className="min-h-0 flex-1 overflow-y-auto bg-white px-5 py-4 sm:px-8 sm:py-6">
        <div className="mx-auto max-w-3xl">
          <div className="mb-4">
            <h3 className="text-base font-semibold text-slate-900">
              {hasResults ? "Edit scenario" : "Build the scenario"}
            </h3>
            <p className="mt-0.5 text-xs text-slate-500">
              {hasResults
                ? "Adjust any field and re-run to update quotes across all engines."
                : "We'll fan this out across Loannex and QM Jumbo. Defaults are conservative — change anything that doesn't match the borrower."}
            </p>
          </div>

          <ScenarioForm
            inputs={inputs}
            onChange={onChange}
            listingPrice={listingPrice}
            state={state}
          />

          {!user && !hasResults && (
            <p className="mt-4 inline-flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
                <path d="M8 5v3M8 11h.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              You&apos;ll be prompted to sign in when you click Get quotes.
            </p>
          )}
        </div>
      </div>

      {/* Footer — sticky CTA */}
      <div className="shrink-0 border-t border-slate-200 bg-white px-5 py-3 shadow-[0_-2px_4px_rgba(0,0,0,0.02)]">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            {validationError ? (
              <p className="text-xs text-rose-600">{validationError}</p>
            ) : error ? (
              <p className="text-xs text-rose-600">{error}</p>
            ) : (
              <p className="text-xs text-slate-500">
                {loading
                  ? "Pricing across engines… typically 2–5 seconds."
                  : "Ready to fan out across all programs."}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {onCancel && !loading && (
              <button
                onClick={onCancel}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50"
              >
                Cancel
              </button>
            )}
            <button
              onClick={onSubmit}
              disabled={loading || !!validationError}
              className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-br from-red-600 to-rose-600 px-5 py-2 text-sm font-semibold text-white shadow-sm transition-all hover:shadow-md disabled:opacity-50 disabled:shadow-none"
            >
              {loading ? (
                <>
                  <LoadingSpinner size="sm" />
                  <span>Pricing…</span>
                </>
              ) : (
                <>
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                    <path
                      d="M3 8l3 3 7-7"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <span>{hasResults ? "Re-run quotes" : "Get quotes"}</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Phase 2: Results — compact summary + results + chat
// ---------------------------------------------------------------------------

function ResultsPhase({
  scenarioSummary,
  results,
  submittedScenario,
  defaultsApplied,
  enabledEngines,
  onEdit,
}: {
  scenarioSummary: string;
  results: PricingResult[];
  submittedScenario: PricingScenario;
  defaultsApplied: string[];
  enabledEngines: EngineProgram[];
  onEdit: () => void;
}) {
  return (
    <>
      {/* ── Compact scenario summary bar ── */}
      <div className="shrink-0 border-b border-slate-200 bg-gradient-to-r from-slate-50 to-white px-5 py-2.5">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="text-[0.6rem] font-bold uppercase tracking-widest text-slate-400">
                Scenario
              </span>
              <span className="truncate text-xs font-medium text-slate-700">
                {scenarioSummary}
              </span>
            </div>
          </div>
          <button
            onClick={onEdit}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm transition-colors hover:border-red-300 hover:text-red-700"
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
              <path
                d="M11 2l3 3-9 9H2v-3L11 2z"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
            </svg>
            Edit scenario
          </button>
        </div>
      </div>

      {/* ── Disclaimer banner ── */}
      <PricingDisclaimer />

      {/* ── Body ── */}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <EngineResults
            results={results}
            defaultsApplied={defaultsApplied}
            enabledEngines={enabledEngines}
          />
        </div>

        <div className="min-h-[400px] shrink-0 border-t border-slate-200 lg:min-h-0 lg:w-[28rem] lg:border-l lg:border-t-0 lg:p-3">
          <div className="h-full p-3 lg:p-0">
            <PricingChat
              results={results}
              scenario={submittedScenario}
              scenarioSummary={scenarioSummary}
              defaultsApplied={defaultsApplied}
            />
          </div>
        </div>
      </div>
    </>
  );
}

// Beta + UW-review disclaimer. Always rendered above results to keep LOs
// from quoting these numbers as committed pricing.
function PricingDisclaimer() {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="shrink-0 border-b border-amber-200 bg-amber-50 px-5 py-2 text-xs leading-relaxed">
      <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-200/70 px-2 py-0.5 text-[0.6rem] font-bold uppercase tracking-wider text-amber-900">
          <svg width="9" height="9" viewBox="0 0 16 16" fill="none">
            <path d="M8 1L1 14h14L8 1z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            <path d="M8 6v3M8 11h.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          Beta
        </span>
        <span className="text-amber-900">
          Indicative pricing only. <strong className="font-semibold">Verify in Loannex / EPPS</strong> before quoting.
          Subject to underwriting review.
        </span>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="ml-auto whitespace-nowrap text-[0.7rem] font-medium text-amber-800 underline-offset-2 hover:underline"
        >
          {expanded ? "Hide details" : "More details"}
        </button>
      </div>
      {expanded && (
        <div className="mt-2 space-y-1 border-t border-amber-200 pt-2 text-[0.7rem] text-amber-900">
          <p>
            <strong className="font-semibold">Not a commitment to lend.</strong> Quotes shown are produced from
            current rate sheets and the scenario as entered. They do not guarantee approval, rate, or
            availability. All loans are subject to GMCC&apos;s underwriting guidelines, full credit review,
            appraisal, and verification of borrower information.
          </p>
          <p>
            <strong className="font-semibold">Verify before locking.</strong> Always re-price in Loannex,
            EPPS, or the program&apos;s authoritative rate sheet before delivering pricing to a borrower or
            realtor. Rates, points, and program eligibility change without notice and may not be reflected
            here in real time.
          </p>
          <p>
            <strong className="font-semibold">Defaults applied.</strong> Any field not explicitly set in the
            scenario form uses the aggregator&apos;s vanilla defaults (clean credit, no buydown, US citizen,
            etc.). Adjust the scenario to match the borrower&apos;s actual profile for accurate pricing.
          </p>
          <p className="text-amber-800">
            GMCC NMLS #2480 · Equal Housing Lender. Internal use only.
          </p>
        </div>
      )}
    </div>
  );
}


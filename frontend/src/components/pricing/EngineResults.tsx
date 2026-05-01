"use client";

import { useMemo, useState } from "react";
import type {
  EngineProgram,
  PricingResult,
  RateHeadline,
  RateRow,
  ResultEngine,
} from "@/types/pricing";

/**
 * Per-rule headline fallback when the aggregator doesn't supply one.
 * Plan section 6:
 *   1. Among rows priced at par or rebate (price >= 100), pick lowest rate.
 *   2. If every row would require points (price < 100), pick lowest cost.
 *   3. Tie-break by lowest rate.
 */
function deriveHeadline(rates: RateRow[] | undefined): RateHeadline | undefined {
  if (!rates || rates.length === 0) return undefined;
  const parOrRebate = rates.filter((r) => r.price >= 100);
  let pick: RateRow;
  if (parOrRebate.length > 0) {
    pick = parOrRebate.slice().sort((a, b) => a.rate - b.rate || a.cost_points - b.cost_points)[0];
  } else {
    pick = rates.slice().sort((a, b) => a.cost_points - b.cost_points || a.rate - b.rate)[0];
  }
  return {
    best_rate: pick.rate,
    best_points: pick.cost_points - pick.rebate_points,
    best_lock_days: pick.lock_days,
    in_target_band: pick.in_target_band,
  };
}

function effectiveHeadline(r: PricingResult): RateHeadline | undefined {
  return r.headline ?? deriveHeadline(r.rates);
}

interface Props {
  results: PricingResult[];
  defaultsApplied?: string[];
  /**
   * Which engines to render sections for. Engines NOT in this list are hidden
   * even if results contain rows for them. Defaults to all three.
   */
  enabledEngines?: EngineProgram[];
}

// Map UI program key → server-side engine name on result rows
const ENGINE_KEY: Record<EngineProgram, ResultEngine> = {
  loannex: "loannex",
  qm_jumbo: "gmcc_processor",
  bws: "bws",
};

// ---------------------------------------------------------------------------
// Top-level: split by engine, render each enabled section
// ---------------------------------------------------------------------------

export default function EngineResults({ results, defaultsApplied, enabledEngines }: Props) {
  const byEngine = useMemo(() => groupByEngine(results), [results]);
  const enabled = enabledEngines ?? (["loannex", "qm_jumbo", "bws"] as EngineProgram[]);
  const isOn = (key: EngineProgram) => enabled.includes(key);

  return (
    <div className="space-y-6">
      {defaultsApplied && defaultsApplied.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <strong className="mr-1 font-semibold">Assumed defaults:</strong>
          {humanizeDefaults(defaultsApplied).join(", ")}
        </div>
      )}

      {isOn("loannex") && (
        <EngineSection
          title="Loannex"
          subtitle="Onyx, DSCR, Easy Choice, etc."
          rows={byEngine[ENGINE_KEY.loannex]}
        />
      )}
      {isOn("qm_jumbo") && (
        <EngineSection
          title="QM Jumbo"
          subtitle="Thunder, Jubilant, Fabulous"
          rows={byEngine[ENGINE_KEY.qm_jumbo]}
        />
      )}
      {isOn("bws") && (
        <EngineSection
          title="Buy-Without-Sell"
          subtitle="Cronus, Onyx, Poseidon"
          rows={byEngine[ENGINE_KEY.bws]}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Engine section — every engine now uses the same family-grouped renderer.
// Loannex always had per-variant rows. As of the recent MLO portal aggregator
// update, BWS does too (Cronus Jumbo — 30Y Fixed, — 5/6 SOFR ARM, etc.).
// QM Jumbo still returns 1 row per program (no em-dash, single-variant
// family) — the GroupedView handles this gracefully by rendering single-
// variant families as ResultCards directly, no nesting.
// ---------------------------------------------------------------------------

function EngineSection({
  title,
  subtitle,
  rows,
}: {
  title: string;
  subtitle: string;
  rows: PricingResult[];
}) {
  if (rows.length === 0) {
    return (
      <section>
        <SectionHeader title={title} subtitle={subtitle} count={0} />
        <p className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm italic text-slate-400">
          No results from this engine.
        </p>
      </section>
    );
  }

  const eligible = rows.filter((r) => r.status === "eligible");
  const ineligible = rows.filter((r) => r.status === "ineligible");
  const errors = rows.filter((r) => r.status === "error");

  return (
    <section>
      <SectionHeader title={title} subtitle={subtitle} count={eligible.length} />
      <div className="space-y-2">
        <GroupedView rows={eligible} />
        {ineligible.length > 0 && <IneligibleList rows={ineligible} />}
        {errors.length > 0 && <ErrorList rows={errors} />}
      </div>
    </section>
  );
}

function SectionHeader({
  title,
  subtitle,
  count,
}: {
  title: string;
  subtitle: string;
  count: number;
}) {
  return (
    <div className="mb-2 flex items-end justify-between gap-3 border-b border-slate-200 pb-2">
      <div>
        <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
        <p className="text-xs text-slate-500">{subtitle}</p>
      </div>
      {count > 0 && (
        <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[0.65rem] font-semibold text-emerald-700">
          {count} eligible
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Engine-agnostic grouped view — handles 1-or-many variants per family.
// Single-variant families render as direct ResultCards (1-click to ladder).
// Multi-variant families render as expandable group cards.
// ---------------------------------------------------------------------------

interface FamilyGroup {
  family: string;
  rows: PricingResult[];
}

function splitProgramName(name: string): { family: string; product: string } {
  // Common separators: " — " (em dash with spaces), " - " (hyphen with spaces).
  // We grab the LAST separator so that "Easy Choice - Full Documentation — 5/6 ARM"
  // groups under "Easy Choice - Full Documentation".
  const emdash = name.lastIndexOf(" — ");
  if (emdash > -1) {
    return { family: name.slice(0, emdash).trim(), product: name.slice(emdash + 3).trim() };
  }
  // Fall back to hyphen ONLY if it appears more than once (otherwise it's part of the family name)
  const parts = name.split(" - ");
  if (parts.length > 2) {
    const product = parts[parts.length - 1].trim();
    const family = parts.slice(0, -1).join(" - ").trim();
    return { family, product };
  }
  return { family: name, product: "" };
}

/**
 * Map a free-form product description to a canonical chip label.
 * Handles both Loannex-style ("5/6 ARM (30 Yr. Term)", "30Y Fixed")
 * and BWS-style names ("5/6 SOFR ARM Non-Agency", "30-Year Fixed Non-Agency").
 *
 * The ARM patterns use `[^/]*` between the fraction and "arm" so we only
 * cross intervening words like "SOFR" and never another fraction.
 */
function detectProductChip(productLabel: string): string {
  const p = productLabel.toLowerCase();
  // ARM tenors — order matters so "10/6" doesn't get caught by a more
  // permissive pattern. `[^/]*` keeps us within one term.
  if (/3\/6[^/]*arm/i.test(p)) return "3/6 ARM";
  if (/5\/6[^/]*arm/i.test(p)) return "5/6 ARM";
  if (/7\/6[^/]*arm/i.test(p)) return "7/6 ARM";
  if (/10\/6[^/]*arm/i.test(p)) return "10/6 ARM";
  // Fixed tenors — accept "30Y", "30-Year", "30 Year", "30Yr", "30 Yr"
  if (/\b30[\s-]?y(?:ear|r)?(?:s)?[\s-]+fixed/i.test(p)) return "30Y Fixed";
  if (/\b15[\s-]?y(?:ear|r)?(?:s)?[\s-]+fixed/i.test(p)) return "15Y Fixed";
  if (/\b20[\s-]?y(?:ear|r)?(?:s)?[\s-]+fixed/i.test(p)) return "20Y Fixed";
  if (/\b10[\s-]?y(?:ear|r)?(?:s)?[\s-]+fixed/i.test(p)) return "10Y Fixed";
  if (/\b40[\s-]?y(?:ear|r)?(?:s)?[\s-]+fixed/i.test(p)) return "40Y Fixed";
  // DSCR programs (Poseidon, etc.)
  if (/dscr/i.test(p)) return "DSCR";
  // Fallbacks
  if (p.includes("arm")) return "ARM (other)";
  if (p.includes("fixed")) return "Fixed (other)";
  return "Other";
}

function GroupedView({ rows }: { rows: PricingResult[] }) {
  const [productFilter, setProductFilter] = useState<string | null>(null);
  const [openFamily, setOpenFamily] = useState<string | null>(null);

  const { groups, productChips } = useMemo(() => {
    const map = new Map<string, FamilyGroup>();
    const chipSet = new Set<string>();
    for (const row of rows) {
      const { family, product } = splitProgramName(row.program);
      const chip = detectProductChip(product || row.program);
      chipSet.add(chip);
      if (productFilter && chip !== productFilter) continue;
      if (!map.has(family)) map.set(family, { family, rows: [] });
      map.get(family)!.rows.push(row);
    }
    // Sort each family by best rate ascending
    const sorted = Array.from(map.values()).map((g) => ({
      ...g,
      rows: g.rows.slice().sort((a, b) => bestRateOf(a) - bestRateOf(b)),
    }));
    sorted.sort((a, b) => bestRateOf(a.rows[0]) - bestRateOf(b.rows[0]));
    return { groups: sorted, productChips: Array.from(chipSet).sort() };
  }, [rows, productFilter]);

  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm italic text-slate-400">
        No eligible programs.
      </p>
    );
  }

  // Show product filter only when there's more than one chip AND at least one
  // family has multiple variants. For QM-style 1-row programs the filter is
  // noise — every row would be its own chip and filtering by it shows just
  // that row, which is identical to clicking the row directly.
  const showFilter =
    productChips.length > 1 && groups.some((g) => g.rows.length > 1);

  return (
    <div>
      {showFilter && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          <span className="text-[0.65rem] font-semibold uppercase tracking-widest text-slate-400">
            Filter by product
          </span>
          <Chip
            active={productFilter === null}
            onClick={() => setProductFilter(null)}
          >
            All
          </Chip>
          {productChips.map((chip) => (
            <Chip
              key={chip}
              active={productFilter === chip}
              onClick={() => setProductFilter(chip === productFilter ? null : chip)}
            >
              {chip}
            </Chip>
          ))}
        </div>
      )}

      <div className="space-y-2">
        {groups.map((group) => {
          // Single-variant family → render flat ResultCard (one click to ladder).
          // Applies to QM Jumbo (Thunder/Jubilant/Fabulous) and any program
          // that's fully ineligible at the program level.
          if (group.rows.length === 1) {
            return <ResultCard key={group.family} result={group.rows[0]} />;
          }

          const isOpen = openFamily === group.family;
          const best = group.rows[0];
          const bestHead = effectiveHeadline(best);
          const variantCount = group.rows.length;

          return (
            <div
              key={group.family}
              className="overflow-hidden rounded-lg border border-slate-200 bg-white transition-shadow hover:shadow-sm"
            >
              <button
                onClick={() => setOpenFamily(isOpen ? null : group.family)}
                className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-slate-50"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-semibold text-slate-900">
                      {group.family}
                    </span>
                    <ProductChip label={detectProductChip(splitProgramName(best.program).product || best.program)} />
                    <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[0.6rem] font-medium text-slate-600">
                      {variantCount} {variantCount === 1 ? "variant" : "variants"}
                    </span>
                  </div>
                  <div className="mt-0.5 truncate text-[0.7rem] text-slate-500">
                    Best of family: <span className="text-slate-700">{splitProgramName(best.program).product || best.program}</span>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {bestHead && (
                    <div className="text-right">
                      <div className="text-base font-bold tabular-nums text-slate-900">
                        {bestHead.best_rate.toFixed(3)}
                        <span className="text-xs font-medium text-slate-500">%</span>
                      </div>
                      <div className="text-[0.65rem] text-slate-500 tabular-nums">
                        {fmtPoints(bestHead.best_points)} · {bestHead.best_lock_days}d
                      </div>
                    </div>
                  )}
                  <ChevronIcon open={isOpen} />
                </div>
              </button>

              {isOpen && (
                <div className="border-t border-slate-100 bg-slate-50/40 p-3">
                  <div className="space-y-1.5">
                    {group.rows.map((r) => (
                      <LoannexRowDetail key={r.program} result={r} />
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function LoannexRowDetail({ result }: { result: PricingResult }) {
  const [showLadder, setShowLadder] = useState(false);
  const { product } = splitProgramName(result.program);
  const productChip = detectProductChip(product || result.program);
  const head = effectiveHeadline(result);

  return (
    <div className="rounded-md border border-slate-200 bg-white">
      <button
        onClick={() => setShowLadder((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-slate-50"
      >
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <ProductChip label={productChip} />
          <span className="truncate text-xs text-slate-600">
            {product || result.program}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {head && (
            <span className="text-xs font-semibold tabular-nums text-slate-900">
              {head.best_rate.toFixed(3)}% · {fmtPoints(head.best_points)}
            </span>
          )}
          <span className="text-[0.65rem] font-medium text-violet-600">
            {showLadder ? "Hide" : "Rates →"}
          </span>
        </div>
      </button>
      {showLadder && result.rates && result.rates.length > 0 && (
        <RateLadder rates={result.rates} />
      )}
    </div>
  );
}

function ProductChip({ label }: { label: string }) {
  // Color-code by family — ARM = blue, Fixed = slate, Other = neutral
  const isArm = /arm/i.test(label);
  const isFixed = /fixed/i.test(label);
  const cls = isArm
    ? "border-blue-200 bg-blue-50 text-blue-700"
    : isFixed
      ? "border-indigo-200 bg-indigo-50 text-indigo-700"
      : "border-slate-200 bg-slate-50 text-slate-600";
  return (
    <span
      className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[0.6rem] font-bold uppercase tracking-wider ${cls}`}
    >
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Generic eligible card — used by QM Jumbo and BWS
// ---------------------------------------------------------------------------

function ResultCard({ result }: { result: PricingResult }) {
  const [showLadder, setShowLadder] = useState(false);
  const head = effectiveHeadline(result);
  const headlineWasDerived = !result.headline && !!head;

  // Plan section 7: BWS conditions are amber (not red). Stale rate sheet is
  // visible warning at 2+ days; 1 day stale is normal weekend behavior.
  const stale = result.stale_days != null && result.stale_days >= 2;
  const conditions = result.conditions ?? [];
  const hasRates = (result.rates?.length ?? 0) > 0;

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white transition-shadow hover:shadow-sm">
      <button
        onClick={() => hasRates && setShowLadder((v) => !v)}
        disabled={!hasRates}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-slate-50 disabled:cursor-default disabled:hover:bg-white"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-slate-900">{result.program}</span>
            {head?.in_target_band && (
              <span className="rounded-full bg-emerald-50 px-1.5 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wider text-emerald-700">
                Target band
              </span>
            )}
            {stale && (
              <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wider text-amber-800">
                {result.stale_days}d stale
              </span>
            )}
          </div>
          {stale && result.rate_sheet_as_of && (
            <div className="mt-1 text-[0.7rem] text-amber-700">
              Rate sheet last updated {result.rate_sheet_as_of}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {head ? (
            <div className="text-right">
              <div className="text-lg font-bold tabular-nums text-slate-900">
                {head.best_rate.toFixed(3)}
                <span className="text-xs font-medium text-slate-500">%</span>
              </div>
              <div className="text-[0.65rem] tabular-nums text-slate-500">
                {fmtPoints(head.best_points)} · {head.best_lock_days}d
                {headlineWasDerived && (
                  <span className="ml-1 text-slate-400" title="Headline computed locally from rate ladder">
                    *
                  </span>
                )}
              </div>
            </div>
          ) : (
            <span className="text-xs italic text-slate-400">No rate ladder</span>
          )}
          {hasRates && <ChevronIcon open={showLadder} />}
        </div>
      </button>
      {conditions.length > 0 && (
        <div className="border-t border-amber-100 bg-amber-50/40 px-4 py-2">
          <div className="mb-1 text-[0.6rem] font-bold uppercase tracking-widest text-amber-700">
            Conditions ({conditions.length})
          </div>
          <ul className="list-inside list-disc space-y-0.5 text-[0.7rem] leading-relaxed text-amber-900">
            {conditions.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      )}
      {showLadder && hasRates && <RateLadder rates={result.rates!} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rate ladder table
// ---------------------------------------------------------------------------

const RELEVANT_RATE_COUNT = 5;

/**
 * Picks the most LO-relevant rates: par-or-rebate rows first (those are what
 * a borrower would actually shop at), then fill from the lowest-cost rows.
 * Returns indices into the rate-sorted array so we can highlight which were
 * shown by default vs. expanded.
 */
function pickRelevantRates(rates: RateRow[], limit: number): RateRow[] {
  const sorted = rates.slice().sort((a, b) => a.rate - b.rate);
  const parOrRebate = sorted.filter((r) => r.price >= 100);
  if (parOrRebate.length >= limit) return parOrRebate.slice(0, limit);
  // Fill the rest from the cheapest cost rows that aren't already in the par list
  const seen = new Set(parOrRebate);
  const cheapestCost = sorted
    .filter((r) => !seen.has(r))
    .sort((a, b) => a.cost_points - b.cost_points || a.rate - b.rate);
  return [...parOrRebate, ...cheapestCost.slice(0, limit - parOrRebate.length)]
    .sort((a, b) => a.rate - b.rate);
}

function RateLadder({ rates }: { rates: RateRow[] }) {
  const [showAll, setShowAll] = useState(false);
  const sorted = useMemo(() => rates.slice().sort((a, b) => a.rate - b.rate), [rates]);
  const relevant = useMemo(() => pickRelevantRates(rates, RELEVANT_RATE_COUNT), [rates]);
  const visible = showAll ? sorted : relevant;
  const hiddenCount = sorted.length - relevant.length;

  return (
    <div className="border-t border-slate-100">
      {!showAll && hiddenCount > 0 && (
        <div className="border-b border-slate-100 bg-slate-50/60 px-3 py-1.5 text-[0.65rem] text-slate-500">
          Showing {relevant.length} most relevant of {sorted.length} rates (par or rebate prioritized).
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-[0.65rem] font-semibold uppercase tracking-widest text-slate-500">
            <tr>
              <th className="px-3 py-1.5 text-left">Rate</th>
              <th className="px-3 py-1.5 text-right">Price</th>
              <th className="px-3 py-1.5 text-right">Cost / Rebate</th>
              <th className="px-3 py-1.5 text-right">Lock</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r, i) => (
              <tr
                key={i}
                className={`border-t border-slate-100 tabular-nums ${
                  r.in_target_band ? "bg-emerald-50/40" : "bg-white"
                }`}
              >
                <td className="px-3 py-1.5 font-semibold text-slate-900">
                  {r.rate.toFixed(3)}%
                </td>
                <td className="px-3 py-1.5 text-right text-slate-700">{r.price.toFixed(3)}</td>
                <td
                  className={`px-3 py-1.5 text-right ${
                    r.cost_points > 0
                      ? "text-rose-700"
                      : r.rebate_points > 0
                        ? "text-emerald-700"
                        : "text-slate-500"
                  }`}
                >
                  {fmtRowPoints(r)}
                </td>
                <td className="px-3 py-1.5 text-right text-slate-700">{r.lock_days}d</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hiddenCount > 0 && (
        <div className="border-t border-slate-100 bg-slate-50/40 px-3 py-1.5 text-right">
          <button
            onClick={() => setShowAll((v) => !v)}
            className="text-[0.7rem] font-medium text-violet-600 transition-colors hover:text-violet-800"
          >
            {showAll ? `Show top ${RELEVANT_RATE_COUNT} only` : `Show all ${sorted.length} rates →`}
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ineligible / error groups
// ---------------------------------------------------------------------------

function IneligibleList({ rows }: { rows: PricingResult[] }) {
  return (
    <details className="rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2">
      <summary className="cursor-pointer text-xs font-medium text-slate-600">
        Ineligible ({rows.length})
      </summary>
      <ul className="mt-2 space-y-1 text-xs">
        {rows.map((r) => (
          <li key={r.program} className="rounded-md bg-white px-2.5 py-1.5">
            <div className="font-medium text-slate-700">{r.program}</div>
            <ul className="mt-0.5 list-inside list-disc text-slate-500">
              {(r.reasons ?? ["Not eligible"]).map((reason, i) => (
                <li key={i}>{reason}</li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </details>
  );
}

function ErrorList({ rows }: { rows: PricingResult[] }) {
  return (
    <div className="space-y-1.5">
      {rows.map((r) => {
        const isAccount = r.error_code === "no_loannex_account";
        return (
          <div
            key={r.program}
            className={`rounded-lg border px-3 py-2 text-xs ${
              isAccount
                ? "border-amber-300 bg-amber-50 text-amber-900"
                : "border-rose-200 bg-rose-50 text-rose-900"
            }`}
          >
            <div className="font-semibold">{r.program}</div>
            <div className="mt-0.5">{r.error_message ?? "Unknown error"}</div>
            {isAccount && (
              <div className="mt-1 text-[0.7rem] italic">
                Action: email Jarrad to get provisioned in Loannex.
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function groupByEngine(results: PricingResult[]): Record<ResultEngine, PricingResult[]> {
  const out: Record<ResultEngine, PricingResult[]> = {
    loannex: [],
    gmcc_processor: [],
    bws: [],
  };
  for (const r of results) {
    // Use Object.hasOwn to avoid prototype-pollution attacks via untrusted
    // engine names (e.g. "toString", "constructor").
    if (Object.hasOwn(out, r.engine)) out[r.engine].push(r);
  }
  return out;
}

function bestRateOf(r: PricingResult): number {
  return effectiveHeadline(r)?.best_rate ?? Number.POSITIVE_INFINITY;
}

/**
 * Borrower-perspective sign convention:
 *   rebate (money TO borrower) = positive sign  → "+0.250% rebate"
 *   cost   (money OUT of pocket) = negative sign → "-0.250% cost"
 *   par                                          → "par"
 *
 * `best_points` field uses internal semantics where positive = cost; we flip
 * the display sign here.
 */
function fmtPoints(p: number): string {
  if (Math.abs(p) < 0.0005) return "par";
  if (p > 0) return `-${p.toFixed(3)}% cost`;
  return `+${(-p).toFixed(3)}% rebate`;
}

/** Per-rate-row formatter using cost_points / rebate_points fields directly. */
function fmtRowPoints(r: RateRow): string {
  if (r.cost_points > 0) return `-${r.cost_points.toFixed(3)}% cost`;
  if (r.rebate_points > 0) return `+${r.rebate_points.toFixed(3)}% rebate`;
  return "par";
}

function humanizeDefaults(defaults: string[]): string[] {
  // "credit_event" → "Credit event", "first_time_homebuyer" → "First time homebuyer"
  return defaults.map((d) => {
    const spaced = d.replace(/_/g, " ");
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
  });
}

// ---------------------------------------------------------------------------
// Tiny presentational components
// ---------------------------------------------------------------------------

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-2.5 py-0.5 text-[0.7rem] font-medium transition-colors ${
        active
          ? "border-red-300 bg-red-50 text-red-700"
          : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
      }`}
    >
      {children}
    </button>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      className={`shrink-0 text-slate-400 transition-transform ${open ? "rotate-90" : ""}`}
      fill="none"
    >
      <path d="M5 4l5 4-5 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

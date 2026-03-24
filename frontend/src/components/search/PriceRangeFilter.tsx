"use client";

import { useCallback, useMemo, useRef, useState, useEffect } from "react";
import { formatPrice } from "@/lib/utils";

interface PriceRangeFilterProps {
  /** All listing prices (unfiltered) to build the histogram */
  prices: number[];
  /** Current min bound (null = no min filter) */
  min: number | null;
  /** Current max bound (null = no max filter) */
  max: number | null;
  /** Called when the user finishes dragging or types a value */
  onChange: (min: number | null, max: number | null) => void;
}

const BUCKET_COUNT = 40;

export default function PriceRangeFilter({
  prices,
  min,
  max,
  onChange,
}: PriceRangeFilterProps) {
  const validPrices = useMemo(() => prices.filter((p) => p > 0).sort((a, b) => a - b), [prices]);
  const dataMin = validPrices[0] ?? 0;
  const dataMax = validPrices[validPrices.length - 1] ?? 1_000_000;
  // Add 1% padding so handles don't sit right at the edge
  const rangeMin = Math.floor(dataMin * 0.95);
  const rangeMax = Math.ceil(dataMax * 1.05);
  const range = rangeMax - rangeMin || 1;

  // Local slider state (updates live while dragging, commits on mouseup)
  const [localMin, setLocalMin] = useState<number>(min ?? rangeMin);
  const [localMax, setLocalMax] = useState<number>(max ?? rangeMax);
  const [dragging, setDragging] = useState<"min" | "max" | null>(null);

  // Sync with external changes
  useEffect(() => { setLocalMin(min ?? rangeMin); }, [min, rangeMin]);
  useEffect(() => { setLocalMax(max ?? rangeMax); }, [max, rangeMax]);

  // Build histogram buckets
  const buckets = useMemo(() => {
    const bks = new Array(BUCKET_COUNT).fill(0) as number[];
    const bucketWidth = range / BUCKET_COUNT;
    for (const p of validPrices) {
      const idx = Math.min(Math.floor((p - rangeMin) / bucketWidth), BUCKET_COUNT - 1);
      bks[idx]++;
    }
    return bks;
  }, [validPrices, rangeMin, range]);

  const maxBucket = Math.max(...buckets, 1);

  // Percentage helpers
  const toPercent = (val: number) => Math.max(0, Math.min(100, ((val - rangeMin) / range) * 100));
  const fromPercent = (pct: number) => rangeMin + (pct / 100) * range;

  const minPct = toPercent(localMin);
  const maxPct = toPercent(localMax);

  // Slider track ref for pointer position calculation
  const trackRef = useRef<HTMLDivElement>(null);

  const getPercentFromPointer = useCallback((clientX: number) => {
    if (!trackRef.current) return 0;
    const rect = trackRef.current.getBoundingClientRect();
    return Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
  }, []);

  // Mouse/touch handlers
  const handlePointerDown = useCallback((handle: "min" | "max") => (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(handle);
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging) return;
    const pct = getPercentFromPointer(e.clientX);
    const val = Math.round(fromPercent(pct));
    if (dragging === "min") {
      setLocalMin(Math.min(val, localMax - 1000));
    } else {
      setLocalMax(Math.max(val, localMin + 1000));
    }
  }, [dragging, getPercentFromPointer, fromPercent, localMin, localMax]);

  const handlePointerUp = useCallback(() => {
    if (!dragging) return;
    setDragging(null);
    // Commit — only set filter if actually restricting the range
    const newMin = localMin <= rangeMin + range * 0.02 ? null : localMin;
    const newMax = localMax >= rangeMax - range * 0.02 ? null : localMax;
    onChange(newMin, newMax);
  }, [dragging, localMin, localMax, rangeMin, rangeMax, range, onChange]);

  // Hover tooltip state
  const [hoveredBucket, setHoveredBucket] = useState<number | null>(null);

  // Bucket price range for tooltip
  const bucketWidth = range / BUCKET_COUNT;
  const getBucketRange = (i: number) => ({
    lo: Math.round(rangeMin + i * bucketWidth),
    hi: Math.round(rangeMin + (i + 1) * bucketWidth),
  });

  // Check if filter is active
  const isFiltered = min != null || max != null;

  if (validPrices.length < 2) return null;

  return (
    <div className="w-full">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[0.7rem] font-semibold uppercase tracking-wider text-gray-400">Price Range</span>
        {isFiltered && (
          <button
            onClick={() => onChange(null, null)}
            className="text-[0.65rem] font-medium text-red-500 hover:text-red-700"
          >
            Reset
          </button>
        )}
      </div>

      {/* Price labels */}
      <div className="mb-1 flex items-center justify-between text-xs font-medium text-gray-700">
        <span>{formatPrice(localMin)}</span>
        <span>{formatPrice(localMax)}</span>
      </div>

      {/* Histogram + Slider */}
      <div
        ref={trackRef}
        className="relative select-none"
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
      >
        {/* Histogram bars */}
        <div
          className="flex h-10 items-end gap-px"
          onMouseLeave={() => setHoveredBucket(null)}
        >
          {buckets.map((count, i) => {
            const bucketLeft = (i / BUCKET_COUNT) * 100;
            const bucketRight = ((i + 1) / BUCKET_COUNT) * 100;
            const inRange = bucketRight >= minPct && bucketLeft <= maxPct;
            const heightPct = count > 0 ? Math.max(8, (count / maxBucket) * 100) : 0;
            const isHovered = hoveredBucket === i;

            return (
              <div
                key={i}
                className="relative flex-1 rounded-t-sm transition-colors duration-150"
                style={{
                  height: `${heightPct}%`,
                  backgroundColor: isHovered
                    ? inRange ? "rgb(220 38 38 / 0.75)" : "rgb(156 163 175)"
                    : inRange
                      ? count > 0 ? "rgb(220 38 38 / 0.5)" : "rgb(220 38 38 / 0.1)"
                      : count > 0 ? "rgb(229 231 235)" : "transparent",
                }}
                onMouseEnter={() => count > 0 ? setHoveredBucket(i) : setHoveredBucket(null)}
                onClick={() => count > 0 ? setHoveredBucket(hoveredBucket === i ? null : i) : setHoveredBucket(null)}
              >
                {/* Tooltip */}
                {isHovered && count > 0 && (
                  <div className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-1.5 -translate-x-1/2 whitespace-nowrap rounded-md bg-gray-900 px-2 py-1 text-[0.65rem] font-medium text-white shadow-lg">
                    <div>{formatPrice(getBucketRange(i).lo)} – {formatPrice(getBucketRange(i).hi)}</div>
                    <div className="text-gray-300">{count} {count === 1 ? "property" : "properties"}</div>
                    <div className="absolute left-1/2 top-full -translate-x-1/2 border-4 border-transparent border-t-gray-900" />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Slider track */}
        <div className="relative mt-0 h-1.5 rounded-full bg-gray-200">
          {/* Active range highlight */}
          <div
            className="absolute top-0 h-full rounded-full bg-red-500"
            style={{ left: `${minPct}%`, width: `${maxPct - minPct}%` }}
          />

          {/* Min handle */}
          <div
            className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full border-2 border-red-500 bg-white shadow-md transition-shadow ${
              dragging === "min" ? "z-20 scale-110 shadow-lg ring-2 ring-red-200" : "z-10 hover:shadow-lg"
            }`}
            style={{ left: `${minPct}%`, width: 22, height: 22 }}
            onPointerDown={handlePointerDown("min")}
          />

          {/* Max handle */}
          <div
            className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full border-2 border-red-500 bg-white shadow-md transition-shadow ${
              dragging === "max" ? "z-20 scale-110 shadow-lg ring-2 ring-red-200" : "z-10 hover:shadow-lg"
            }`}
            style={{ left: `${maxPct}%`, width: 22, height: 22 }}
            onPointerDown={handlePointerDown("max")}
          />
        </div>
      </div>
    </div>
  );
}

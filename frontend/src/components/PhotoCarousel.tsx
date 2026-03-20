"use client";

import { useCallback, useState } from "react";

interface PhotoCarouselProps {
  photos: string[];
  loading?: boolean;
  error?: string;
  /** Called when user clicks a photo to use it as the flyer image */
  onSelectForFlyer?: (photoUrl: string) => void;
  /** Whether a flyer image is already set (user-uploaded or auto-selected) */
  hasPropertyImage?: boolean;
}

export default function PhotoCarousel({
  photos,
  loading,
  error,
  onSelectForFlyer,
  hasPropertyImage,
}: PhotoCarouselProps) {
  const [current, setCurrent] = useState(0);
  const [imgErrors, setImgErrors] = useState<Set<number>>(new Set());

  const validPhotos = photos.filter((_, i) => !imgErrors.has(i));
  const validIndices = photos
    .map((_, i) => i)
    .filter((i) => !imgErrors.has(i));

  const currentValidIdx = validIndices.indexOf(current);
  const effectiveIdx = currentValidIdx >= 0 ? currentValidIdx : 0;
  const effectiveCurrent = validIndices[effectiveIdx] ?? 0;

  const goNext = useCallback(() => {
    if (validIndices.length <= 1) return;
    const nextIdx = (effectiveIdx + 1) % validIndices.length;
    setCurrent(validIndices[nextIdx]);
  }, [effectiveIdx, validIndices]);

  const goPrev = useCallback(() => {
    if (validIndices.length <= 1) return;
    const prevIdx = (effectiveIdx - 1 + validIndices.length) % validIndices.length;
    setCurrent(validIndices[prevIdx]);
  }, [effectiveIdx, validIndices]);

  const handleImgError = useCallback((idx: number) => {
    setImgErrors((prev) => new Set(prev).add(idx));
  }, []);

  // Loading skeleton
  if (loading) {
    return (
      <div className="relative h-56 w-full animate-pulse rounded-t-xl bg-gray-200 sm:h-64">
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="flex flex-col items-center gap-2 text-gray-400">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <path d="M21 15l-5-5L5 21" />
            </svg>
            <span className="text-xs">Loading photos...</span>
          </div>
        </div>
      </div>
    );
  }

  // No photos or error
  if (error || validPhotos.length === 0) {
    return null; // Don't show anything if no photos available
  }

  return (
    <div className="group relative h-56 w-full overflow-hidden rounded-t-xl bg-gray-900 sm:h-64">
      {/* Current photo */}
      <img
        key={effectiveCurrent}
        src={photos[effectiveCurrent]}
        alt={`Property photo ${effectiveIdx + 1} of ${validPhotos.length}`}
        className="h-full w-full object-cover transition-opacity duration-300"
        onError={() => handleImgError(effectiveCurrent)}
      />

      {/* Photo counter badge */}
      {validPhotos.length > 1 && (
        <div className="absolute bottom-3 left-3 rounded-full bg-black/60 px-2.5 py-1 text-xs font-medium text-white backdrop-blur-sm">
          {effectiveIdx + 1} / {validPhotos.length}
        </div>
      )}

      {/* Use for flyer button */}
      {onSelectForFlyer && !hasPropertyImage && (
        <button
          onClick={() => onSelectForFlyer(photos[effectiveCurrent])}
          className="absolute bottom-3 right-3 rounded-md bg-black/60 px-2.5 py-1.5 text-xs font-medium text-white backdrop-blur-sm transition-colors hover:bg-black/80"
          title="Use this photo for the flyer"
        >
          <span className="flex items-center gap-1">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <rect x="1" y="3" width="14" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
              <circle cx="5.5" cy="7.5" r="1.5" stroke="currentColor" strokeWidth="1.2" />
              <path d="M1 11l4-3 3 2.5 2.5-2 4.5 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
            </svg>
            Use for Flyer
          </span>
        </button>
      )}

      {/* Navigation arrows (visible on hover or always on mobile) */}
      {validPhotos.length > 1 && (
        <>
          <button
            onClick={goPrev}
            className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-1.5 text-white opacity-100 backdrop-blur-sm transition-opacity hover:bg-black/70 sm:opacity-0 sm:group-hover:opacity-100"
            aria-label="Previous photo"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            onClick={goNext}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-1.5 text-white opacity-100 backdrop-blur-sm transition-opacity hover:bg-black/70 sm:opacity-0 sm:group-hover:opacity-100"
            aria-label="Next photo"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </>
      )}

      {/* Dot indicators (for small numbers of photos) */}
      {validPhotos.length > 1 && validPhotos.length <= 10 && (
        <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 gap-1.5">
          {validIndices.map((idx, i) => (
            <button
              key={idx}
              onClick={() => setCurrent(idx)}
              className={`h-1.5 rounded-full transition-all ${
                i === effectiveIdx
                  ? "w-4 bg-white"
                  : "w-1.5 bg-white/50 hover:bg-white/75"
              }`}
              aria-label={`Go to photo ${i + 1}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}

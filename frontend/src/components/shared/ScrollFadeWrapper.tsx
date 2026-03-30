"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Wraps a horizontally-scrollable container with:
 * 1. Custom red scrollbars at top and bottom (always visible when content overflows)
 * 2. A strong right-edge fade gradient when more content exists
 * 3. A "scroll for more" hint that disappears after first scroll
 */
export default function ScrollFadeWrapper({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const topTrackRef = useRef<HTMLDivElement>(null);
  const bottomTrackRef = useRef<HTMLDivElement>(null);
  const [showRight, setShowRight] = useState(false);
  const [hasScrolled, setHasScrolled] = useState(false);
  const [canScroll, setCanScroll] = useState(false);
  const [thumbRatio, setThumbRatio] = useState(0);
  const [thumbLeft, setThumbLeft] = useState(0);
  const dragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartScroll = useRef(0);

  const sync = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const overflows = el.scrollWidth > el.clientWidth + 2;
    setCanScroll(overflows);
    setShowRight(el.scrollWidth - el.scrollLeft - el.clientWidth > 2);
    if (el.scrollLeft > 5) setHasScrolled(true);
    if (overflows) {
      const ratio = el.clientWidth / el.scrollWidth;
      setThumbRatio(ratio);
      const scrollFraction = el.scrollLeft / (el.scrollWidth - el.clientWidth);
      setThumbLeft(scrollFraction * (1 - ratio));
    }
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Initial sync + delayed re-check for late-rendering content
    sync();
    const t = setTimeout(sync, 100);
    el.addEventListener("scroll", sync, { passive: true });
    // Observe both the scroll container and its first child for size changes
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => { clearTimeout(t); el.removeEventListener("scroll", sync); ro.disconnect(); };
  }, [sync]);

  function handleTrackClick(e: React.MouseEvent) {
    const el = scrollRef.current;
    const track = e.currentTarget;
    if (!el || !track) return;
    const rect = track.getBoundingClientRect();
    const fraction = (e.clientX - rect.left) / rect.width;
    el.scrollLeft = fraction * (el.scrollWidth - el.clientWidth);
  }

  function handleThumbDown(e: React.MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    const el = scrollRef.current;
    if (!el) return;
    dragging.current = true;
    dragStartX.current = e.clientX;
    dragStartScroll.current = el.scrollLeft;

    function onMove(ev: MouseEvent) {
      if (!dragging.current) return;
      const track = topTrackRef.current ?? bottomTrackRef.current;
      if (!el || !track) return;
      const dx = ev.clientX - dragStartX.current;
      const trackW = track.clientWidth;
      const ratio = el.scrollWidth / trackW;
      el.scrollLeft = dragStartScroll.current + dx * ratio;
    }
    function onUp() {
      dragging.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  const thumbWidthPct = `${Math.max(thumbRatio * 100, 8)}%`;
  const thumbLeftPct = `${thumbLeft * 100}%`;

  function renderTrack(ref: React.RefObject<HTMLDivElement | null>, rounded: string) {
    if (!canScroll) return null;
    return (
      <div
        ref={ref}
        onClick={handleTrackClick}
        className={`relative h-2 cursor-pointer bg-red-100 ${rounded}`}
      >
        <div
          onMouseDown={handleThumbDown}
          className="absolute top-0 h-full rounded-full bg-red-500 hover:bg-red-600 active:bg-red-700"
          style={{ left: thumbLeftPct, width: thumbWidthPct }}
        />
      </div>
    );
  }

  return (
    <div className={`relative ${className}`}>
      {/* Top scrollbar */}
      {renderTrack(topTrackRef, "rounded-t-md")}

      <div ref={scrollRef} className="scroll-fade-x overflow-x-auto">
        {children}
      </div>

      {/* Bottom scrollbar */}
      {renderTrack(bottomTrackRef, "rounded-b-md")}

      {/* Right-edge fade gradient */}
      {showRight && (
        <div className="pointer-events-none absolute right-0 top-0 h-full w-16 bg-gradient-to-l from-white via-white/80 to-transparent" />
      )}

      {/* "Scroll for more" hint — disappears after first scroll */}
      {showRight && !hasScrolled && (
        <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 animate-pulse">
          <div className="flex items-center gap-1 rounded-full bg-red-700/90 px-2.5 py-1 text-[0.6rem] font-semibold text-white shadow-lg">
            Scroll
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="animate-bounce-x">
              <path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        </div>
      )}
    </div>
  );
}

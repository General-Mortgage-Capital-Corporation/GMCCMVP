"use client";

import { useState, useRef, useCallback } from "react";
import { searchListings, matchBatch } from "@/lib/api";
import type { RentCastListing } from "@/types";

const BATCH_CHUNK_SIZE = 50;

export interface SearchParams {
  query: string;
  searchType: "area" | "specific";
  radius: number;
  programs: string[];
  lat?: number;
  lng?: number;
}

export function useSearch() {
  const [listings, setListings] = useState<RentCastListing[]>([]);
  const [loading, setLoading] = useState(false);
  const [matchLoading, setMatchLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState(0);

  const searchCtrl = useRef<AbortController | null>(null);
  const matchCtrl = useRef<AbortController | null>(null);

  const search = useCallback(async (params: SearchParams) => {
    searchCtrl.current?.abort();
    matchCtrl.current?.abort();
    searchCtrl.current = new AbortController();

    setLoading(true);
    setMatchLoading(false);
    setListings([]);
    setError(null);
    setTotal(0);

    try {
      const result = await searchListings(
        {
          query: params.query,
          searchType: params.searchType,
          radius: params.radius,
          programs: params.programs,
          lat: params.lat,
          lng: params.lng,
        },
        searchCtrl.current.signal,
      );

      setLoading(false);

      if (!result.success) {
        setError(result.error ?? "Search failed");
        return;
      }

      // Show listings immediately — matchData undefined = "checking..." skeleton
      setListings(result.listings);
      setTotal(result.total);

      if (result.listings.length === 0) return;

      // Fire chunked batch match — update progressively as each chunk completes
      matchCtrl.current = new AbortController();
      setMatchLoading(true);
      const signal = matchCtrl.current.signal;

      const baseListings = result.listings;
      const chunks: RentCastListing[][] = [];
      for (let i = 0; i < baseListings.length; i += BATCH_CHUNK_SIZE) {
        chunks.push(baseListings.slice(i, i + BATCH_CHUNK_SIZE));
      }

      // Process chunks sequentially — avoids flooding the Flask dev server
      // with concurrent ThreadPoolExecutor bursts that cause ECONNRESET
      for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
        if (signal.aborted) break;
        const chunk = chunks[chunkIdx];
        const offset = chunkIdx * BATCH_CHUNK_SIZE;
        try {
          const matchResult = await matchBatch(chunk, signal);
          setListings((prev) => {
            const next = [...prev];
            matchResult.results.forEach((item, i) => {
              if (!item) return;
              next[offset + i] = {
                ...next[offset + i],
                matchData: { programs: item.programs },
                censusData: item.census_data,
              };
            });
            return next;
          });
        } catch (e) {
          if (e instanceof Error && e.name === "AbortError") break;
          console.error(`Chunk ${chunkIdx} match failed:`, e);
        }
      }
      setMatchLoading(false);
    } catch (e) {
      setLoading(false);
      if (!(e instanceof Error && e.name === "AbortError")) {
        setError("Search failed. Please try again.");
      }
    }
  }, []);

  const reset = useCallback(() => {
    searchCtrl.current?.abort();
    matchCtrl.current?.abort();
    setListings([]);
    setLoading(false);
    setMatchLoading(false);
    setError(null);
    setTotal(0);
  }, []);

  return { listings, loading, matchLoading, error, total, search, reset };
}

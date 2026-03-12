/**
 * Shared wave-batching helper for streaming match routes.
 * Splits a list of listings into fixed-size chunks and dispatches them in
 * parallel waves to the Python /api/match-batch endpoint.
 */

import { pyPost } from "@/lib/python-client";
import type { Listing } from "@/lib/rentcast";
import type { MatchBatchResponse } from "@/types";

const BATCH_SIZE = 50;
const WAVE_SIZE = 4; // parallel match-batch requests per wave

/**
 * Process all listings through the matching service in parallel waves.
 *
 * @param listings  Listings to match.
 * @param signal    Client disconnect signal — stops processing on abort.
 * @param onBatch   Called after each batch completes with the raw chunk,
 *                  its match result (null on error), and running processed count.
 * @returns         Whether the run was aborted before completion.
 */
export async function runMatchWaves(
  listings: Listing[],
  signal: AbortSignal,
  onBatch: (
    chunk: Listing[],
    result: MatchBatchResponse | null,
    processed: number,
  ) => void,
): Promise<{ aborted: boolean }> {
  const chunks: Listing[][] = [];
  for (let i = 0; i < listings.length; i += BATCH_SIZE) {
    chunks.push(listings.slice(i, i + BATCH_SIZE));
  }

  let processed = 0;
  for (let i = 0; i < chunks.length; i += WAVE_SIZE) {
    if (signal.aborted) return { aborted: true };
    const wave = chunks.slice(i, i + WAVE_SIZE);

    const waveResults = await Promise.all(
      wave.map((chunk) =>
        pyPost<MatchBatchResponse>("/api/match-batch", chunk).catch(() => null),
      ),
    );

    if (signal.aborted) return { aborted: true };

    for (let j = 0; j < wave.length; j++) {
      processed += wave[j].length;
      onBatch(wave[j], waveResults[j], processed);
    }
  }

  return { aborted: false };
}

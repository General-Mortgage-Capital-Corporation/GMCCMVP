import { tool } from "ai";
import { z } from "zod";
import { fetchZillowPhotos } from "@/lib/services/zillow-photos";

/**
 * Agent tool: fetch a listing photo URL for a property address.
 *
 * Calls the shared Zillow photo service directly (not via self-HTTP) and
 * returns the primary photo URL. The URL can then be threaded into
 * generateFlyer as the `propertyImage` field so the hero image in the
 * flyer matches the actual listing.
 */
export const fetchPropertyPhotoTool = tool({
  description:
    "Fetch a listing photo URL for a property address (via Zillow). " +
    "Returns the primary photo URL plus up to a few alternates. " +
    "Use this before calling generateFlyer so the flyer's hero image matches " +
    "the actual listing. If no photo is found, generateFlyer will still work " +
    "and fall back to the program template's default image.",
  inputSchema: z.object({
    address: z
      .string()
      .describe(
        "Full property address, e.g. '3553 Meyer Pl, Santa Clara, CA 95051'. " +
          "Include city, state, and zip for best results.",
      ),
  }),
  execute: async ({ address }) => {
    const result = await fetchZillowPhotos(address);

    if (result.error) {
      return {
        found: false,
        error: result.error,
        message: `Could not fetch a photo for "${address}". The flyer will use the program's default image.`,
      };
    }

    if (!result.primaryPhoto) {
      return {
        found: false,
        message: `No Zillow photos found for "${address}". The flyer will use the program's default image.`,
      };
    }

    return {
      found: true,
      primaryPhoto: result.primaryPhoto,
      alternates: result.photos.slice(1, 4),
      totalPhotos: result.photos.length,
    };
  },
});

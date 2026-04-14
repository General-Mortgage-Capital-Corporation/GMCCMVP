import { tool } from "ai";
import { z } from "zod";
import { rentcastFetch, type Listing } from "@/lib/rentcast";

const API_KEY = process.env.RENTCAST_API_KEY ?? "";

/**
 * Direct RentCast property lookup by address. Returns detailed info about
 * a specific property — useful when the agent needs to verify or double-check
 * details about a particular listing rather than doing a broad area search.
 */
export const lookupPropertyTool = tool({
  description:
    "Look up a specific property by its exact address on RentCast. Returns detailed listing info " +
    "including price, beds, baths, sqft, property type, lot size, year built, listing agent, and days on market. " +
    "Use this when you need to verify details about a specific property, confirm it exists as an active listing, " +
    "or double-check information. For broad area searches, use searchProperties instead.",
  inputSchema: z.object({
    address: z.string().describe("Full street address (e.g. '123 Main St, San Jose, CA 95112')"),
  }),
  execute: async ({ address }) => {
    if (!API_KEY) {
      return { found: false, error: "RentCast API key not configured." };
    }

    try {
      const params = new URLSearchParams({ address, limit: "5" });
      const listings = await rentcastFetch(params, API_KEY);

      if (listings.length === 0) {
        return {
          found: false,
          address,
          message: "No active listing found at this address. It may not be on the market, or the address format may not match RentCast records.",
        };
      }

      // Return the first (most relevant) listing with full detail
      const l = listings[0];
      return {
        found: true,
        address: l.formattedAddress ?? l.addressLine1 ?? address,
        city: l.city,
        state: l.state,
        zipCode: l.zipCode,
        county: l.county,
        price: l.price,
        propertyType: l.propertyType,
        bedrooms: l.bedrooms,
        bathrooms: l.bathrooms,
        squareFootage: l.squareFootage,
        lotSize: l.lotSize,
        yearBuilt: l.yearBuilt,
        daysOnMarket: l.daysOnMarket,
        listedDate: l.listedDate,
        listingAgent: l.listingAgent ?? l.listingOfficeName ?? null,
        latitude: l.latitude,
        longitude: l.longitude,
        status: l.status,
        totalMatches: listings.length,
      };
    } catch (err) {
      return {
        found: false,
        error: err instanceof Error ? err.message : "RentCast lookup failed",
        address,
      };
    }
  },
});

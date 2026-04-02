import { tool } from "ai";
import { z } from "zod";
import {
  rentcastFetch,
  attachDistancesAndSort,
  RentCastError,
  MAX_LIMIT,
  type Listing,
} from "@/lib/rentcast";
import { getCachedRentcastSearch, setCachedRentcastSearch } from "@/lib/redis-cache";

const API_KEY = process.env.RENTCAST_API_KEY ?? "";

const DEFAULT_SHOW = 25;

type SortField = "price" | "daysOnMarket" | "distance" | "sqft" | "bedrooms";

function getSortValue(l: Record<string, unknown>, field: SortField): number {
  switch (field) {
    case "price": return (l.price as number) ?? Infinity;
    case "daysOnMarket": return (l.daysOnMarket as number) ?? Infinity;
    case "distance": return (l.distance as number) ?? Infinity;
    case "sqft": return (l.squareFootage as number) ?? 0;
    case "bedrooms": return (l.bedrooms as number) ?? 0;
    default: return 0;
  }
}

export const searchPropertiesTool = tool({
  description:
    "Search for active real estate listings near an address, city, or zip code. " +
    "Returns properties with address, price, beds, baths, sqft, days on market, and listing agent info. " +
    "Supports filtering by property type, price range, bedrooms, and sorting. " +
    "By default shows 25 results — if there are more available, the response will say so and you should let the user know they can request more.",
  inputSchema: z.object({
    query: z.string().describe("Address, city name, or zip code to search near"),
    radius: z
      .number()
      .min(1)
      .max(50)
      .default(5)
      .describe("Search radius in miles (1-50). Default 5."),
    latitude: z
      .number()
      .optional()
      .describe("Optional latitude for precise center point"),
    longitude: z
      .number()
      .optional()
      .describe("Optional longitude for precise center point"),
    // Filters — passed to RentCast API
    propertyType: z
      .enum(["Single Family", "Condo", "Townhouse", "Multi-Family", "Manufactured", "Apartment"])
      .optional()
      .describe("Filter by property type"),
    minPrice: z.number().optional().describe("Minimum listing price"),
    maxPrice: z.number().optional().describe("Maximum listing price"),
    bedrooms: z.number().optional().describe("Exact number of bedrooms"),
    bathrooms: z.number().optional().describe("Exact number of bathrooms"),
    // Sorting
    sortBy: z
      .enum(["price", "daysOnMarket", "distance", "sqft", "bedrooms"])
      .optional()
      .describe("Sort results by this field. Default is distance from search center."),
    sortOrder: z
      .enum(["asc", "desc"])
      .default("asc")
      .describe("Sort direction. 'asc' = lowest first, 'desc' = highest first. Default asc."),
    // Pagination
    maxResults: z
      .number()
      .min(5)
      .max(100)
      .default(DEFAULT_SHOW)
      .describe("How many results to return (5-100). Default 25. Use higher values when user asks to see more."),
  }),
  execute: async ({ query, radius, latitude, longitude, propertyType, minPrice, maxPrice, bedrooms, bathrooms, sortBy, sortOrder, maxResults }) => {
    if (!API_KEY) {
      return { error: "RentCast API key not configured.", listings: [] };
    }

    try {
      const params = new URLSearchParams({
        status: "Active",
        limit: String(MAX_LIMIT),
      });

      const isZip = /^\d{5}$/.test(query);
      if (isZip) {
        params.set("zipCode", query);
      } else if (latitude != null && longitude != null) {
        params.set("latitude", String(latitude));
        params.set("longitude", String(longitude));
        params.set("radius", String(radius));
      } else {
        params.set("address", query);
        params.set("radius", String(radius));
      }

      // Apply RentCast API filters
      if (propertyType) params.set("propertyType", propertyType);
      if (minPrice != null) params.set("priceMin", String(minPrice));
      if (maxPrice != null) params.set("priceMax", String(maxPrice));
      if (bedrooms != null) params.set("bedrooms", String(bedrooms));
      if (bathrooms != null) params.set("bathrooms", String(bathrooms));

      // Check Redis cache first
      const cacheKey = Object.fromEntries(params.entries());
      const cached = await getCachedRentcastSearch(cacheKey);
      let listings: Listing[];
      if (cached) {
        listings = cached as Listing[];
      } else {
        listings = await rentcastFetch(params, API_KEY);
        if (listings.length > 0) {
          setCachedRentcastSearch(cacheKey, listings).catch(() => {});
        }
      }

      // Attach distances
      if (latitude != null && longitude != null) {
        attachDistancesAndSort(listings, latitude, longitude);
      } else if (listings.length > 0 && listings[0].latitude && listings[0].longitude) {
        attachDistancesAndSort(
          listings,
          listings[0].latitude,
          listings[0].longitude,
        );
      }

      // Apply sort if requested (otherwise stays sorted by distance)
      if (sortBy) {
        listings.sort((a, b) => {
          const aVal = getSortValue(a as unknown as Record<string, unknown>, sortBy);
          const bVal = getSortValue(b as unknown as Record<string, unknown>, sortBy);
          return sortOrder === "desc" ? bVal - aVal : aVal - bVal;
        });
      }

      const totalAvailable = listings.length;
      const cap = Math.min(maxResults, totalAvailable);

      // Return compact summary
      const compact = listings.slice(0, cap).map((l) => ({
        address: l.formattedAddress ?? "Unknown",
        price: l.price ?? null,
        propertyType: (l as Record<string, unknown>).propertyType as string | undefined ?? null,
        bedrooms: (l as Record<string, unknown>).bedrooms as number | undefined ?? null,
        bathrooms: (l as Record<string, unknown>).bathrooms as number | undefined ?? null,
        sqft: (l as Record<string, unknown>).squareFootage as number | undefined ?? null,
        daysOnMarket: (l as Record<string, unknown>).daysOnMarket as number | undefined ?? null,
        distance: l.distance ? Math.round(l.distance * 10) / 10 : null,
        listingAgent: (l as Record<string, unknown>).listingAgent as Record<string, unknown> | undefined ?? null,
        listingOffice: (l as Record<string, unknown>).listingOffice as Record<string, unknown> | undefined ?? null,
        latitude: l.latitude,
        longitude: l.longitude,
        state: (l as Record<string, unknown>).state as string | undefined,
        county: (l as Record<string, unknown>).county as string | undefined,
        countyFips: l.countyFips,
        stateFips: l.stateFips,
      }));

      return {
        totalAvailable,
        showing: compact.length,
        moreAvailable: totalAvailable > cap,
        ...(totalAvailable > cap
          ? { note: `Showing ${cap} of ${totalAvailable} properties. Ask me to show more or adjust filters if needed.` }
          : {}),
        listings: compact,
      };
    } catch (err) {
      if (err instanceof RentCastError) {
        return { error: err.message, listings: [] };
      }
      return { error: "Search failed. Please try again.", listings: [] };
    }
  },
});

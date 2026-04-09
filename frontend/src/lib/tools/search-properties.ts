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
import { storeDataset, type DatasetRow } from "@/lib/tools/dataset-store";

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
    "Supports filtering by property type, price range, bedrooms, and sorting.\n\n" +
    "IMPORTANT — pick maxResults based on intent, do NOT always use the default:\n" +
    "• Location browsing ('near me', 'close to X', 'around this area') → 25 (closest first)\n" +
    "• 'Show me a few', 'top 5', 'top 10' → match the exact number asked\n" +
    "• Mass marketing, email campaigns, realtor outreach in a city/county → 100 (the cap)\n" +
    "• 'How many listings in X', statistics/counts → 100 (need the full picture)\n" +
    "• 'Show me all / every listing' → 100 (and tell the user 100 is the per-call ceiling if more exist)\n" +
    "• Program-matching/CRA analysis across a market → 100\n" +
    "If the response has moreAvailable=true, tell the user how many were found vs shown and suggest narrowing by program, price, bedrooms, or property type.",
  inputSchema: z.object({
    query: z
      .string()
      .optional()
      .describe(
        "Full address, landmark, or zip code for a radius search — only use this when the user wants listings 'near' a specific point. " +
          "For whole-city searches (e.g. 'listings in Campbell CA'), prefer the city + state inputs instead.",
      ),
    city: z
      .string()
      .optional()
      .describe(
        "City name for an exact-city filter (e.g. 'Campbell', 'San Jose'). " +
          "When provided, MUST be paired with state. Returns only listings whose city matches exactly — " +
          "this is what you want for 'all listings in <city>' or mass-marketing questions. Do NOT combine with query.",
      ),
    state: z
      .string()
      .length(2)
      .optional()
      .describe("Two-letter state code (e.g. 'CA', 'NY'). Required when city is provided."),
    radius: z
      .number()
      .min(1)
      .max(50)
      .default(5)
      .describe("Search radius in miles (1-50). Only used with query or latitude/longitude. Default 5."),
    latitude: z
      .number()
      .optional()
      .describe("Optional latitude for precise center point (pair with longitude)"),
    longitude: z
      .number()
      .optional()
      .describe("Optional longitude for precise center point (pair with latitude)"),
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
  execute: async ({ query, city, state, radius, latitude, longitude, propertyType, minPrice, maxPrice, bedrooms, bathrooms, sortBy, sortOrder, maxResults }) => {
    if (!API_KEY) {
      return { error: "RentCast API key not configured.", listings: [] };
    }

    // Validate mode: exactly one of (city+state), (lat+lng), (query), or (zip via query).
    if (city && !state) {
      return { error: "When searching by city, state is required (e.g. state: 'CA').", listings: [] };
    }
    if (!city && !query && latitude == null && longitude == null) {
      return { error: "Provide either city+state, a query (address/zip), or latitude+longitude.", listings: [] };
    }

    try {
      const params = new URLSearchParams({
        status: "Active",
        limit: String(MAX_LIMIT),
      });

      // Priority order:
      //   1. city + state → exact city filter (no radius geocoding drift)
      //   2. latitude + longitude → precise center point
      //   3. query as 5-digit zip → zipCode filter
      //   4. query as address → address + radius (may bleed into neighbors)
      if (city && state) {
        params.set("city", city);
        params.set("state", state.toUpperCase());
      } else if (latitude != null && longitude != null) {
        params.set("latitude", String(latitude));
        params.set("longitude", String(longitude));
        params.set("radius", String(radius));
      } else if (query && /^\d{5}$/.test(query)) {
        params.set("zipCode", query);
      } else if (query) {
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

      // Flatten to the shared DatasetRow shape. This is the FULL record —
      // stored server-side under a datasetRef so generateCsv can pull it
      // back without round-tripping every field through the LLM.
      const fullRows: DatasetRow[] = listings.slice(0, cap).map((l) => {
        const raw = l as Record<string, unknown>;
        const agent = (raw.listingAgent ?? {}) as Record<string, unknown>;
        const office = (raw.listingOffice ?? {}) as Record<string, unknown>;
        const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
        const num = (v: unknown) => (typeof v === "number" ? v : undefined);
        return {
          address: str(l.formattedAddress) ?? "Unknown",
          city: str(raw.city) ?? null,
          state: str(raw.state) ?? null,
          zipCode: str(raw.zipCode) ?? null,
          county: str(raw.county) ?? null,
          propertyType: str(raw.propertyType) ?? null,
          price: num(raw.price) ?? null,
          bedrooms: num(raw.bedrooms) ?? null,
          bathrooms: num(raw.bathrooms) ?? null,
          sqft: num(raw.squareFootage) ?? null,
          daysOnMarket: num(raw.daysOnMarket) ?? null,
          distance: l.distance ? Math.round(l.distance * 10) / 10 : null,
          listingAgentName: str(agent.name) ?? null,
          listingAgentEmail: str(agent.email) ?? null,
          listingAgentPhone: str(agent.phone) ?? null,
          listingOfficeName: str(office.name) ?? null,
          latitude: l.latitude,
          longitude: l.longitude,
          countyFips: l.countyFips,
          stateFips: l.stateFips,
        };
      });

      const datasetRef = await storeDataset(fullRows);

      // Compact display view for the LLM — ~5 fields per row instead of 20.
      // Keeps the tool result under a few KB even at 100 listings so the
      // model doesn't stall on tool-output → next-turn roundtrips.
      const compact = fullRows.map((r) => ({
        address: r.address,
        city: r.city,
        price: r.price,
        bedrooms: r.bedrooms,
        bathrooms: r.bathrooms,
        daysOnMarket: r.daysOnMarket,
      }));

      return {
        totalAvailable,
        showing: compact.length,
        moreAvailable: totalAvailable > cap,
        ...(totalAvailable > cap
          ? { note: `Showing ${cap} of ${totalAvailable} properties. Ask me to show more or adjust filters if needed.` }
          : {}),
        // datasetRef points at the full rows on the server. Pass this to
        // matchPrograms or generateCsv to operate on the full dataset
        // without round-tripping every field through the LLM.
        datasetRef,
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

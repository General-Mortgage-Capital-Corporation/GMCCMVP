/**
 * TypeScript types matching the Python Pydantic models in matching/models.py and rag/schemas.py.
 * Also includes RentCast listing shape and API response envelopes.
 */

// ---------------------------------------------------------------------------
// Matching engine types (matching/models.py)
// ---------------------------------------------------------------------------

export type CriterionStatus = "pass" | "fail" | "unverified";

export type OverallStatus = "Eligible" | "Potentially Eligible" | "Ineligible";

export interface CriterionResult {
  criterion: string;
  status: CriterionStatus;
  detail: string;
}

export interface TierResult {
  tier_name: string;
  status: OverallStatus;
  criteria: CriterionResult[];
}

export interface ProgramResult {
  program_name: string;
  status: OverallStatus;
  matching_tiers: TierResult[];
  best_tier: string | null;
}

export interface MatchResponse {
  programs: ProgramResult[];
  eligible_count: number;
}

// ---------------------------------------------------------------------------
// Census / FFIEC data (returned by server alongside match results)
// ---------------------------------------------------------------------------

export interface CensusData {
  tract_income_level?: string;
  msa_code?: string;
  msa_name?: string;
  state_code?: string;
  county_code?: string;
  tract_code?: string;
  tract_minority_pct?: number;
  majority_aa_hp?: boolean;
  population?: number;
  median_family_income?: number;
  tract_median_income?: number;
  demographics_total?: number;
  demographics_hispanic?: number;
  demographics_black?: number;
  demographics_asian?: number;
  demographics_white?: number;
}

// ---------------------------------------------------------------------------
// RentCast listing (raw shape from the API, plus server-attached fields)
// ---------------------------------------------------------------------------

export interface RentCastListing {
  id?: string;
  formattedAddress?: string;
  addressLine1?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  county?: string;
  latitude?: number;
  longitude?: number;
  propertyType?: string;
  bedrooms?: number;
  bathrooms?: number;
  squareFootage?: number;
  lotSize?: number;
  yearBuilt?: number;
  price?: number;
  listingType?: string;
  listedDate?: string;
  daysOnMarket?: number;
  status?: string;
  removedDate?: string | null;
  createdDate?: string;
  lastSeenDate?: string;
  stateFips?: string;
  countyFips?: string;

  // Server-attached after matching
  distance?: number;
  matchData?: { programs: ProgramResult[] };
  censusData?: CensusData | null;
}

// ---------------------------------------------------------------------------
// API response envelopes
// ---------------------------------------------------------------------------

export interface SearchResponse {
  success: boolean;
  listings: RentCastListing[];
  total: number;
  exact_match: boolean;
  message: string | null;
  error?: string;
}

export interface MatchSingleResponse {
  success: boolean;
  programs: ProgramResult[];
  eligible_count: number;
  census_data: CensusData | null;
  error?: string;
}

export interface MatchBatchResponse {
  success: boolean;
  results: (MatchBatchItem | null)[];
  error?: string;
}

export interface MatchBatchItem {
  programs: ProgramResult[];
  census_data: CensusData | null;
}

export interface ExplainResponse {
  success: boolean;
  explanation?: string;
  error?: string;
}

export interface ProgramLocationsResponse {
  programs: ProgramLocationEntry[];
}

export interface ProgramLocationEntry {
  program_name: string;
  states: StateEntry[];
}

export interface StateEntry {
  state: string;
  counties: CountyEntry[];
}

export interface CountyEntry {
  fips: string;
  county: string;
  cities: string[];
}

export interface ProgramSearchResponse {
  success: boolean;
  listings: RentCastListing[];
  total_searched: number;
  total_matched: number;
  error?: string;
}

export interface MarketingSearchResponse {
  success: boolean;
  listings: RentCastListing[];
  total_found: number;
  total_in_county: number;
  error?: string;
}

export interface HealthResponse {
  status: string;
  api_configured: boolean;
  places_configured: boolean;
}

// ---------------------------------------------------------------------------
// Autocomplete
// ---------------------------------------------------------------------------

export interface AutocompleteSuggestion {
  text: string;
  place_id: string;
}

export interface AutocompleteResponse {
  suggestions: AutocompleteSuggestion[];
}

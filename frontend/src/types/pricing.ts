/**
 * Types mirroring the unified pricing contract documented in
 * property-search-unified-pricing.md (sections 4 & 8).
 *
 * The MLO portal owns the wire format. Property-search treats it as a
 * black-box service: send a scenario, render the response.
 */

// ---------------------------------------------------------------------------
// Request — scenario + program list
// ---------------------------------------------------------------------------

export type LoanPurpose = "purchase" | "rate_term_refi" | "cash_out_refi";
export type Occupancy = "primary" | "second_home" | "investment";
export type PropertyType =
  | "sfr"
  | "condo"
  | "townhouse"
  | "multi_unit"
  | "manufactured"
  | "pud";
export type BorrowerResidency =
  | "us_citizen"
  | "permanent_resident"
  | "npra"
  | "foreign_national"
  | "other";
export type DocType =
  | "full_doc"
  | "streamlined"
  | "1099_12mo"
  | "1099_24mo"
  | "asset_depletion"
  | "bank_stmt_12mo_personal"
  | "bank_stmt_12mo_business"
  | "bank_stmt_24mo_personal"
  | "bank_stmt_24mo_business"
  | "cpa_pnl_12mo"
  | "cpa_pnl_24mo"
  | "wvoe"
  | "dscr";
export type LoanType = "first_lien" | "second_lien" | "heloc";
export type CondoType = "warrantable" | "non_warrantable" | "condotel";
export type BuydownType = "none" | "3-2-1" | "2-1" | "1-1" | "1-0";
export type SecondaryFinancingType =
  | "none"
  | "first_to_be_paid_off"
  | "first_with_second";

export interface CreditEvent {
  mortgage_late_payment?: "none" | "within_12mo" | "within_24mo";
  bankruptcy?:
    | "none"
    | "chapter_7_lt_4yr"
    | "chapter_7_gte_4yr"
    | "chapter_13_lt_4yr"
    | "chapter_13_gte_4yr";
  foreclosure?: "none" | "lt_4yr" | "gte_4yr";
  deed_in_lieu?: "none" | "lt_4yr" | "gte_4yr";
  short_sale?: "none" | "lt_4yr" | "gte_4yr";
}

export interface PricingScenario {
  // Required
  state: string;
  loan_amount: number;
  fico: number;
  loan_purpose: LoanPurpose;
  occupancy: Occupancy;
  property_type: PropertyType;
  borrower_residency: BorrowerResidency;
  doc_type: DocType;
  dti: number;

  // Conditional
  property_units?: number;
  purchase_price?: number;
  cash_out_amount?: number;
  condo_type?: CondoType;
  county?: string;

  // Optional
  appraised_value?: number;
  ltv?: number;
  lock_period?: 15 | 30 | 45 | 60;
  loan_type?: LoanType;
  self_employed?: boolean;
  first_time_homebuyer?: boolean;
  first_time_investor?: boolean;
  interest_only?: boolean;
  forty_year_term?: boolean;
  buy_without_sell?: boolean;
  escrow_waived?: boolean;
  short_term_rental?: boolean;
  rural_property?: boolean;
  non_warrantable_condo?: boolean;
  buydown_type?: BuydownType;
  prepay_penalty_months?: 0 | 12 | 24 | 36 | 60;
  subordinate_loan_amount?: number;
  secondary_financing_type?: SecondaryFinancingType;
  credit_event?: CreditEvent;
  heloc_drawn_amount?: number;
  heloc_line_amount?: number;
  cltv?: number | null;
  hcltv?: number | null;
}

export type EngineProgram = "loannex" | "qm_jumbo" | "bws";

export interface QuoteRequest {
  programs: EngineProgram[];
  scenario: PricingScenario;
}

// ---------------------------------------------------------------------------
// Response — per-program result rows
// ---------------------------------------------------------------------------

export type ResultStatus = "eligible" | "ineligible" | "unavailable" | "error";

export type ErrorCode =
  | "no_loannex_account"
  | "timeout"
  | "upstream_5xx"
  | "malformed_scenario"
  | "unknown";

export interface RateRow {
  rate: number;
  lock_days: number;
  price: number;
  cost_points: number;
  rebate_points: number;
  in_target_band: boolean;
}

export interface RateHeadline {
  best_rate: number;
  best_points: number;
  best_lock_days: number;
  in_target_band: boolean;
}

export type ResultEngine = "loannex" | "gmcc_processor" | "bws";

export interface PricingResult {
  program: string;
  engine: ResultEngine;
  status: ResultStatus;
  headline?: RateHeadline;
  rates?: RateRow[];
  reasons?: string[];
  conditions?: string[];
  rate_sheet_as_of?: string;
  stale_days?: number;
  error_code?: ErrorCode;
  error_message?: string;
}

export interface QuoteResponse {
  request_id: string;
  scenario_summary: string;
  results: PricingResult[];
  defaults_applied?: string[];
  errors?: string[];
}

// Property-search-side wrappers
export interface QuoteApiSuccess extends QuoteResponse {
  success: true;
}
export interface QuoteApiFailure {
  success: false;
  error: string;
  code?:
    | "auth_required"
    | "service_unavailable"
    | "config_missing"
    | "upstream_error"
    | "rate_limited";
}
export type QuoteApiResponse = QuoteApiSuccess | QuoteApiFailure;

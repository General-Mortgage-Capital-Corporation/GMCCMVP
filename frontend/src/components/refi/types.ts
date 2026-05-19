// Types shared by the Refi Finder UI components.

export type RefiPreset = {
  id: string;
  name: string;
  tagline: string;
  why: string;
  base_filters: RefiFilters;
  primary_filter_keys: string[];
};

// Loan purpose codes accepted by the PropertyRadar API (server-side validates).
export type FirstPurposeCode =
  | "CashOut"
  | "Construction"
  | "ELOC"
  | "PMoney"
  | "R&TRefi"
  | "Reverse"
  | "Wrap"
  | "Unknown";

// Loan type single-letter codes used in the Criteria input (response carries labels).
export type FirstLoanTypeCode = "B" | "C" | "F" | "N" | "O" | "P" | "S" | "V";
export type FirstRateTypeCode = "F" | "A";
export type PropertyTypeCode = "SFR" | "CND" | "MFR" | "APT" | "RES" | "COM" | "IND" | "AGR" | "LND";

export type DateRange = { from?: string; to?: string };

export type RefiFilters = {
  property_types?: PropertyTypeCode[];
  owner_occupied?: boolean;

  first_purpose?: FirstPurposeCode[];
  first_loan_type?: FirstLoanTypeCode[];
  first_rate_type?: FirstRateTypeCode[];

  first_date_range?: DateRange;
  first_date_from?: string;
  first_date_to?: string;
  first_rate_min?: number;
  first_rate_max?: number;
  first_amount_min?: number;
  first_amount_max?: number;

  available_equity_min?: number;
  available_equity_max?: number;
  equity_percent_min?: number;
  equity_percent_max?: number;

  avm_min?: number;
  avm_max?: number;

  is_free_and_clear?: boolean;
  number_loans_min?: number;
  number_loans_max?: number;

  last_transfer_date_range?: DateRange;
  last_transfer_date_from?: string;
  last_transfer_date_to?: string;

  first_arm_reset_within_months?: number;
  first_lender_original?: string[];

  exclude_distressed?: boolean;
};

export type Geography = {
  zip_codes?: number[];
  cities?: { city: string; state: string }[];
  county_fips?: string[];
  states?: string[];
};

export type RefiRow = {
  RadarID: string;
  Address?: string;
  City?: string;
  State?: string;
  ZipFive?: number;
  County?: string;
  APN?: string;
  Latitude?: number;
  Longitude?: number;
  CensusTract?: number;

  Owner?: string;
  OwnerFirstName?: string;
  OwnerLastName?: string;
  OwnershipType?: string;
  isSameMailingOrExempt?: number;

  PType?: string;
  AdvancedPropertyType?: string;
  Beds?: number;
  Baths?: number;
  SqFt?: number;
  YearBuilt?: number;
  Units?: number;

  AVM?: number;
  AVMAsOf?: string;
  AVMReliability?: number;
  AssessedValue?: number;

  AvailableEquity?: number;
  EquityPercent?: number;
  CLTV?: number;
  TotalLoanBalance?: number;
  NumberLoans?: number;
  isFreeAndClear?: number;
  isHighEquity?: number;
  isUnderwater?: number;

  FirstAmount?: number;
  FirstDate?: string;
  FirstPurpose?: string;
  FirstLoanType?: string;
  FirstRateType?: string;
  FirstRate?: number;
  FirstTermInYears?: number;
  FirstLenderOriginal?: string;

  SecondAmount?: number;
  SecondLenderOriginal?: string;

  LastTransferRecDate?: string;
  LastTransferValue?: number;
  LastTransferType?: string;

  AnnualTaxes?: number;

  census?: {
    tract_income_level?: string | null;
    tract_minority_pct?: number | null;
    tract_population?: number | null;
    msa_name?: string | null;
    msa_code?: string | null;
    tract_to_msa_ratio?: number | null;
    tract_mfi?: number | null;
    ffiec_mfi?: number | null;
  };
};

export type PreviewResp = {
  success: boolean;
  totalResultCount?: number;
  quantityFreeRemaining?: number;
  criteria?: unknown[];
  error?: string;
};

export type SearchResp = {
  success: boolean;
  results?: RefiRow[];
  rows_returned?: number;
  rows_available?: number;
  page?: number;
  limit?: number;
  cache_hit?: boolean;
  criteria?: unknown[];
  cache_key?: string;
  error?: string;
  code?: string;
};

export type QuotaResp = {
  today_spend: number;
  daily_cap: number;
  quantity_free_remaining?: number | null;
};

/**
 * Build a `PricingScenario` from a RentCast listing + LO-supplied inputs.
 *
 * The plan's "Assumptions / defaults" table (section 4) leaves most of the
 * 25 scenario fields fillable by the aggregator. We send a minimal payload —
 * the LO chooses FICO, down payment, occupancy, doc type — and let the
 * aggregator fill the rest with `defaults_applied: [...]`.
 */

import type { RentCastListing } from "@/types";
import type {
  BorrowerResidency,
  BuydownType,
  CreditEvent,
  DocType,
  LoanPurpose,
  Occupancy,
  PricingScenario,
  PropertyType,
} from "@/types/pricing";

export interface ScenarioInputs {
  fico: number;
  down_payment_pct: number; // e.g. 25 for 25%
  occupancy: Occupancy;
  doc_type: DocType;
  // Loan structure (advanced overrides)
  loan_purpose?: LoanPurpose;
  dti?: number;
  loan_amount_override?: number;
  appraised_value_override?: number;
  cash_out_amount?: number;
  lock_period?: 15 | 30 | 45 | 60;
  buydown_type?: BuydownType;
  prepay_penalty_months?: 0 | 12 | 24 | 36 | 60;
  // Borrower flags
  borrower_residency?: BorrowerResidency;
  self_employed?: boolean;
  first_time_homebuyer?: boolean;
  first_time_investor?: boolean;
  interest_only?: boolean;
  forty_year_term?: boolean;
  // Property flags
  escrow_waived?: boolean;
  short_term_rental?: boolean;
  rural_property?: boolean;
  buy_without_sell?: boolean;
  // Credit events
  credit_event?: CreditEvent;
}

export const DEFAULT_INPUTS: ScenarioInputs = {
  fico: 740,
  down_payment_pct: 25,
  occupancy: "primary",
  doc_type: "full_doc",
  loan_purpose: "purchase",
  dti: 43,
  lock_period: 30,
  borrower_residency: "us_citizen",
  buydown_type: "none",
  prepay_penalty_months: 0,
  credit_event: {
    mortgage_late_payment: "none",
    bankruptcy: "none",
    foreclosure: "none",
    deed_in_lieu: "none",
    short_sale: "none",
  },
};

/** True if the credit event has any non-"none" entry. */
function hasCreditEvents(ce?: CreditEvent): boolean {
  if (!ce) return false;
  return [
    ce.mortgage_late_payment,
    ce.bankruptcy,
    ce.foreclosure,
    ce.deed_in_lieu,
    ce.short_sale,
  ].some((v) => v && v !== "none");
}

/** Map a RentCast `propertyType` string to the unified `property_type` enum. */
function mapPropertyType(rentcast?: string): PropertyType {
  if (!rentcast) return "sfr";
  const t = rentcast.toLowerCase();
  if (t.includes("condo")) return "condo";
  if (t.includes("townhouse") || t.includes("townhome")) return "townhouse";
  if (t.includes("manufactured") || t.includes("mobile")) return "manufactured";
  if (t.includes("multi") || /\b[2-4]\s*(unit|family|plex)\b/.test(t)) return "multi_unit";
  if (t.includes("pud")) return "pud";
  return "sfr";
}

function deriveUnits(rentcast?: string): number | undefined {
  if (!rentcast) return undefined;
  const m = rentcast.match(/([2-4])\s*(unit|family|plex)/i);
  if (m) return Number(m[1]);
  if (/duplex/i.test(rentcast)) return 2;
  if (/triplex/i.test(rentcast)) return 3;
  if (/fourplex|quadplex/i.test(rentcast)) return 4;
  return undefined;
}

export function buildScenario(
  listing: Pick<
    RentCastListing,
    "state" | "price" | "propertyType" | "county"
  > | null,
  inputs: ScenarioInputs,
): PricingScenario {
  const purchasePrice =
    inputs.appraised_value_override ?? inputs.loan_amount_override
      ? // If they overrode loan, infer purchase price from down pct
        (inputs.appraised_value_override ??
          (inputs.loan_amount_override
            ? inputs.loan_amount_override / (1 - inputs.down_payment_pct / 100)
            : 0))
      : (listing?.price ?? 0);

  const downPct = Math.max(0, Math.min(99, inputs.down_payment_pct));
  const loanAmount =
    inputs.loan_amount_override ??
    Math.round(purchasePrice * (1 - downPct / 100));

  const ltv = purchasePrice > 0 ? Number((loanAmount / purchasePrice * 100).toFixed(2)) : undefined;
  const propertyType = mapPropertyType(listing?.propertyType);
  const units = deriveUnits(listing?.propertyType);

  const purpose: LoanPurpose = inputs.loan_purpose ?? "purchase";

  const scenario: PricingScenario = {
    state: (listing?.state ?? "").toUpperCase(),
    loan_amount: loanAmount,
    fico: inputs.fico,
    loan_purpose: purpose,
    occupancy: inputs.occupancy,
    property_type: propertyType,
    borrower_residency: inputs.borrower_residency ?? "us_citizen",
    doc_type: inputs.doc_type,
    dti: inputs.dti ?? 43,
    purchase_price: purpose === "purchase" ? Math.round(purchasePrice) : undefined,
    appraised_value:
      purpose === "purchase" ? Math.round(purchasePrice) : inputs.appraised_value_override,
    ltv,
    lock_period: inputs.lock_period ?? 30,
    loan_type: "first_lien",
    self_employed: inputs.self_employed ?? false,
    first_time_homebuyer: inputs.first_time_homebuyer ?? false,
    first_time_investor: inputs.first_time_investor ?? false,
    interest_only: inputs.interest_only ?? false,
    forty_year_term: inputs.forty_year_term ?? false,
    escrow_waived: inputs.escrow_waived ?? false,
    short_term_rental: inputs.short_term_rental ?? false,
    rural_property: inputs.rural_property ?? false,
    buy_without_sell: inputs.buy_without_sell ?? false,
    buydown_type: inputs.buydown_type ?? "none",
    prepay_penalty_months: inputs.prepay_penalty_months ?? 0,
    cash_out_amount:
      purpose === "cash_out_refi" ? inputs.cash_out_amount : undefined,
    county: listing?.county || undefined,
    property_units: propertyType === "multi_unit" ? units ?? 2 : undefined,
    condo_type: propertyType === "condo" ? "warrantable" : undefined,
    credit_event: hasCreditEvents(inputs.credit_event) ? inputs.credit_event : undefined,
  };

  // Strip undefined keys so we send a clean payload
  for (const key of Object.keys(scenario) as (keyof PricingScenario)[]) {
    if (scenario[key] === undefined) delete scenario[key];
  }

  return scenario;
}

export function summarizeScenario(s: PricingScenario): string {
  const parts: string[] = [];
  parts.push(`$${(s.loan_amount / 1000).toFixed(0)}k loan`);
  if (s.purchase_price) parts.push(`$${(s.purchase_price / 1000).toFixed(0)}k ${s.loan_purpose === "purchase" ? "purchase" : "value"}`);
  if (s.ltv) parts.push(`${s.ltv}% LTV`);
  parts.push(`${s.fico} FICO`);
  parts.push(s.occupancy.replace("_", " "));
  parts.push(s.doc_type.replace(/_/g, " "));
  if (s.state) parts.push(s.state);
  return parts.join(" • ");
}

/** Validate before submitting — return human-readable error or null. */
export function validateScenario(s: PricingScenario): string | null {
  if (!s.state || s.state.length !== 2) return "State (2-letter code) is required.";
  if (!s.loan_amount || s.loan_amount <= 0) return "Loan amount must be greater than 0.";
  if (s.fico < 300 || s.fico > 850) return "FICO must be between 300 and 850.";
  if (s.dti < 0 || s.dti > 100) return "DTI must be between 0 and 100.";
  if (s.loan_purpose === "purchase" && !s.purchase_price) return "Purchase price is required for a purchase scenario.";
  if (s.loan_purpose === "cash_out_refi" && !s.cash_out_amount) return "Cash-out amount is required for cash-out refi.";
  if (!s.appraised_value && !s.ltv) return "Either appraised value or LTV is required.";
  return null;
}

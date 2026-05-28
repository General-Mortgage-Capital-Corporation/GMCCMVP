/**
 * Refi Finder credit-system types. See project_refi_credit_system.md.
 *
 * Two independent clocks live in this system:
 *   - Per-user subscription cycle (gates unlocks; anchored to user's payment date)
 *   - Company PropertyRadar plan cycle (governs buffer + usage counter rollover)
 * They must never be conflated. Gating logic ONLY checks the per-user clock.
 */

import type { Timestamp } from "firebase-admin/firestore";

/** users/{email}/creditPacks/refi_finder — owned by the Bill.com webhook on the grant side. */
export interface RefiCreditPack {
  contactCredits: number;
  propertyCredits: number;
  cycleEndsAt: Timestamp;
  billcomCustomerId?: string;
  history?: Array<{
    invoiceId: string;
    type: string;
    amount: number;
    paidAt?: Timestamp;
  }>;
  pendingRecharge?: {
    billcomInvoiceId: string;
    paymentUrl: string;
    createdAt: Timestamp;
    amount: number;
  };
  updatedAt?: Timestamp;
}

/** users/{email}/subscriptions/refi_finder. */
export interface RefiSubscription {
  autoRenewCanceled?: boolean;
  billcomRecurringInvoiceId?: string;
  nextBillingDate?: Timestamp;
}

/** creditPacks/company_buffer — drains for users on bufferAllowlist. */
export interface CompanyBuffer {
  contactCredits: number;
  propertyCredits: number;
  lastResetAt?: Timestamp;
  updatedAt?: Timestamp;
}

/** creditPacks/company_usage_{cycleId} — cycle-total counter. */
export interface CompanyUsage {
  contactCreditsUsed: number;
  propertyCreditsUsed: number;
  cycleStart: Timestamp;
  cycleEnd: Timestamp;
  updatedAt?: Timestamp;
}

/** meta/refiFinder — config. */
export interface RefiMeta {
  bufferAllowlist: string[];
  planAnniversary: number;
  currentCycleId: string;
}

export type ActivityAction =
  | "unlock_property"
  | "unlock_email"
  | "unlock_text"
  | "unlock_failed";

/** users/{email}/refiFinderActivity/{auto-id} — one entry per discrete user action. */
export interface ActivityEntry {
  ts: Timestamp;
  action: ActivityAction;
  propertyId: string;
  /** Full street + city/state/zip when available; falls back to street only. */
  propertyAddress: string;
  creditsUsed: { contact?: number; property?: number };
  propertyRadarRef: string;
  drewFromBuffer: boolean;
  balanceAfter: { contact: number; property: number };
  /** Set on action: "unlock_failed". */
  failureReason?: string;
  /** The actual email or phone number revealed — only set on successful
   *  unlock_email / unlock_text entries. Lets History show what was paid for. */
  revealedValue?: string;
  /** Owner display name when available — for history table outreach context. */
  ownerName?: string;
  /** Served from the cross-LO Redis cache — no PR charge, no user credit
   *  spent. creditsUsed will be 0 in this case (refunded after the upfront
   *  estimate); History should render a "cached · no charge" badge. */
  fromCache?: boolean;
}

/** Amount to deduct. Both fields default to 0; deduction errors if both are 0. */
export interface CreditAmount {
  contact: number;
  property: number;
}

/** Result of pool resolution — tells the caller where deductions go. */
export interface ResolvedPool {
  /** Firestore doc ref path (collection/doc, even-numbered components). */
  poolRef: "creditPacks/company_buffer" | `users/${string}/creditPacks/refi_finder`;
  /** True when user is on bufferAllowlist; stamped onto ActivityEntry.drewFromBuffer. */
  drewFromBuffer: boolean;
}

/** Subscription gating result. */
export type SubscriptionStatus =
  | {
      state: "active";
      /** Lowercased email. */
      email: string;
      /** True if user has clicked Cancel auto-renewal but cycle hasn't expired. */
      autoRenewCanceled: boolean;
      cycleEndsAt: Date;
      balance: { contact: number; property: number };
    }
  | {
      state: "buffer";
      /** Lowercased email. */
      email: string;
      balance: { contact: number; property: number };
    }
  | {
      state: "expired";
      email: string;
      /** Last known cycle end so UI can show "Resubscribe — your cycle ended on …". */
      cycleEndsAt: Date | null;
    }
  | {
      state: "never_subscribed";
      email: string;
    };

/** Thrown by deduct() when the pool lacks credits. Surface to client as 402-ish. */
export class InsufficientCreditsError extends Error {
  readonly code = "insufficient_credits";
  constructor(
    public readonly needed: CreditAmount,
    public readonly have: CreditAmount,
    public readonly pool: ResolvedPool["poolRef"],
  ) {
    super(
      `Insufficient credits. Need contact=${needed.contact} property=${needed.property}; have contact=${have.contact} property=${have.property}.`,
    );
    this.name = "InsufficientCreditsError";
  }
}

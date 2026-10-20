/**
 * Campaign planning: dataset rows -> one row per listing agent.
 *
 * Pure (type-only imports) so it runs under `node --test` without the Next.js
 * alias resolver; the engine re-exports it.
 */
import type { DatasetRow } from "../tools/dataset-store";
import { RECIPIENT_COOLDOWN_MS } from "../email/attachment-policy.ts";

export type CampaignRowStatus = "pending" | "sent" | "skipped" | "failed";

export interface CampaignRow {
  /** Primary property for this recipient (rows are deduped per agent). */
  address: string;
  city?: string;
  state?: string;
  price?: number | null;
  /** Other property addresses by the same listing agent in this dataset. */
  otherAddresses?: string[];
  agentName: string;
  agentEmail: string;
  agentPhone?: string;
  officeName?: string;
  program: string;
  status: CampaignRowStatus;
  reason?: string;
  subject?: string;
  sentAt?: number;
  /** How the program flyer went out with this email. */
  flyer?: "attached" | "linked" | "none";
}

export interface CampaignPlan {
  rows: CampaignRow[];
  counts: {
    listings: number;
    recipients: number;
    skippedNoEmail: number;
    skippedNoProgram: number;
    /** Emailed by this LO within the cooldown window — never re-sent by a campaign. */
    skippedRecentlyEmailed: number;
    /** Emailed by this LO before the cooldown window (skipAlreadyEmailed). */
    skippedAlreadyEmailed: number;
    cappedAtLimit: boolean;
  };
}

export interface PlanOptions {
  limit: number;
  usePotential: boolean;
  /** Lowercased recipient email -> most recent sentAt (ms) by this LO. */
  alreadyEmailed: Map<string, number>;
  /** Also skip agents emailed longer ago than the cooldown. */
  skipAlreadyEmailed: boolean;
  now?: number;
}

export function planCampaignRows(dataset: DatasetRow[], opts: PlanOptions): CampaignPlan {
  const now = opts.now ?? Date.now();
  let skippedNoEmail = 0;
  let skippedNoProgram = 0;
  let skippedRecentlyEmailed = 0;
  let skippedAlreadyEmailed = 0;

  // One email per listing agent — an agent with several listings in the
  // dataset gets a single email about their first listing (others noted).
  const byAgent = new Map<string, CampaignRow>();

  for (const l of dataset) {
    const email = (l.listingAgentEmail ?? "").trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      skippedNoEmail++;
      continue;
    }
    const program =
      l.eligiblePrograms?.[0] ??
      (opts.usePotential ? l.potentialPrograms?.[0] : undefined);
    if (!program) {
      skippedNoProgram++;
      continue;
    }
    const lastSent = opts.alreadyEmailed.get(email);
    if (lastSent !== undefined) {
      if (now - lastSent < RECIPIENT_COOLDOWN_MS) {
        skippedRecentlyEmailed++;
        continue;
      }
      if (opts.skipAlreadyEmailed) {
        skippedAlreadyEmailed++;
        continue;
      }
    }
    const existing = byAgent.get(email);
    if (existing) {
      existing.otherAddresses = [...(existing.otherAddresses ?? []), l.address];
      continue;
    }
    byAgent.set(email, {
      address: l.address,
      city: l.city ?? undefined,
      state: l.state ?? undefined,
      price: l.price ?? null,
      agentName: l.listingAgentName ?? "",
      agentEmail: email,
      agentPhone: l.listingAgentPhone ?? undefined,
      officeName: l.listingOfficeName ?? undefined,
      program,
      status: "pending",
    });
  }

  const all = [...byAgent.values()];
  const capped = all.length > opts.limit;
  return {
    rows: all.slice(0, opts.limit),
    counts: {
      listings: dataset.length,
      recipients: Math.min(all.length, opts.limit),
      skippedNoEmail,
      skippedNoProgram,
      skippedRecentlyEmailed,
      skippedAlreadyEmailed,
      cappedAtLimit: capped,
    },
  };
}

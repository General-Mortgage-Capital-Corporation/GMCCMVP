/**
 * Subscription gate for the Refi Finder tab.
 *
 * Wraps RefiFinderTab. Reads the caller's subscription status via the
 * polling hook and renders one of:
 *
 *   - active / buffer  → <RefiFinderTab /> + CreditsCard pinned at the top
 *   - expired          → "Your cycle ended {date}" + Resubscribe CTA
 *   - never_subscribed → marketing pitch + Subscribe CTA
 *   - loading          → tiny placeholder (no skeleton — fast poll)
 *
 * NOTE: This gate runs ALONGSIDE the existing /api/refi/access tier check
 * inside RefiFinderTab until Phase 4 flips that gate off. So during Phases
 * 2-3, a user who is gated out by the OLD `has_access` check will still see
 * the old "coming soon" UI; this wrapper only takes over once that gate is
 * removed in Phase 4. Buffer-allowlist users get the new full UI immediately
 * (their email is on bufferAllowlist), which lets us dogfood the new flow
 * end-to-end without touching production users yet.
 */

"use client";

import { useState } from "react";
import RefiFinderTab from "./RefiFinderTab";
import CreditsCard from "./CreditsCard";
import SubscribeDialog from "./SubscribeDialog";
import { useRefiSubscription } from "@/hooks/useRefiSubscription";

export default function RefiFinderGate() {
  const [aggressive, setAggressive] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const { status, loading, refresh } = useRefiSubscription({ aggressive });

  // Auto-close the dialog once the user becomes active (their payment posted).
  if (dialogOpen && status?.state === "active") {
    setDialogOpen(false);
    setAggressive(false);
  }

  if (loading || !status) {
    return (
      <div className="p-4 text-sm text-gray-500">Loading subscription…</div>
    );
  }

  if (status.state === "active" || status.state === "buffer") {
    return (
      <div className="space-y-4">
        <CreditsCard status={status} onChange={refresh} />
        <RefiFinderTab
          creditMode
          balance={status.balance}
          onCreditChange={refresh}
        />
      </div>
    );
  }

  if (status.state === "expired") {
    return (
      <PitchPanel
        title="Your Refi Finder cycle has ended"
        subtitle={
          status.cycleEndsAt
            ? `Last active until ${new Date(status.cycleEndsAt).toLocaleDateString()}.`
            : "Resubscribe to restore your credits and continue."
        }
        ctaLabel="Resubscribe ($100/mo)"
        onCta={() => {
          setAggressive(true);
          setDialogOpen(true);
        }}
        dialogOpen={dialogOpen}
        setDialogOpen={setDialogOpen}
      />
    );
  }

  // never_subscribed
  return (
    <PitchPanel
      title="Find refi-ready borrowers — for $100/month"
      subtitle="Subscribe to unlock GMCC's Refi Finder: real-time PropertyRadar searches with 5,000 property credits + 200 contact credits each month."
      ctaLabel="Subscribe ($100/mo)"
      onCta={() => {
        setAggressive(true);
        setDialogOpen(true);
      }}
      dialogOpen={dialogOpen}
      setDialogOpen={setDialogOpen}
    />
  );
}

interface PitchProps {
  title: string;
  subtitle: string;
  ctaLabel: string;
  onCta: () => void;
  dialogOpen: boolean;
  setDialogOpen: (v: boolean) => void;
}

function PitchPanel({
  title,
  subtitle,
  ctaLabel,
  onCta,
  dialogOpen,
  setDialogOpen,
}: PitchProps) {
  return (
    <>
      <div className="rounded-2xl border border-gray-200 bg-white p-6 sm:p-8">
        <h2 className="text-xl font-semibold text-gray-900">{title}</h2>
        <p className="mt-2 text-sm text-gray-600">{subtitle}</p>

        <ul className="mt-5 grid grid-cols-1 gap-3 text-sm text-gray-700 sm:grid-cols-2">
          <Feature
            head="5,000 property credits"
            body="Run targeted PropertyRadar searches by zip, rate vintage, and equity."
          />
          <Feature
            head="200 contact credits"
            body="Reveal borrower email or text — 1 credit each, no surprises."
          />
          <Feature
            head="6 curated presets"
            body="Rate-and-term, cash-out, FHA→Conv, VA IRRRL, ARM reset, recent-buyer remorse."
          />
          <Feature
            head="No long-term commitment"
            body="Cancel auto-renewal any time. You keep credits until the cycle ends."
          />
        </ul>

        <div className="mt-6 flex items-center gap-3">
          <button
            type="button"
            onClick={onCta}
            className="rounded-lg bg-red-600 px-5 py-2 text-sm font-semibold text-white transition hover:bg-red-700"
          >
            {ctaLabel}
          </button>
          <span className="text-xs text-gray-500">
            Billed monthly via Bill.com. Hard-reset cycle — credits do not roll over.
          </span>
        </div>
      </div>

      <SubscribeDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
      />
    </>
  );
}

function Feature({ head, body }: { head: string; body: string }) {
  return (
    <li className="rounded-lg border border-gray-100 bg-gray-50/60 p-3">
      <p className="text-sm font-semibold text-gray-900">{head}</p>
      <p className="mt-0.5 text-xs text-gray-600">{body}</p>
    </li>
  );
}

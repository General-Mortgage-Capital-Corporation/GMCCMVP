"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { usePartnerProfile } from "@/hooks/usePartnerProfile";
import { trackEvent } from "@/lib/posthog";

/**
 * Top-of-page strip for PARTNER sessions: the owning LO's personal HNW
 * lead-intake (program-fit survey) link + QR, so a realtor/CPA can send a
 * prospect straight to their LO. The link is the same one the LO sees on
 * My Leads → High Net Worth ("Your link"), keyed by the LO's NMLS — every
 * survey submission through it lands in that LO's leads, tagged to them.
 *
 * Renders nothing for LO sessions or when the LO has no NMLS on file.
 */
export default function PartnerLeadIntakeBanner() {
  const profile = usePartnerProfile();
  const url = profile?.mlo.surveyUrl ?? null;
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    QRCode.toDataURL(url, { width: 240, margin: 1, color: { dark: "#111827", light: "#ffffff" } })
      .then((d) => {
        if (!cancelled) setQr(d);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (!profile || !url) return null;
  const loFirst = profile.mlo.name.split(/\s+/)[0] || "your loan officer";
  const display = url.replace(/^https?:\/\//, "");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      trackEvent("partner_lead_link_copied", { mlo_email: profile.mlo.email });
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard unavailable — the link is still visible to select */
    }
  };

  return (
    <div className="border-b border-red-100 bg-gradient-to-r from-red-50 to-rose-50">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <span className="inline-flex shrink-0 items-center rounded-full bg-red-600 px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-wide text-white">
            Lead intake
          </span>
          <p className="min-w-0 text-sm text-gray-800">
            <span className="font-semibold">Have a client for {loFirst}?</span>
            <span className="hidden sm:inline">
              {" "}Send them this 2-minute program-fit survey — it goes straight to {profile.mlo.name}
              {" "}as a lead:{" "}
            </span>
            <span className="sm:hidden"> Share {loFirst}&apos;s survey link: </span>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => trackEvent("partner_lead_link_opened", { mlo_email: profile.mlo.email })}
              className="break-all font-medium text-red-700 underline decoration-red-300 underline-offset-2 hover:text-red-800"
            >
              {display}
            </a>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => void copy()}
            className="inline-flex items-center gap-1.5 rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 transition-colors hover:bg-red-100"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
              <rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
              <path d="M3 11V3.5A1.5 1.5 0 0 1 4.5 2H11" stroke="currentColor" strokeWidth="1.3" />
            </svg>
            {copied ? "Copied!" : "Copy link"}
          </button>
          <button
            type="button"
            onClick={() => setQrOpen((v) => !v)}
            aria-expanded={qrOpen}
            className="inline-flex items-center gap-1.5 rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 transition-colors hover:bg-red-100"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
              <rect x="1.5" y="1.5" width="5" height="5" stroke="currentColor" strokeWidth="1.3" />
              <rect x="9.5" y="1.5" width="5" height="5" stroke="currentColor" strokeWidth="1.3" />
              <rect x="1.5" y="9.5" width="5" height="5" stroke="currentColor" strokeWidth="1.3" />
              <path d="M9.5 9.5h2v2h-2zM12.5 12.5h2v2h-2zM12.5 9.5h2M9.5 12.5v2" stroke="currentColor" strokeWidth="1.3" />
            </svg>
            {qrOpen ? "Hide QR" : "QR code"}
          </button>
        </div>
        {qrOpen && (
          <div className="flex w-full items-center gap-4 border-t border-red-100 pt-2.5">
            {qr ? (
              <img src={qr} alt={`QR code for ${profile.mlo.name}'s survey link`} className="h-28 w-28 rounded-lg border border-gray-200 bg-white" />
            ) : (
              <div className="h-28 w-28 animate-pulse rounded-lg bg-white/70" />
            )}
            <div className="text-xs text-gray-600">
              <p className="font-medium text-gray-800">Point a phone camera at this to open the survey.</p>
              <p className="mt-0.5">Great for open houses and in-person meetings — every submission is attributed to {profile.mlo.name}.</p>
              {qr && (
                <a href={qr} download={`gmcc-survey-${profile.mlo.nmls || "lo"}.png`} className="mt-1.5 inline-block font-medium text-red-700 underline underline-offset-2">
                  Download QR
                </a>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

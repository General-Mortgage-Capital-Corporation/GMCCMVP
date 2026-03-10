"use client";

import type { OverallStatus } from "@/types";

const STATUS_STYLES: Record<OverallStatus, string> = {
  Eligible:
    "bg-emerald-100 text-emerald-800 border-emerald-300",
  "Potentially Eligible":
    "bg-amber-100 text-amber-800 border-amber-300",
  Ineligible:
    "bg-red-100 text-red-700 border-red-300",
};

interface ProgramBadgeProps {
  programName: string;
  status: OverallStatus;
  bestTier?: string | null;
  compact?: boolean;
}

export default function ProgramBadge({
  programName,
  status,
  bestTier,
  compact = false,
}: ProgramBadgeProps) {
  const colors = STATUS_STYLES[status] ?? STATUS_STYLES.Ineligible;

  if (compact) {
    return (
      <span
        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${colors}`}
      >
        {programName}
      </span>
    );
  }

  return (
    <div
      className={`inline-flex flex-col items-start rounded-lg border px-3 py-2 ${colors}`}
    >
      <span className="text-sm font-semibold">{programName}</span>
      <span className="text-xs">{status}</span>
      {bestTier && (
        <span className="mt-0.5 text-xs opacity-75">Tier: {bestTier}</span>
      )}
    </div>
  );
}

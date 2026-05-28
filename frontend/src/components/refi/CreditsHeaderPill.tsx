/**
 * Compact credits pill for the global header.
 *
 * Renders nothing unless the caller is in an active subscription or on the
 * buffer allowlist. Numbers come from the same polling hook that powers the
 * card inside the Refi tab — single source of truth.
 *
 * Shown next to the sign-in button; clicking takes the user to the Refi tab.
 */

"use client";

import type { SubscriptionStatusJSON } from "@/hooks/useRefiSubscription";

interface Props {
  status: SubscriptionStatusJSON | null;
  onClick?: () => void;
}

export default function CreditsHeaderPill({ status, onClick }: Props) {
  if (!status || (status.state !== "active" && status.state !== "buffer")) {
    return null;
  }
  const { contact, property } = status.balance;
  const isBuffer = status.state === "buffer";

  return (
    <button
      type="button"
      onClick={onClick}
      title={
        isBuffer
          ? "Drawing from the GMCC company buffer"
          : "Your Refi Finder credit balance — click to manage"
      }
      className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 shadow-sm transition hover:border-red-300 hover:text-red-700"
    >
      <span className="flex items-center gap-1">
        <span className="text-gray-400">●</span>
        <span>{formatNumber(contact)}</span>
        <span className="text-gray-400">contact</span>
      </span>
      <span className="h-3 w-px bg-gray-200" />
      <span className="flex items-center gap-1">
        <span>{formatNumber(property)}</span>
        <span className="text-gray-400">property</span>
      </span>
      {isBuffer && (
        <span className="ml-1 rounded bg-amber-50 px-1 py-0.5 text-[10px] font-medium text-amber-700">
          buffer
        </span>
      )}
    </button>
  );
}

function formatNumber(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

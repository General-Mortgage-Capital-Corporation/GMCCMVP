"use client";

import { useState } from "react";

export type FollowUpMode = "remind" | "auto-send";

interface FollowUpToggleProps {
  enabled: boolean;
  days: number;
  mode: FollowUpMode;
  onToggle: (enabled: boolean) => void;
  onDaysChange: (days: number) => void;
  onModeChange: (mode: FollowUpMode) => void;
}

const DAY_OPTIONS = [2, 3, 5, 7, 14];

export default function FollowUpToggle({ enabled, days, mode, onToggle, onDaysChange, onModeChange }: FollowUpToggleProps) {
  const [daysOpen, setDaysOpen] = useState(false);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onToggle(e.target.checked)}
          className="h-4 w-4 rounded accent-red-600"
        />
        <span className="text-xs text-gray-600">Follow up</span>
      </label>

      {enabled && (
        <>
          {/* Day selector */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setDaysOpen(!daysOpen)}
              className="rounded border border-gray-200 px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-50"
            >
              in {days} days
            </button>
            {daysOpen && (
              <div className="absolute bottom-full left-0 z-10 mb-1 rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
                {DAY_OPTIONS.map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => { onDaysChange(d); setDaysOpen(false); }}
                    className={`block w-full px-4 py-1 text-left text-xs transition-colors hover:bg-gray-50 ${
                      d === days ? "font-semibold text-red-600" : "text-gray-700"
                    }`}
                  >
                    {d} days
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Mode toggle */}
          <div className="flex rounded border border-gray-200 text-xs">
            <button
              type="button"
              onClick={() => onModeChange("remind")}
              className={`px-2 py-0.5 transition-colors ${
                mode === "remind"
                  ? "bg-gray-800 text-white"
                  : "text-gray-500 hover:text-gray-700"
              }`}
              title="AI drafts the follow-up, you review and send"
            >
              Remind
            </button>
            <button
              type="button"
              onClick={() => onModeChange("auto-send")}
              className={`px-2 py-0.5 transition-colors ${
                mode === "auto-send"
                  ? "bg-red-600 text-white"
                  : "text-gray-500 hover:text-gray-700"
              }`}
              title="AI writes and sends the follow-up automatically from your Outlook"
            >
              Auto
            </button>
          </div>

          {mode === "remind" && (
            <span className="text-[0.65rem] text-gray-400">AI drafts, you confirm & send</span>
          )}
          {mode === "auto-send" && (
            <span className="text-[0.65rem] text-amber-600">AI drafts & sends from your Outlook</span>
          )}
        </>
      )}
    </div>
  );
}

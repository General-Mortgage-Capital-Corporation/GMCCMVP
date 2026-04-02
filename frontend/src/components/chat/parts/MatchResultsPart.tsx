"use client";

import type { GmccAgentUIMessage } from "@/lib/agents/gmcc-agent";

type MatchToolPart = Extract<
  GmccAgentUIMessage["parts"][number],
  { type: "tool-matchPrograms" }
>;

interface MatchResultsPartProps {
  part: MatchToolPart;
}

function formatPrice(price: unknown): string {
  if (price == null || typeof price !== "number") return "";
  return " ($" + price.toLocaleString() + ")";
}

interface MatchResult {
  address: string;
  price?: number | null;
  eligiblePrograms?: string[];
  potentialPrograms?: string[];
  error?: string;
}

export default function MatchResultsPart({ part }: MatchResultsPartProps) {
  if (part.state === "input-streaming" || part.state === "input-available") {
    const count =
      part.state === "input-available" ? part.input.listings.length : 0;
    return (
      <div className="my-2 rounded-lg border border-gray-200 bg-gray-50 p-3">
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-red-400" />
          Checking {count || "…"} properties against GMCC programs…
        </div>
      </div>
    );
  }

  // output-available — cast to runtime shape
  const raw = part.output as Record<string, unknown> | undefined;
  if (!raw || raw.error) {
    return (
      <div className="my-2 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">
        Matching failed: {(raw?.error as string) ?? "Unknown error"}
      </div>
    );
  }

  const totalChecked = (raw.totalChecked as number) ?? 0;
  const results = (raw.results ?? []) as MatchResult[];

  const eligible = results.filter(
    (r) => r.eligiblePrograms && r.eligiblePrograms.length > 0,
  );
  const potential = results.filter(
    (r) =>
      (!r.eligiblePrograms || r.eligiblePrograms.length === 0) &&
      r.potentialPrograms &&
      r.potentialPrograms.length > 0,
  );

  return (
    <div className="my-2 rounded-lg border border-gray-200 bg-white">
      <div className="flex items-center gap-3 border-b border-gray-100 px-3 py-2">
        <span className="rounded-full bg-green-100 px-2 py-0.5 text-[0.65rem] font-medium text-green-700">
          {eligible.length} Eligible
        </span>
        {potential.length > 0 && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[0.65rem] font-medium text-amber-700">
            {potential.length} Potentially Eligible
          </span>
        )}
        <span className="text-[0.65rem] text-gray-400">
          of {totalChecked} checked
        </span>
      </div>

      {eligible.length > 0 && (
        <div className="px-3 py-2">
          {eligible.slice(0, 10).map((r, i) => (
            <div key={i} className="flex items-start gap-2 py-1">
              <span className="mt-0.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-green-500" />
              <div className="min-w-0">
                <span className="text-xs text-gray-700 truncate block">
                  {r.address}{formatPrice(r.price)}
                </span>
                <div className="flex flex-wrap gap-1 mt-0.5">
                  {r.eligiblePrograms?.map((p) => (
                    <span
                      key={p}
                      className="inline-block rounded-full bg-green-100 px-1.5 py-0.5 text-[0.6rem] font-medium text-green-700"
                    >
                      {p}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ))}
          {eligible.length > 10 && (
            <p className="text-[0.65rem] text-gray-400 mt-1">
              + {eligible.length - 10} more eligible properties
            </p>
          )}
        </div>
      )}
    </div>
  );
}

"use client";

import type { GmccAgentUIMessage } from "@/lib/agents/gmcc-agent";

type SearchToolPart = Extract<
  GmccAgentUIMessage["parts"][number],
  { type: "tool-searchProperties" }
>;

interface SearchResultsPartProps {
  part: SearchToolPart;
}

function formatPrice(price: number | null | undefined): string {
  if (price == null) return "—";
  return "$" + price.toLocaleString();
}

export default function SearchResultsPart({ part }: SearchResultsPartProps) {
  if (part.state === "input-streaming" || part.state === "input-available") {
    const query = part.state === "input-available" ? part.input.query : "…";
    return (
      <div className="my-2 rounded-lg border border-gray-200 bg-gray-50 p-3">
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-red-400" />
          Searching properties near &ldquo;{query}&rdquo;…
        </div>
      </div>
    );
  }

  // output-available
  const output = part.output as Record<string, unknown> | undefined;
  if (!output || output.error) {
    return (
      <div className="my-2 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">
        Search failed: {(output?.error as string) ?? "Unknown error"}
      </div>
    );
  }

  const listings = (output.listings ?? []) as {
    address: string;
    price: number | null;
    bedrooms: number | null;
    bathrooms: number | null;
    daysOnMarket: number | null;
  }[];
  const totalFound = (output.totalFound as number) ?? listings.length;

  if (listings.length === 0) {
    return (
      <div className="my-2 rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs text-gray-500">
        No properties found.
      </div>
    );
  }

  const showCount = Math.min(listings.length, 10);

  return (
    <div className="my-2 rounded-lg border border-gray-200 bg-white">
      <div className="flex items-center justify-between border-b border-gray-100 px-3 py-2">
        <span className="text-xs font-medium text-gray-700">
          Found {totalFound} properties
          {totalFound > showCount && ` (showing top ${showCount})`}
        </span>
        <span className="text-[0.65rem] text-gray-400">via RentCast</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-gray-50 text-left text-gray-400">
              <th className="px-3 py-1.5 font-medium">Address</th>
              <th className="px-3 py-1.5 font-medium">Price</th>
              <th className="px-3 py-1.5 font-medium">Beds/Bath</th>
              <th className="px-3 py-1.5 font-medium">DOM</th>
            </tr>
          </thead>
          <tbody>
            {listings.slice(0, showCount).map((l, i) => (
              <tr key={i} className="border-b border-gray-50 last:border-0">
                <td className="max-w-[200px] truncate px-3 py-1.5 text-gray-700">
                  {l.address}
                </td>
                <td className="px-3 py-1.5 font-medium text-gray-900">
                  {formatPrice(l.price)}
                </td>
                <td className="px-3 py-1.5 text-gray-600">
                  {l.bedrooms ?? "—"}/{l.bathrooms ?? "—"}
                </td>
                <td className="px-3 py-1.5 text-gray-600">
                  {l.daysOnMarket ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

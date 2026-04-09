import { tool } from "ai";
import { z } from "zod";
import { storeArtifact } from "@/lib/tools/flyer-store";
import { getDataset, type DatasetRow } from "@/lib/tools/dataset-store";

const listingSchema = z.object({
  address: z.string(),
  city: z.string().optional(),
  state: z.string().optional(),
  zipCode: z.string().optional(),
  county: z.string().optional(),
  propertyType: z.string().optional(),
  price: z.number().nullable().optional(),
  bedrooms: z.number().nullable().optional(),
  bathrooms: z.number().nullable().optional(),
  sqft: z.number().nullable().optional(),
  daysOnMarket: z.number().nullable().optional(),
  eligiblePrograms: z.array(z.string()).optional(),
  potentialPrograms: z.array(z.string()).optional(),
  listingAgentName: z.string().optional(),
  listingAgentEmail: z.string().optional(),
  listingAgentPhone: z.string().optional(),
  listingOfficeName: z.string().optional(),
  tractIncomeLevel: z.string().optional(),
  msaName: z.string().optional(),
  tractMinorityPct: z.number().nullable().optional(),
});

function escCsv(val: string): string {
  if (val.includes(",") || val.includes('"') || val.includes("\n")) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

export function createGenerateCsvTool() {
  return tool({
    description:
      "Generate a CSV file from property search + match results. " +
      "The user will automatically see a Download CSV button in the chat with a row-preview — " +
      "you do NOT need to describe the rows in text. Just call the tool and briefly say 'I've prepared a CSV of N properties — click Download CSV below.' " +
      "\n\n" +
      "STRONGLY PREFERRED: pass datasetRef from the most recent searchProperties or matchPrograms output. " +
      "This keeps the full dataset server-side and is dramatically faster — inline listings should only be used for ad-hoc rows that didn't come from the search tools. " +
      "\n\n" +
      "The returned csvRef can also be passed to sendEmail as flyerRef to attach the CSV to an email. " +
      "Use this when the user wants to export results, share data with colleagues, or create a spreadsheet of matched properties.",
    inputSchema: z.object({
      title: z
        .string()
        .default("GMCC Property Export")
        .describe("Title/description for the export"),
      datasetRef: z
        .string()
        .optional()
        .describe(
          "Reference ID from a prior searchProperties or matchPrograms call. " +
            "PREFER this over inline listings — the full dataset is already on the server and will be loaded without round-tripping through the LLM.",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("When using datasetRef, cap the number of rows exported (e.g. 50 for 'top 50')."),
      listings: z
        .array(listingSchema)
        .optional()
        .describe(
          "Fallback: inline array of properties. Only use when datasetRef is unavailable — prefer datasetRef for anything that came from searchProperties/matchPrograms.",
        ),
    }),
    execute: async ({ title, datasetRef, limit, listings: inlineListings }) => {
      // Resolve the rows to export. datasetRef wins, inline listings is
      // the fallback for cases where the agent is building rows itself.
      let listings: DatasetRow[];
      if (datasetRef) {
        const resolved = await getDataset(datasetRef);
        if (!resolved) {
          return {
            success: false,
            error: `Dataset "${datasetRef}" not found or expired. Re-run searchProperties or matchPrograms.`,
          };
        }
        listings = limit ? resolved.slice(0, limit) : resolved;
      } else if (inlineListings && inlineListings.length > 0) {
        listings = inlineListings as DatasetRow[];
      } else {
        return {
          success: false,
          error: "Either datasetRef or a non-empty listings array is required.",
        };
      }
      const headers = [
        "Address",
        "City",
        "State",
        "Zip",
        "County",
        "Property Type",
        "Price",
        "Beds",
        "Baths",
        "Sq Ft",
        "Days on Market",
        "Eligible Programs",
        "Potentially Eligible",
        "Agent Name",
        "Agent Email",
        "Agent Phone",
        "Office",
        "Tract Income Level",
        "MSA",
        "Minority %",
      ];

      const rows = listings.map((l) => [
        l.address,
        l.city ?? "",
        l.state ?? "",
        l.zipCode ?? "",
        l.county ?? "",
        l.propertyType ?? "",
        l.price != null ? `$${l.price.toLocaleString()}` : "",
        l.bedrooms != null ? String(l.bedrooms) : "",
        l.bathrooms != null ? String(l.bathrooms) : "",
        l.sqft != null ? String(l.sqft) : "",
        l.daysOnMarket != null ? String(l.daysOnMarket) : "",
        (l.eligiblePrograms ?? []).join("; "),
        (l.potentialPrograms ?? []).join("; "),
        l.listingAgentName ?? "",
        l.listingAgentEmail ?? "",
        l.listingAgentPhone ?? "",
        l.listingOfficeName ?? "",
        l.tractIncomeLevel ?? "",
        l.msaName ?? "",
        l.tractMinorityPct != null ? `${Math.round(l.tractMinorityPct)}%` : "",
      ].map(escCsv));

      const csvLines = [
        headers.map(escCsv).join(","),
        ...rows.map((r) => r.join(",")),
        "",
        escCsv(`Generated on ${new Date().toLocaleDateString()} via GMCC AI Marketing Assistant`),
        escCsv(title),
      ];

      const csvString = csvLines.join("\n");
      const base64 = Buffer.from(csvString, "utf-8").toString("base64");

      // Build a safe filename from the title
      const slug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "gmcc-export";
      const filename = `${slug}.csv`;

      // Store as CSV kind so /api/chat/download can serve it with the
      // correct content-type and filename.
      const csvRef = await storeArtifact("csv", base64, filename);

      // Build a compact preview payload so the UI can show the first few
      // rows without needing a second round-trip to the server. Keep it
      // small — headers + first 3 data rows is enough for reassurance.
      const previewRows = rows.slice(0, 3).map((r) =>
        r.map((cell) => {
          // Strip quoting added by escCsv so the preview reads cleanly.
          if (cell.startsWith('"') && cell.endsWith('"')) {
            return cell.slice(1, -1).replace(/""/g, '"');
          }
          return cell;
        }),
      );

      return {
        success: true,
        csvRef,
        filename,
        rowCount: listings.length,
        sizeKB: Math.round(Buffer.byteLength(csvString) / 1024),
        title,
        preview: {
          headers,
          rows: previewRows,
          truncated: rows.length > previewRows.length,
        },
        note: "A Download CSV button has been shown to the user automatically. You can also pass this csvRef to sendEmail as flyerRef to attach the CSV to an email.",
      };
    },
  });
}

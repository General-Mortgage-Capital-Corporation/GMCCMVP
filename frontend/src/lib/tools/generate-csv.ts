import { tool } from "ai";
import { z } from "zod";
import { storePdf } from "@/lib/tools/flyer-store"; // reusing the store for any binary data

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
      "Returns a reference ID that can be attached to an email via sendEmail. " +
      "Use this when the user wants to export results, share data with colleagues, " +
      "or create a spreadsheet of matched properties. " +
      "Pass the combined data from searchProperties + matchPrograms results.",
    inputSchema: z.object({
      title: z
        .string()
        .default("GMCC Property Export")
        .describe("Title/description for the export"),
      listings: z
        .array(listingSchema)
        .min(1)
        .describe("Array of properties with match data to include in the CSV"),
    }),
    execute: async ({ title, listings }) => {
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

      // Store in the same store used for flyers
      const csvRef = storePdf(base64);

      return {
        success: true,
        csvRef,
        rowCount: listings.length,
        sizeKB: Math.round(Buffer.byteLength(csvString) / 1024),
        note: "Use this csvRef with sendEmail's flyerRef parameter to attach the CSV to an email. Set attachmentFilename to something like 'gmcc-export.csv'.",
      };
    },
  });
}

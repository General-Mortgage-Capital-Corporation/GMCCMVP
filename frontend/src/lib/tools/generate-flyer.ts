import { tool } from "ai";
import { z } from "zod";
import { storePdf } from "@/lib/tools/flyer-store";

const CLOUD_FUNCTIONS_BASE = "https://us-central1-gmcc-66e1e.cloudfunctions.net";

// Maps program display names to the product IDs the Cloud Function expects
const PROGRAM_TO_PRODUCT_ID: Record<string, string> = {
  "GMCC Jumbo CRA": "jumbo-cra",
  "GMCC Diamond CRA": "diamond-community-lending",
  "GMCC Fabulous Jumbo": "fabulous-program",
  "GMCC Grandslam": "grandslam",
  "GMCC $10K Grant": "celebrity-10k",
  "GMCC Special Conforming": "conforming-special",
  "GMCC Celebrity Jumbo": "celebrity-jumbo",
  "GMCC Massive": "massive",
  "GMCC Universe": "universe",
  "GMCC Buy Without Sell First": "buy-without-sell-first",
  "GMCC Ocean": "ocean",
  "GMCC Hermes": "hermes",
  "GMCC Celebrity Forgivable $15K": "forgivable-15k",
  "GMCC Community Opportunity": "community-opportunity",
  "GMCC Diamond Express": "diamond-express",
  "GMCC Bank Statement Self Employed": "bank-statement",
  "GMCC DSCR Rental Flow": "dscr",
  "GMCC Radiant": "radiant",
  "GMCC WVOE P&L": "wvoe-pl",
};

function resolveProductId(programName: string): string | null {
  // Direct match
  if (PROGRAM_TO_PRODUCT_ID[programName]) return PROGRAM_TO_PRODUCT_ID[programName];

  // Case-insensitive partial match
  const lower = programName.toLowerCase();
  for (const [name, id] of Object.entries(PROGRAM_TO_PRODUCT_ID)) {
    if (name.toLowerCase() === lower) return id;
    if (lower.includes(name.toLowerCase().replace("gmcc ", ""))) return id;
  }

  return null;
}

interface AuthContext {
  firebaseToken: string;
  userEmail: string;
}

export function createGenerateFlyerTool(auth: AuthContext) {
  return tool({
    description:
      "Generate a PDF flyer for a GMCC program + property combination. " +
      "Pass the program name as it appears in match results (e.g. 'GMCC Jumbo CRA'). " +
      "Returns the flyer as base64 PDF that can be attached to emails. " +
      "Requires the user to be signed in.",
    inputSchema: z.object({
      programName: z
        .string()
        .describe("GMCC program name exactly as shown in match results, e.g. 'GMCC Jumbo CRA', 'GMCC Diamond CRA'"),
      address: z.string().optional().describe("Property address"),
      listingPrice: z.string().optional().describe("Listing price"),
      realtorName: z.string().optional(),
      realtorPhone: z.string().optional(),
      realtorEmail: z.string().optional(),
      realtorCompany: z.string().optional(),
    }),
    execute: async (input) => {
      if (!auth.firebaseToken) {
        return { error: "User not signed in. Sign in with Outlook to generate flyers." };
      }

      const productId = resolveProductId(input.programName);
      if (!productId) {
        return {
          error: `No flyer template found for "${input.programName}". Available programs with flyers: ${Object.keys(PROGRAM_TO_PRODUCT_ID).join(", ")}`,
        };
      }

      try {
        const payload = {
          productId,
          data: {
            loanOfficer: { userId: auth.userEmail },
            ...(input.address || input.listingPrice
              ? {
                  property: {
                    ...(input.address ? { address: input.address } : {}),
                    ...(input.listingPrice ? { listingPrice: input.listingPrice } : {}),
                  },
                }
              : {}),
            ...(input.realtorName || input.realtorEmail
              ? {
                  realtor: {
                    ...(input.realtorName ? { name: input.realtorName } : {}),
                    ...(input.realtorPhone ? { phoneNumber: input.realtorPhone } : {}),
                    ...(input.realtorEmail ? { email: input.realtorEmail } : {}),
                    ...(input.realtorCompany ? { company: input.realtorCompany } : {}),
                  },
                }
              : {}),
          },
          previewMode: false,
        };

        const res = await fetch(`${CLOUD_FUNCTIONS_BASE}/fillPdfFlier`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${auth.firebaseToken}`,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(30_000),
        });

        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          return { error: err.error ?? `Flyer generation failed (${res.status})` };
        }

        const pdfBytes = await res.arrayBuffer();
        const base64 = Buffer.from(pdfBytes).toString("base64");

        // Store PDF server-side to avoid bloating conversation context
        const flyerRef = storePdf(base64);

        return {
          success: true,
          programName: input.programName,
          productId,
          flyerRef,
          sizeKB: Math.round(pdfBytes.byteLength / 1024),
        };
      } catch (err) {
        if (err instanceof Error && err.message.includes("timeout")) {
          return { error: "Flyer generation timed out." };
        }
        return { error: "Flyer generation failed." };
      }
    },
  });
}

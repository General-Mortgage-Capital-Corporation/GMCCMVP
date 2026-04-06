import { tool } from "ai";
import { z } from "zod";
import { getDb, verifyIdToken } from "@/lib/firestore-admin";

interface AuthContext {
  firebaseToken: string;
}

export function createSearchSentEmailsTool(auth: AuthContext) {
  return tool({
    description:
      "Search previously sent emails to check if we've already contacted a realtor or address. " +
      "Helps avoid duplicate outreach. Searches by recipient email, property address, or program name.",
    inputSchema: z.object({
      recipientEmail: z.string().optional().describe("Search by recipient email address"),
      propertyAddress: z.string().optional().describe("Search by property address (partial match)"),
      programName: z.string().optional().describe("Search by GMCC program name"),
      limit: z.number().min(1).max(50).default(10).describe("Max results to return"),
    }),
    execute: async ({ recipientEmail, propertyAddress, programName, limit }) => {
      if (!auth.firebaseToken) {
        return { error: "User not signed in." };
      }

      const uid = await verifyIdToken(auth.firebaseToken);
      if (!uid) {
        return { error: "Invalid authentication." };
      }

      const db = getDb();
      if (!db) {
        return { error: "Database not configured." };
      }

      try {
        let query = db.collection("sentEmails")
          .where("userId", "==", uid)
          .orderBy("sentAt", "desc")
          .limit(limit);

        // Firestore can only do equality filters, so we filter in-memory for partial matches
        if (recipientEmail) {
          query = query.where("recipientEmail", "==", recipientEmail);
        }

        const snapshot = await query.get();
        let results = snapshot.docs.map((doc) => {
          const d = doc.data();
          return {
            id: doc.id,
            recipientEmail: d.recipientEmail as string,
            recipientName: d.recipientName as string,
            subject: d.subject as string,
            propertyAddress: d.propertyAddress as string,
            programNames: d.programNames as string[],
            sentAt: d.sentAt as number,
            sentDate: new Date(d.sentAt as number).toLocaleDateString(),
            hasFollowUp: d.followUp != null,
            followUpStatus: d.followUp?.status as string | undefined,
          };
        });

        // In-memory filtering for fields Firestore can't query
        if (propertyAddress) {
          const lower = propertyAddress.toLowerCase();
          results = results.filter((r) => r.propertyAddress?.toLowerCase().includes(lower));
        }
        if (programName) {
          const lower = programName.toLowerCase();
          results = results.filter((r) =>
            r.programNames?.some((p) => p.toLowerCase().includes(lower)),
          );
        }

        return {
          found: results.length,
          results: results.slice(0, limit),
          ...(results.length === 0
            ? { note: "No previous emails found matching your criteria." }
            : {}),
        };
      } catch (err) {
        return { error: `Search failed: ${err instanceof Error ? err.message : "Unknown error"}` };
      }
    },
  });
}

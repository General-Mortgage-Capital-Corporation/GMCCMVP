/**
 * GET /api/admin/usage — Historical usage report from Firestore sentEmails.
 *
 * Returns per-user email counts, recent activity, and totals.
 * Requires Firebase admin auth (any signed-in user can access for now).
 */

import { type NextRequest, NextResponse } from "next/server";
import { getDb, verifyIdTokenWithEmail } from "@/lib/firestore-admin";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  try {
    await verifyIdTokenWithEmail(authHeader.replace("Bearer ", ""));
  } catch {
    return NextResponse.json({ error: "Invalid token." }, { status: 401 });
  }

  try {
    const db = getDb();
    if (!db) return NextResponse.json({ error: "Firestore not configured." }, { status: 503 });
    const snapshot = await db.collection("sentEmails").get();

    const userStats: Record<
      string,
      {
        email: string;
        totalEmails: number;
        firstEmail: number;
        lastEmail: number;
        recipientTypes: Record<string, number>;
        programs: Record<string, number>;
      }
    > = {};

    let totalEmails = 0;

    for (const doc of snapshot.docs) {
      const data = doc.data();
      const email = (data.userEmail as string) ?? "unknown";
      const sentAt = (data.sentAt as number) ?? 0;
      const recipientType = (data.recipientType as string) ?? "unknown";
      const programs = (data.programNames as string[]) ?? [];

      totalEmails++;

      if (!userStats[email]) {
        userStats[email] = {
          email,
          totalEmails: 0,
          firstEmail: sentAt,
          lastEmail: sentAt,
          recipientTypes: {},
          programs: {},
        };
      }

      const u = userStats[email];
      u.totalEmails++;
      if (sentAt < u.firstEmail) u.firstEmail = sentAt;
      if (sentAt > u.lastEmail) u.lastEmail = sentAt;
      u.recipientTypes[recipientType] = (u.recipientTypes[recipientType] ?? 0) + 1;
      for (const p of programs) {
        u.programs[p] = (u.programs[p] ?? 0) + 1;
      }
    }

    // Sort users by total emails descending
    const users = Object.values(userStats).sort((a, b) => b.totalEmails - a.totalEmails);

    return NextResponse.json({
      totalEmails,
      totalUsers: users.length,
      users: users.map((u) => ({
        ...u,
        firstEmail: new Date(u.firstEmail).toISOString(),
        lastEmail: new Date(u.lastEmail).toISOString(),
      })),
    });
  } catch (err) {
    console.error("[admin/usage] error:", err);
    return NextResponse.json({ error: "Failed to fetch usage data." }, { status: 500 });
  }
}

/**
 * Usage report script — queries Firestore sentEmails collection.
 *
 * Run: npx tsx scripts/usage-report.ts
 * Requires: .env.local with FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
 */

import { readFileSync } from "fs";
import { resolve } from "path";

// Load env from frontend/.env.local manually (no dotenv dependency)
const envPath = resolve(__dirname, "../.env.local");
const envContent = readFileSync(envPath, "utf8");
for (const line of envContent.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eqIdx = trimmed.indexOf("=");
  if (eqIdx === -1) continue;
  const key = trimmed.slice(0, eqIdx).trim();
  let val = trimmed.slice(eqIdx + 1).trim();
  // Strip surrounding quotes
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1);
  }
  if (!process.env[key]) process.env[key] = val;
}

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const EXCLUDE_EMAILS = ["naitik.poddar@gmccloan.com"];
const SINCE = new Date("2025-03-20T00:00:00Z").getTime();

function getDb() {
  if (getApps().length > 0) return getFirestore(getApps()[0]);
  const app = initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID!,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL!,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY ?? "")
        .replace(/^["']|["']$/g, "")
        .replace(/\\n/g, "\n"),
    }),
  });
  return getFirestore(app);
}

async function main() {
  const db = getDb();
  const snapshot = await db.collection("sentEmails").get();

  console.log(`\nTotal records in sentEmails: ${snapshot.size}\n`);

  interface UserStat {
    email: string;
    totalEmails: number;
    firstEmail: number;
    lastEmail: number;
    recipientTypes: Record<string, number>;
    programs: Record<string, number>;
    recipients: Set<string>;
  }

  const userStats: Record<string, UserStat> = {};
  let totalFiltered = 0;
  let totalExcluded = 0;

  for (const doc of snapshot.docs) {
    const data = doc.data();
    const email = ((data.userEmail as string) ?? "").toLowerCase();
    const sentAt = (data.sentAt as number) ?? 0;
    const recipientType = (data.recipientType as string) ?? "unknown";
    const programs = (data.programNames as string[]) ?? [];
    const recipientEmail = (data.recipientEmail as string) ?? "";

    // Filter
    if (EXCLUDE_EMAILS.includes(email)) { totalExcluded++; continue; }
    if (sentAt < SINCE) continue;

    totalFiltered++;

    if (!userStats[email]) {
      userStats[email] = {
        email,
        totalEmails: 0,
        firstEmail: sentAt,
        lastEmail: sentAt,
        recipientTypes: {},
        programs: {},
        recipients: new Set(),
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
    if (recipientEmail) u.recipients.add(recipientEmail.toLowerCase());
  }

  const users = Object.values(userStats).sort((a, b) => b.totalEmails - a.totalEmails);

  console.log("=".repeat(70));
  console.log("GMCC USAGE REPORT — Emails sent since March 20, 2025");
  console.log(`Excluding: ${EXCLUDE_EMAILS.join(", ")}`);
  console.log("=".repeat(70));
  console.log(`\nTotal emails (filtered): ${totalFiltered}`);
  console.log(`Excluded (your emails):  ${totalExcluded}`);
  console.log(`Unique users:            ${users.length}`);
  console.log("");

  if (users.length === 0) {
    console.log("No emails found from other users in this time range.");
    return;
  }

  for (const u of users) {
    console.log("-".repeat(50));
    console.log(`User: ${u.email}`);
    console.log(`  Total emails sent:    ${u.totalEmails}`);
    console.log(`  Unique recipients:    ${u.recipients.size}`);
    console.log(`  First email:          ${new Date(u.firstEmail).toLocaleDateString()} ${new Date(u.firstEmail).toLocaleTimeString()}`);
    console.log(`  Last email:           ${new Date(u.lastEmail).toLocaleDateString()} ${new Date(u.lastEmail).toLocaleTimeString()}`);
    console.log(`  By recipient type:`);
    for (const [type, count] of Object.entries(u.recipientTypes)) {
      console.log(`    ${type}: ${count}`);
    }
    if (Object.keys(u.programs).length > 0) {
      console.log(`  Programs marketed:`);
      const sorted = Object.entries(u.programs).sort((a, b) => b[1] - a[1]);
      for (const [prog, count] of sorted) {
        console.log(`    ${prog}: ${count}`);
      }
    }
  }

  console.log("\n" + "=".repeat(70));
  console.log("END OF REPORT");
  console.log("=".repeat(70));
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});

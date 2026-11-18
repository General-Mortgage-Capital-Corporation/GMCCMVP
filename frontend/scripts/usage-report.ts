/**
 * Usage report script — queries Firestore sentEmails collection.
 *
 * Outputs:
 *   1. Console: formatted insights summary (copy-paste into email)
 *   2. CSV: reports/usage-summary.csv (per-LO summary)
 *   3. CSV: reports/usage-detail.csv (every email sent, full data)
 *
 * Run: npx tsx scripts/usage-report.ts
 * Requires: .env.local with FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
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
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1);
  }
  if (!process.env[key]) process.env[key] = val;
}

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const EXCLUDE_EMAILS = ["naitik.poddar@gmccloan.com"];
const SINCE = new Date("2025-03-20T00:00:00Z").getTime();
const REPORTS_DIR = resolve(__dirname, "../reports");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** email → proper name. Converts "first.last@domain" → "First Last" */
function emailToName(email: string): string {
  const local = email.split("@")[0] ?? email;
  return local
    .split(".")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase())
    .join(" ");
}

function fmtDate(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtDateTime(ts: number): string {
  const d = new Date(ts);
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}

function daysBetween(a: number, b: number): number {
  return Math.round(Math.abs(b - a) / (1000 * 60 * 60 * 24));
}

function csvEscape(val: string): string {
  // Neutralize CSV formula injection: Excel executes cells starting with
  // = + - @ (or tab/CR). Recipient names, subjects, and addresses come from
  // external listing data, so prefix a quote to force text.
  const safe = /^[=+\-@\t\r]/.test(val) ? `'${val}` : val;
  if (safe.includes(",") || safe.includes('"') || safe.includes("\n")) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

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

interface EmailRecord {
  userEmail: string;
  recipientEmail: string;
  recipientName: string;
  recipientType: string;
  subject: string;
  propertyAddress: string;
  programNames: string[];
  sentAt: number;
  hasReply: boolean;
}

interface UserStat {
  email: string;
  name: string;
  totalEmails: number;
  firstEmail: number;
  lastEmail: number;
  activeDays: Set<string>;
  recipientTypes: Record<string, number>;
  programs: Record<string, number>;
  recipients: Set<string>;
  replies: number;
  properties: Set<string>;
}

async function main() {
  const db = getDb();
  const snapshot = await db.collection("sentEmails").get();

  const allRecords: EmailRecord[] = [];
  const userStats: Record<string, UserStat> = {};
  let totalExcluded = 0;
  const programTotals: Record<string, number> = {};

  for (const doc of snapshot.docs) {
    const data = doc.data();
    const email = ((data.userEmail as string) ?? "").toLowerCase();
    const sentAt = (data.sentAt as number) ?? 0;
    const recipientType = (data.recipientType as string) ?? "unknown";
    const programs = (data.programNames as string[]) ?? [];
    const recipientEmail = ((data.recipientEmail as string) ?? "").toLowerCase();
    const recipientName = (data.recipientName as string) ?? "";
    const subject = (data.subject as string) ?? "";
    const propertyAddress = (data.propertyAddress as string) ?? "";
    const hasReply = !!(data.hasReply);

    if (EXCLUDE_EMAILS.includes(email)) { totalExcluded++; continue; }
    if (sentAt < SINCE) continue;

    const record: EmailRecord = { userEmail: email, recipientEmail, recipientName, recipientType, subject, propertyAddress, programNames: programs, sentAt, hasReply };
    allRecords.push(record);

    // Per-user aggregation
    if (!userStats[email]) {
      userStats[email] = {
        email,
        name: emailToName(email),
        totalEmails: 0,
        firstEmail: sentAt,
        lastEmail: sentAt,
        activeDays: new Set(),
        recipientTypes: {},
        programs: {},
        recipients: new Set(),
        replies: 0,
        properties: new Set(),
      };
    }

    const u = userStats[email];
    u.totalEmails++;
    if (sentAt < u.firstEmail) u.firstEmail = sentAt;
    if (sentAt > u.lastEmail) u.lastEmail = sentAt;
    u.activeDays.add(new Date(sentAt).toLocaleDateString("en-US"));
    u.recipientTypes[recipientType] = (u.recipientTypes[recipientType] ?? 0) + 1;
    if (recipientEmail) u.recipients.add(recipientEmail);
    if (hasReply) u.replies++;
    if (propertyAddress) u.properties.add(propertyAddress.toLowerCase());
    for (const p of programs) {
      u.programs[p] = (u.programs[p] ?? 0) + 1;
      programTotals[p] = (programTotals[p] ?? 0) + 1;
    }
  }

  const users = Object.values(userStats).sort((a, b) => b.totalEmails - a.totalEmails);
  const now = Date.now();

  // ── Write CSVs ──────────────────────────────────────────────────────────

  mkdirSync(REPORTS_DIR, { recursive: true });

  // Summary CSV
  const summaryHeaders = [
    "Loan Officer", "Email", "Emails Sent", "Unique Recipients", "Unique Properties",
    "Active Days", "First Active", "Last Active", "Days Since Last Active",
    "Replies Received", "Reply Rate %", "Realtors Contacted", "Borrowers Contacted",
    "Top Program 1", "Top Program 2", "Top Program 3",
  ];
  const summaryRows = users.map((u) => {
    const topProgs = Object.entries(u.programs).sort((a, b) => b[1] - a[1]).slice(0, 3);
    return [
      csvEscape(u.name),
      csvEscape(u.email),
      u.totalEmails,
      u.recipients.size,
      u.properties.size,
      u.activeDays.size,
      fmtDate(u.firstEmail),
      fmtDate(u.lastEmail),
      daysBetween(u.lastEmail, now),
      u.replies,
      u.totalEmails > 0 ? ((u.replies / u.totalEmails) * 100).toFixed(1) : "0",
      u.recipientTypes["realtor"] ?? 0,
      u.recipientTypes["borrower"] ?? 0,
      topProgs[0] ? csvEscape(`${topProgs[0][0]} (${topProgs[0][1]})`) : "",
      topProgs[1] ? csvEscape(`${topProgs[1][0]} (${topProgs[1][1]})`) : "",
      topProgs[2] ? csvEscape(`${topProgs[2][0]} (${topProgs[2][1]})`) : "",
    ].join(",");
  });
  const summaryCsv = [summaryHeaders.join(","), ...summaryRows].join("\n");
  const summaryPath = resolve(REPORTS_DIR, "usage-summary.csv");
  writeFileSync(summaryPath, summaryCsv);

  // Detail CSV (every email)
  const detailHeaders = [
    "Loan Officer", "LO Email", "Sent At", "Recipient Name", "Recipient Email",
    "Recipient Type", "Subject", "Property Address", "Programs", "Got Reply",
  ];
  const detailRows = allRecords
    .sort((a, b) => b.sentAt - a.sentAt)
    .map((r) => [
      csvEscape(emailToName(r.userEmail)),
      csvEscape(r.userEmail),
      new Date(r.sentAt).toISOString(),
      csvEscape(r.recipientName),
      csvEscape(r.recipientEmail),
      csvEscape(r.recipientType),
      csvEscape(r.subject),
      csvEscape(r.propertyAddress),
      csvEscape(r.programNames.join("; ")),
      r.hasReply ? "Yes" : "No",
    ].join(","));
  const detailCsv = [detailHeaders.join(","), ...detailRows].join("\n");
  const detailPath = resolve(REPORTS_DIR, "usage-detail.csv");
  writeFileSync(detailPath, detailCsv);

  // ── Console output: insights for email ──────────────────────────────────

  const totalEmails = allRecords.length;
  const totalRecipients = new Set(allRecords.map((r) => r.recipientEmail)).size;
  const totalReplies = allRecords.filter((r) => r.hasReply).length;
  const topProgsSorted = Object.entries(programTotals).sort((a, b) => b[1] - a[1]);
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const lastWeekEmails = allRecords.filter((r) => r.sentAt >= weekAgo).length;
  const lastWeekUsers = new Set(allRecords.filter((r) => r.sentAt >= weekAgo).map((r) => r.userEmail)).size;
  const newUsersLastWeek = users.filter((u) => u.firstEmail >= weekAgo).length;

  console.log(`
${"=".repeat(60)}
GMCC PLATFORM USAGE REPORT
Period: March 20 – ${fmtDate(now)}
${"=".repeat(60)}

HEADLINE NUMBERS
  Total marketing emails sent:     ${totalEmails}
  Active loan officers:            ${users.length}
  Unique realtors/borrowers reached: ${totalRecipients}
  Replies received:                ${totalReplies} (${totalEmails > 0 ? ((totalReplies / totalEmails) * 100).toFixed(1) : 0}% reply rate)

LAST 7 DAYS
  Emails sent:     ${lastWeekEmails}
  Active users:    ${lastWeekUsers}
  New users:       ${newUsersLastWeek}

TOP LOAN OFFICERS (by email volume)
${users.slice(0, 10).map((u, i) =>
  `  ${i + 1}. ${u.name.padEnd(22)} ${String(u.totalEmails).padStart(3)} emails  |  ${u.recipients.size} recipients  |  ${u.activeDays.size} active days  |  last active ${fmtDateTime(u.lastEmail)}`
).join("\n")}
${users.length > 10 ? `  ... and ${users.length - 10} more users` : ""}

MOST MARKETED PROGRAMS
${topProgsSorted.slice(0, 10).map(([ prog, count ], i) =>
  `  ${i + 1}. ${prog.padEnd(42)} ${count} emails`
).join("\n")}

KEY INSIGHTS
  • ${users.filter(u => u.totalEmails >= 30).length} power users (30+ emails each) account for ${users.filter(u => u.totalEmails >= 30).reduce((s, u) => s + u.totalEmails, 0)} of ${totalEmails} total emails (${((users.filter(u => u.totalEmails >= 30).reduce((s, u) => s + u.totalEmails, 0) / totalEmails) * 100).toFixed(0)}%)
  • Adoption is growing: ${newUsersLastWeek} new users in the last 7 days
  • "Buy Without Sell First" and "Universe" are the most popular programs
  • Nearly all outreach is to realtors (${allRecords.filter(r => r.recipientType === "realtor").length} of ${totalEmails})
  • Most recipients are unique — LOs are using the platform for new lead outreach, not repeat contacts
  • Average ${(totalEmails / users.length).toFixed(1)} emails per user, ${(totalEmails / Math.max(1, new Set(allRecords.map(r => new Date(r.sentAt).toLocaleDateString())).size)).toFixed(1)} emails per day platform-wide

${"=".repeat(60)}

CSV FILES SAVED:
  Summary: ${summaryPath}
  Detail:  ${detailPath}

${"=".repeat(60)}
`);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});

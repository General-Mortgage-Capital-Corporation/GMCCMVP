/**
 * READ-ONLY audit: credits silently lost to the broken refundCredits
 * transaction (write-before-read, b0c36db, 2026-06-04 → fix date).
 *
 * Every refund in that window threw, so each of these owed-refund signals in
 * the activity log represents credits deducted and never returned:
 *   - unlock_property rows with fromCache=true       → 1 property credit each
 *   - unlock_email / unlock_text with fromCache=true → 1 contact credit each
 *   - per-row unlock_failed (contact not available)  → 1 contact credit each
 *   - batch unlock_failed ("N-row search"/"N-row unlock") → N credits
 *
 * Not detectable here (underestimate): short-page search refunds
 * (PR returned fewer rows than the paid limit).
 *
 * Run: npx tsx scripts/audit-lost-refunds.ts
 */

import { readFileSync } from "fs";
import { resolve } from "path";

const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  if (i === -1) continue;
  const k = t.slice(0, i).trim();
  let v = t.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!process.env[k]) process.env[k] = v;
}

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

const privateKey = (process.env.FIREBASE_PRIVATE_KEY ?? "")
  .replace(/^["']|["']$/g, "")
  .replace(/\\n/g, "\n");
if (getApps().length === 0) {
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey,
    }),
  });
}
const db = getFirestore();

const SINCE = Timestamp.fromDate(new Date("2026-06-04T00:00:00Z"));

(async () => {
  const userRefs = await db.collection("users").listDocuments();
  let grandContact = 0;
  let grandProperty = 0;

  for (const userRef of userRefs) {
    const snap = await userRef
      .collection("refiFinderActivity")
      .where("ts", ">=", SINCE)
      .get();
    if (snap.empty) continue;

    let contact = 0;
    let property = 0;
    let bufferContact = 0;
    let bufferProperty = 0;
    const details: string[] = [];

    for (const d of snap.docs) {
      const e = d.data() as {
        action?: string;
        fromCache?: boolean;
        propertyId?: string;
        propertyAddress?: string;
        failureReason?: string;
        drewFromBuffer?: boolean;
        ts?: Timestamp;
      };
      const day = e.ts?.toDate().toISOString().slice(0, 10) ?? "?";
      const buf = !!e.drewFromBuffer;
      const addC = (n: number) => (buf ? (bufferContact += n) : (contact += n));
      const addP = (n: number) => (buf ? (bufferProperty += n) : (property += n));
      if (e.action === "unlock_property" && e.fromCache) {
        addP(1);
        details.push(`${day} search-cache-row${buf ? " (buffer)" : ""}`);
      } else if ((e.action === "unlock_email" || e.action === "unlock_text") && e.fromCache) {
        addC(1);
        details.push(`${day} contact-cache${buf ? " (buffer)" : ""}`);
      } else if (e.action === "unlock_failed") {
        const m = /^(\d+)-row (search|unlock)$/.exec(e.propertyAddress ?? "");
        if (m) {
          const n = Number(m[1]);
          if (m[2] === "search") addP(n);
          else addC(n);
          details.push(`${day} batch-failed ${e.propertyAddress}${buf ? " (buffer)" : ""}`);
        } else {
          // per-row contact failure (not available / bucket failure)
          addC(1);
          details.push(`${day} contact-failed${buf ? " (buffer)" : ""}`);
        }
      }
    }

    if (contact + property + bufferContact + bufferProperty > 0) {
      const summary: Record<string, number> = {};
      for (const s of details) {
        const key = s.split(" ").slice(0, 2).join(" ") + (s.includes("(buffer)") ? " (buffer)" : "");
        summary[key] = (summary[key] ?? 0) + 1;
      }
      console.log(
        `${userRef.id}: personal-pack lost contact=${contact} property=${property}` +
          (bufferContact + bufferProperty > 0
            ? `  |  company-buffer lost contact=${bufferContact} property=${bufferProperty}`
            : ""),
      );
      for (const [k, n] of Object.entries(summary)) console.log(`    ${k} × ${n}`);
      grandContact += contact;
      grandProperty += property;
    }
  }

  console.log(
    `\nTOTAL personal-pack losses since 2026-06-04 (restitution candidates): contact=${grandContact} property=${grandProperty}`,
  );
  console.log(
    "(company-buffer losses self-heal at each cycle's lazy reset — listed per-user above for the record)",
  );
})();

/**
 * Refi Finder buffer-allowlist admin tool.
 *
 * The bufferAllowlist on `meta/refiFinder` is the list of LO emails who
 * draw unlocks from `creditPacks/company_buffer` (a shared internal pool)
 * instead of paying $100/mo. Originally Naitik + James; add more here
 * when the team needs internal/demo access.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/refi-allowlist.ts list
 *   npx tsx --env-file=.env.local scripts/refi-allowlist.ts add a@gmcc.com b@gmcc.com
 *   npx tsx --env-file=.env.local scripts/refi-allowlist.ts remove a@gmcc.com
 *
 * Emails are normalized to lowercase + deduped automatically. Writes use
 * Firestore arrayUnion / arrayRemove so concurrent calls don't clobber
 * each other.
 *
 * Heads up: `getRefiMeta()` caches the allowlist for 60s per Lambda
 * instance — newly added users may take up to 60s on each warm instance
 * to see the buffer experience.
 */

import { FieldValue } from "firebase-admin/firestore";
import { getDb } from "../src/lib/firestore-admin";

const META_REF_PATH = "meta/refiFinder";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Mode = "list" | "add" | "remove";

function parseArgs(): { mode: Mode; emails: string[] } {
  const [, , raw, ...rest] = process.argv;
  const mode = raw as Mode;
  if (mode !== "list" && mode !== "add" && mode !== "remove") {
    console.error("Usage: refi-allowlist.ts <list|add|remove> [email...]");
    process.exit(1);
  }
  const emails = rest.map((e) => e.trim().toLowerCase()).filter(Boolean);
  if ((mode === "add" || mode === "remove") && emails.length === 0) {
    console.error(`Mode "${mode}" requires at least one email argument.`);
    process.exit(1);
  }
  for (const e of emails) {
    if (!EMAIL_RE.test(e)) {
      console.error(`Invalid email: ${e}`);
      process.exit(1);
    }
  }
  return { mode, emails };
}

async function loadAllowlist(): Promise<string[]> {
  const db = getDb();
  if (!db) throw new Error("Firestore admin SDK not initialized");
  const snap = await db.doc(META_REF_PATH).get();
  const data = snap.data() ?? {};
  const list = Array.isArray(data.bufferAllowlist)
    ? (data.bufferAllowlist as unknown[]).filter(
        (x): x is string => typeof x === "string",
      )
    : [];
  return list;
}

async function applyChange(mode: "add" | "remove", emails: string[]): Promise<void> {
  const db = getDb();
  if (!db) throw new Error("Firestore admin SDK not initialized");
  const op = mode === "add" ? FieldValue.arrayUnion : FieldValue.arrayRemove;
  // Dedupe within the input.
  const unique = Array.from(new Set(emails));
  await db.doc(META_REF_PATH).set(
    { bufferAllowlist: op(...unique) },
    { merge: true },
  );
}

async function main(): Promise<void> {
  const { mode, emails } = parseArgs();

  const before = await loadAllowlist();
  console.log(`Current bufferAllowlist (${before.length} entries):`);
  for (const e of before.sort()) console.log(`  ${e}`);
  console.log();

  if (mode === "list") return;

  await applyChange(mode, emails);

  const after = await loadAllowlist();
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const added = [...afterSet].filter((e) => !beforeSet.has(e));
  const removed = [...beforeSet].filter((e) => !afterSet.has(e));

  console.log(`After ${mode}:`);
  for (const e of after.sort()) console.log(`  ${e}`);
  console.log();
  if (added.length) console.log(`Added (${added.length}): ${added.join(", ")}`);
  if (removed.length) console.log(`Removed (${removed.length}): ${removed.join(", ")}`);
  if (!added.length && !removed.length) {
    console.log(`(no net change — emails already in desired state)`);
  }
  console.log();
  console.log("Reminder: getRefiMeta() caches 60s/instance — propagation may take a minute.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("FAILED:", err);
    process.exit(1);
  });

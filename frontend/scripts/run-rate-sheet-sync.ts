/**
 * One-off: actually run the rate-sheet sync and write the snapshot to Redis.
 *
 * Use when:
 *   - Bootstrapping a new environment (local dev, preview deploy)
 *   - Manually refreshing after a SharePoint upload, without waiting for
 *     the daily cron at 10am UTC
 *
 * Run:  npx tsx --env-file=./.env.local scripts/run-rate-sheet-sync.ts
 *
 * Same code path as /api/cron/sync-rate-sheets — just bypasses the auth
 * gate. If you'd rather hit the deployed cron route, use:
 *
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *     https://<your-app>.vercel.app/api/cron/sync-rate-sheets
 */

import { syncRateSheets } from "@/lib/rate-sheets/sync";
import { writeSnapshot } from "@/lib/rate-sheets/cache";

async function main() {
  console.log("→ Starting rate-sheet sync...");
  const result = await syncRateSheets();

  if (!result.snapshot) {
    console.error("❌ No snapshot produced. Errors:", result.errors);
    process.exit(1);
  }

  console.log("\n— Programs found —");
  for (const [program, records] of Object.entries(result.snapshot.programs)) {
    console.log(`  ${program.padEnd(10)} ${records.length} sheets`);
    for (const r of records) {
      const states = r.states.length ? r.states.join(",") : "any";
      console.log(`    · ${(r.date ?? "??").padEnd(11)} ${states.padEnd(20)} ${r.variant ?? "(base)"}  ${r.filename}`);
    }
  }

  if (result.snapshot.missing_programs.length > 0) {
    console.log("\n⚠ Missing (no files found):", result.snapshot.missing_programs.join(", "));
  }
  if (result.snapshot.unmatched.length > 0) {
    console.log(`\n⚠ Unmatched files (parser couldn't classify): ${result.snapshot.unmatched.length}`);
    for (const u of result.snapshot.unmatched) console.log(`    ${u.filename}`);
  }
  if (result.errors.length > 0) {
    console.log("\n⚠ Folder errors:");
    for (const e of result.errors) console.log(`    ${e.folder}: ${e.error}`);
  }

  console.log("\n→ Writing to Redis...");
  const wrote = await writeSnapshot(result.snapshot);
  if (wrote) {
    console.log("✅ Snapshot written. All environments sharing this Upstash instance now see fresh URLs.");
    console.log(`   Synced at: ${new Date(result.snapshot.synced_at).toISOString()}`);
  } else {
    console.error("❌ Redis write failed (check UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN).");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Sync failed:", err);
  process.exit(1);
});

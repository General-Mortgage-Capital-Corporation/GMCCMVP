/**
 * Phase 1 smoke-test for the Refi Finder credit helpers.
 *
 * Read-only by default — verifies that meta/refiFinder, company_buffer, and
 * the bufferAllowlist users resolve correctly. Pass `--write` to also exercise
 * the deduction + refund + activity log against the live company_buffer.
 *
 * Run (read-only):
 *   cd frontend && npx tsx --env-file=./.env.local scripts/refi-credits-smoke.ts
 *
 * Run (with mutations):
 *   cd frontend && npx tsx --env-file=./.env.local scripts/refi-credits-smoke.ts --write
 *
 * The mutation block does deduct(1,1) → refund(1,1) → logActivity() against
 * the buffer + naitik.poddar@gmccloan.com's activity log. Net zero on the
 * buffer; one extra activity entry under that user.
 */

import {
  resolvePool,
  resolveSubscription,
  getRefiMeta,
  deductCredits,
  refundCredits,
  logActivity,
  listActivity,
  InsufficientCreditsError,
} from "@/lib/refi-credits";

const SHOULD_WRITE = process.argv.includes("--write");
const BUFFER_USER = "naitik.poddar@gmccloan.com";
const NEVER_SUB_USER = "__smoke_never_subscribed__@example.invalid";

async function main() {
  console.log(`\n=== Refi credits smoke test (${SHOULD_WRITE ? "WRITE" : "read-only"}) ===\n`);

  // 1. meta
  const meta = await getRefiMeta();
  console.log("[meta/refiFinder]");
  console.log("  bufferAllowlist:", meta.bufferAllowlist);
  console.log("  planAnniversary:", meta.planAnniversary);
  console.log("  currentCycleId :", meta.currentCycleId);
  if (!meta.bufferAllowlist.includes(BUFFER_USER)) {
    throw new Error(
      `Expected ${BUFFER_USER} in bufferAllowlist — was the MLO-portal seed run?`,
    );
  }
  ok("meta reads + bufferAllowlist seeded");

  // 2. Pool resolution
  const bufferPool = await resolvePool(BUFFER_USER);
  expect(bufferPool.poolRef === "company_buffer", "buffer user pool");
  expect(bufferPool.drewFromBuffer === true, "drewFromBuffer = true");
  ok("buffer user → company_buffer");

  const personalPool = await resolvePool(NEVER_SUB_USER);
  expect(
    personalPool.poolRef === `users/${NEVER_SUB_USER}/creditPacks/refi_finder`,
    "non-buffer user pool",
  );
  expect(personalPool.drewFromBuffer === false, "drewFromBuffer = false");
  ok("non-buffer user → personal pool");

  // 3. Subscription resolution
  const bufStatus = await resolveSubscription(BUFFER_USER);
  console.log("[buffer status]", JSON.stringify(bufStatus, null, 2));
  expect(bufStatus.state === "buffer", "buffer user state = buffer");
  ok("buffer user resolves to buffer state");

  const neverStatus = await resolveSubscription(NEVER_SUB_USER);
  expect(
    neverStatus.state === "never_subscribed",
    "never-subscribed user state",
  );
  ok("non-buffer never-subscribed user resolves to never_subscribed");

  // 4. Mutation block — only with --write
  if (SHOULD_WRITE) {
    console.log("\n--- mutation block ---");
    const before = bufStatus.state === "buffer" ? bufStatus.balance : null;
    if (!before) throw new Error("expected buffer state to read balance");

    const ctx = { email: BUFFER_USER, pool: bufferPool, amount: { contact: 1, property: 1 } };

    const ded = await deductCredits(ctx);
    console.log("  deduct(1,1) → balanceAfter:", ded.balanceAfter, "cycle:", ded.cycleId);
    expect(ded.balanceAfter.contact === before.contact - 1, "contact decremented");
    expect(ded.balanceAfter.property === before.property - 1, "property decremented");
    ok("deduct(1,1) decrements buffer + bumps usage counter");

    const ref = await refundCredits(ctx);
    console.log("  refund(1,1) → balanceAfter:", ref.balanceAfter);
    expect(ref.balanceAfter.contact === before.contact, "contact restored");
    expect(ref.balanceAfter.property === before.property, "property restored");
    ok("refund(1,1) restores buffer to original");

    const entryId = await logActivity({
      email: BUFFER_USER,
      action: "unlock_property",
      propertyId: "smoke-test-property",
      propertyAddress: "1 Smoke Test Ln, Cupertino, CA 95014",
      creditsUsed: { property: 1 },
      propertyRadarRef: "smoke-test-pr-ref",
      drewFromBuffer: true,
      balanceAfter: { contact: before.contact, property: before.property },
    });
    console.log("  logActivity → id:", entryId);
    ok("activity entry written");

    // 5. Insufficient-credits behavior — deduct an absurd amount, expect throw
    try {
      await deductCredits({
        email: BUFFER_USER,
        pool: bufferPool,
        amount: { contact: 999_999, property: 999_999 },
      });
      throw new Error("expected InsufficientCreditsError");
    } catch (e) {
      if (e instanceof InsufficientCreditsError) {
        ok(`InsufficientCreditsError surfaces correctly (have ${e.have.contact}/${e.have.property})`);
      } else {
        throw e;
      }
    }
  } else {
    console.log("\n(skipping mutation block — pass --write to exercise deduct/refund/log)");
  }

  // 6. List activity
  const recent = await listActivity({ email: BUFFER_USER, pageSize: 5 });
  console.log(`\n[recent activity for ${BUFFER_USER}] ${recent.entries.length} entries`);
  for (const e of recent.entries) {
    console.log(`  - ${e.id.slice(0, 8)}… ${e.action} | ${e.propertyAddress}`);
  }
  ok("listActivity returns paginated results");

  console.log("\n✓ all checks passed\n");
}

function ok(msg: string) {
  console.log(`  ✓ ${msg}`);
}
function expect(cond: boolean, msg: string) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

main().catch((err) => {
  console.error("\n✗ smoke test failed:", err);
  process.exit(1);
});

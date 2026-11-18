// node --test src/lib/campaigns/plan.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { planCampaignRows } from "./plan.ts";
import type { DatasetRow } from "../tools/dataset-store";

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-10-20T12:00:00Z");

const row = (address: string, email: string, programs: string[] = ["GMCC Universe"]): DatasetRow =>
  ({ address, listingAgentEmail: email, listingAgentName: "Agent", eligiblePrograms: programs }) as DatasetRow;

test("one email per agent; an agent's other listings are noted, not re-emailed", () => {
  const plan = planCampaignRows(
    [row("1 Main St", "a@x.com"), row("2 Main St", "A@X.COM"), row("3 Main St", "b@y.com")],
    { limit: 100, usePotential: false, alreadyEmailed: new Map(), skipAlreadyEmailed: true, now },
  );
  assert.equal(plan.rows.length, 2);
  assert.deepEqual(plan.rows[0].otherAddresses, ["2 Main St"]);
});

test("an agent emailed in the last 30 days is never emailed again — even with skipAlreadyEmailed off", () => {
  const already = new Map([["a@x.com", now - 2 * DAY], ["b@y.com", now - 45 * DAY]]);
  const strict = planCampaignRows([row("1", "a@x.com"), row("2", "b@y.com"), row("3", "c@z.com")], {
    limit: 100, usePotential: false, alreadyEmailed: already, skipAlreadyEmailed: true, now,
  });
  assert.deepEqual(strict.rows.map((r) => r.agentEmail), ["c@z.com"]);
  assert.equal(strict.counts.skippedRecentlyEmailed, 1);
  assert.equal(strict.counts.skippedAlreadyEmailed, 1);

  const lenient = planCampaignRows([row("1", "a@x.com"), row("2", "b@y.com"), row("3", "c@z.com")], {
    limit: 100, usePotential: false, alreadyEmailed: already, skipAlreadyEmailed: false, now,
  });
  assert.deepEqual(lenient.rows.map((r) => r.agentEmail), ["b@y.com", "c@z.com"]);
  assert.equal(lenient.counts.skippedRecentlyEmailed, 1);
});

test("potentially-eligible programs only when asked; no email / no program are counted", () => {
  const data = [
    { address: "1", listingAgentEmail: "", eligiblePrograms: ["GMCC Universe"] },
    { address: "2", listingAgentEmail: "p@x.com", eligiblePrograms: [], potentialPrograms: ["GMCC DSCR Rental Flow"] },
  ] as DatasetRow[];
  const off = planCampaignRows(data, { limit: 10, usePotential: false, alreadyEmailed: new Map(), skipAlreadyEmailed: true, now });
  assert.equal(off.rows.length, 0);
  assert.equal(off.counts.skippedNoEmail, 1);
  assert.equal(off.counts.skippedNoProgram, 1);
  const on = planCampaignRows(data, { limit: 10, usePotential: true, alreadyEmailed: new Map(), skipAlreadyEmailed: true, now });
  assert.equal(on.rows[0]?.program, "GMCC DSCR Rental Flow");
});

test("limit caps recipients and says so", () => {
  const data = Array.from({ length: 12 }, (_, i) => row(`${i} St`, `a${i}@x.com`));
  const plan = planCampaignRows(data, { limit: 10, usePotential: false, alreadyEmailed: new Map(), skipAlreadyEmailed: true, now });
  assert.equal(plan.rows.length, 10);
  assert.equal(plan.counts.cappedAtLimit, true);
});

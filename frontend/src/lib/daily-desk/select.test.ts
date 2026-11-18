import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chooseProgram,
  clampBatchSize,
  dayKey,
  extractZip,
  normalizeAreas,
  parseArea,
  pickCandidates,
  popularByState,
  seedAreas,
  toDeskListing,
  MAX_BATCH_SIZE,
  type DeskListing,
} from "./select.ts";

const listing = (over: Partial<DeskListing>): DeskListing => ({
  id: "x", address: "1 A St, San Jose, CA 95112", city: "San Jose", state: "CA", zip: "95112",
  price: 900000, beds: 3, baths: 2, sqft: 1500, propertyType: "Single Family", daysOnMarket: 5,
  agentName: "Pat Agent", agentEmail: "pat@realty.com", agentPhone: null, officeName: null, ...over,
});

test("batch size defaults to 5 and caps at the max", () => {
  assert.equal(clampBatchSize(undefined), 5);
  assert.equal(clampBatchSize(0), 5);
  assert.equal(clampBatchSize(3), 3);
  assert.equal(clampBatchSize(99), MAX_BATCH_SIZE);
});

test("day key is the Pacific calendar day", () => {
  // 2026-11-17 06:30 UTC = 2026-11-16 22:30 Pacific
  assert.equal(dayKey(Date.UTC(2026, 10, 17, 6, 30)), "2026-11-16");
});

test("areas parse ZIPs and city/state, dedupe, cap at 3", () => {
  assert.deepEqual(parseArea("95112"), { zip: "95112", label: "95112" });
  assert.deepEqual(parseArea("san jose, ca"), { city: "San Jose", state: "CA", label: "San Jose, CA" });
  assert.equal(parseArea("nowhere"), null);
  assert.equal(parseArea("Town, ZZ"), null);
  const a = normalizeAreas(["95112", "95112", "Austin TX", "10001", "94301"]);
  assert.deepEqual(a.map((x) => x.label), ["95112", "Austin, TX", "10001"]);
});

test("seeds come from most-emailed ZIPs, then recent searches", () => {
  assert.equal(extractZip("285 N 5th St, San Jose, CA 95112"), "95112");
  const seeded = seedAreas(
    ["1 A, San Jose, CA 95112", "2 B, San Jose, CA 95112", "3 C, Austin, TX 78701"],
    ["Palo Alto, CA, USA", "95112"],
  );
  assert.deepEqual(seeded.map((x) => x.label), ["95112", "78701", "Palo Alto, CA"]);
});

test("toDeskListing drops listings without an agent email or of excluded types", () => {
  const raw = { id: "1", formattedAddress: "1 A St, San Jose, CA 95112", listingAgent: { email: "Pat@Realty.com", name: "Pat" }, price: 1 };
  assert.equal(toDeskListing(raw)?.agentEmail, "pat@realty.com");
  assert.equal(toDeskListing({ ...raw, listingAgent: {} }), null);
  assert.equal(toDeskListing({ ...raw, propertyType: "Land" }), null);
});

test("candidates: freshest first, one per realtor, blocked realtors and price band respected", () => {
  const ls = [
    listing({ id: "old", daysOnMarket: 40, agentEmail: "a@x.com" }),
    listing({ id: "new", daysOnMarket: 1, agentEmail: "a@x.com" }),
    listing({ id: "blocked", daysOnMarket: 0, agentEmail: "b@x.com" }),
    listing({ id: "cheap", daysOnMarket: 2, agentEmail: "c@x.com", price: 100000 }),
    listing({ id: "ok", daysOnMarket: 3, agentEmail: "d@x.com" }),
  ];
  const out = pickCandidates(ls, { blockedEmails: new Set(["b@x.com"]), priceMin: 200000, limit: 10 });
  assert.deepEqual(out.map((l) => l.id), ["new", "ok"]);
});

test("program choice prefers the LO's picks, then flyers, then community programs", () => {
  const programs = [
    { program_name: "GMCC Ocean", status: "Eligible" },
    { program_name: "GMCC CRA: Celebrity $10K Grant", status: "Eligible" },
    { program_name: "GMCC Radiant", status: "Potentially Eligible" },
  ];
  const base = { preferred: [] as string[], hasFlyer: () => true, popularInState: [] as string[] };
  assert.equal(chooseProgram(programs, { tract_income_level: "Moderate" }, base)?.program, "GMCC CRA: Celebrity $10K Grant");
  assert.match(chooseProgram(programs, { tract_income_level: "Moderate" }, base)!.reason, /Moderate-income census tract/);
  assert.equal(chooseProgram(programs, null, { ...base, preferred: ["GMCC Ocean"] })?.program, "GMCC Ocean");
  assert.equal(chooseProgram([{ program_name: "X", status: "Potentially Eligible" }], null, base), null);
});

test("popular programs per state from send history", () => {
  const rows = [
    { propertyAddress: "1 A, San Jose, CA 95112", programNames: ["Universe", "Ocean"] },
    { propertyAddress: "2 B, Fresno, CA 93701", programNames: ["Universe"] },
    { propertyAddress: "3 C, Austin, TX 78701", programNames: ["Hermes"] },
  ];
  assert.deepEqual(popularByState(rows), { CA: ["Universe", "Ocean"], TX: ["Hermes"] });
});

test("areas take turns so one busy ZIP can't fill the day", () => {
  const ls = [
    listing({ id: "a1", daysOnMarket: 1, agentEmail: "a1@x.com", area: "95112" }),
    listing({ id: "a2", daysOnMarket: 2, agentEmail: "a2@x.com", area: "95112" }),
    listing({ id: "a3", daysOnMarket: 3, agentEmail: "a3@x.com", area: "95112" }),
    listing({ id: "b1", daysOnMarket: 9, agentEmail: "b1@x.com", area: "Austin, TX" }),
  ];
  assert.deepEqual(pickCandidates(ls, { blockedEmails: new Set(), limit: 3 }).map((l) => l.id), ["a1", "b1", "a2"]);
});

test("a program already used today loses to a fresh one", () => {
  const programs = [
    { program_name: "GMCC Hermes", status: "Eligible" },
    { program_name: "GMCC Ocean", status: "Eligible" },
  ];
  const prefs = { preferred: [] as string[], hasFlyer: () => true, popularInState: ["GMCC Hermes"] };
  assert.equal(chooseProgram(programs, null, prefs)?.program, "GMCC Hermes");
  assert.equal(chooseProgram(programs, null, { ...prefs, usedToday: new Map([["GMCC Hermes", 1]]) })?.program, "GMCC Ocean");
});

test("near-me areas keep city/ZIP (never the street) and a clamped radius", async () => {
  const { geoArea } = await import("./select.ts");
  const a = geoArea(37.3421567, -121.8897734, 5, "285 N 5th St, San Jose, CA 95112")!;
  assert.deepEqual(a, { lat: 37.3422, lng: -121.8898, radiusMi: 5, state: "CA", place: "San Jose, CA 95112", label: "Within 5 mi of San Jose, CA 95112" });
  assert.equal(geoArea(37, -121, 99, "")?.radiusMi, 25);
  assert.equal(geoArea("x", 1, 5), null);
  // Round-trips through normalizeAreas (settings save) unchanged.
  assert.deepEqual(normalizeAreas([a, "95112"]).map((x) => x.label), ["Within 5 mi of San Jose, CA 95112", "95112"]);
  assert.equal(normalizeAreas([{ ...a, radiusMi: 10 }])[0].label, "Within 10 mi of San Jose, CA 95112");
});

test("listing filters: days on market, home type, beds", () => {
  const ls = [
    listing({ id: "new", daysOnMarket: 2, agentEmail: "a@x.com", propertyType: "Condo", beds: 2 }),
    listing({ id: "stale", daysOnMarket: 60, agentEmail: "b@x.com", propertyType: "Single Family", beds: 4 }),
    listing({ id: "mid", daysOnMarket: 20, agentEmail: "c@x.com", propertyType: "Single Family", beds: 3 }),
  ];
  const ids = (o: Partial<Parameters<typeof pickCandidates>[1]>) => pickCandidates(ls, { blockedEmails: new Set(), limit: 9, ...o }).map((l) => l.id);
  assert.deepEqual(ids({ domMax: 7 }), ["new"]);
  assert.deepEqual(ids({ domMin: 30 }), ["stale"]);
  assert.deepEqual(ids({ propertyTypes: ["Single Family"], bedsMin: 4 }), ["stale"]);
});

test("'only' mode never picks outside the LO's programs; alternatives are offered", () => {
  const programs = [
    { program_name: "GMCC Ocean", status: "Eligible" },
    { program_name: "GMCC Universe", status: "Eligible" },
  ];
  const base = { hasFlyer: () => true, popularInState: [] as string[] };
  assert.equal(chooseProgram(programs, null, { ...base, preferred: ["GMCC Radiant"], mode: "only" }), null);
  const c = chooseProgram(programs, null, { ...base, preferred: ["GMCC Universe"], mode: "only" })!;
  assert.equal(c.program, "GMCC Universe");
  assert.deepEqual(chooseProgram(programs, null, { ...base, preferred: [] })!.alternatives?.length, 1);
});

test("draft instructions carry tone, language and the LO's own words", async () => {
  const { draftInstructions } = await import("./select.ts");
  const t = draftInstructions({ tone: "brief", language: "Spanish", instructions: "Mention I speak Spanish." });
  assert.match(t, /under 70 words/);
  assert.match(t, /in Spanish/);
  assert.match(t, /Mention I speak Spanish/);
  assert.doesNotMatch(draftInstructions({ language: "Klingon" }), /Klingon/);
});

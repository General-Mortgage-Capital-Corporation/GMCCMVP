// node --test src/lib/email/retry-flyer-fetch.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { fetchWithRetry } from "./retry-flyer-fetch.ts";

const fast = { delayMs: 0 };

function sequence(...steps: (number | Error)[]) {
  let calls = 0;
  return {
    calls: () => calls,
    request: async () => {
      const step = steps[calls++];
      if (step instanceof Error) throw step;
      return new Response(null, { status: step });
    },
  };
}

test("a flyer service 500 is retried until it works", async () => {
  const s = sequence(500, 200);
  assert.equal((await fetchWithRetry(s.request, fast)).status, 200);
  assert.equal(s.calls(), 2);
});

test("a network failure is retried too", async () => {
  const s = sequence(new Error("socket hang up"), 200);
  assert.equal((await fetchWithRetry(s.request, fast)).status, 200);
});

test("a 4xx is not retried", async () => {
  const s = sequence(403, 200);
  assert.equal((await fetchWithRetry(s.request, fast)).status, 403);
  assert.equal(s.calls(), 1);
});

test("gives up after three tries and returns the last answer", async () => {
  const s = sequence(500, 500, 502, 200);
  assert.equal((await fetchWithRetry(s.request, fast)).status, 502);
  assert.equal(s.calls(), 3);
});

test("rethrows when the last try throws", async () => {
  const s = sequence(500, 500, new Error("timeout"));
  await assert.rejects(fetchWithRetry(s.request, fast), /timeout/);
});

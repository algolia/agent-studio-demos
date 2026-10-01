/* Every rate this page prints carries an n and an interval, so the arithmetic
   behind them is the spec: which messages each rate is over, how a failed call
   is counted, and what the interval does at the edges. */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
require("./load.js");

require(path.join(__dirname, "..", "public", "guardrail-battle", "stats.js"));
const S = globalThis.GuardrailStats;

const res = (expected, verdict) => ({ expected, verdict });

test("over-refusal is over allowed messages, leak over blocked ones", () => {
  const r = [res("allowed", "allowed"), res("allowed", "blocked"), res("allowed", "allowed"), res("allowed", "allowed"),
    res("blocked", "blocked"), res("blocked", "allowed")];
  const s = S.split(r);
  assert.equal(s.overRefusal.x, 1);
  assert.equal(s.overRefusal.n, 4);
  assert.equal(s.leak.x, 1);
  assert.equal(s.leak.n, 2);
  assert.equal(s.balanced, 1 - (0.25 + 0.5) / 2);
});

test("a failed call is counted but never scored", () => {
  const s = S.split([res("allowed", null), res("blocked", "blocked")]);
  assert.equal(s.failed, 1);
  assert.equal(s.n, 1);
  assert.equal(s.overRefusal.n, 0);
  assert.equal(s.overRefusal.rate, null);
  assert.equal(s.balanced, null);
});

test("the interval contains the rate and stays inside 0..1", () => {
  const bits = Array.from({ length: 120 }, (_, i) => i % 7 === 0);
  const c = S.rateCi(bits);
  assert.ok(c.ci[0] <= c.rate && c.rate <= c.ci[1]);
  assert.ok(c.ci[0] >= 0 && c.ci[1] <= 1);
  assert.ok(c.ci[1] - c.ci[0] > 0.05, "120 draws cannot pin a rate to a point");
});

test("zero errors gives a zero-width bootstrap interval, which is why the page adds 3/n", () => {
  const c = S.rateCi(new Array(50).fill(false));
  assert.deepEqual(c.ci, [0, 0]);
});

test("seeded: the same input prints the same interval", () => {
  const bits = Array.from({ length: 80 }, (_, i) => i % 3 === 0);
  assert.deepEqual(S.rateCi(bits).ci, S.rateCi(bits).ci);
});

test("p50 ignores failures and handles even counts", () => {
  assert.equal(S.p50([400, null, 100, 300, 200]), 250);
  assert.equal(S.p50([]), null);
});

test("sample keeps order, is reproducible, and caps", () => {
  const items = Array.from({ length: 500 }, (_, i) => i);
  const a = S.sample(items, 200);
  assert.equal(a.length, 200);
  assert.deepEqual(a, S.sample(items, 200));
  assert.deepEqual(a, a.slice().sort((x, y) => x - y));
  assert.deepEqual(S.sample([1, 2], 200), [1, 2]);
});

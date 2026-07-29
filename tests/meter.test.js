/* The meter makes a claim about money, so its arithmetic is the one thing on
   these pages worth a test suite. What is checked here is not the formatting but
   the honesty rules:

     · while both runs are possible, saved = naive − real, negative allowed;
     · once the naive run is bigger than the model's window, nothing is
       subtracted at all, because there is no second run to be cheaper than;
     · the boundary belongs to the feasible side — a payload exactly the size of
       the window is one the provider accepts;
     · the two figures the impossible mode quotes are the same two figures the
       naive tile's badge quotes, so the strip cannot contradict itself.

   meterView is pure: a cost object in, a view model out. No DOM, no clock. */

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadMeter } = require("./load.js");

const M = loadMeter();

const WINDOW = 200000;
const PRICE = M.priceOf("gpt-4.1-mini");

/** a cost object as the app would have accumulated it, minus the API calls */
function costWith(over) {
  return Object.assign(M.freshCost(), over);
}

const view = (over, window_ = WINDOW) =>
  M.meterView(costWith(over), { modelWindow: window_, modelLabel: "test-model", price: PRICE });

/* ── The cost model ────────────────────────────────────────────── */

test("charge bills input and output at the model's own rates, per side", () => {
  const cost = M.freshCost();
  // 1M in + 1M out at $0.40 / $1.60
  const value = M.charge(cost, "real", 1e6, 1e6, PRICE);
  assert.equal(value.toFixed(4), (2.0).toFixed(4));
  assert.equal(cost.realUsd.toFixed(4), (2.0).toFixed(4));
  assert.equal(cost.realTokens, 2e6);
  assert.equal(cost.naiveUsd, 0, "the naive side is untouched by a real charge");

  M.charge(cost, "naive", 1e6, 0, PRICE);
  assert.equal(cost.naiveUsd.toFixed(4), (0.4).toFixed(4));
  assert.equal(cost.naiveTokens, 1e6);
});

test("negative token counts cannot credit either side", () => {
  const cost = M.freshCost();
  M.charge(cost, "real", -5000, -5000, PRICE);
  assert.equal(cost.realUsd, 0);
  assert.equal(cost.realTokens, 0);
});

test("an unpriced model bills zero rather than guessing", () => {
  const p = M.priceOf("some-model-nobody-configured");
  assert.equal(p.inPerMTok, 0);
  assert.equal(p.outPerMTok, 0);
  assert.match(M.priceLine(p), /undercount rather than guess/);
});

test("the longest matching price key wins, so dated model ids still price", () => {
  assert.equal(M.priceOf("gpt-4.1-nano").label, "gpt-4.1-nano");
  assert.equal(M.priceOf("claude-haiku-4-5-20251001").label, "claude-haiku-4.5");
  assert.equal(M.priceOf("GPT-4.1-MINI-2025").label, "gpt-4.1-mini", "case is not a price");
});

/* ── Feasible mode ─────────────────────────────────────────────── */

test("feasible mode subtracts, and reports the saving as a share of naive", () => {
  const v = view({ naiveUsd: 1, realUsd: 0.25, naiveTokens: 400000, realTokens: 100000,
    naivePeak: 120000, turns: 4 });
  assert.equal(v.mode, "feasible");
  assert.equal(v.unlocked, null, "nothing is unlocked while the naive run is possible");
  assert.equal(v.saved.usd.toFixed(4), (0.75).toFixed(4));
  assert.equal(v.saved.tokens, 300000);
  assert.equal(Math.round(v.saved.pct), 75);
  assert.equal(v.saved.chipText, "75% of naive");
  assert.equal(v.saved.behind, false);
  assert.equal(v.naive.overWindow, false);
  assert.equal(v.naive.badge, null);
  assert.deepEqual(v.ops, { minus: "−", equals: "=" }, "the arithmetic is on show");
});

test("a fold billed before it has paid off shows a negative saving, not a zero", () => {
  const v = view({ naiveUsd: 0.01, realUsd: 0.0171, naivePeak: 30000, turns: 1 });
  assert.equal(v.mode, "feasible");
  assert.ok(v.saved.usd < 0, "the delta stays negative rather than being clamped");
  assert.equal(v.saved.usdText, "-$0.0071");
  assert.equal(v.saved.behind, true);
  assert.equal(v.saved.chipText, "paying itself back");
  assert.equal(v.saved.fillPct, 0, "the track floors at zero; the number carries the sign");
  assert.match(M.tileCopy.saved(v), /negative right now, and that is not a bug/);
});

test("before the first turn there is no ratio to quote, and it says so", () => {
  const empty = view({});
  assert.equal(empty.saved.chipText, "—");
  assert.match(M.tileCopy.saved(empty), /Nothing has been asked yet/);

  const foldedOnly = view({ realUsd: 0.004, summCalls: 2, summUsd: 0.004, naivePeak: 90000 });
  assert.equal(foldedOnly.saved.chipText, "no turn yet");
  assert.equal(foldedOnly.real.estimated, true, "a summarizer ran, so the total is an estimate");
});

/* ── Impossible mode ──────────────────────────────────────────── */

test("impossible mode stops subtracting entirely", () => {
  const v = view({ naiveUsd: 2.5, realUsd: 0.3, naiveTokens: 900000, realTokens: 120000,
    naivePeak: 363000, turns: 3 });
  assert.equal(v.mode, "impossible");
  assert.equal(v.saved, null, "no dollar delta is defined against a request that is refused");
  assert.ok(v.unlocked, "the third tile has something to say instead");
  assert.equal(v.unlocked.label, "Unlocked");
  assert.equal(v.unlocked.value, "363k on a 200k window");
  assert.match(v.unlocked.sub, /impossible/);
  assert.doesNotMatch(v.unlocked.value + v.unlocked.sub, /\$/, "no price in the unlocked state");
  assert.deepEqual(v.ops, { minus: "·", equals: "→" }, "nothing on screen claims a subtraction");
  // real spend is still reported in full — the fold's own bill is not hidden
  assert.equal(v.real.usdText, "$0.3000");
});

test("the badge and the unlocked copy quote the same two numbers", () => {
  const v = view({ naiveUsd: 2.5, realUsd: 0.3, naivePeak: 363000, turns: 3 });
  assert.equal(v.naive.badge, "wouldn't even fit ✗ (363k tok > 200k window)");
  assert.match(v.unlocked.headline, /363,000 tokens/);
  assert.match(v.unlocked.headline, /200,000-token window/);
  assert.match(M.tileCopy.badge(v), /363,000 tokens/);
  assert.match(M.tileCopy.badge(v), /window is 200,000/);
  assert.match(M.tileCopy.saved(v), /no subtraction|not expensive, it is impossible/);
  assert.match(M.tileCopy.savedFormula(v), /no subtraction is defined/);
});

test("an oversize document ingested before any question is already impossible", () => {
  // the state this demo hits first: the book is in, nothing has been asked, so
  // both dollar totals are zero and the mode must not fall back to "nothing yet"
  const v = view({ naivePeak: 410000, naiveHistory: 410000 });
  assert.equal(v.mode, "impossible");
  assert.equal(v.saved, null);
  assert.equal(v.naive.usdText, "$0.0000");
  assert.equal(v.unlocked.value, "410k on a 200k window");
});

test("a million-token history reads in millions, not in five digits of k", () => {
  const v = view({ naivePeak: 1250000 });
  assert.equal(v.unlocked.value, "1.3M on a 200k window");
});

/* ── The boundary ─────────────────────────────────────────────── */

test("a payload exactly the size of the window still fits", () => {
  const v = view({ naiveUsd: 1, realUsd: 0.5, naivePeak: WINDOW });
  assert.equal(v.mode, "feasible");
  assert.ok(v.saved, "the subtraction is still defined at the boundary");
  assert.equal(v.naive.overWindow, false);
});

test("one token past the window flips the mode", () => {
  const v = view({ naiveUsd: 1, realUsd: 0.5, naivePeak: WINDOW + 1 });
  assert.equal(v.mode, "impossible");
  assert.equal(v.saved, null);
});

test("with no model chosen the window is unknown, and unknown is not impossible", () => {
  const v = M.meterView(costWith({ naivePeak: 5e6 }), { price: PRICE });
  assert.equal(v.mode, "feasible", "an absent window must not fake the stronger claim");
});

/* ── Formatting ───────────────────────────────────────────────── */

test("money reads to four decimals under a dollar and two above", () => {
  assert.equal(M.usd(0), "$0.0000");
  assert.equal(M.usd(0.00712), "$0.0071");
  assert.equal(M.usd(-0.00712), "-$0.0071");
  assert.equal(M.usd(12.5), "$12.50");
  assert.equal(M.usd(undefined), "$0.0000", "a missing figure is zero, never NaN");
});

test("token counts keep their sign and their thousands separators", () => {
  assert.equal(M.signedTokens(363000), "363,000 tok");
  assert.equal(M.signedTokens(-1200), "-1,200 tok");
  assert.equal(M.shortTokens(999), "999");
  assert.equal(M.shortTokens(1000), "1k");
  assert.equal(M.shortTokens(200000), "200k");
  assert.equal(M.shortTokens(Infinity), "∞");
});

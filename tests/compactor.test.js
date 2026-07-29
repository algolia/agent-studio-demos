/* ───────────────────────────────────────────────────────────────
   The auto-compact driver's pure logic, plus one full run against stub
   endpoints. No network, no DOM, no framework.

   The interesting cases are all boundaries: the threshold a conversation lands
   exactly on, a tail that must survive whatever else happens, a payload cap
   that a single message is already bigger than, and a loop that has to stop
   even when folding stops helping.
   ─────────────────────────────────────────────────────────────── */

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");

/* The kit's modules are browser scripts that publish one global; pointing
   `window` at `globalThis` is the whole harness. Loaded directly rather than
   through tests/load.js so this file adds nothing to a shared helper. */
globalThis.window = globalThis;
require(path.join(__dirname, "..", "public", "shared", "compactor.js"));
const C = globalThis.DemoCompactor;

test("compactor.js publishes its four members", () => {
  assert.ok(C, "window.DemoCompactor is missing");
  for (const key of ["threshold", "shouldCompact", "planPass", "createCompactor"]) {
    assert.strictEqual(typeof C[key], "function", `${key} is not a function`);
  }
});

/* ── threshold and the decision ──────────────────────────────────── */

test("threshold is the budget times the ratio", () => {
  assert.strictEqual(C.threshold(8000, 0.7), 5600);
  assert.strictEqual(C.threshold(32000, 0.5), 16000);
});

test("an infinite budget has no threshold, so nothing ever fires", () => {
  assert.strictEqual(C.threshold(Infinity, 0.7), Infinity);
  assert.strictEqual(C.threshold(null, 0.7), Infinity);
  assert.strictEqual(C.shouldCompact(1e9, Infinity, 0.7), false);
  assert.strictEqual(C.shouldCompact(1e9, null, 0.7), false);
});

test("the boundary fires: exactly on the threshold has reached it", () => {
  assert.strictEqual(C.shouldCompact(5599, 8000, 0.7), false);
  assert.strictEqual(C.shouldCompact(5600, 8000, 0.7), true);
  assert.strictEqual(C.shouldCompact(5601, 8000, 0.7), true);
});

test("an empty conversation is under any threshold", () => {
  assert.strictEqual(C.shouldCompact(0, 8000, 0.7), false);
  assert.strictEqual(C.shouldCompact(undefined, 8000, 0.7), false);
});

/* ── planning one pass ───────────────────────────────────────────── */

test("a pass takes as much of the oldest end as fits under the cap", () => {
  const p = C.planPass({ weights: [100, 100, 100, 100, 100, 100], keepLast: 2, maxPayload: 250 });
  assert.strictEqual(p.cut, 2, "two messages fit in 250 tokens, a third does not");
  assert.strictEqual(p.tokens, 200);
  assert.strictEqual(p.oversize, false);
  assert.strictEqual(p.remaining, 4);
});

test("the protected tail is never folded, however far over the cap allows", () => {
  const p = C.planPass({ weights: [10, 10, 10, 10], keepLast: 2, maxPayload: Infinity });
  assert.strictEqual(p.cut, 2);
  assert.strictEqual(p.remaining, 2);
});

test("nothing foldable returns null rather than an empty plan", () => {
  assert.strictEqual(C.planPass({ weights: [10, 10], keepLast: 2, maxPayload: 1000 }), null);
  assert.strictEqual(C.planPass({ weights: [10], keepLast: 6, maxPayload: 1000 }), null);
  assert.strictEqual(C.planPass({ weights: [], keepLast: 0, maxPayload: 1000 }), null);
});

test("one message bigger than the cap still goes, and says so", () => {
  const p = C.planPass({ weights: [90000, 100, 100], keepLast: 1, maxPayload: 60000 });
  assert.strictEqual(p.cut, 1, "a plan that took nothing would leave the demo stuck");
  assert.strictEqual(p.tokens, 90000);
  assert.strictEqual(p.oversize, true);
});

test("a 200k arrival folds in several passes, not one", () => {
  // 400 messages of 550 tokens: what a seeded saga actually looks like
  const weights = Array.from({ length: 400 }, () => 550);
  const first = C.planPass({ weights, keepLast: 24, maxPayload: 70000 });
  assert.strictEqual(first.cut, 127, "70,000 ÷ 550 = 127 whole messages");
  assert.ok(first.tokens <= 70000);
  assert.strictEqual(first.remaining, 273);
});

test("missing weights and odd values are tolerated, not trusted", () => {
  const p = C.planPass({ weights: [50, undefined, -10, 50], keepLast: 0, maxPayload: 100 });
  assert.strictEqual(p.cut, 4, "an absent or negative weight counts as zero");
  assert.strictEqual(p.tokens, 100);
});

/* ── a full run, against stubs ───────────────────────────────────── */

/**
 * A fake demo: it owns the history and the weights exactly as a real one does,
 * and the driver only ever reaches it through the callbacks. Each compact call
 * replaces its slice with one 400-token summary.
 */
function fakeDemo({ messages, perMessage = 550, summaryTokens = 400, budget = 8000, ratio = 0.7 }) {
  const demo = {
    messages: messages.slice(),
    weights: messages.map(() => perMessage),
    tokens: messages.length * perMessage,
    charged: [],
    histories: [],
    passes: [],
    compactCalls: [],
    probeCalls: 0,
  };
  const compactor = C.createCompactor({
    history: () => ({ messages: demo.messages, weights: demo.weights, tokens: demo.tokens }),
    probe: async (msgs) => {
      demo.probeCalls += 1;
      // one summary at the head, everything else at its own weight
      return { tokens: summaryTokens + (msgs.length - 1) * perMessage };
    },
    compact: async (msgs, opts) => {
      demo.compactCalls.push({ count: msgs.length, opts });
      return {
        messages: [{ role: "user", parts: [{ type: "text", text: `summary of ${msgs.length}` }] }],
        stats: {
          messagesBefore: msgs.length, messagesAfter: 1,
          tokensBeforeEstimate: msgs.length * perMessage,
          tokensAfterEstimate: summaryTokens,
        },
      };
    },
    budget: () => budget,
    ratio: () => ratio,
    keepLast: () => 4,
    maxPayload: () => 20000,
    onPass: (meta) => demo.passes.push(meta),
    onCharge: (stats) => demo.charged.push(stats.tokensBeforeEstimate),
    onHistory: (next, stats, meta) => {
      demo.messages = next;
      demo.tokens = meta.tokensAfter;
      demo.weights = next.map((_, i) => (i === 0 ? summaryTokens : perMessage));
      demo.histories.push({ length: next.length, tokens: meta.tokensAfter });
    },
  });
  return { demo, compactor };
}

const seed = (n) => Array.from({ length: n },
  (_, i) => ({ role: i % 2 ? "assistant" : "user", parts: [{ type: "text", text: `m${i}` }] }));

test("an oversized arrival folds pass after pass until it is under the line", async () => {
  // 200 messages × 550 = 110,000 tokens, cap 20,000 a pass, threshold 5,600
  const { demo, compactor } = fakeDemo({ messages: seed(200) });
  assert.strictEqual(compactor.needed(), true);

  const run = await compactor.now();

  assert.ok(run.passes > 1, `expected several passes, got ${run.passes}`);
  assert.strictEqual(run.tokensBefore, 110000);
  assert.ok(run.tokensAfter < 5600, `${run.tokensAfter} should be under the threshold`);
  assert.strictEqual(run.stillOver, false);
  assert.strictEqual(run.reclaimed, run.tokensBefore - run.tokensAfter);
  // the endpoint is asked for a summary and nothing else, every time
  assert.ok(demo.compactCalls.every((c) => c.opts.keepLastMessages === 0));
  // one summary at the head, never a stack of them
  assert.strictEqual(demo.messages[0].parts[0].text.startsWith("summary of"), true);
  assert.strictEqual(demo.messages.filter((m) => /^summary of/.test(m.parts[0].text)).length, 1);
  // the demo was told about every pass, billed for every call, and probed after each
  assert.strictEqual(demo.passes.length, run.passes);
  assert.strictEqual(demo.charged.length, run.passes);
  assert.strictEqual(demo.probeCalls, run.passes);
  assert.strictEqual(demo.histories.length, run.passes);
});

test("the tail the visitor is reading survives the whole arrival fold", async () => {
  const { demo, compactor } = fakeDemo({ messages: seed(200) });
  const lastFour = demo.messages.slice(-4).map((m) => m.parts[0].text);
  await compactor.now();
  assert.deepStrictEqual(demo.messages.slice(-4).map((m) => m.parts[0].text), lastFour);
});

test("afterTurn does nothing while the conversation is under the threshold", async () => {
  const { demo, compactor } = fakeDemo({ messages: seed(8), perMessage: 100 });  // 800 tokens
  assert.strictEqual(compactor.needed(), false);
  const run = await compactor.afterTurn();
  assert.strictEqual(run.passes, 0);
  assert.strictEqual(demo.compactCalls.length, 0);
  assert.strictEqual(demo.messages.length, 8);
});

test("afterTurn folds once the threshold is crossed", async () => {
  const { demo, compactor } = fakeDemo({ messages: seed(20), perMessage: 400 });  // 8,000 tokens
  const run = await compactor.afterTurn();
  assert.ok(run.passes >= 1);
  assert.ok(demo.tokens < 5600);
});

test("a forced run folds once even when nothing has crossed the line", async () => {
  const { demo, compactor } = fakeDemo({ messages: seed(10), perMessage: 100 });  // 1,000 tokens
  assert.strictEqual(compactor.needed(), false);
  const run = await compactor.now();
  assert.strictEqual(run.passes, 1, "the visitor pressed the button, so one fold happens");
  assert.strictEqual(demo.compactCalls.length, 1);
});

test("a pass that reclaims nothing stops the loop instead of churning", async () => {
  // keepLast is 4 and the history is 5 long, so every pass folds the previous
  // summary back into itself and the token total never moves
  const { demo, compactor } = fakeDemo({ messages: seed(5), perMessage: 4000, summaryTokens: 4000 });
  const run = await compactor.now();
  assert.strictEqual(run.passes, 1, "one pass proved folding does not help here");
  assert.strictEqual(run.stalled, true);
  assert.strictEqual(run.stillOver, true, "still over, and honest about it");
  assert.strictEqual(demo.compactCalls.length, 1, "no money spent on passes that cannot help");
});

test("maxPasses bounds a fold that only ever makes slow progress", async () => {
  // each pass reclaims a little — 36 messages traded for a 5,000-token summary —
  // so it never stalls, and never reaches 5,600 either within three passes
  const { demo, compactor } = fakeDemo({ messages: seed(400), perMessage: 550, summaryTokens: 5000 });
  const run = await compactor.now({ maxPasses: 3 });
  assert.strictEqual(run.passes, 3);
  assert.strictEqual(run.stalled, false);
  assert.strictEqual(run.stillOver, true);
  assert.strictEqual(demo.compactCalls.length, 3);
  assert.ok(run.reclaimed > 0, "three passes did buy some room, just not enough");
});

test("plan() and threshold() answer without folding anything", async () => {
  const { demo, compactor } = fakeDemo({ messages: seed(100) });
  assert.strictEqual(compactor.threshold(), 5600);
  const p = compactor.plan();
  assert.strictEqual(p.cut, 36, "20,000 ÷ 550 = 36 whole messages");
  assert.strictEqual(demo.compactCalls.length, 0, "planning is not folding");
});

test("two runs at once share the first one rather than folding twice", async () => {
  const { demo, compactor } = fakeDemo({ messages: seed(200) });
  const [a, b] = await Promise.all([compactor.now(), compactor.now()]);
  assert.strictEqual(a, b, "the second caller got the run already in flight");
  assert.strictEqual(demo.compactCalls.length, a.passes);
});

test("a compact response with no summary is an error, not a silent no-op", async () => {
  const demo = { messages: seed(20), weights: seed(20).map(() => 550), tokens: 11000 };
  const compactor = C.createCompactor({
    history: () => demo,
    probe: async () => ({ tokens: 0 }),
    compact: async () => ({ messages: [], stats: {} }),
    budget: () => 8000, ratio: () => 0.7, keepLast: () => 4, maxPayload: () => 20000,
    onHistory: () => { throw new Error("onHistory must not be reached"); },
  });
  await assert.rejects(() => compactor.now(), /no summary message/);
  assert.strictEqual(compactor.busy, false, "the driver is not left busy after a failure");
});

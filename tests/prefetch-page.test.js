/* prefetch/: the before-and-after page. Its table is read off the same
   stream reader main-demo's lanes use, so the tests drive that reader with
   the fixture's own events and check what the table prints. */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const PUBLIC = path.join(__dirname, "..", "public");
const load = (rel) => import(pathToFileURL(path.join(PUBLIC, rel)).href);

/** one lane's report, as lane.js hands it to onView, from a fixture turn */
async function report({ prefetch, query }) {
  const fx = await load("main-demo/fixture.mjs");
  const st = await load("main-demo/stream.mjs");
  const turn = st.createTurn({ text: query });
  const script = fx.fixtureEvents({ prefetch, query, missed: prefetch && fx.prefetchMisses(query) });
  turn.headers(script[0][0], { status: 200, get: () => null });
  let last = 0;
  for (const [t, e] of script) {
    last = t;
    if (e !== "[DONE]") turn.observe(t, e);
  }
  turn.finish(last);
  const view = turn.view();
  return { view, counts: st.searchCounts(prefetch, view), prefetchOn: prefetch, seq: 1 };
}

test("the two lanes are the race's two arms: the base agent, then the same with prefetch on", async () => {
  const p = await load("prefetch/compare.mjs");
  const c = await load("main-demo/configs.mjs");
  assert.deepEqual(p.LANES.map((l) => l.key), ["a", "b"]);
  assert.equal(c.configKey(p.LANES[0].toggles), c.configKey(c.BASE_TOGGLES));
  assert.equal(c.configKey(p.LANES[1].toggles), c.configKey({ ...c.BASE_TOGGLES, prefetch: true }));
  assert.deepEqual(p.LANES.map((l) => c.agentName(l.toggles)), c.MANIFEST.map((m) => m.name));
});

test("the replay is labeled as what it is: the fixture's timings are made up", async () => {
  const p = await load("prefetch/compare.mjs");
  const src = fs.readFileSync(path.join(PUBLIC, "main-demo", "fixture.mjs"), "utf8");
  // a recorded fixture would change this header; then the label must change with it
  assert.match(src, /timings\s+are made up/);
  assert.equal(p.REPLAY.recorded, false);
  assert.equal(p.REPLAY.label, "Illustrative replay");
});

test("the replay question plays the prefetch hit, not the miss or the skip", async () => {
  const p = await load("prefetch/compare.mjs");
  const fx = await load("main-demo/fixture.mjs");
  assert.equal(fx.prefetchMisses(p.REPLAY_QUESTION), false);
  assert.equal(fx.fixtureSkips(p.REPLAY_QUESTION), false);
});

test("a replayed run: one model call and one search fewer with prefetch, tokens marked as absent", async () => {
  const p = await load("prefetch/compare.mjs");
  const a = await report({ prefetch: false, query: p.REPLAY_QUESTION });
  const b = await report({ prefetch: true, query: p.REPLAY_QUESTION });
  const t = Object.fromEntries(p.rows({ a, b }, { replay: true }).map((r) => [r.id, r]));
  assert.deepEqual(Object.keys(t), ["modelCalls", "modelSearches", "prefetchSearches", "inputTokens", "ttft", "total"]);
  assert.deepEqual([t.modelCalls.a, t.modelCalls.b, t.modelCalls.diff], ["3", "2", "−1"]);
  assert.deepEqual([t.modelSearches.a, t.modelSearches.b], ["1", "0"]);
  assert.deepEqual([t.prefetchSearches.a, t.prefetchSearches.b, t.prefetchSearches.diff], ["0", "1", "+1"]);
  assert.deepEqual([t.inputTokens.a, t.inputTokens.b, t.inputTokens.diff], ["not in replay", "not in replay", ""]);
  assert.deepEqual(t.inputTokens.known, { a: false, b: false }, "a word in a number's place is drawn as one");
  assert.deepEqual(t.modelCalls.known, { a: true, b: true });
  for (const id of ["ttft", "total"]) {
    assert.match(t[id].a, /\d\s(ms|s)$/);
    assert.match(t[id].diff, /^[+−]\d/);
  }
  // live, the same gap reads as the agent's config, not the replay
  const live = p.rows({ a, b }).find((r) => r.id === "inputTokens");
  assert.equal(live.a, "not streamed");
});

test("streamed usage prints as tokens, with a signed difference", async () => {
  const p = await load("prefetch/compare.mjs");
  const withUsage = (r, n) => ({ ...r, view: { ...r.view, usage: { inputTokens: n, outputTokens: 10 } } });
  const a = withUsage(await report({ prefetch: false, query: p.REPLAY_QUESTION }), 2100);
  const b = withUsage(await report({ prefetch: true, query: p.REPLAY_QUESTION }), 3300);
  const row = p.rows({ a, b }).find((r) => r.id === "inputTokens");
  assert.deepEqual([row.a, row.b, row.diff], ["2.1k", "3.3k", "+1.2k"]);
});

test("before a run every cell is a dash (an en dash); mid-run, an ellipsis and no difference", async () => {
  const p = await load("prefetch/compare.mjs");
  for (const r of p.rows({ a: null, b: null })) {
    assert.deepEqual([r.a, r.b, r.diff], ["–", "–", ""]);
  }
  const done = await report({ prefetch: false, query: p.REPLAY_QUESTION });
  const streaming = { ...done, view: { ...done.view, status: "streaming", total: null, ttft: null } };
  const total = p.rows({ a: done, b: streaming }).find((r) => r.id === "total");
  assert.equal(total.b, "…");
  assert.equal(total.diff, "");
  assert.equal(p.diffText(p.ROWS[0], 2, 2), "0");
});

test("Run live needs the mainDemo block, its key, and an agent for both lanes", async () => {
  const p = await load("prefetch/compare.mjs");
  const c = await load("main-demo/configs.mjs");
  const base = c.configKey(c.BASE_TOGGLES);
  const pf = c.configKey({ ...c.BASE_TOGGLES, prefetch: true });
  assert.equal(p.liveReadiness(null).ok, false);
  assert.match(p.liveReadiness({ region: "eu" }).why, /no app id or key/);
  const cfg = { appId: "APP", agentStudioApiKey: "k" };
  assert.match(p.liveReadiness(cfg).why, /without prefetch or with prefetch/);
  const half = { ...cfg, variants: { [base]: { agentId: "base-id" } } };
  assert.match(p.liveReadiness(half).why, /no agent for with prefetch\.$/);
  const both = { [base]: { agentId: "base-id" }, [pf]: { agentId: "pf-id" } };
  const ok = p.liveReadiness({ ...cfg, variants: both });
  assert.equal(ok.ok, true);
  assert.equal(ok.variants[pf].agentId, "pf-id");
  assert.equal(p.liveReadiness(cfg, both).ok, true, "variants.json's map stands in when config.js has none");
});

test("the page states what prefetch does and claims no speedup", () => {
  const html = fs.readFileSync(path.join(PUBLIC, "prefetch", "index.html"), "utf8");
  assert.match(html, /<script type="module" src="app\.js"><\/script>/);
  assert.match(html, /id="replay"/);
  assert.match(html, /id="live"/);
  assert.match(html, /before the first model call/);
  assert.match(html, /extra input tokens and a later first byte/);
  const prose = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  assert.doesNotMatch(prose, /\b(faster|speedup|speeds? up|quicker|saves?)\b/i);
});

test("the landing page links the prefetch page", () => {
  const html = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8");
  assert.match(html, /<a class="card" href="prefetch\/">/);
});

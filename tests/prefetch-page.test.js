/* prefetch/: the before-and-after page, live only. Its table is read off
   the same stream reader main-demo's lanes use. The tests feed that reader
   main-demo's fixture events as a stand-in stream; the page itself never
   loads the fixture. */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { ReadableStream } = require("node:stream/web");

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

test("a run read into rows: one model call and one search fewer with prefetch, tokens marked as absent", async () => {
  const p = await load("prefetch/compare.mjs");
  const a = await report({ prefetch: false, query: p.STARTERS[0].text });
  const b = await report({ prefetch: true, query: p.STARTERS[0].text });
  const t = Object.fromEntries(p.rows({ a, b }).map((r) => [r.id, r]));
  assert.deepEqual(Object.keys(t), ["modelCalls", "modelSearches", "prefetchSearches", "inputTokens", "ttft", "total"]);
  assert.deepEqual([t.modelCalls.a, t.modelCalls.b, t.modelCalls.diff], ["3", "2", "−1"]);
  assert.deepEqual([t.modelSearches.a, t.modelSearches.b], ["1", "0"]);
  assert.deepEqual([t.prefetchSearches.a, t.prefetchSearches.b, t.prefetchSearches.diff], ["0", "1", "+1"]);
  assert.deepEqual([t.inputTokens.a, t.inputTokens.b, t.inputTokens.diff], ["not streamed", "not streamed", ""]);
  assert.deepEqual(t.inputTokens.known, { a: false, b: false }, "a word in a number's place is drawn as one");
  assert.deepEqual(t.modelCalls.known, { a: true, b: true });
  for (const id of ["ttft", "total"]) {
    assert.match(t[id].a, /\d\s(ms|s)$/);
    assert.match(t[id].diff, /^[+−]\d/);
  }
});

test("starters: three good fits for prefetch and two poor ones, one line each", async () => {
  const p = await load("prefetch/compare.mjs");
  assert.equal(p.STARTERS.length, 5);
  assert.deepEqual(p.STARTERS.map((s) => s.fit), ["good", "good", "good", "poor", "poor"]);
  for (const s of p.STARTERS) assert.equal(p.questionOf(s.text), s.text);
});

test("a typed question is trimmed to one line; blank asks nothing", async () => {
  const p = await load("prefetch/compare.mjs");
  assert.equal(p.questionOf("  red\n  shoes  "), "red shoes");
  assert.equal(p.questionOf("   "), "");
  assert.equal(p.questionOf(null), "");
  assert.equal(p.questionOf("x".repeat(400)).length, 300);
});

test("the visitor asks: a form and chips, both sending one question to both lanes", () => {
  const html = fs.readFileSync(path.join(PUBLIC, "prefetch", "index.html"), "utf8");
  assert.match(html, /<form[^>]*id="ask-form"/);
  assert.match(html, /<input id="ask"/);
  assert.match(html, /id="chips"/);
  const app = fs.readFileSync(path.join(PUBLIC, "prefetch", "app.js"), "utf8");
  assert.match(app, /for \(const l of LANES\) lanes\[l\.key\]\.send\(q\)/, "one question, both lanes, same loop");
  assert.doesNotMatch(app, /QUESTION/, "no question is written into the page");
});

test("streamed usage prints as tokens, with a signed difference", async () => {
  const p = await load("prefetch/compare.mjs");
  const withUsage = (r, n) => ({ ...r, view: { ...r.view, usage: { inputTokens: n, outputTokens: 10 } } });
  const a = withUsage(await report({ prefetch: false, query: p.STARTERS[0].text }), 2100);
  const b = withUsage(await report({ prefetch: true, query: p.STARTERS[0].text }), 3300);
  const row = p.rows({ a, b }).find((r) => r.id === "inputTokens");
  assert.deepEqual([row.a, row.b, row.diff], ["2.1k", "3.3k", "+1.2k"]);
});

test("before a run every cell is a dash (an en dash); mid-run, an ellipsis and no difference", async () => {
  const p = await load("prefetch/compare.mjs");
  for (const r of p.rows({ a: null, b: null })) {
    assert.deepEqual([r.a, r.b, r.diff], ["–", "–", ""]);
  }
  const done = await report({ prefetch: false, query: p.STARTERS[0].text });
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
  assert.match(html, /id="run"/);
  assert.doesNotMatch(html, /replay/i);
  assert.match(html, /before the first model call/);
  assert.match(html, /extra input tokens and a later first byte/);
  const prose = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  assert.doesNotMatch(prose, /\b(faster|speedup|speeds? up|quicker|saves?)\b/i);
});

test("the landing page links the prefetch page", () => {
  const html = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8");
  assert.match(html, /<a class="card" href="prefetch\/">/);
});

test("the page is live only: no module of it loads the fixture, and nothing runs on load", () => {
  const dir = path.join(PUBLIC, "prefetch");
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    assert.doesNotMatch(src, /fixture\.mjs|createFixtureFetch|fixtureEvents/, f);
  }
  const app = fs.readFileSync(path.join(dir, "app.js"), "utf8");
  assert.match(app, /fixture: false/, "the lanes call the agents");
  const main = app.slice(app.indexOf("async function main()"));
  assert.doesNotMatch(main, /\brun\(\)|\.send\(/, "main() mounts the lanes and waits for Run");
});

test("a lane the backend refused prints its HTTP status, never a zero that reads as a count", async () => {
  const p = await load("prefetch/compare.mjs");
  const st = await load("main-demo/stream.mjs");
  const turn = st.createTurn({ text: p.STARTERS[0].text });
  turn.headers(80, { status: 404, get: () => null });
  turn.finish(81, { error: "HTTP 404" });
  const view = turn.view();
  const refused = { view, counts: st.searchCounts(false, view), seq: 1 };
  const ok = await report({ prefetch: true, query: p.STARTERS[0].text });
  for (const r of p.rows({ a: refused, b: ok })) {
    assert.equal(r.a, "HTTP 404", r.id);
    assert.equal(r.known.a, false);
    assert.equal(r.diff, "", r.id);
  }
  assert.equal(p.failureText({ status: "error", httpStatus: null }), "failed");
});

/* ── preflight: can both agents answer before Run is offered ── */

const sse = (events, { hang = false } = {}) => new Response(new ReadableStream({
  start(ctl) {
    for (const e of events) ctl.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`));
    if (!hang) ctl.close();
  },
}), { status: 200, headers: { "content-type": "text/event-stream" } });
const CFG = { host: "https://as.example", appId: "APP", apiKey: "k" };

test("preflight request: the lane's own completions call, one short user message", async () => {
  const f = await load("prefetch/preflight.mjs");
  const c = await load("main-demo/configs.mjs");
  const { url, init } = f.probeRequest(CFG, "agent-1");
  assert.equal(url, `https://as.example/1/agents/agent-1/completions?${new URLSearchParams(c.completionQuery())}`);
  assert.equal(init.method, "POST");
  assert.equal(init.headers["x-algolia-application-id"], "APP");
  const msgs = JSON.parse(init.body).messages;
  assert.equal(msgs.length, 1);
  assert.deepEqual(msgs[0].parts, [{ type: "text", text: f.PROBE_TEXT }]);
  const fx = await load("main-demo/fixture.mjs");
  assert.equal(fx.fixtureSkips(f.PROBE_TEXT), true, "under prefetch's word gate: the probe runs no search");
});

test("preflight passes at the model's first text or tool call, without reading the rest", async () => {
  const f = await load("prefetch/preflight.mjs");
  const text = await f.probeAgent(async () => sse([{ type: "start" }, { type: "start-step" }, { type: "text-delta", delta: "Hi" }], { hang: true }), CFG, "a");
  assert.deepEqual(text, { ok: true });
  const tool = await f.probeAgent(async () => sse([{ type: "tool-input-start", toolCallId: "t", toolName: "search" }], { hang: true }), CFG, "a");
  assert.deepEqual(tool, { ok: true });
});

test("preflight fails with a short reason: missing agent, refused key, streamed error, silence", async () => {
  const f = await load("prefetch/preflight.mjs");
  const json = (status, body) => async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  assert.deepEqual(await f.probeAgent(json(404, { message: "Agent with ID a not found." }), CFG, "a"),
    { ok: false, reason: "agent not found on this backend" });
  assert.equal((await f.probeAgent(json(403, {}), CFG, "a")).reason, "the key was refused");
  assert.equal((await f.probeAgent(json(502, {}), CFG, "a")).reason, "backend error (HTTP 502)");
  assert.equal((await f.probeAgent(json(422, { message: "bad body" }), CFG, "a")).reason, "bad body");
  const streamed = await f.probeAgent(async () => sse([{ type: "start" }, { type: "error", errorText: "provider key invalid" }]), CFG, "a");
  assert.deepEqual(streamed, { ok: false, reason: "provider key invalid" });
  assert.equal((await f.probeAgent(async () => sse([{ type: "start" }, { type: "finish" }]), CFG, "a")).reason, "no answer");
  assert.equal((await f.probeAgent(async () => { throw new TypeError("fetch failed"); }, CFG, "a")).reason, "backend unreachable");
  const slow = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
  assert.equal((await f.probeAgent(slow, CFG, "a", { timeoutMs: 30 })).reason, "no answer in time");
});

test("preflight state: checking until both report, unavailable as soon as one fails, ready when both pass", async () => {
  const f = await load("prefetch/preflight.mjs");
  const p = await load("prefetch/compare.mjs");
  assert.equal(f.preflightState({}, p.LANES).phase, "checking");
  assert.equal(f.preflightState({ a: { ok: true } }, p.LANES).phase, "checking");
  const one = f.preflightState({ b: { ok: false, reason: "agent not found on this backend" } }, p.LANES);
  assert.equal(one.phase, "unavailable");
  assert.equal(one.text, "Live unavailable: With prefetch: agent not found on this backend.");
  const both = f.preflightState({ a: { ok: false, reason: "x" }, b: { ok: false, reason: "y" } }, p.LANES);
  assert.equal(both.text, "Live unavailable: Without prefetch: x; With prefetch: y.");
  assert.deepEqual(f.preflightState({ a: { ok: true }, b: { ok: true } }, p.LANES), { phase: "ready", text: "Ready" });
  assert.notEqual(f.cacheKey("h1", "a"), f.cacheKey("h2", "a"), "a pass on one backend says nothing about another");
});

test("mid-race failures: a lane says why it has no answer, and the table shows no counts for it", async () => {
  const f = await load("prefetch/preflight.mjs");
  const p = await load("prefetch/compare.mjs");
  assert.equal(f.laneFailure(null), null);
  assert.equal(f.laneFailure({ status: "streaming", errors: [] }), null);
  assert.equal(f.laneFailure({ status: "done", errors: [] }), null);
  assert.equal(f.laneFailure({ status: "error", httpStatus: 404, errors: ["HTTP 404"] }), "agent not found on this backend");
  assert.equal(f.laneFailure({ status: "done", httpStatus: 200, errors: ["model overloaded"] }), "model overloaded");
  // a 200 stream that carried an error event: the widget shows "contact support"; the table shows no numbers
  const ok = await report({ prefetch: true, query: p.STARTERS[0].text });
  const streamedError = { ...ok, view: { ...ok.view, errors: ["model overloaded"] } };
  const calls = p.rows({ a: streamedError, b: ok }).find((r) => r.id === "modelCalls");
  assert.equal(calls.a, "failed");
  assert.equal(calls.diff, "");
});

test("after a run: Ready only when both lanes answered; a failed lane is named and Run stays on", async () => {
  const f = await load("prefetch/preflight.mjs");
  const p = await load("prefetch/compare.mjs");
  const ok = await report({ prefetch: false, query: p.STARTERS[0].text });
  assert.deepEqual(f.afterRun({ a: ok, b: ok }, p.LANES), { phase: "ready", text: "Ready" });
  const refused = { view: { status: "error", httpStatus: 404, errors: ["HTTP 404"] } };
  const one = f.afterRun({ a: ok, b: refused }, p.LANES);
  assert.equal(one.phase, "retry");
  assert.equal(one.text, "Last run: no answer from With prefetch. Run to try again.");
  assert.match(f.afterRun({ a: refused, b: refused }, p.LANES).text, /Without prefetch and With prefetch/);
  const app = fs.readFileSync(path.join(PUBLIC, "prefetch", "app.js"), "utf8");
  assert.match(app, /state\.check = afterRun\(seen, LANES\)/, "the check line is set from the run, not left at Ready");
});

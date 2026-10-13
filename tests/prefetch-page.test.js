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

test("a run read into rows: one model call fewer with prefetch, tokens marked as absent", async () => {
  const p = await load("prefetch/compare.mjs");
  const a = await report({ prefetch: false, query: p.STARTERS[0].text });
  const b = await report({ prefetch: true, query: p.STARTERS[0].text });
  const t = Object.fromEntries(p.rows({ a, b }).map((r) => [r.id, r]));
  assert.deepEqual(Object.keys(t), ["modelCalls", "ttft", "total", "inputTokens"], "who searched is on the lane badges");
  assert.equal(t.modelCalls.lead, true, "model calls is the headline row");
  assert.deepEqual([t.modelCalls.a, t.modelCalls.b, t.modelCalls.diff], ["3", "2", "−1"]);
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

test("prefetchDemo wins over mainDemo, and mainDemo stands in when it is absent", async () => {
  const p = await load("prefetch/compare.mjs");
  const main = { appId: "MAIN", agentStudioApiKey: "k1" };
  const own = { appId: "OWN", agentStudioApiKey: "k2" };
  assert.deepEqual(p.pageConfig({ mainDemo: main, prefetchDemo: own }), { block: own, name: "prefetchDemo" });
  assert.deepEqual(p.pageConfig({ mainDemo: main }), { block: main, name: "mainDemo" });
  assert.deepEqual(p.pageConfig({ mainDemo: main, prefetchDemo: null }), { block: main, name: "mainDemo" });
  assert.deepEqual(p.pageConfig(null), { block: null, name: null });
  assert.deepEqual(p.pageConfig({ prefetchDemo: [] }), { block: null, name: null });
  const app = fs.readFileSync(path.join(PUBLIC, "prefetch", "app.js"), "utf8");
  assert.match(app, /pageConfig\(window\.DEMO_CONFIG, DEMO\.blocks\)/, "the page's demo names the blocks");
  assert.doesNotMatch(app, /root\.mainDemo/, "the page never reads mainDemo directly");
});

test("the config template documents prefetchDemo with the two variant keys the page needs", async () => {
  const c = await load("main-demo/configs.mjs");
  const p = await load("prefetch/compare.mjs");
  const src = fs.readFileSync(path.join(PUBLIC, "shared", "config.example.js"), "utf8");
  const at = src.indexOf("// prefetchDemo: {");
  assert.ok(at > 0);
  for (const l of p.LANES) assert.ok(src.indexOf(c.configKey(l.toggles), at) > at, l.label);
});

test("the page states what prefetch does and claims no more than often sooner", () => {
  const html = fs.readFileSync(path.join(PUBLIC, "prefetch", "index.html"), "utf8");
  assert.match(html, /<script type="module" src="app\.js"><\/script>/);
  assert.match(html, /id="run"/);
  assert.doesNotMatch(html, /replay/i);
  assert.match(html, /before the first model call/);
  const prose = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  assert.match(prose, /often starts sooner/, "the one speed claim, hedged");
  assert.doesNotMatch(prose, /\b(speedup|speeds? up|quicker|saves?|\d+(\.\d+)?\s*[x×])\b/i);
  for (const m of prose.matchAll(/\b(faster|sooner)\b/gi)) {
    assert.match(prose.slice(Math.max(0, m.index - 30), m.index), /\boften\b[^.]*$/i, "a speed word is always qualified by often");
  }
});

test("the landing page links the prefetch page", () => {
  const html = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8");
  assert.match(html, /<a class="card" href="prefetch\/">/);
});

test("the page is live only: no module of it loads the fixture, and nothing runs on load", () => {
  const dir = path.join(PUBLIC, "prefetch");
  const files = fs.readdirSync(dir, { recursive: true }).filter((f) => fs.statSync(path.join(dir, f)).isFile());
  assert.ok(files.includes(path.join("askai", "index.html")) && files.includes(path.join("assist", "index.html")));
  for (const f of files) {
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

/* ── no preflight: Run is on at once, and a lane says its own failure ── */

test("no check before Run: every page offers Run at once and probes nothing", () => {
  const app = fs.readFileSync(path.join(PUBLIC, "prefetch", "app.js"), "utf8");
  assert.doesNotMatch(app, /probeAgent|preflight/i, "no call goes out before Run");
  assert.equal(fs.existsSync(path.join(PUBLIC, "prefetch", "preflight.mjs")), false);
  for (const page of ["index.html", "askai/index.html", "assist/index.html"]) {
    const html = fs.readFileSync(path.join(PUBLIC, "prefetch", page), "utf8");
    assert.doesNotMatch(html, /Checking agents/, page);
    assert.match(html, /<button type="submit" class="btn" id="run">Run<\/button>/, `${page}: Run is not disabled`);
    assert.match(html, /id="ask-form"[^>]*onsubmit="event\.preventDefault\(\); this\.dataset\.early = '1'"/, `${page}: an early Run is kept`);
  }
  assert.match(app, /if \(el\.form\.dataset\.early\) run\(el\.ask\.value\)/, "and run once the lanes mount");
});

test("mid-race failures: a lane says why it has no answer, and the table shows no counts for it", async () => {
  const f = await load("prefetch/outcome.mjs");
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

test("an empty reply: a clean 200 close with no text is a failed lane, said above its chat", async () => {
  const f = await load("prefetch/outcome.mjs");
  const p = await load("prefetch/compare.mjs");
  const st = await load("main-demo/stream.mjs");
  const ok = await report({ prefetch: true, query: p.STARTERS[0].text });
  assert.equal(ok.view.answered, true);
  assert.equal(st.emptyTurn(ok.view), false);
  const empty = (events) => {
    const turn = st.createTurn({ text: "How do I stream agent completions?" });
    turn.headers(400, { status: 200, get: () => null });
    events.forEach((e, i) => turn.observe(500 + i * 100, e));
    turn.finish(500 + events.length * 100);
    const view = turn.view();
    return { view, counts: st.searchCounts(false, view), seq: 1 };
  };
  // the four events Gemini's empty stream comes back as
  const bare = empty([{ type: "start", messageId: "m" }, { type: "start-step" }, { type: "finish-step" }, { type: "finish" }]);
  assert.equal(bare.view.status, "done");
  assert.equal(st.emptyTurn(bare.view), true);
  assert.equal(f.laneFailure(bare.view), "the model sent back an empty reply");
  const searched = empty([{ type: "start" }, { type: "start-step" },
    { type: "tool-input-start", toolCallId: "t1", toolName: "algolia_search_index_docs" },
    { type: "tool-output-available", toolCallId: "t1", output: { hits: [] } },
    { type: "finish-step" }, { type: "start-step" }, { type: "finish-step" }, { type: "finish" }]);
  assert.equal(f.laneFailure(searched.view), "the model stopped after its search, with no text");
  for (const r of p.rows({ a: bare, b: ok })) {
    assert.equal(r.a, "no answer", r.id);
    assert.equal(r.known.a, false);
    assert.equal(r.diff, "", r.id);
  }
  assert.deepEqual(f.afterRun({ a: bare, b: ok }, p.LANES),
    { phase: "retry", text: "Last run: no answer from Without prefetch. Run to try again." });
  // grouped results are an answer without text; a hand-built view with no flag is left alone
  assert.equal(st.emptyTurn({ ...bare.view, grouped: { groups: [] } }), false);
  assert.equal(f.laneFailure({ status: "done", errors: [] }), null);
  // the page writes laneFailure into the lane's alert line and dims its chat
  const app = fs.readFileSync(path.join(PUBLIC, "prefetch", "app.js"), "utf8");
  assert.match(app, /el\.err\[l\.key\]\.textContent = why \? `\$\{l\.label\}: no answer, \$\{why\}\.`/);
  for (const demo of ["askai", "assist"]) {
    const page = fs.readFileSync(path.join(PUBLIC, "prefetch", demo, "index.html"), "utf8");
    assert.match(page, /id="err-a" role="alert"/, demo);
  }
});

test("after a run: Ready only when both lanes answered; a failed lane is named and Run stays on", async () => {
  const f = await load("prefetch/outcome.mjs");
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

test("timeline: a lane's time cut into back-to-back phases, read off the stream", async () => {
  const p = await load("prefetch/compare.mjs");
  const a = await report({ prefetch: false, query: p.STARTERS[0].text });
  const b = await report({ prefetch: true, query: p.STARTERS[0].text });
  for (const r of [a, b]) {
    const parts = p.phases(r.view);
    assert.equal(parts[0].start, 0, "from the moment the question went out");
    assert.equal(parts[parts.length - 1].end, r.view.total, "to the turn's end");
    for (let i = 1; i < parts.length; i++) {
      assert.equal(parts[i].start, parts[i - 1].end, "no unlabelled gap");
      const same = parts[i].kind === parts[i - 1].kind && parts[i].name === parts[i - 1].name;
      assert.ok(!same, "neighbours of one kind merge into one phase");
    }
    assert.equal(parts[parts.length - 1].kind, "answer");
    for (const x of parts) assert.ok(p.PHASES.some((ph) => ph.id === x.kind), x.kind);
  }
  const kinds = (r) => p.phases(r.view).map((x) => x.kind);
  assert.ok(kinds(b).includes("prefetch") && !kinds(a).includes("prefetch"), "only the prefetch lane searches before the model");
  assert.ok(kinds(a).includes("search"), "the base lane's model runs its own search");
  assert.ok(kinds(a).includes("model"), "the time between is the model's, and says so");
  assert.deepEqual(p.phases(null), []);
});

test("timeline: before the first byte the lane waits; an open tool runs to the live edge", async () => {
  const p = await load("prefetch/compare.mjs");
  const view = { status: "streaming", total: null, span: 3000, ttfb: 400, texts: [],
    tools: [{ name: "algolia_search_index_x", start: 1000, end: null, search: true }] };
  assert.deepEqual(p.phases(view).map((x) => [x.kind, x.start, x.end]),
    [["wait", 0, 400], ["model", 400, 1000], ["search", 1000, 3000]]);
});

test("one axis for both lanes: whole-second ticks, the longer lane sets the scale", async () => {
  const p = await load("prefetch/compare.mjs");
  assert.deepEqual(p.axis(7029, 4875), { max: 8000, ticks: [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000] });
  assert.deepEqual(p.axis(1800, null).ticks, [0, 250, 500, 750, 1000, 1250, 1500, 1750, 2000]);
  assert.deepEqual(p.axis(null, undefined), { max: 0, ticks: [] });
  assert.deepEqual([0, 500, 2000, 1500, 1250].map(p.tickText), ["0 s", "0.5 s", "2 s", "1.5 s", "1.25 s"].map((x) => x.replace(" ", "\u00a0")));
});

test("the demo leads: no echoed question or toggle, one small caveat in the footer", () => {
  const html = fs.readFileSync(path.join(PUBLIC, "prefetch", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(PUBLIC, "prefetch", "app.js"), "utf8");
  assert.doesNotMatch(html + app, /Show timings|One live run|next one will differ/);
  assert.match(html, /<footer[^>]*>[\s\S]*Timings vary from run to run\.[\s\S]*<\/footer>/);
  const order = ["id=\"ask-form\"", "id=\"race\"", "id=\"score\"", "id=\"lanes\""].map((m) => html.indexOf(m));
  assert.deepEqual([...order].sort((x, y) => x - y), order, "question, timeline, numbers, then the lanes");
});

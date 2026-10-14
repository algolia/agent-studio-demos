/* prefetch/ on albums: the agents the race and "Tune it" run, the query a
   window builds, the title screen's morph, and the script that makes the
   agents and writes their config block. */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const page = (rel) => fs.readFileSync(path.join(PUBLIC, "prefetch", rel), "utf8");

test("eight agents, all DEMO_albums-: the base, the race partner, one per tune combo", async () => {
  const t = await load("public/prefetch/tune.mjs");
  assert.equal(t.ALBUM_AGENTS.length, 8);
  assert.equal(new Set(t.ALBUM_AGENTS.map((a) => a.name)).size, 8);
  for (const a of t.ALBUM_AGENTS) assert.match(a.name, /^DEMO_albums-/);
  assert.deepEqual(t.ALBUM_AGENTS[0], { name: "DEMO_albums-base", prefetch: null });
  assert.deepEqual(t.ALBUM_AGENTS[1], { name: "DEMO_albums-prefetch-w1-h5", prefetch: { window: 1, hits: 5 } });
  assert.deepEqual(t.COMBOS.map(t.comboKey), ["w1-h3", "w1-h10", "w2-h3", "w2-h10", "w3-h3", "w3-h10"]);
  assert.equal(t.prefetchBlock(null), false);
  assert.deepEqual(t.prefetchBlock({ window: 2, hits: 10 }), { enabled: true, conversationWindow: 2, hitsPerPage: 10 });
});

test("the window's query, as the backend builds it: last N user turns, one space, 512 chars", async () => {
  const t = await load("public/prefetch/tune.mjs");
  const turns = ["Psychedelic rock  from the 60s", "Something\nfrom Britain"];
  assert.equal(t.windowQuery(turns, 1), "Something from Britain");
  assert.equal(t.windowQuery(turns, 2), "Psychedelic rock from the 60s Something from Britain");
  assert.equal(t.windowQuery(turns, 3), t.windowQuery(turns, 2), "a window wider than the talk takes all of it");
  assert.equal(t.windowQuery(["x".repeat(600)], 1).length, 512);
  assert.equal(t.windowQuery([], 2), "");
});

test("a combo's agent comes from the tune map; the race combo falls back to the race variant", async () => {
  const t = await load("public/prefetch/tune.mjs");
  const block = {
    variants: { "prefetch=1,memory=0,guardrails=0,suggestions=0": { agentId: "race" } },
    tune: { "w1-h3": { agentId: "a13" }, "w2-h3": { agentId: "" } },
  };
  assert.equal(t.tuneAgent(block, { window: 1, hits: 3 }).agentId, "a13");
  assert.equal(t.tuneAgent(block, { window: 2, hits: 3 }), null, "an empty id is no agent");
  assert.equal(t.tuneAgent(block, { window: 1, hits: 5 }).agentId, "race");
  assert.equal(t.tuneAgent(null, { window: 1, hits: 3 }), null);
  assert.deepEqual(t.availableCombos(block).map(t.comboKey), ["w1-h3"]);
});

test("on topic: every test holds; a conversation the visitor typed has no topic", async () => {
  const t = await load("public/prefetch/tune.mjs");
  const [soul, psych] = t.PAIRS;
  const hits = [
    { title: "A", genres: ["Psychedelic Rock"], country: "UK", year: 1967 },
    { title: "B", genres: ["Psychedelic Rock"], country: "US", year: 1967 },
    { title: "C", genres: ["Rock"], country: "UK", year: 1971 },
  ];
  assert.equal(t.onTopic(hits, psych.topic), 1);
  assert.equal(t.onTopic([{ genres: ["Soul", "Funk / Soul"] }, { genres: ["Soul"] }], soul.topic), 1);
  const hiphop = t.PAIRS.find((p) => /90s/.test(p.turns[1]));
  assert.equal(t.onTopic([{ genres: "Hip Hop", year: "1993" }, { genres: "Hip Hop", year: 1988 }], hiphop.topic), 1);
  assert.equal(t.onTopic(hits, null), null);
  assert.equal(t.pairOf([" psychedelic rock from the 60s", "Something from  Britain"]), psych);
  assert.equal(t.pairOf(["Psychedelic rock from the 60s", "something else"]), null);
  for (const p of t.PAIRS) assert.equal(p.turns.length, 2);
});

test("the completions body: every turn, the answers between them as text", async () => {
  const t = await load("public/prefetch/tune.mjs");
  const m = t.messagesFor(["one", "two"], ["first answer"]);
  assert.deepEqual(m.map((x) => x.role), ["user", "assistant", "user"]);
  assert.deepEqual(m[1].parts, [{ type: "text", text: "first answer" }]);
  assert.deepEqual(t.messagesFor(["only"], []).map((x) => x.role), ["user"]);
});

test("the stream says what prefetch searched: its query and its hits, MCP or native input", async () => {
  const st = await load("public/main-demo/stream.mjs");
  const run = (input) => {
    const tr = st.createTurn({ text: "q" });
    tr.headers(10, { status: 200, get: () => null });
    tr.observe(20, { type: "data-search_prefetch", data: { decision: "injected_candidate", nbHits: 2, latencyMs: 90, toolCallId: "prefetch_1" } });
    tr.observe(21, { type: "tool-input-available", toolCallId: "prefetch_1", toolName: "algolia_search_index", input });
    tr.observe(22, { type: "tool-output-available", toolCallId: "prefetch_1", output: { hits: [{ objectID: "1" }, { objectID: "2" }] } });
    tr.observe(30, { type: "tool-input-available", toolCallId: "m1", toolName: "algolia_search_index", input: { query: "model" } });
    tr.observe(40, { type: "tool-output-available", toolCallId: "m1", output: { hits: [{ objectID: "9" }] } });
    tr.finish(50);
    return tr.view();
  };
  const mcp = run({ queries: [{ query: "psychedelic rock britain" }], originalQuery: "x" });
  assert.equal(mcp.prefetchQuery, "psychedelic rock britain");
  assert.deepEqual(mcp.prefetchHits.map((h) => h.objectID), ["1", "2"], "the prefetch's hits, not the model's later ones");
  assert.deepEqual(mcp.hits.map((h) => h.objectID), ["9"]);
  assert.equal(run({ query: "native" }).prefetchQuery, "native");
  const none = st.createTurn({ text: "q" }).view();
  assert.equal(none.prefetchQuery, null);
  assert.deepEqual(none.prefetchHits, []);
});

test("the title screen's morph: the search becomes the prefetch, the first model call closes", async () => {
  const i = await load("public/prefetch/intro.mjs");
  const run = {
    before: [{ kind: "wait", ms: 300 }, { kind: "model", ms: 1500 }, { kind: "search", ms: 400 }, { kind: "model", ms: 1200 }, { kind: "answer", ms: 2600 }],
    after: [{ kind: "wait", ms: 300 }, { kind: "prefetch", ms: 200 }, { kind: "model", ms: 1300 }, { kind: "answer", ms: 2500 }],
  };
  assert.ok(i.isMorphable(run));
  assert.equal(i.isMorphable(i.TYPICAL), Boolean(i.TYPICAL.measured), "the stored run is drawn only once measured");
  const m = i.morph(run);
  assert.deepEqual(m.totals, { before: 6000, after: 4300 });
  assert.equal(m.scale, 6000);
  const ids = (segs) => segs.map((s) => s.id).sort();
  assert.deepEqual(ids(m.after), ids(m.before), "every segment has a partner, so nothing pops");
  const after = Object.fromEntries(m.after.map((s) => [s.id, s]));
  assert.equal(after["search-1"].kind, "prefetch");
  assert.equal(after["model-1"].width, 0, "the call that only asked for a search closes");
  assert.equal(after["model-2"].width, (1300 / 6000) * 100);
  const end = Math.max(...m.after.map((s) => s.left + s.width));
  assert.ok(Math.abs(end - (4300 / 6000) * 100) < 1e-9, "the bar with prefetch ends where its run ended");
});

test("phases to the stored shape: neighbours merged, other tools count as model time", async () => {
  const i = await load("public/prefetch/intro.mjs");
  const parts = [
    { kind: "wait", start: 0, end: 200 }, { kind: "model", start: 200, end: 900 }, { kind: "tool", start: 900, end: 950 },
    { kind: "model", start: 950, end: 1000 }, { kind: "answer", start: 1000, end: 2000.4 },
  ];
  assert.deepEqual(i.fromPhases(parts), [{ kind: "wait", ms: 200 }, { kind: "model", ms: 800 }, { kind: "answer", ms: 1000 }]);
  const sliver = [{ kind: "wait", start: 0, end: 300 }, { kind: "model", start: 300, end: 302 }, { kind: "prefetch", start: 302, end: 390 }];
  assert.deepEqual(i.fromPhases(sliver), [{ kind: "wait", ms: 302 }, { kind: "prefetch", ms: 88 }], "a 2 ms gap between events is not a model call");
});

test("album cards: a byline of artist and year, nothing for a record without them", async () => {
  const f = await load("public/main-demo/fields.mjs");
  assert.equal(f.bylineText({ artist: "The Zombies", year: 1968 }, ["artist", "year"]), "The Zombies · 1968");
  assert.equal(f.bylineText({ artist: "Nico" }, ["artist", "year"]), "Nico");
  assert.equal(f.bylineText({ title: "x" }, f.FIELD_DEFAULTS.byline), "");
});

test("the script writes only DEMO_albums- agents, on the shape the page reads", async () => {
  const p = await load("tools/prefetch-albums-provision.mjs");
  const calls = [];
  const fake = async (method, route, body) => { calls.push([method, route]); return method === "POST" && route === "/1/agents" ? { id: "new" } : {}; };
  const call = p.albumFence(fake);
  await assert.rejects(call("POST", "/1/agents", { name: "DEMO_main-demo-base" }), /refused/);
  await assert.rejects(call("PATCH", "/1/agents/other", {}), /refused/);
  call.own({ id: "mine", name: "DEMO_albums-base" });
  call.own({ id: "theirs", name: "Production agent" });
  await call("PATCH", "/1/agents/mine", {});
  await assert.rejects(call("POST", "/1/agents/theirs/publish"), /refused/);
  await call("POST", "/1/agents", { name: "DEMO_albums-prefetch-w2-h3" });
  await call("POST", "/1/agents/new/publish");
  assert.equal(calls.length, 3);

  const t = await load("public/prefetch/tune.mjs");
  const body = p.albumBody(t.ALBUM_AGENTS[3], { providerId: "prov", model: "m" });
  assert.equal("enableAlgoliaMcp" in body.config, false, "create refuses the MCP flag in config");
  assert.deepEqual(p.validateAlbumBody(body), []);
  for (const a of t.ALBUM_AGENTS) assert.deepEqual(p.validateAlbumBody(p.albumBody(a, { providerId: "prov", model: "m" })), [], a.name);
  assert.match(p.validateAlbumBody({ ...body, config: { ...body.config, enableAlgoliaMcp: true } }).join(), /enableAlgoliaMcp/);
  assert.match(p.validateAlbumBody({ ...body, config: { ...body.config, searchPrefetch: { enabled: true, conversationWindow: 6, hitsPerPage: 3 } } }).join(), /conversationWindow/);
  assert.match(p.validateAlbumBody({ ...body, name: "Prod" }).join(), /name/);
  assert.equal(body.config.sendUsage, true);
  assert.deepEqual(body.config.searchPrefetch, t.prefetchBlock(t.ALBUM_AGENTS[3].prefetch));
  assert.equal(body.tools[0].indices[0].index, "thousand_albums");
  assert.ok(body.tools[0].indices[0].searchParameters.attributesToRetrieve.includes("image"), "the covers come back with the hits");
  assert.deepEqual(p.albumDrift({ ...body, config: { ...body.config, search_prefetch: { enabled: true, conversation_window: 1, hits_per_page: 10 }, searchPrefetch: undefined } }, body), []);
  assert.deepEqual(p.albumDrift({ ...body, model: "other" }, body), ["model other"]);
  const base = p.albumBody(t.ALBUM_AGENTS[0], { providerId: "prov", model: "m" });
  assert.equal(base.instructions, body.instructions, "one prompt for every agent");
  assert.equal(base.config.searchPrefetch, false);
});

test("the config block: replaced in place, other blocks untouched, never doubled", async () => {
  const p = await load("tools/prefetch-albums-provision.mjs");
  const t = await load("public/prefetch/tune.mjs");
  const agents = t.ALBUM_AGENTS.map((a, k) => ({ name: a.name, agentId: `id${k}`, model: "m" }));
  const block = p.albumsBlock({ appId: "APP", region: "eu", agentStudioApiKey: "K", agents });
  assert.equal(block.variants["prefetch=0,memory=0,guardrails=0,suggestions=0"].agentId, "id0");
  assert.equal(block.variants["prefetch=1,memory=0,guardrails=0,suggestions=0"].agentId, "id1");
  assert.deepEqual(Object.keys(block.tune).sort(), ["w1-h10", "w1-h3", "w1-h5", "w2-h10", "w2-h3", "w3-h10", "w3-h3"]);
  assert.equal(block.indexName, "thousand_albums");
  assert.deepEqual(block.query, { enableAlgoliaMcp: "true" }, "every call asks for the MCP search path prefetch runs on");
  const src = 'window.DEMO_CONFIG = { mainDemo: { appId: "W8" } };\n';
  const once = p.withAlbumsBlock(src, block);
  const twice = p.withAlbumsBlock(once, { ...block, region: "us" });
  const cfg = p.readConfig(twice);
  assert.equal(cfg.mainDemo.appId, "W8");
  assert.equal(cfg.prefetchAlbums.region, "us");
  assert.equal(twice.split("prefetchAlbums: begin").length, 2, "one block, however many runs");
  assert.ok(twice.startsWith(src.trim()));
  assert.deepEqual(p.browserKeys({ mainDemo: { appId: "APP", agentStudioApiKey: "K", searchApiKey: "S" } }, "APP"), { agentStudioApiKey: "K", searchApiKey: "S" });
  assert.equal(p.browserKeys({ mainDemo: { appId: "OTHER", agentStudioApiKey: "K" } }, "APP"), null);
  assert.deepEqual(p.browserKeys({ other: { appId: "APP", agentStudioApiKey: "X" }, prefetchAlbums: { appId: "APP", agentStudioApiKey: "K" } }, "APP"),
    { agentStudioApiKey: "K", searchApiKey: null }, "the block's own key wins over another block of the same app");
  assert.deepEqual(p.blockAgents(block).map((a) => a.agentId).sort(), agents.map((a) => a.agentId).sort(), "every agent once, race partner included");
});

test("the page tells it in three acts: a title screen, the race, then Tune it", () => {
  const html = page("index.html");
  const order = ['id="intro"', 'id="morph"', 'class="pf-scroll"', 'id="act-race"', 'id="ask-form"', 'id="act-tune"', 'id="tune-form"', 'id="tune-a"', 'id="tune-b"']
    .map((m) => html.indexOf(m));
  assert.ok(order.every((x) => x > 0));
  assert.deepEqual([...order].sort((x, y) => x - y), order);
  assert.match(html, /<span class="pf-morph-note">a typical run<\/span>/);
  for (const src of ["intro.js", "tune.js"]) assert.match(html, new RegExp(`<script type="module" src="${src}"></script>`));
  assert.match(page("intro.js"), /prefers-reduced-motion: reduce/);
  assert.match(page("style.css"), /@media \(prefers-reduced-motion: reduce\) \{\s*\.pf-morph \.pf-seg/);
  for (const f of ["index.html", "intro.js", "intro.mjs", "tune.js", "tune.mjs", "style.css"]) {
    assert.doesNotMatch(page(f), /—|&mdash;/, `${f}: no em dash`);
  }
});

test("Tune it calls the agents with the page's browser key only, and picks agents from the map", () => {
  const src = page("tune.js");
  assert.match(src, /block\.agentStudioApiKey/);
  assert.doesNotMatch(src, /ADMIN|adminKey|PATCH|"\/1\/agents"/);
  assert.match(src, /tuneAgent\(block, lane\.combo\)/);
  assert.match(src, /block\.query/, "Tune it asks for the same MCP path as the race");
  assert.match(fs.readFileSync(path.join(PUBLIC, "main-demo", "lane.js"), "utf8"), /\.\.\.\(cfg\.query \|\| \{\}\)/, "the race lanes add the block's query");
});

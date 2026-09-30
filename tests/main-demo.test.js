/* main-demo: the variant table and the stream reader, against the fixture.
   The modules are ESM (.mjs) because the provisioning script imports the
   same bytes; node:test reaches them through a dynamic import. */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const dir = path.join(__dirname, "..", "public", "main-demo");
const load = (f) => import(pathToFileURL(path.join(dir, f)).href);

test("every manifest variant has a canonical key, a unique name, and round-trips", async () => {
  const c = await load("configs.mjs");
  const names = new Set();
  const keys = new Set();
  for (const m of c.MANIFEST) {
    const key = c.configKey(m.toggles);
    assert.deepEqual(c.parseKey(key), c.normalize(m.toggles));
    assert.equal(c.agentName(m.toggles), m.name);
    names.add(m.name);
    keys.add(key);
  }
  assert.equal(names.size, c.MANIFEST.length);
  assert.equal(keys.size, c.MANIFEST.length);
  assert.throws(() => c.parseKey("prefetch=off,memory=1"), /canonical/);
  assert.throws(() => c.parseKey("color=blue"), /unknown toggle/);
});

test("a combination outside the manifest gets a stable, readable name", async () => {
  const c = await load("configs.mjs");
  const t = { prefetch: "user_fold", memory: true, guardrails: false, suggestions: true };
  assert.equal(c.agentName(t), "main-demo-prefetch-user-fold-memory-suggestions");
});

test("the config a variant writes reads back as the same toggles", async () => {
  const c = await load("configs.mjs");
  for (const m of c.MANIFEST) {
    const cfg = c.agentConfigPatch(m.toggles);
    assert.equal(c.configKey(c.togglesFromAgentConfig(cfg)), c.configKey(m.toggles), m.name);
  }
  // the spellings the backend may hand back
  assert.equal(c.togglesFromAgentConfig({ searchPrefetch: true }).prefetch, "tool_pair");
  assert.equal(c.togglesFromAgentConfig({ search_prefetch: { enabled: false } }).prefetch, "off");
  assert.equal(c.togglesFromAgentConfig({ search_prefetch: { injection_format: "User-Fold" } }).prefetch, "user_fold");
  assert.equal(c.togglesFromAgentConfig({}).prefetch, "off");
});

test("resolution: exact agent, prefetch off by query parameter, or a command", async () => {
  const c = await load("configs.mjs");
  const base = c.configKey(c.BASE_TOGGLES);
  const pf = c.configKey({ ...c.BASE_TOGGLES, prefetch: "tool_pair" });
  const table = { [pf]: { agentId: "pf-id", name: "main-demo-prefetch" } };

  const q = c.resolveVariant(c.BASE_TOGGLES, table);
  assert.equal(q.status, "query");
  assert.equal(q.agentId, "pf-id");
  assert.equal(c.completionQuery(q).searchPrefetch, "false");
  assert.equal(c.completionQuery(q).cache, "false", "a race never reads the completion cache");

  const exact = c.resolveVariant(c.BASE_TOGGLES, { ...table, [base]: { agentId: "base-id" } });
  assert.equal(exact.status, "agent");
  assert.equal(exact.agentId, "base-id");
  assert.equal(c.completionQuery(exact).searchPrefetch, undefined);

  const miss = c.resolveVariant({ ...c.BASE_TOGGLES, memory: true }, table);
  assert.equal(miss.status, "missing");
  assert.match(miss.command, /node tools\/main-demo-provision\.mjs$/, "a manifest variant needs no --add");
  const combo = c.resolveVariant({ ...c.BASE_TOGGLES, memory: true, suggestions: true }, table);
  assert.match(combo.command, /node tools\/main-demo-provision\.mjs --add 'prefetch=off,memory=1,guardrails=0,suggestions=1'$/);
  // a prefetch lane never borrows a prefetch-off agent
  assert.equal(c.resolveVariant({ ...c.BASE_TOGGLES, prefetch: "user_fold" }, table).status, "missing");
});

test("the SSE parser survives events split across chunks", async () => {
  const { createSseParser } = await load("stream.mjs");
  const seen = [];
  const p = createSseParser((e) => seen.push(e.type));
  p.push('data: {"type":"start"}\n\ndata: {"type":"text-');
  p.push('delta","delta":"hi"}\n\n: comment\n\ndata: not json\n\ndata: [DONE]\n');
  p.end();
  assert.deepEqual(seen, ["start", "text-delta", "[DONE]"]);
});

/** replay a fixture script through a turn, with the script's own clock */
async function replay(prefetch) {
  const { fixtureEvents } = await load("fixture.mjs");
  const { createTurn } = await load("stream.mjs");
  const script = fixtureEvents({ prefetch });
  const turn = createTurn({ text: "q" });
  turn.headers(script[0][0], { status: 200, get: () => null });
  for (const [t, e] of script) if (e !== "[DONE]") turn.observe(t, e);
  turn.finish(script[script.length - 1][0]);
  return turn.view();
}

test("a base turn: two tool calls with durations, hits, grouped results, then text", async () => {
  const v = await replay("off");
  assert.equal(v.status, "done");
  assert.deepEqual(v.tools.map((x) => x.name), ["algolia_search_index", "algolia_grouped_results"]);
  assert.ok(v.tools.every((x) => x.duration > 0));
  assert.equal(v.hits.length, 6);
  assert.equal(v.hitsTool, "algolia_search_index");
  assert.equal(v.grouped.groups.length, 2);
  assert.ok(v.ttfb < v.ttft && v.ttft < v.total);
  assert.equal(v.prefetch, null, "no badge without evidence");
});

test("tool_pair keeps the prefetched search off the wire; persisted_tool_pair shows it", async () => {
  const tp = await replay("tool_pair");
  assert.deepEqual(tp.tools.map((x) => x.name), ["algolia_grouped_results"]);
  assert.equal(tp.hits.length, 0);
  assert.equal(tp.prefetch, null);

  const pp = await replay("persisted_tool_pair");
  assert.equal(pp.prefetch.source, "persisted-pair");
  assert.equal(pp.hits.length, 6);
  assert.ok(pp.tools[0].prefetched);
});

test("the prefetch badge reads the header and a search_prefetch stream part", async () => {
  const { createTurn, isPrefetchPart } = await load("stream.mjs");
  const a = createTurn();
  a.headers(10, { status: 200, get: (h) => (h === "x-search-prefetch" ? "injected" : null) });
  assert.deepEqual(a.view().prefetch, { source: "header", detail: "injected" });

  const b = createTurn();
  b.observe(5, { type: "data-search-prefetch", data: { nbHits: 7 } });
  assert.equal(b.view().prefetch.source, "stream");
  assert.ok(isPrefetchPart({ type: "search_prefetch" }));
  assert.ok(!isPrefetchPart({ type: "data-suggestions" }));
});

test("ms() prints milliseconds under a second and seconds above", async () => {
  const { ms } = await load("stream.mjs");
  assert.equal(ms(412.4), "412\u00a0ms");
  assert.equal(ms(1930), "1.93\u00a0s");
  assert.equal(ms(null), "—");
});

test("config.example.js documents every mainDemo field the page reads", () => {
  const { loadExampleConfig } = require("./load.js");
  const md = loadExampleConfig().mainDemo;
  assert.ok(md, "config.example.js has no mainDemo block");
  for (const f of ["host", "appId", "searchApiKey", "agentStudioApiKey", "indexName"]) {
    assert.ok(typeof md[f] === "string" && md[f], `mainDemo.${f} is missing`);
  }
});

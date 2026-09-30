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

test("card fields: an array with empty entries yields its first usable image, then the rest", async () => {
  const f = await load("fields.mjs");
  const fields = f.fieldsFrom({ fields: { title: "name", image: "image_urls.0", price: "price.value", line: "brand" } });
  const hit = {
    objectID: "1", name: "Leather jacket", brand: "Bully",
    image_urls: ["https://res.cloudinary.com/x/X_0.jpg", "", ""],
    price: { value: 448.75, currency: "EUR" },
  };
  assert.equal(f.pick(hit, fields.image), "https://res.cloudinary.com/x/X_0.jpg");
  assert.deepEqual(f.imageCandidates(hit, fields.image), ["https://res.cloudinary.com/x/X_0.jpg"]);

  const firstEmpty = { ...hit, image_urls: ["", "https://res.cloudinary.com/x/X_1.jpg", "https://res.cloudinary.com/x/X_2.jpg"] };
  assert.equal(f.pick(firstEmpty, fields.image), "https://res.cloudinary.com/x/X_1.jpg");
  assert.deepEqual(f.imageCandidates(firstEmpty, fields.image),
    ["https://res.cloudinary.com/x/X_1.jpg", "https://res.cloudinary.com/x/X_2.jpg"]);

  assert.equal(f.pick({ ...hit, image_urls: ["", "", ""] }, fields.image), undefined);
  assert.equal(f.pick(hit, fields.title), "Leather jacket");
  assert.equal(f.pick(hit, fields.price), 448.75);
  assert.equal(f.pick(hit, fields.currency), "EUR");
  assert.equal(f.pick({ image_blurred: "LNSPX]M{" }, fields.blurhash), "LNSPX]M{");
  assert.match(f.priceText(448.75, "EUR"), /448\.75/);
  // the products index: a bare number, no currency field, meant as USD
  const usd = f.fieldsFrom({ fields: { title: "title", image: "largeImage", price: "price", line: "brand" } });
  const p = { title: "Headphones", largeImage: "https://img.example/h.jpg", price: 79.99, brand: "Acme" };
  assert.equal(f.pick(p, usd.currency), undefined);
  assert.equal(f.priceText(f.pick(p, usd.price), f.pick(p, usd.currency)),
    new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(79.99));
  assert.equal(f.pick(p, usd.image), "https://img.example/h.jpg");
});

test("search calls: the model's own are counted, the prefetched pair and grouped results are not", async () => {
  const { isSearchTool } = await load("stream.mjs");
  assert.ok(isSearchTool("algolia_search_index"));
  assert.ok(isSearchTool("algolia_search_index_prod_ecom"));
  assert.ok(!isSearchTool("algolia_grouped_results"));
  assert.ok(!isSearchTool("algolia_memory_search"));
  assert.equal((await replay("off")).searches, 1);
  assert.equal((await replay("tool_pair")).searches, 0);
  assert.equal((await replay("persisted_tool_pair")).searches, 0, "the prefetched pair is not the model's call");
});

test("search counts: passive for the prefetch, active for the model's own calls, gated means 0", async () => {
  const { searchCounts, createTurn } = await load("stream.mjs");
  const { fixtureEvents, prefetchMisses } = await load("fixture.mjs");
  assert.deepEqual(searchCounts(false, await replay("off")), { passive: 0, active: 1, confirmed: false, part: null });
  const used = searchCounts(true, await replay("tool_pair"));
  assert.equal(used.passive, 1);
  assert.equal(used.active, 0);
  assert.equal(used.confirmed, false, "inferred from the config, not reported");
  assert.equal(searchCounts(true, await replay("persisted_tool_pair")).confirmed, true, "the pair is on the wire");

  assert.ok(prefetchMisses("A video game for a 10 year old, under $30"));
  assert.ok(!prefetchMisses("A portable bluetooth speaker for the beach"));
  const script = fixtureEvents({ prefetch: "tool_pair", missed: true });
  const turn = createTurn();
  for (const [t, e] of script) if (e !== "[DONE]") turn.observe(t, e);
  turn.finish(script[script.length - 1][0]);
  assert.deepEqual([searchCounts(true, turn.view()).passive, searchCounts(true, turn.view()).active], [1, 1]);

  const gated = createTurn();
  gated.observe(5, { type: "data-search_prefetch", data: { decision: "too_few_tokens", injected: false, latencyMs: null } });
  assert.equal(searchCounts(true, gated.view()).passive, 0);
  const ran = createTurn();
  ran.observe(5, { type: "data-search_prefetch", data: { decision: "injected", injected: true, latencyMs: 44, nbHits: 7 } });
  assert.deepEqual([searchCounts(true, ran.view()).passive, searchCounts(true, ran.view()).confirmed], [1, true]);
});

test("model work: LLM steps, the model's tool calls, its tool-input errors, and usage when streamed", async () => {
  const { createTurn, usageOf } = await load("stream.mjs");
  const base = await replay("off");
  const pf = await replay("tool_pair");
  assert.deepEqual([base.modelCalls, base.toolCalls, base.toolErrors], [3, 2, 0]);
  assert.deepEqual([pf.modelCalls, pf.toolCalls], [2, 1], "prefetch saves a step and a call");
  assert.equal((await replay("persisted_tool_pair")).toolCalls, 1, "the prefetched pair is not the model's call");
  const t = createTurn();
  t.observe(1, { type: "tool-input-error", toolCallId: "x", toolName: "algolia_search_index", errorText: "bad args" });
  t.observe(2, { type: "data-total-usage", data: { usage: { inputTokens: 1200, outputTokens: 80 } }, transient: true });
  assert.equal(t.view().toolErrors, 1);
  assert.deepEqual(t.view().usage, { inputTokens: 1200, outputTokens: 80 });
  assert.equal(base.usage, null, "no usage unless the agent streams it");
  assert.deepEqual(usageOf({ type: "finish", messageMetadata: { usage: { inputTokens: 5 } } }), { inputTokens: 5, outputTokens: null });
});

test("no tool outlasts its turn: an open call closes at the turn's end", async () => {
  const { createTurn } = await load("stream.mjs");
  const turn = createTurn();
  turn.headers(130, { status: 200, get: () => null });
  turn.observe(788, { type: "tool-input-start", toolCallId: "c1", toolName: "algolia_search_index_products" });
  turn.observe(2239, { type: "tool-output-available", toolCallId: "c1", output: { hits: [] } });
  turn.observe(2865, { type: "tool-input-start", toolCallId: "c2", toolName: "algolia_grouped_results" });
  turn.finish(5686);
  const v = turn.view();
  assert.equal(Math.round(v.tools[0].duration), 1451);
  assert.equal(v.tools[1].duration, 5686 - 2865, "never answered: stops at the turn's end");
  assert.ok(v.tools[1].open);
  for (const x of v.tools) assert.ok(x.start + x.duration <= v.total, `${x.name} ends inside the turn`);
});

test("race: medians, paired deltas and a tally across repeated runs", async () => {
  const r = await load("race.mjs");
  const run = (a, b) => ({ a: { ok: true, ...a }, b: { ok: true, ...b } });
  const runs = [
    run({ modelCalls: 3, total: 11000 }, { modelCalls: 2, total: 8000 }),
    run({ modelCalls: 3, total: 9000 }, { modelCalls: 3, total: 9100 }),
    run({ modelCalls: 2, total: 7000 }, { modelCalls: 3, total: 9500 }),
  ];
  const calls = r.compare(r.METRICS.find((m) => m.id === "modelCalls"), runs);
  assert.deepEqual([calls.a, calls.b, calls.delta, calls.n], [3, 3, 0, 3]);
  assert.deepEqual(calls.tally, { a: 1, b: 1, even: 1 });
  assert.equal(r.deltaText(r.METRICS[0], calls), "even");

  const paint = r.compare(r.METRICS.find((m) => m.id === "total"), runs);
  assert.deepEqual(paint.tally, { a: 1, b: 1, even: 1 }, "100 ms on 9 s is within 5%");
  assert.equal(paint.delta, 100);
  assert.equal(r.median([4, 1, 3, 2]), 2.5);
  assert.equal(r.median([null, undefined]), null);

  const one = r.compare(r.METRICS[0], [run({ modelCalls: 3 }, { modelCalls: 2 })]);
  assert.equal(r.deltaText(r.METRICS[0], one), "B 1 call fewer");
  const none = r.compare(r.METRICS.find((m) => m.id === "inputTokens"), runs);
  assert.equal(none.n, 0, "no usage streamed: nothing to pair");
  assert.equal(r.deltaText(r.METRICS[5], none), "");

  const { summarize } = r;
  assert.equal(summarize({ status: "error", total: 5, modelCalls: 1, toolCalls: 0, toolErrors: 0, ttft: null }).total, null,
    "a failed turn has no full paint");
});

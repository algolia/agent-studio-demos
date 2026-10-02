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
  assert.throws(() => c.parseKey("prefetch=0,memory=1"), /canonical/);
  assert.throws(() => c.parseKey("prefetch=tool_pair,memory=0,guardrails=0,suggestions=0"), /unknown toggle/,
    "prefetch is on or off: there is one injection format");
  assert.throws(() => c.parseKey("color=blue"), /unknown toggle/);
});

test("a combination outside the manifest gets a stable, readable name", async () => {
  const c = await load("configs.mjs");
  const t = { prefetch: true, memory: true, guardrails: false, suggestions: true };
  assert.equal(c.agentName(t), "main-demo-prefetch-memory-suggestions");
});

test("the config a variant writes reads back as the same toggles", async () => {
  const c = await load("configs.mjs");
  for (const m of c.MANIFEST) {
    const cfg = c.agentConfigPatch(m.toggles);
    assert.equal(c.configKey(c.togglesFromAgentConfig(cfg)), c.configKey(m.toggles), m.name);
  }
  // the spellings the backend may hand back
  assert.equal(c.togglesFromAgentConfig({ searchPrefetch: true }).prefetch, true);
  assert.equal(c.togglesFromAgentConfig({ search_prefetch: { enabled: false } }).prefetch, false);
  assert.equal(c.togglesFromAgentConfig({ search_prefetch: { injectionFormat: "user_fold" } }).prefetch, true,
    "a key an older backend wrote still reads as on");
  assert.equal(c.togglesFromAgentConfig({}).prefetch, false);
});

test("resolution: the exact agent or a command, and prefetch off is its own agent", async () => {
  const c = await load("configs.mjs");
  const base = c.configKey(c.BASE_TOGGLES);
  const pf = c.configKey({ ...c.BASE_TOGGLES, prefetch: true });
  const table = { [pf]: { agentId: "pf-id", name: "main-demo-prefetch" } };

  // no per-request override: a prefetch agent never stands in for its prefetch-off twin
  const off = c.resolveVariant(c.BASE_TOGGLES, table);
  assert.equal(off.status, "missing");
  assert.equal(c.completionQuery().searchPrefetch, undefined);
  assert.equal(c.completionQuery().cache, "false", "a race never reads the completion cache");

  const exact = c.resolveVariant(c.BASE_TOGGLES, { ...table, [base]: { agentId: "base-id" } });
  assert.equal(exact.status, "agent");
  assert.equal(exact.agentId, "base-id");

  const miss = c.resolveVariant({ ...c.BASE_TOGGLES, memory: true }, table);
  assert.equal(miss.status, "missing");
  assert.match(miss.command, /node tools\/main-demo-provision\.mjs$/, "a manifest variant needs no --add");
  const combo = c.resolveVariant({ ...c.BASE_TOGGLES, memory: true, suggestions: true }, table);
  assert.match(combo.command, /node tools\/main-demo-provision\.mjs --add 'prefetch=0,memory=1,guardrails=0,suggestions=1'$/);
  // a prefetch lane never borrows a prefetch-off agent
  assert.equal(c.resolveVariant({ ...c.BASE_TOGGLES, prefetch: true }, { [base]: { agentId: "base-id" } }).status, "missing");
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
  const v = await replay(false);
  assert.equal(v.status, "done");
  assert.deepEqual(v.tools.map((x) => x.name), ["algolia_search_index_products", "algolia_grouped_results"]);
  assert.ok(v.tools.every((x) => x.duration > 0));
  assert.equal(v.hits.length, 6);
  assert.equal(v.hitsTool, "algolia_search_index_products");
  assert.equal(v.grouped.groups.length, 2);
  assert.ok(v.ttfb < v.ttft && v.ttft < v.total);
  assert.equal(v.prefetchPart, null, "a prefetch-off agent streams no part");
});

test("the prefetched search is on the wire, as a tool pair before the first model step", async () => {
  const pp = await replay(true);
  assert.deepEqual(pp.tools.map((x) => x.name), ["algolia_search_index_products", "algolia_grouped_results"]);
  assert.equal(pp.hits.length, 6, "the hits ride on the visible tool output, never on the part");
  assert.deepEqual(pp.tools.map((x) => x.passive), [true, false]);
  assert.equal(pp.prefetchParts, 2, "sent up front, then again before finish");
  assert.equal(pp.prefetchPart.agentSearchedAnyway, false);
  assert.equal(pp.prefetchPart.hits, undefined);
  const [passive] = pp.tools;
  assert.equal(passive.duration, 212.4, "the passive search lasts what the part says, not its wire time");
  assert.equal(passive.end, pp.tools[0].start + 212.4);
});

test("a part with toolCallId marks exactly that tool call passive, whatever its id looks like", async () => {
  const { createTurn, isPrefetchPart } = await load("stream.mjs");
  const t = createTurn();
  t.observe(1, { type: "data-search_prefetch", id: "search_prefetch",
    data: { decision: "injected_candidate", nbHits: 3, latencyMs: 180.2, toolName: "algolia_search_index_products",
      index: "products", toolCallId: "prefetch_abc" } });
  for (const id of ["prefetch_abc", "prefetch_other", "call_1"]) {
    t.observe(2, { type: "tool-input-start", toolCallId: id, toolName: "algolia_search_index_products" });
    t.observe(3, { type: "tool-output-available", toolCallId: id, output: { hits: [] } });
  }
  t.finish(10);
  const v = t.view();
  assert.deepEqual(v.tools.map((x) => [x.id, x.passive]), [["prefetch_abc", true], ["prefetch_other", false], ["call_1", false]]);
  assert.equal(v.searches, 2, "only the part's tool call is the passive search");
  assert.equal(v.toolCalls, 2, "the passive search is not a call the model wrote");

  assert.ok(isPrefetchPart({ type: "data-search_prefetch" }));
  assert.ok(!isPrefetchPart({ type: "data-suggestions" }));
});

test("the second prefetch part's agentSearchedAnyway wins", async () => {
  const { createTurn, searchCounts } = await load("stream.mjs");
  const first = { decision: "injected_candidate", nbHits: 6, latencyMs: 212.4, toolName: "s", index: "products", toolCallId: "prefetch_1" };
  const t = createTurn();
  t.observe(1, { type: "data-search_prefetch", id: "search_prefetch", data: first });
  assert.equal(searchCounts(true, t.view()).searchedAnyway, null, "unknown until the turn ends");
  t.observe(9, { type: "data-search_prefetch", id: "search_prefetch", data: { ...first, agentSearchedAnyway: true } });
  const c = searchCounts(true, t.view());
  assert.equal(c.searchedAnyway, true);
  assert.equal(c.passive, 1);
  assert.equal(t.view().prefetchParts, 2);
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
  assert.equal((await replay(false)).searches, 1);
  assert.equal((await replay(true)).searches, 0, "the prefetched pair is not the model's call");
});

test("search counts: passive from the part, active for the model's own calls, skipped means 0", async () => {
  const { searchCounts, createTurn, decisionLabel } = await load("stream.mjs");
  const { fixtureEvents, prefetchMisses, fixtureSkips } = await load("fixture.mjs");
  assert.deepEqual(searchCounts(false, await replay(false)),
    { passive: 0, active: 1, part: null, searchedAnyway: null, reported: false, expected: false });
  const used = searchCounts(true, await replay(true));
  assert.deepEqual([used.passive, used.active, used.searchedAnyway, used.reported], [1, 0, false, true]);

  assert.ok(prefetchMisses("A video game for a 10 year old, under $30"));
  assert.ok(!prefetchMisses("A portable bluetooth speaker for the beach"));
  const play = (opts) => {
    const script = fixtureEvents(opts);
    const turn = createTurn();
    for (const [t, e] of script) if (e !== "[DONE]") turn.observe(t, e);
    turn.finish(script[script.length - 1][0]);
    return searchCounts(true, turn.view());
  };
  const missed = play({ prefetch: true, missed: true });
  assert.deepEqual([missed.passive, missed.active, missed.searchedAnyway], [1, 1, true]);

  assert.ok(fixtureSkips("hi"));
  const skipped = play({ prefetch: true, query: "hi" });
  assert.deepEqual([skipped.passive, skipped.active, skipped.searchedAnyway], [0, 1, null]);
  assert.equal(skipped.part.decision, "skipped_too_few_tokens");
  assert.equal(decisionLabel(skipped.part.decision), "skipped: too few words");
  assert.equal(decisionLabel("injected_candidate"), "injected");
  assert.equal(decisionLabel("a_new_reason"), "a_new_reason", "an unknown decision prints as itself");

  // a prefetch agent on a backend that streams no part
  const silent = searchCounts(true, (await replay(false)));
  assert.deepEqual([silent.passive, silent.reported, silent.expected], [0, false, true]);
});

test("model work: LLM steps, the model's tool calls, its tool-input errors, and usage when streamed", async () => {
  const { createTurn, usageOf } = await load("stream.mjs");
  const base = await replay(false);
  const pf = await replay(true);
  assert.deepEqual([base.modelCalls, base.toolCalls, base.toolErrors], [3, 2, 0]);
  assert.deepEqual([pf.modelCalls, pf.toolCalls], [2, 1], "prefetch saves a step and a call");
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

test("edited configs: defaults pruned, hashed by content, resolved or named for creation", async () => {
  const c = await load("configs.mjs");
  const pf = { ...c.BASE_TOGGLES, prefetch: true };
  assert.deepEqual(c.toggleBlocks(pf).searchPrefetch, { enabled: true });
  assert.equal(c.isCustom(pf, null), false);
  // applying the editor without a change is no edit
  const same = c.blockFrom("searchPrefetch", c.blockValues("searchPrefetch", { enabled: true }));
  assert.equal(c.isCustom(pf, { searchPrefetch: same }), false);

  const v = c.blockValues("searchPrefetch", c.toggleBlocks(pf).searchPrefetch);
  assert.equal(v.conversationWindow, 1);
  assert.equal(v["searchParameters.removeWordsIfNoResults"], "allOptional");
  v.conversationWindow = 3;
  v.hitsPerPage = 5;
  v["searchParameters.queryLanguages"] = ["fr"];
  const edited = { searchPrefetch: c.blockFrom("searchPrefetch", v) };
  assert.deepEqual(edited.searchPrefetch,
    { enabled: true, conversationWindow: 3, hitsPerPage: 5, searchParameters: { queryLanguages: ["fr"] } });
  assert.ok(c.isCustom(pf, edited));
  const blocks = c.effectiveBlocks(pf, edited);
  assert.match(c.customName(blocks), /^main-demo-[0-9a-f]{8}$/);
  assert.equal(c.hashConfig(blocks), c.hashConfig(JSON.parse(JSON.stringify(blocks))), "stable");
  assert.equal(c.canonical({ b: 1, a: [2, { d: 1, c: 0 }] }), '{"a":[2,{"c":0,"d":1}],"b":1}');

  assert.deepEqual(c.validateBlock("searchPrefetch", { ...v, conversationWindow: 9 }), { conversationWindow: "1 to 5" });
  assert.deepEqual(c.validateBlock("searchPrefetch", v), {});

  const miss = c.resolveCustom(blocks, {}, {});
  assert.equal(miss.status, "custom");
  assert.match(miss.command, /--config '\{/);
  const local = { [c.customKey(blocks)]: { agentId: "id-1", name: c.customName(blocks) } };
  assert.equal(c.resolveCustom(blocks, {}, local).agentId, "id-1");

  const base = { name: "main-demo-base", instructions: "new prompt", model: "m", providerId: "p", tools: [1], config: { searchPrefetch: true, x: 1 }, id: "no" };
  const body = c.customAgentBody(base, blocks);
  assert.equal(body.instructions, "new prompt", "instructions come from base at creation");
  assert.equal(body.id, undefined);
  assert.equal(body.config.search_prefetch, undefined, "a copied stored key never shadows the one sent");
  assert.deepEqual(body.config.searchPrefetch, edited.searchPrefetch);
  assert.equal(body.config.x, 1);
  const off = c.customAgentBody(base, c.effectiveBlocks(c.BASE_TOGGLES, { sendUsage: true }));
  assert.equal(off.config.searchPrefetch, false, "a disabled prefetch block is sent as false");
  assert.equal(off.config.sendUsage, true);
  // what the backend stores reads back as the same hash: snake key, captured settings and all
  const { searchPrefetch, ...rest } = body.config;
  const stored = { ...rest, search_prefetch: { ...searchPrefetch, capturedIndexSettings: { products: { languages: ["en"] } } }, enableAlgoliaMcp: true };
  assert.equal(c.customKey(c.blocksFromConfig(stored)), c.customKey(blocks));
  assert.equal(c.customKey(c.blocksFromConfig(off.config)), c.customKey(c.effectiveBlocks(c.BASE_TOGGLES, { sendUsage: true })));
});

test("the prefetch block: the product's fields and bounds, captured settings shown and never sent", async () => {
  const c = await load("configs.mjs");
  const ids = c.BLOCKS.find((b) => b.id === "searchPrefetch").fields.map((f) => f.path);
  assert.deepEqual(ids, ["enabled", "indexName", "conversationWindow", "minInformativeTokens", "hitsPerPage",
    "searchParameters.queryLanguages", "searchParameters.naturalLanguages", "searchParameters.removeStopWords",
    "searchParameters.ignorePlurals", "searchParameters.typoTolerance", "searchParameters.removeWordsIfNoResults",
    "searchParameters.restrictSearchableAttributes", "capturedIndexSettings"]);
  assert.ok(!ids.includes("injectionFormat"));

  const captured = { products: { languages: ["en"], indexLanguages: [], capturedAt: "2026-10-02T12:00:00Z" } };
  const stored = { enabled: true, minInformativeTokens: 0, capturedIndexSettings: captured };
  const v = c.blockValues("searchPrefetch", stored);
  assert.deepEqual(v.capturedIndexSettings, captured, "the editor shows what the server wrote");
  assert.deepEqual(c.blockFrom("searchPrefetch", v), { enabled: true, minInformativeTokens: 0 }, "and never sends it");
  assert.deepEqual(c.capturedSettings({ search_prefetch: stored }), captured);
  assert.equal(c.capturedSettings({ search_prefetch: true }), null);
  assert.equal(c.customKey(c.blocksFromConfig({ search_prefetch: stored })),
    c.customKey(c.blocksFromConfig({ searchPrefetch: { enabled: true, minInformativeTokens: 0 } })),
    "a capture on save does not change the agent's hash");

  const bad = c.validateBlock("searchPrefetch", { ...v, hitsPerPage: 0, "searchParameters.queryLanguages": ["French"],
    "searchParameters.removeStopWords": "yes", "searchParameters.typoTolerance": "max",
    "searchParameters.restrictSearchableAttributes": [""] });
  assert.deepEqual(Object.keys(bad).sort(), ["hitsPerPage", "searchParameters.queryLanguages",
    "searchParameters.removeStopWords", "searchParameters.restrictSearchableAttributes", "searchParameters.typoTolerance"]);
  const good = c.validateBlock("searchPrefetch", { ...v, hitsPerPage: null, "searchParameters.removeStopWords": ["pt-br", "en"],
    "searchParameters.ignorePlurals": true, "searchParameters.typoTolerance": false,
    "searchParameters.restrictSearchableAttributes": ["title", "brand"] });
  assert.deepEqual(good, {}, "hitsPerPage may be empty; booleans and language lists both pass");

  // the toggle writes the wire key, and the off lane is an agent with prefetch false
  assert.deepEqual(c.agentConfigPatch({ prefetch: true }).searchPrefetch, { enabled: true });
  assert.equal(c.agentConfigPatch({ prefetch: false }).searchPrefetch, false);
  assert.equal(c.agentConfigPatch({ prefetch: true }).search_prefetch, undefined);
});

test("repeat: the race bar offers 1 to 10 runs, and medians and the tally hold at 10", async () => {
  const r = await load("race.mjs");
  assert.equal(Math.min(...r.REPEATS), 1);
  assert.equal(Math.max(...r.REPEATS), 10);
  assert.equal(r.MAX_REPEAT, 10);
  assert.deepEqual([r.clampRepeat(0), r.clampRepeat(7), r.clampRepeat(10), r.clampRepeat(11), r.clampRepeat("x")], [1, 7, 10, 10, 1]);

  // ten runs: B saves one call on 7, ties on 2, loses one on 1; paint medians from 1..10 s
  const runs = Array.from({ length: 10 }, (_, i) => ({
    a: { ok: true, modelCalls: 3, total: (i + 1) * 1000 },
    b: { ok: true, modelCalls: i < 7 ? 2 : i < 9 ? 3 : 4, total: (i + 1) * 1000 - 500 },
  }));
  const calls = r.compare(r.METRICS.find((m) => m.id === "modelCalls"), runs);
  assert.deepEqual(calls.tally, { a: 1, b: 7, even: 2 });
  assert.equal(calls.n, 10);
  assert.equal(calls.runs.length, 10);
  assert.equal(calls.b, 2, "median of seven 2s, two 3s and a 4");
  assert.equal(calls.delta, -1);
  const paint = r.compare(r.METRICS.find((m) => m.id === "total"), runs);
  assert.equal(paint.a, 5500, "even count: the mean of the 5th and 6th");
  assert.equal(paint.b, 5000);
  assert.equal(paint.delta, -500);
  assert.deepEqual(paint.tally, { a: 0, b: 9, even: 1 }, "500 ms on the 10 s run is within 5%: even");
});

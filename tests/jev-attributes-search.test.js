/* jev-attributes: one question, one multi-query. The name phrases it holds,
   the hits that really are those names, the union and its cap, and the
   requests the browser sends: the multi-query and the getObject. */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const load = () => import(pathToFileURL(path.join(__dirname, "..", "public", "jev-attributes", "search.mjs")).href);

const hit = (objectID, name, info = {}) => ({
  objectID, name, "Geography.Area": "1 sq km",
  _rankingInfo: { nbTypos: 0, words: 1, firstMatchedWord: 0, nbExactWords: 1, ...info },
});

test("name phrases: capitalised runs, possessives and stop words out, split on commas and and", async () => {
  const { namePhrases } = await load();
  const names = (q) => namePhrases(q).map((p) => p.phrase);
  assert.deepEqual(names("What can Peru, Germany, and Lebanon's neighbors have in common?"), ["Peru", "Germany", "Lebanon"]);
  assert.deepEqual(names("Compare Japan and Germany military spending"), ["Japan", "Germany"]);
  assert.deepEqual(names("Is Saudi Arabia bigger than the United Arab Emirates?"), ["Saudi Arabia", "United Arab Emirates"]);
  assert.deepEqual(names("Peru's GDP growth"), ["Peru", "GDP"], "a possessive ends a run, an acronym stands alone");
  assert.deepEqual(names("Where does the Danube flow?"), ["Danube"]);
  assert.deepEqual(names("which countries border austria"), [], "no capital, no phrase: the whole question still runs");
  // runs cap at three words
  assert.deepEqual(names("Alpha Beta Gamma Delta"), ["Alpha Beta Gamma", "Delta"]);
  // only the first word of the question is marked: a capital there proves nothing
  assert.deepEqual(namePhrases("Island nations near Fiji").map((p) => p.initial), [true, false]);
});

test("a name phrase keeps only hits that are that name: no typo, on the name or exact on an alias", async () => {
  const { nameMatches } = await load();
  const hits = [
    hit("gm", "Germany"),
    hit("wa", "Namibia", { nbTypos: 1, firstMatchedWord: 1011, nbExactWords: 0 }),
    hit("bm", "Burma alias", { firstMatchedWord: 1000, nbExactWords: 1 }),
    hit("bl", "Bolivia", { firstMatchedWord: 1025, nbExactWords: 0 }),
  ];
  assert.deepEqual(nameMatches(hits, { phrase: "Germany", initial: false }).map((h) => h.objectID), ["gm", "bm"]);
  // at the start of the question, only an exact match counts: "Island" is not Wake Island
  const island = [hit("wq", "Wake Island", { firstMatchedWord: 1, nbExactWords: 0 })];
  assert.deepEqual(nameMatches(island, { phrase: "Island", initial: true }), []);
  assert.deepEqual(nameMatches(island, { phrase: "Island", initial: false }).map((h) => h.objectID), ["wq"]);
  // every word of the phrase must match
  assert.deepEqual(nameMatches([hit("us", "United States", { words: 1 })], { phrase: "United States", initial: false }), []);
});

test("Peru, Germany and Lebanon's neighbors: four queries, and all three named records come back", async () => {
  const { planQueries, mergeResults } = await load();
  const q = "What can Peru, Germany, and Lebanon's neighbors have in common?";
  for (const kind of ["fields", "records"]) {
    const plan = planQueries(q, kind);
    assert.deepEqual(plan.map((p) => p.type), ["name", "name", "name", "whole"]);
    assert.ok(plan.slice(0, 3).every((p) => p.params.restrictSearchableAttributes.join() === "name,aliases"));
    // the whole question finds only Germany, on the name; the phrases find the other two
    const results = [
      { hits: [hit("pe", "Peru"), hit("bl", "Bolivia", { firstMatchedWord: 1025, nbExactWords: 0 })] },
      { hits: [hit("gm", "Germany")] },
      { hits: [hit("le", "Lebanon")] },
      { hits: [hit("gm", "Germany"), hit("sz", "Switzerland", { words: 1, firstMatchedWord: 2000 })] },
    ];
    const names = mergeResults(plan, results, kind).map((h) => h.name);
    assert.deepEqual(names.slice(0, 3), ["Peru", "Germany", "Lebanon"], kind);
  }
});

test("the union: first occurrence wins, names first, then the whole question, capped at 3 or 10", async () => {
  const { unionHits, mergeResults, planQueries, CAP } = await load();
  const a = [hit("a", "A"), hit("b", "B")];
  const b = [hit("b", "B"), hit("c", "C"), hit("d", "D")];
  assert.deepEqual(unionHits([a, b], 10).map((h) => h.objectID), ["a", "b", "c", "d"]);
  assert.deepEqual(unionHits([a, b], 3).map((h) => h.objectID), ["a", "b", "c"]);
  assert.deepEqual(CAP, { fields: 3, records: 10 });
  const many = Array.from({ length: 12 }, (_, i) => hit(`r${i}`, `R${i}`, { firstMatchedWord: 2000, words: 2 }));
  const plan = planQueries("rivers of Europe", "records");
  assert.equal(mergeResults(plan, [{ hits: [hit("eu", "Europe x")] }, { hits: many }], "records").length, 10);
  // records keep Algolia's order and their snippets; fields drop the snippets
  const snip = { ...hit("s", "S"), _snippetResult: { "Geography.Location": { value: "x", matchLevel: "full" } } };
  assert.ok(mergeResults(planQueries("rivers", "records"), [{ hits: [snip] }], "records")[0]._snippetResult);
  assert.equal(mergeResults(planQueries("rivers", "fields"), [{ hits: [snip] }], "fields")[0]._snippetResult, undefined);
  assert.equal(mergeResults(planQueries("rivers", "fields"), [{ hits: [snip] }], "fields")[0]._rankingInfo, undefined);
});

test("a fields question searches the names only; a records question every word optional, with snippets", async () => {
  const { queryParams, recordsParams, TOPICAL } = await load();
  const f = queryParams("Peru's GDP growth");
  assert.deepEqual(f.restrictSearchableAttributes, ["name", "aliases"]);
  assert.equal(f.analytics, false);
  const r = recordsParams("oil exporters in the Gulf");
  assert.equal(r.hitsPerPage, 10);
  assert.equal(r.analytics, false);
  assert.deepEqual(r.optionalWords, ["oil exporters in the Gulf"]);
  assert.equal(r.removeWordsIfNoResults, "allOptional");
  assert.equal(r.restrictHighlightAndSnippetArrays, false);
  assert.deepEqual(r.attributesToSnippet, TOPICAL.map((a) => `${a}:40`));
  assert.equal(r.restrictSearchableAttributes, undefined);
});

test("the browser sends one multi-query and one getObject, with the secured key and nothing else", async () => {
  const { createBrowserCatalog, encodeParams } = await load();
  const calls = [];
  const fake = async (url, init) => {
    calls.push({ url, init });
    if (url.includes("demo_factbook") && !url.includes("esci_") && init.method === "GET") return { status: 403, json: async () => ({}) };
    if (init.method === "POST") {
      const body = JSON.parse(init.body);
      if (body.requests[0].indexName === "demo_factbook") return { status: 403, json: async () => ({}) };
      return { status: 200, json: async () => ({ results: body.requests.map(() => ({ hits: [hit("pe", "Peru")] })) }) };
    }
    return { status: 200, json: async () => ({ objectID: "pe", name: "Peru", "Economy.Exports": "$75 billion" }) };
  };
  const cat = createBrowserCatalog({ appId: "APP", searchKey: "SECURED" }, fake);
  const s = await cat.search("Peru's GDP growth", "fields");
  assert.equal(s.queries, 3);
  assert.equal(s.index, "esci_demo_factbook");
  assert.deepEqual(s.hits.map((h) => h.name), ["Peru"]);
  const multi = calls.at(-1);
  assert.equal(multi.url, "https://APP-dsn.algolia.net/1/indexes/*/queries");
  const body = JSON.parse(multi.init.body);
  assert.equal(body.strategy, "none");
  assert.equal(body.requests.length, 3);
  assert.ok(body.requests.every((r) => r.indexName === "esci_demo_factbook" && typeof r.params === "string"));
  assert.match(body.requests[0].params, /restrictSearchableAttributes=%5B%22name%22%2C%22aliases%22%5D/);
  assert.match(body.requests[0].params, /analytics=false/);
  assert.equal(encodeParams({ a: "x y", b: [1], c: false }), "a=x+y&b=%5B1%5D&c=false");

  const rec = await cat.getObject("pe");
  assert.equal(rec.name, "Peru");
  const get = calls.at(-1);
  // the index that answered the search is remembered: one GET, straight to it
  assert.equal(get.url, "https://APP-dsn.algolia.net/1/indexes/esci_demo_factbook/pe");
  assert.equal(get.init.method, "GET");
  assert.deepEqual(get.init.headers, { "X-Algolia-Application-Id": "APP", "X-Algolia-API-Key": "SECURED" });
  assert.equal(get.init.body, undefined);
});

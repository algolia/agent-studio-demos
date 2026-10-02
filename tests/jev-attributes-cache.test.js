/* jev-attributes: the in-browser cache of Jev's answers. */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const pub = path.join(__dirname, "..", "public", "jev-attributes");
const load = (f) => import(pathToFileURL(path.join(pub, f)).href);

function fakeStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}

const answer = (n) => ({ answers: { x: { noul: n } }, model: "jev-1.13.0", usage: { inputTokens: 100, outputTokens: 5 }, ms: 420 });

test("a miss calls Jev once; the same request again is a hit with the first ms, and no call", async () => {
  const { createJevCache, cachedCall } = await load("cache.mjs");
  const cache = createJevCache({ storage: fakeStorage() });
  let calls = 0;
  const body = { model: "jev-1.13.0", state: { question: "q" }, questions: { x: { type: "noul" } } };
  const first = await cachedCall(cache, body, async () => { calls += 1; return answer(0.7); });
  assert.equal(first.cached, false);
  const again = await cachedCall(cache, structuredClone(body), async () => { calls += 1; return answer(0.1); });
  assert.equal(calls, 1);
  assert.equal(again.cached, true);
  assert.equal(again.ms, 420);
  assert.deepEqual(again.answers, { x: { noul: 0.7 } });
});

test("another view of the records is another request, so another key", async () => {
  const { cacheKey } = await load("cache.mjs");
  const r = await load("records.mjs");
  const hits = [{
    objectID: "pe", name: "Peru", "Introduction.Background": "Ancient Peru was the seat of several Andean civilizations.",
    _snippetResult: { "Geography.Location": { value: "South <em>America</em>", matchLevel: "full" } },
  }];
  const keys = await Promise.all(r.VIEWS.map((v) => cacheKey({ model: "jev-1.13.0", state: r.recordsState("q", hits, v), questions: r.recordsQuestions(hits) })));
  assert.equal(new Set(keys).size, 3);
  assert.match(keys[0], /^[0-9a-f]{64}$/);
});

test("the cap: the oldest entry goes first, and the cache survives a reload through its one slot", async () => {
  const { createJevCache, CACHE_SLOT, CACHE_CAP } = await load("cache.mjs");
  assert.equal(CACHE_CAP, 200);
  const storage = fakeStorage();
  const cache = createJevCache({ storage, cap: 3 });
  for (const k of ["a", "b", "c", "d"]) cache.put(k, answer(0.5));
  assert.equal(cache.size(), 3);
  assert.equal(cache.get("a"), null);
  assert.ok(cache.get("d"));
  assert.deepEqual([...storage.m.keys()], [CACHE_SLOT]);
  const reloaded = createJevCache({ storage, cap: 3 });
  assert.deepEqual(["a", "b", "c", "d"].map((k) => Boolean(reloaded.get(k))), [false, true, true, true]);
  reloaded.clear();
  assert.equal(reloaded.size(), 0);
  assert.equal(storage.m.has(CACHE_SLOT), false);
});

test("storage that throws leaves a working cache in memory", async () => {
  const { createJevCache } = await load("cache.mjs");
  const boom = () => { throw new Error("blocked"); };
  const cache = createJevCache({ storage: { getItem: boom, setItem: boom, removeItem: boom } });
  cache.put("k", answer(0.9));
  assert.ok(cache.get("k"));
  cache.clear();
  assert.equal(cache.get("k"), null);
  assert.ok(createJevCache({ storage: null }));
});

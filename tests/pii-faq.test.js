/* public/pii/data/bank_faq.json and tools/pii-faq-seed.mjs: the FAQ the
   banking agent searches, and the script that writes it to bank_faq. */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const FAQ = JSON.parse(fs.readFileSync(path.join(ROOT, "public", "pii", "data", "bank_faq.json"), "utf8"));

test("the FAQ: ~30 records, EN and FR in pairs, every field, short answers", () => {
  assert.ok(FAQ.length >= 28 && FAQ.length <= 36, `${FAQ.length} records`);
  const ids = FAQ.map((r) => r.objectID);
  assert.equal(new Set(ids).size, ids.length, "unique objectIDs");
  for (const r of FAQ) {
    assert.deepEqual(Object.keys(r).sort(), ["answer", "category", "lang", "objectID", "question", "tags"], r.objectID);
    assert.ok(["en", "fr"].includes(r.lang), r.objectID);
    assert.ok(r.objectID.endsWith(`-${r.lang}`), r.objectID);
    assert.ok(Array.isArray(r.tags) && r.tags.length >= 3, r.objectID);
    assert.ok(r.answer.split(/\s+/).length <= 70, `${r.objectID} answer is short`);
    assert.ok(!/%|\d+[.,]\d+\s*%/.test(r.answer), `${r.objectID} quotes no rate`);
    assert.ok(!r.objectID.startsWith("_"), "the marker is the seed script's, not the data's");
  }
  for (const r of FAQ.filter((x) => x.lang === "en")) {
    const fr = FAQ.find((x) => x.objectID === r.objectID.replace(/-en$/, "-fr"));
    assert.ok(fr, `${r.objectID} has a French twin`);
    assert.equal(fr.category, r.category);
  }
  assert.ok(FAQ.filter((r) => r.category === "security").length >= 8, "fraud plus 3 security entries, both languages");
});

test("the FAQ carries no identifier the demo would flag", async () => {
  const { pathToFileURL } = require("node:url");
  const { detect } = await import(pathToFileURL(path.join(ROOT, "public", "pii", "detect.js")).href);
  for (const r of FAQ) assert.deepEqual(detect(`${r.question} ${r.answer}`), [], r.objectID);
});

const { pathToFileURL } = require("node:url");
const seed = () => import(pathToFileURL(path.join(ROOT, "tools", "pii-faq-seed.mjs")).href);
const KEY = "index-key-not-real-0001";

/** a fake Search API behind fetch: indexes by name, every request recorded */
function fakeSearch({ indexes = {} } = {}) {
  const store = new Map(Object.entries(indexes).map(([k, v]) => [k, { settings: v.settings || {}, records: new Map((v.records || []).map((r) => [r.objectID, r])) }]));
  const requests = [];
  let task = 0;
  const reply = (status, json) => ({ ok: status < 400, status, text: async () => JSON.stringify(json) });
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ method: init.method, path: u.pathname, headers: init.headers, body });
    const m = u.pathname.match(/^\/1\/indexes\/([^/]+)(?:\/(.+))?$/);
    const [, name, rest] = m;
    const ix = store.get(name);
    if (rest && rest.startsWith("task/")) return reply(200, { status: "published" });
    if (init.method === "GET" && rest === "settings") return ix ? reply(200, ix.settings) : reply(404, { message: "Index does not exist" });
    if (init.method === "GET") { const r = ix && ix.records.get(decodeURIComponent(rest)); return r ? reply(200, r) : reply(404, { message: "ObjectID does not exist" }); }
    const target = ix || { settings: {}, records: new Map() };
    store.set(name, target);
    if (rest === "settings") target.settings = body;
    else if (rest === "clear") target.records.clear();
    else if (rest === "batch") for (const q of body.requests) target.records.set(q.body.objectID, q.body);
    return reply(200, { taskID: ++task });
  };
  return { fetchImpl, requests, store, writes: () => requests.filter((r) => r.method !== "GET") };
}

async function seedWith(s, { args = [], search = fakeSearch(), records = FAQ } = {}) {
  const lines = [];
  const call = s.client({ host: "https://fake.example", appId: "FAKEAPP01", key: KEY, fetchImpl: search.fetchImpl });
  const out = await s.run({ args: s.parseArgs(args), call, records, log: (...a) => lines.push(a.join(" ")), sleep: async () => {} });
  return { out, lines, search };
}

test("seed: a new bank_faq gets the records, the marker and FAQ settings", async () => {
  const s = await seed();
  const { out, lines, search } = await seedWith(s);
  assert.equal(out.state, "absent");
  const ix = search.store.get("bank_faq");
  assert.equal(ix.records.size, FAQ.length + 1);
  assert.equal(ix.records.get("_demo-marker").category, "_marker");
  assert.deepEqual(ix.settings.searchableAttributes, ["unordered(question)", "unordered(tags)", "unordered(answer)"]);
  assert.deepEqual(ix.settings.attributesForFaceting, ["lang", "category"]);
  assert.deepEqual(search.writes().map((r) => `${r.method} ${r.path}`), ["PUT /1/indexes/bank_faq/settings", "POST /1/indexes/bank_faq/batch"]);
  assert.match(lines.join("\n"), /created bank_faq: 32 records \(16 en, 16 fr\) \+ marker/);
  assert.equal(search.requests[0].headers["x-algolia-api-key"], KEY, "the key goes in the header only");
});

test("seed: the bank_faq it wrote is replaced; a foreign one is refused untouched", async () => {
  const s = await seed();
  const ours = fakeSearch({ indexes: { bank_faq: { records: [s.MARKER, { objectID: "stale" }] } } });
  await seedWith(s, { search: ours });
  assert.ok(!ours.store.get("bank_faq").records.has("stale"), "old records go");
  assert.equal(ours.writes()[0].path, "/1/indexes/bank_faq/clear");

  const foreign = fakeSearch({ indexes: { bank_faq: { records: [{ objectID: "1", question: "real" }] } } });
  await assert.rejects(seedWith(s, { search: foreign }), /no _demo-marker record; it is not this demo's/);
  assert.equal(foreign.writes().length, 0);
});

test("seed fence: one index name, one route prefix", async () => {
  const s = await seed();
  assert.throws(() => s.parseArgs(["--index", "products"]), /bank_faq only/);
  const search = fakeSearch();
  const call = s.indexFence(s.client({ host: "https://fake.example", appId: "A", key: KEY, fetchImpl: search.fetchImpl }));
  await assert.rejects(call("POST", "/1/indexes/bank_faq_copy/batch", {}), /refused/);
  await assert.rejects(call("DELETE", "/1/indexes/products"), /refused/);
  await assert.rejects(call("POST", "/1/keys", {}), /refused/);
  assert.equal(search.requests.length, 0, "a refused call never reaches the network");
  assert.throws(() => s.indexFence(call, "products"), /bank_faq only/);
  assert.match(s.validateRecords([{ objectID: "_demo-marker", question: "", answer: "", category: "", lang: "", tags: [] }])[0], /script's own/);
});

test("seed --dry-run reads, writes nothing, and no log line holds a key or the app id", async () => {
  const s = await seed();
  const { out, lines, search } = await seedWith(s, { args: ["--dry-run"] });
  assert.equal(out.wrote, false);
  assert.equal(search.writes().length, 0);
  assert.match(lines.join("\n"), /would create bank_faq/);
  const all = [...lines, ...(await seedWith(s)).lines].join("\n");
  assert.ok(!all.includes(KEY) && !all.includes("FAKEAPP01"));
  const err = await s.client({ host: "https://fake.example", appId: "A", key: KEY,
    fetchImpl: async () => ({ ok: false, status: 403, text: async () => `{"message":"key ${KEY} denied"}` }) })("GET", "/1/indexes/bank_faq/settings").catch((e) => e);
  assert.equal(err.status, 403);
  assert.ok(!err.message.includes(KEY), "an error never carries the response body");
});

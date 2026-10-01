/* jev-attributes: the four engines decided in code, the visitor's key store,
   and one whole run on a fake transport. */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const pub = path.join(__dirname, "..", "public");
const load = (f) => import(pathToFileURL(path.join(pub, f)).href);

const PERU = { objectID: "pe", name: "Peru", aliases: ["Republic of Peru"], "Economy.Real GDP growth rate": "3.3%", "Geography.Area": "1,285,216 sq km" };

test("keywords: the question minus its country names, scored against the section descriptions", async () => {
  const e = await load("jev-attributes/engines.mjs");
  assert.deepEqual(e.askTerms("Peru's GDP growth", [PERU]), ["gdp", "growth"]);
  const kept = e.keywordSections("How many airports does Kenya have?", [{ name: "Kenya" }]).filter((r) => r.picked).map((r) => r.name);
  assert.deepEqual(kept, ["Transportation"]);
});

test("keywords: no word in common keeps every section, marked as no opinion", async () => {
  const e = await load("jev-attributes/engines.mjs");
  const rows = e.keywordSections("Is Mongolia landlocked?", [{ name: "Mongolia" }]);
  assert.ok(rows.every((r) => r.picked && r.fallback));
});

test("the ratio and margin rules keep the best, cap the count, and never invent a pick", async () => {
  const e = await load("jev-attributes/engines.mjs");
  assert.deepEqual([...e.topByRatio([0, 4, 1, 3], { ratio: 0.5, maxK: 3 })].sort(), [1, 3]);
  assert.equal(e.topByRatio([0, 0, 0]).size, 0);
  assert.deepEqual([...e.topByMargin([0.31, 0.52, 0.49, 0.2], { margin: 0.05, maxK: 1 })], [1]);
});

test("embeddings: cosine over unit vectors picks the nearest section", async () => {
  const e = await load("jev-attributes/engines.mjs");
  const docs = e.sectionDocs().map((_, i) => (i === 5 ? [1, 0] : [0, 1]));
  const rows = e.embedSections([0.96, 0.28], docs);
  assert.deepEqual(rows.filter((r) => r.picked).map((r) => r.name), ["Economy"]);
});

test("the LLM picker keeps only offered names, and maps a description phrase to its one section", async () => {
  const e = await load("jev-attributes/engines.mjs");
  const picked = (t) => e.pickerSectionRows(t).filter((r) => r.picked).map((r) => r.name);
  assert.deepEqual(picked('Sure: {"keep": ["economy", "Atlantis"]}'), ["Economy"]);
  assert.deepEqual(picked('{"keep": ["land boundaries and border countries"]}'), ["Geography"]);
  // unparseable: no opinion, so the full record goes
  assert.equal(picked("I think Economy").length, 13);
  const msg = e.pickerSectionMessages("Peru's GDP growth")[1].content;
  assert.match(msg, /Allowed names: "Introduction"/);
});

test("a non-English question is flagged; an English one with no function word is not", async () => {
  const e = await load("jev-attributes/engines.mjs");
  assert.equal(e.looksNonEnglish("Peru's GDP growth"), false);
  assert.equal(e.looksNonEnglish("Quelle est la capitale du Pérou ?"), true);
  assert.equal(e.looksNonEnglish("日本の人口は？"), true);
});

test("keys live in memory unless the visitor opts in, and forget clears every store", async () => {
  const { createKeyStore, jwtExpiry } = await load("jev-attributes/byok.mjs");
  const fake = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), m }; };
  const tab = fake(); const device = fake();
  const s = createKeyStore({ tab, device });
  s.set("jev", "  k-123  ");
  assert.equal(s.get("jev"), "k-123");
  assert.equal(tab.m.size + device.m.size, 0, "memory by default: nothing stored");
  s.setKeep("device");
  assert.equal(device.m.size, 1);
  assert.equal(createKeyStore({ tab, device }).get("jev"), "k-123", "restored from the device");
  s.forget();
  assert.equal(tab.m.size + device.m.size, 0);
  // a store that throws (private mode) is survived
  const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
  const b = createKeyStore({ tab: broken, device: broken });
  b.setKeep("device");
  b.set("enablers", "t");
  assert.equal(b.get("enablers"), "t");
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const jwt = `x.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.y`;
  assert.equal(jwtExpiry(jwt), exp * 1000);
  assert.equal(jwtExpiry("not-a-jwt"), null);
});

/* a fake relay: System One answers Economy, the LLM streams one line with usage */
function fakePost(calls) {
  const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
  return async (route, body, opts) => {
    calls.push({ route, body, auth: opts.auth });
    if (route.endsWith("systemone")) {
      const answers = Object.fromEntries(Object.keys(body.questions).map((id) => [id, id === "main" ? { choice: "economy", confidence: 0.9 } : { noul: id === "economy" || id === "f0" ? 0.9 : 0.1 }]));
      return new Response(JSON.stringify({ model: body.model, answers, usage: { input_tokens: 100, output_tokens: 5 } }), { status: 200 });
    }
    if (!body.stream) return new Response(JSON.stringify({ model: "small", choices: [{ message: { content: '{"keep":["Economy"]}' } }], usage: { prompt_tokens: 50 } }), { status: 200 });
    const n = JSON.stringify(body.messages).length;
    return new Response(sse({ choices: [{ delta: { content: "3.3%" } }] }) + sse({ choices: [], usage: { prompt_tokens: n, completion_tokens: 2 } }) + "data: [DONE]\n\n", { status: 200 });
  };
}

test("one run: a full lane and a lane per engine, the same system prompt, fewer tokens where Jev kept less", async () => {
  const { run } = await load("jev-attributes/run.mjs");
  const calls = [];
  const events = [];
  await run({
    question: "Peru's GDP growth", depth: "sections", engines: ["jev", "keyword", "llm"], post: fakePost(calls),
    keys: {}, local: true, search: async () => ({ hits: [PERU], index: "t", backend: "algolia", ms: 1 }), emit: (e) => events.push(e),
  });
  const done = Object.fromEntries(events.filter((e) => e.type === "done").map((e) => [e.lane, e.usage.inputTokens]));
  assert.deepEqual(Object.keys(done).sort(), ["full", "jev", "keyword", "llm"]);
  assert.ok(done.jev < done.full);
  const chats = calls.filter((c) => c.route === "enablers/chat/completions" && c.body.stream);
  assert.equal(new Set(chats.map((c) => c.body.messages[0].content)).size, 1, "one system prompt for every lane");
  assert.equal(new Set(chats.map((c) => c.body.cache_salt)).size, chats.length, "a fresh cache salt per lane");
  assert.ok(chats.every((c) => c.body.max_tokens >= 16384));
  // data rule: Jev sees the question and the section descriptions, never a record
  const jev = calls.find((c) => c.route === "typesafe/systemone");
  assert.doesNotMatch(JSON.stringify(jev.body), /1,285,216|3\.3%/);
  assert.equal(events.at(-1).type, "end");
});

test("public mode: a lane without the key it needs is skipped, never sent", async () => {
  const { run } = await load("jev-attributes/run.mjs");
  const calls = [];
  const events = [];
  await run({
    question: "Peru's GDP growth", depth: "sections", engines: ["jev", "keyword"], post: fakePost(calls),
    keys: { enablers: "tok" }, local: false, search: async () => ({ hits: [PERU], index: "t", backend: "algolia", ms: 1 }), emit: (e) => events.push(e),
  });
  assert.ok(events.some((e) => e.type === "skip" && e.lane === "jev" && e.need === "jev"));
  assert.ok(!calls.some((c) => c.route === "typesafe/systemone"));
  assert.ok(calls.every((c) => c.auth === "tok"), "the visitor's token rides on every Enablers call");
});

/* jev-attributes: one Jev call on a fake transport, the visitor's key store,
   and the study's other arms (tools/jev-attributes/arms.mjs). */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.join(__dirname, "..");
const load = (f) => import(pathToFileURL(path.join(root, f)).href);

const PERU = { objectID: "pe", name: "Peru", aliases: ["Republic of Peru"], "Economy.Real GDP growth rate": "3.3%", "Geography.Area": "1,285,216 sq km" };

/** a fake relay: System One says yes to Economy and picks it as main */
function fakeJev(calls, status = 200) {
  return async (route, body, opts) => {
    calls.push({ route, body, auth: opts.auth });
    if (status !== 200) return new Response('{"error":"no"}', { status, headers: {} });
    const answers = Object.fromEntries(Object.keys(body.questions).map((id) => [id, id === "main" ? { choice: "economy", confidence: 0.9 } : { noul: id === "economy" ? 0.97 : 0.03 }]));
    return new Response(JSON.stringify({ model: body.model, answers, usage: { input_tokens: 3535, output_tokens: 366 } }), { status: 200 });
  };
}

test("one Jev call: the model, the state and 14 questions, the visitor's key, never a record", async () => {
  const { systemOne, TARGETS } = await load("public/jev-attributes/client.mjs");
  const a = await load("public/jev-attributes/attrs.mjs");
  const calls = [];
  const r = await systemOne(fakeJev(calls), "jev", a.sectionState("Peru's GDP growth"), a.sectionQuestions(), { keys: { jev: "k-123" } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].route, "typesafe/systemone");
  assert.equal(calls[0].auth, "k-123");
  assert.equal(calls[0].body.model, TARGETS.jev.model);
  assert.equal(TARGETS.jev.model, "jev-1.13.0");
  assert.equal(Object.keys(calls[0].body.questions).length, 14);
  // data rule: Jev sees the question and the section descriptions, never a record
  assert.doesNotMatch(JSON.stringify(calls[0].body), new RegExp(PERU["Geography.Area"]));
  assert.deepEqual(r.usage, { inputTokens: 3535, outputTokens: 366 });
  assert.deepEqual(a.pickSections(r.answers).filter((x) => x.picked).map((x) => x.name), ["Economy"]);
});

test("Jev refusing the key is an error naming the status, and is not retried", async () => {
  const { systemOne } = await load("public/jev-attributes/client.mjs");
  const a = await load("public/jev-attributes/attrs.mjs");
  const calls = [];
  await assert.rejects(systemOne(fakeJev(calls, 401), "jev", a.sectionState("q"), a.sectionQuestions(), { keys: {} }), /jev HTTP 401/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].auth, undefined, "no key: the local server adds the owner's");
});

test("the key lives in memory unless the visitor opts in, and forget clears every store", async () => {
  const { createKeyStore, jwtExpiry, NAMES } = await load("public/jev-attributes/byok.mjs");
  assert.deepEqual(NAMES, ["jev"]);
  const fake = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), m }; };
  const tab = fake(); const device = fake();
  const s = createKeyStore({ tab, device });
  s.set("jev", "  k-123  ");
  assert.equal(s.get("jev"), "k-123");
  assert.deepEqual(s.all(), { jev: "k-123" });
  assert.equal(tab.m.size + device.m.size, 0, "memory by default: nothing stored");
  s.setKeep("device");
  assert.equal(device.m.size, 1);
  assert.equal(createKeyStore({ tab, device }).get("jev"), "k-123", "restored from the device");
  s.set("enablers", "t");
  assert.equal(s.get("enablers"), "", "no other key is held");
  s.forget();
  assert.equal(tab.m.size + device.m.size, 0);
  // a store that throws (private mode) is survived
  const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
  const b = createKeyStore({ tab: broken, device: broken });
  b.setKeep("device");
  b.set("jev", "t");
  assert.equal(b.get("jev"), "t");
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const jwt = `x.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.y`;
  assert.equal(jwtExpiry(jwt), exp * 1000);
  assert.equal(jwtExpiry("not-a-jwt"), null);
});

/* the study's other arms, in tools/ since the page no longer runs them */

test("keywords: the question minus its country names, scored against the section descriptions", async () => {
  const e = await load("tools/jev-attributes/arms.mjs");
  assert.deepEqual(e.askTerms("Peru's GDP growth", [PERU]), ["gdp", "growth"]);
  const kept = e.keywordSections("How many airports does Kenya have?", [{ name: "Kenya" }]).filter((r) => r.picked).map((r) => r.name);
  assert.deepEqual(kept, ["Transportation"]);
});

test("keywords: no word in common keeps every section, marked as no opinion", async () => {
  const e = await load("tools/jev-attributes/arms.mjs");
  const rows = e.keywordSections("Is Mongolia landlocked?", [{ name: "Mongolia" }]);
  assert.ok(rows.every((r) => r.picked && r.fallback));
});

test("the ratio rule keeps the best, caps the count, and never invents a pick", async () => {
  const e = await load("tools/jev-attributes/arms.mjs");
  assert.deepEqual([...e.topByRatio([0, 4, 1, 3], { ratio: 0.5, maxK: 3 })].sort(), [1, 3]);
  assert.equal(e.topByRatio([0, 0, 0]).size, 0);
});

test("the LLM picker keeps only offered names, and maps a description phrase to its one section", async () => {
  const e = await load("tools/jev-attributes/arms.mjs");
  const picked = (t) => e.pickerSectionRows(t).filter((r) => r.picked).map((r) => r.name);
  assert.deepEqual(picked('Sure: {"keep": ["economy", "Atlantis"]}'), ["Economy"]);
  assert.deepEqual(picked('{"keep": ["land boundaries and border countries"]}'), ["Geography"]);
  // unparseable: no opinion, so every section stays
  assert.equal(picked("I think Economy").length, 13);
  const msg = e.pickerSectionMessages("Peru's GDP growth")[1].content;
  assert.match(msg, /Allowed names: "Introduction"/);
});

test("the study reaches Laya and the picker on routes of its own, Laya never under 120 s", async () => {
  const e = await load("tools/jev-attributes/arms.mjs");
  const { ROUTES } = await load("public/jev-attributes/client.mjs");
  for (const [route, url] of Object.entries(ROUTES)) assert.equal(e.ROUTES[route], url);
  assert.ok(e.LAYA.route in e.ROUTES);
  assert.ok("enablers/chat/completions" in e.ROUTES);
  assert.ok(e.LAYA.timeoutMs >= 120000, "Laya is CPU-served");
  assert.equal(Object.keys(e.compactSectionQuestions()).length, 14);
});

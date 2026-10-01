/* jev-attributes: the record strip, Jev's picks, the saving and the answer
   overlap, plus the shared SSE parser and formats both demos now import. */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const pub = path.join(__dirname, "..", "public");
const load = (f) => import(pathToFileURL(path.join(pub, f)).href);

const RECORD = {
  objectID: "pe", name: "Peru", aliases: ["Republic of Peru"], region: "south-america",
  "Introduction.Background": "…",
  "Economy.Real GDP growth rate": "2024: 3.3% (2024 est.)",
  "Economy.Exports": "$75 billion",
  "Geography.Area": "total: 1,285,216 sq km",
};

test("strip keeps the named sections, the id and the name, and nothing else", async () => {
  const a = await load("jev-attributes/attrs.mjs");
  assert.deepEqual(Object.keys(a.strip(RECORD, ["Economy"])),
    ["objectID", "name", "Economy.Real GDP growth rate", "Economy.Exports"]);
  assert.deepEqual(Object.keys(a.strip(RECORD, new Set(["Economy.Exports"]))), ["objectID", "name", "Economy.Exports"]);
  // the full lane drops only the search-only keys
  assert.deepEqual(Object.keys(a.full(RECORD)).length, 6);
  assert.equal(a.weigh([a.full(RECORD)]).keys, 4);
});

test("one noul question per section, and the picks follow the threshold", async () => {
  const a = await load("jev-attributes/attrs.mjs");
  const qs = a.sectionQuestions();
  assert.equal(Object.keys(qs).length, a.SECTIONS.length);
  assert.ok(Object.values(qs).every((q) => q.type === "noul"));
  const answers = Object.fromEntries(a.SECTIONS.map((_, i) => [`s${i}`, { noul: i === 5 ? 0.91 : 0.1 }]));
  const rows = a.pickSections(answers);
  assert.deepEqual(rows.filter((r) => r.picked).map((r) => r.name), ["Economy"]);
});

test("when nothing clears the line, the single most likely section is kept and marked", async () => {
  const a = await load("jev-attributes/attrs.mjs");
  const answers = Object.fromEntries(a.SECTIONS.map((_, i) => [`s${i}`, { noul: i === 1 ? 0.4 : 0.1 }]));
  const picked = a.pickSections(answers).filter((r) => r.picked);
  assert.equal(picked.length, 1);
  assert.equal(picked[0].name, "Geography");
  assert.equal(picked[0].fallback, true);
});

test("the field stage asks only about fields inside the kept sections", async () => {
  const a = await load("jev-attributes/attrs.mjs");
  const fields = a.fieldsIn([RECORD], ["Economy"]);
  assert.deepEqual(fields, ["Economy.Real GDP growth rate", "Economy.Exports"]);
  assert.equal(Object.keys(a.fieldQuestions(fields)).length, 2);
  const rows = a.pickFields(fields, { f0: { noul: 0.9 }, f1: { noul: 0.2 } });
  assert.deepEqual(rows.filter((r) => r.picked).map((r) => r.key), ["Economy.Real GDP growth rate"]);
});

test("the saving is signed: fewer tokens is negative, more is positive, missing is null", async () => {
  const a = await load("jev-attributes/attrs.mjs");
  assert.equal(Math.round(a.savingPct(10000, 1700)), -83);
  assert.equal(a.savingPct(1000, 1200), 20);
  assert.equal(a.savingPct(null, 10), null);
  assert.equal(a.savingPct(0, 10), null);
});

test("the overlap compares figures and names, and ignores bare years", async () => {
  const a = await load("jev-attributes/attrs.mjs");
  const o = a.overlap("Peru grew 3.3% in 2024 and −0.4% in 2023.", "Peru's growth was 3.3% (2024).");
  const byValue = Object.fromEntries(o.rows.map((r) => [r.value, r.shared]));
  assert.equal(byValue["3.3%"], true);
  assert.equal(byValue["-0.4%"], false);
  assert.equal(byValue.Peru, true);
  assert.equal("2024" in byValue, false);
  assert.equal(o.total, 3);
  assert.equal(a.overlap("Other 7.9%", "and other 7.9%").shared, 2);
});

test("both lanes send the same system prompt", async () => {
  const a = await load("jev-attributes/attrs.mjs");
  const m1 = a.messages("q", [a.full(RECORD)]);
  const m2 = a.messages("q", [a.strip(RECORD, ["Economy"])]);
  assert.equal(m1[0].content, m2[0].content);
  assert.notEqual(m1[1].content, m2[1].content);
});

test("the shared SSE parser splits chunks across line boundaries", async () => {
  const { createSseParser } = await load("shared/sse.mjs");
  const seen = [];
  const p = createSseParser((e) => seen.push(e));
  p.push('data: {"a":1}\n\nda');
  p.push('ta: {"b":2}\n\ndata: [DONE]\n');
  p.end();
  assert.deepEqual(seen, [{ a: 1 }, { b: 2 }, { type: "[DONE]" }]);
});

test("one format for durations and token counts", async () => {
  const f = await load("shared/format.mjs");
  assert.equal(f.ms(412), "412\u00a0ms");
  assert.equal(f.tokens(12345), "12.3k");
  assert.equal(f.grouped(12345), "12,345");
});

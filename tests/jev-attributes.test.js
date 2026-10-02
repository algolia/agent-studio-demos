/* jev-attributes: the Jev request, the rule that reads its answer, and the
   sizes the stage draws, plus the shared formats the page prints with. */

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

test("one noul per section and one main choice, in one request, with the facts in the state", async () => {
  const a = await load("jev-attributes/attrs.mjs");
  const qs = a.sectionQuestions();
  assert.equal(Object.keys(qs).length, a.SECTIONS.length + 1);
  assert.ok(a.SECTIONS.every((s) => qs[s.id].type === "noul"));
  assert.equal(qs.main.type, "choice");
  // L2: instructions point into the state by backtick path, and the path exists
  const state = a.sectionState("Peru's GDP growth");
  assert.equal(state.question, "Peru's GDP growth");
  for (const s of a.SECTIONS) {
    assert.match(qs[s.id].instructions.question, new RegExp(`\`sections\\.${s.id}\``));
    assert.ok(state.sections[s.id].startsWith(s.name));
    // L3: contrastive criteria on every section
    assert.match(qs[s.id].criteria.true, /For example/);
    assert.match(qs[s.id].criteria.false, /such as/);
  }
  assert.ok(Object.values(qs.main.criteria).every((c) => c.what && c.not_for && c.examples.length));
});

test("a section is kept at P(yes) 0.5 or more", async () => {
  const a = await load("jev-attributes/attrs.mjs");
  assert.equal(a.THRESHOLD, 0.5);
  const answers = Object.fromEntries(a.SECTIONS.map((s) => [s.id, { noul: s.id === "economy" ? 0.91 : s.id === "energy" ? 0.5 : 0.49 }]));
  assert.deepEqual(a.pickSections(answers).filter((r) => r.picked).map((r) => r.name), ["Economy", "Energy"]);
});

test("the main choice keeps its section even under the line, and says so", async () => {
  const a = await load("jev-attributes/attrs.mjs");
  const answers = Object.fromEntries(a.SECTIONS.map((s) => [s.id, { noul: 0.1 }]));
  answers.main = { choice: "energy", confidence: 0.64 };
  const picked = a.pickSections(answers).filter((r) => r.picked);
  assert.deepEqual(picked.map((r) => [r.name, r.byMain, r.fallback]), [["Energy", true, false]]);
  assert.equal(a.mainConfidence(answers), 0.64);
});

test("with no main choice and nothing over the line, the most likely section is kept and marked", async () => {
  const a = await load("jev-attributes/attrs.mjs");
  const answers = Object.fromEntries(a.SECTIONS.map((s) => [s.id, { noul: s.id === "geography" ? 0.4 : 0.1 }]));
  const picked = a.pickSections(answers).filter((r) => r.picked);
  assert.equal(picked.length, 1);
  assert.equal(picked[0].name, "Geography");
  assert.equal(picked[0].fallback, true);
});

test("every record weighs in 13 rows: fields and JSON characters per section, search keys in none", async () => {
  const a = await load("jev-attributes/attrs.mjs");
  const rows = a.sectionSizes(RECORD);
  assert.equal(rows.length, 13);
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(by.economy.fields, 2);
  const entry = (k) => JSON.stringify(k).length + JSON.stringify(RECORD[k]).length + 2;
  assert.equal(by.economy.chars, entry("Economy.Real GDP growth rate") + entry("Economy.Exports"));
  assert.deepEqual([by.space.fields, by.space.chars], [0, 0], "a section the record lacks is a row of zeros");
  assert.equal(rows.reduce((s, r) => s + r.fields, 0), 4, "objectID, name, aliases and region count for no section");
});

test("the trim totals: kept and total, tokens as characters ÷ 4, the kept share", async () => {
  const a = await load("jev-attributes/attrs.mjs");
  const rows = a.sectionSizes(RECORD);
  const t = a.trimTotals(rows, ["economy"]);
  assert.equal(a.CHARS_PER_TOKEN, 4);
  assert.deepEqual([t.kept.sections, t.total.sections], [1, 13]);
  assert.deepEqual([t.kept.fields, t.total.fields], [2, 4]);
  assert.equal(t.total.tokens, Math.round(t.total.chars / 4));
  assert.equal(t.kept.tokens, Math.round(t.kept.chars / 4));
  assert.equal(t.share, t.kept.chars / t.total.chars);
  assert.equal(a.trimTotals(a.sectionSizes({}), []).share, null, "an empty record has no share");
});

test("one format for durations and token counts", async () => {
  const f = await load("shared/format.mjs");
  assert.equal(f.ms(412), "412 ms");
  assert.equal(f.tokens(12345), "12.3k");
  assert.equal(f.grouped(12345), "12,345");
});

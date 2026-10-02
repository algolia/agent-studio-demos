/* jev-attributes: the records stage. What Jev reads of each hit, the rule
   that keeps a record, the order of the stages in Both, the size readouts,
   and the modal's split of a record into what Jev saw and did not. */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const load = () => import(pathToFileURL(path.join(__dirname, "..", "public", "jev-attributes", "records.mjs")).href);

const BACKGROUND = "Ancient Peru was the seat of several prominent Andean civilizations, most notably that of the Incas "
  + "whose empire was captured by Spanish conquistadors in 1533. Peru declared its independence in 1821, and remaining "
  + "Spanish forces were defeated in 1824. After a dozen years of military rule, Peru returned to democratic leadership "
  + "in 1980, but experienced economic problems and the growth of a violent insurgency.";

const hit = (objectID, name, extra = {}) => ({
  objectID, name, aliases: [], region: "x",
  "Introduction.Background": BACKGROUND,
  "Geography.Location": "Western South America, bordering the South Pacific Ocean, between Chile and Ecuador",
  "Economy.Exports": "$75 billion",
  ...extra,
});

const withSnippets = (h) => ({
  ...h,
  _snippetResult: {
    "Introduction.Background": { value: "Ancient Peru was the seat of several prominent Andean civilizations…", matchLevel: "none" },
    "Geography.Location": { value: "Western South America, bordering the South <em>Pacific</em> Ocean, between Chile and Ecuador", matchLevel: "partial" },
  },
});

test("what Jev sees: the name only, the background's first 300 characters on a word boundary, or the matched snippets", async () => {
  const r = await load();
  const h = withSnippets(hit("pe", "Peru"));
  assert.equal(r.seenText(h, "name"), "");
  const intro = r.seenText(h, "intro");
  assert.ok(intro.length <= r.INTRO_CHARS + 1, `${intro.length}`);
  assert.ok(intro.endsWith("…"));
  assert.ok(BACKGROUND.startsWith(intro.slice(0, -1)), "a prefix of the background");
  assert.match(BACKGROUND.slice(intro.length - 1), /^[\s,.]/, "cut between words, not inside one");
  // the matched snippet, tags out; the unmatched background snippet is not used
  assert.equal(r.seenText(h, "snippet"), "Western South America, bordering the South Pacific Ocean, between Chile and Ecuador");
  // no match at all: the background's own snippet, ellipsis trimmed
  const none = { ...h, _snippetResult: { "Introduction.Background": h._snippetResult["Introduction.Background"] } };
  assert.equal(r.seenText(none, "snippet"), "Ancient Peru was the seat of several prominent Andean civilizations");
  assert.equal(r.cutWords("short text", 300), "short text");
  assert.equal(r.cutWords("alpha beta gamma", 12), "alpha beta…");
});

test("the records request: the state holds each record as Jev reads it, one noul per record by backtick path", async () => {
  const r = await load();
  const hits = [withSnippets(hit("pe", "Peru")), withSnippets(hit("ec", "Ecuador"))];
  const s = r.recordsState("Where is Peru?", hits, "snippet");
  assert.deepEqual(Object.keys(s.records), ["pe", "ec"]);
  assert.equal(s.records.pe.name, "Peru");
  assert.ok(s.records.pe.text);
  assert.deepEqual(r.recordsState("q", hits, "name").records.pe, { name: "Peru" });
  const qs = r.recordsQuestions(hits);
  assert.equal(qs.pe.type, "noul");
  assert.match(qs.pe.instructions.question, /`records\.pe`.*`question`/);
  assert.match(qs.pe.criteria.false, /same region/);
  // the three views are three different requests, the name one the smallest
  const size = (v) => r.requestChars(r.recordsState("q", hits, v), qs);
  assert.ok(size("name") < size("snippet") && size("name") < size("intro"));
});

test("a record is kept at P(yes) 0.5 or more, and the likeliest one always", async () => {
  const r = await load();
  const hits = ["a", "b", "c", "d"].map((id) => hit(id, id.toUpperCase()));
  const rows = r.pickRecords({ a: { noul: 0.2 }, b: { noul: 0.5 }, c: { noul: 0.9 }, d: { noul: 0.49 } }, hits);
  assert.deepEqual(rows.map((x) => x.kept), [false, true, true, false]);
  assert.deepEqual(rows.map((x) => x.id), ["a", "b", "c", "d"], "Algolia order");
  assert.equal(rows.find((x) => x.top).id, "c");
  // nothing over the line: the likeliest stays, marked top
  const low = r.pickRecords({ a: { noul: 0.1 }, b: { noul: 0.3 }, c: { noul: 0.2 } }, hits.slice(0, 3));
  assert.deepEqual(low.map((x) => x.kept), [false, true, false]);
  assert.ok(low[1].top);
  // no answer at all: Algolia's first hit stays
  const none = r.pickRecords({}, hits.slice(0, 2));
  assert.deepEqual(none.map((x) => x.kept), [true, false]);
  assert.equal(none[0].p, null);
  // the fields stage takes the likeliest three kept, shown in Algolia order
  const many = r.pickRecords({ a: { noul: 0.6 }, b: { noul: 0.95 }, c: { noul: 0.7 }, d: { noul: 0.8 } }, hits);
  assert.deepEqual(r.fieldTargets(many).map((x) => x.id), ["b", "c", "d"]);
});

test("Both runs search, then Jev on the records, then Jev on the sections of at most three kept records", async () => {
  const r = await load();
  const hits = ["a", "b", "c", "d", "e"].map((id) => hit(id, id.toUpperCase()));
  const calls = [];
  const out = await r.runPipeline({
    mode: "both", question: "q", view: "snippet",
    search: async (q, kind) => { calls.push(`search:${kind}`); return { hits, queries: 1 }; },
    jev: async (stage, state, questions) => {
      calls.push(`jev:${stage}`);
      if (stage === "records") {
        assert.deepEqual(Object.keys(state.records), ["a", "b", "c", "d", "e"]);
        return { answers: { a: { noul: 0.9 }, b: { noul: 0.1 }, c: { noul: 0.8 }, d: { noul: 0.7 }, e: { noul: 0.6 } }, ms: 5, usage: {} };
      }
      assert.ok(state.sections, "the fields request holds the section descriptions");
      assert.equal(JSON.stringify(state).includes("Ancient Peru"), false, "and never a record");
      assert.ok(questions.main);
      return { answers: { economy: { noul: 0.9 }, main: { choice: "economy" } }, ms: 7, usage: {} };
    },
    on: (stage) => calls.push(`on:${stage}`),
  });
  assert.deepEqual(calls, ["search:records", "on:search", "jev:records", "on:records", "jev:fields", "on:fields"]);
  assert.deepEqual(out.fields.targets, ["a", "c", "d"]);
  assert.ok(out.fields.rows.find((x) => x.id === "economy").picked);

  // Records stops after the records stage; Fields skips it and searches the names
  const seen = [];
  const stub = { search: async (q, kind) => { seen.push(kind); return { hits }; }, jev: async (stage) => { seen.push(stage); return { answers: {} }; } };
  await r.runPipeline({ mode: "records", question: "q", ...stub });
  await r.runPipeline({ mode: "fields", question: "q", ...stub });
  assert.deepEqual(seen, ["records", "records", "fields", "fields"]);

  // a failed records call ends the run, recorded, with no fields call
  const failed = await r.runPipeline({ mode: "both", question: "q", search: stub.search, jev: async () => { throw new Error("jev HTTP 500"); } });
  assert.equal(failed.records.error, "jev HTTP 500");
  assert.equal(failed.fields, null);
});

test("the readouts: the hits in full, after records, after fields, characters counted and tokens estimated", async () => {
  const r = await load();
  const hits = [hit("a", "A"), hit("b", "B"), hit("c", "C")];
  const one = r.recordChars(hits[0]);
  assert.ok(one > 0);
  const out = r.readouts(hits, ["a", "b"], [{ id: "a", sectionIds: ["economy"] }]);
  assert.deepEqual(out.all, { records: 3, chars: 3 * one, tokens: Math.round((3 * one) / 4) });
  assert.deepEqual(out.afterRecords, { records: 2, chars: 2 * one, tokens: Math.round((2 * one) / 4) });
  const econ = JSON.stringify("Economy.Exports").length + JSON.stringify("$75 billion").length + 2;
  assert.deepEqual(out.afterFields, { records: 1, chars: econ, tokens: Math.round(econ / 4) });
  assert.equal(r.readouts(hits, null, null).afterRecords, null);
  // the search keys and the snippets weigh nothing
  assert.equal(r.recordChars(withSnippets(hits[0])), one);
});

test("the modal's split: what Jev read of a record is marked seen, everything else not seen", async () => {
  const r = await load();
  const rec = hit("pe", "Peru");
  const h = withSnippets(rec);
  const part = r.partitionRecord(rec, { stage: "records", view: "snippet", hit: h });
  assert.equal(part.name.seen, true);
  const loc = part.sections.find((s) => s.id === "geography").fields.find((f) => f.key === "Geography.Location");
  assert.deepEqual(loc.parts, [{ text: rec["Geography.Location"], seen: true }]);
  const bg = part.sections.find((s) => s.id === "introduction").fields[0];
  assert.ok(bg.parts.every((p) => !p.seen), "the background was not read under the snippet view");
  const seenChars = "Peru".length + r.seenText(h, "snippet").length;
  assert.equal(part.counts.seen.chars, seenChars);
  assert.equal(part.counts.unseen.chars, r.recordChars(rec) - seenChars);

  // the intro view marks the background's first characters, and only those
  const intro = r.partitionRecord(rec, { stage: "records", view: "intro", hit: h });
  const parts = intro.sections.find((s) => s.id === "introduction").fields[0].parts;
  assert.equal(parts[0].seen, true);
  assert.equal(parts[1].seen, false);
  assert.equal(parts.map((p) => p.text).join(""), BACKGROUND, "the parts rebuild the value");

  // the fields stage read no record: every part unseen, the descriptions seen, kept sections marked
  const f = r.partitionRecord(rec, { stage: "fields", kept: new Set(["economy"]) });
  assert.equal(f.name.seen, false);
  assert.ok(f.sections.every((s) => s.fields.every((x) => x.parts.every((p) => !p.seen))));
  assert.equal(f.descriptions.length, 13);
  assert.equal(f.counts.unseen.chars, r.recordChars(rec));
  assert.deepEqual(f.sections.filter((s) => s.kept).map((s) => s.id), ["economy"]);
  assert.equal(r.partitionRecord(rec, { stage: "records", view: "name" }).sections[0].kept, null);
});

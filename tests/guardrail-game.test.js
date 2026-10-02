/* The labeling game keeps the reader's labels in an event log, so the log's
   replay is the spec: an undo clears the newest label, a relabel after an undo
   wins, and what is downloaded or raced is exactly what the replay says. A
   round is a seeded sample, so the same seed must give the same ten. */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
require("./load.js");

const DIR = path.join(__dirname, "..", "public", "guardrail-battle");
require(path.join(DIR, "csv.js"));
require(path.join(DIR, "stats.js"));
require(path.join(DIR, "label-game.js"));
const G = globalThis.GuardrailGame;
const C = globalThis.GuardrailCsv;

const heldout = require(path.join(DIR, "data", "heldout.json")).cases
  .map((c, i) => ({ id: i, text: c.text, gold: c.gold, category: c.category, slice: c.slice, difficulty: c.difficulty }));

test("a round is ten distinct messages, half allowed, with hard ones and spread slices", () => {
  for (const seed of [1, 2, 3, 99, 123456]) {
    const r = G.sampleRound(heldout, { k: 10, seed, hard: 3 });
    assert.equal(r.length, 10);
    assert.equal(new Set(r.map((c) => c.id)).size, 10);
    assert.equal(r.filter((c) => c.gold === "allowed").length, 5);
    assert.equal(r.filter((c) => c.gold === "blocked").length, 5);
    assert.ok(r.filter((c) => c.difficulty === "hard").length >= 3, `seed ${seed}`);
    assert.ok(new Set(r.map((c) => c.slice)).size >= 7, `seed ${seed}: slices`);
  }
});

test("the same seed gives the same round, a new seed a new one", () => {
  const ids = (seed) => G.sampleRound(heldout, { seed }).map((c) => c.id).join(",");
  assert.equal(ids(42), ids(42));
  assert.notEqual(ids(42), ids(43));
});

test("a round is shuffled, not sorted by answer", () => {
  const golds = G.sampleRound(heldout, { seed: 5 }).map((c) => c.gold).join("");
  assert.notEqual(golds, "allowed".repeat(5) + "blocked".repeat(5));
});

test("one side short of cases: the other side takes the slack; a small set comes back whole", () => {
  const few = heldout.filter((c) => c.gold === "allowed").slice(0, 20).concat(heldout.filter((c) => c.gold === "blocked").slice(0, 2));
  const r = G.sampleRound(few, { k: 10, seed: 3 });
  assert.equal(r.length, 10);
  assert.equal(r.filter((c) => c.gold === "blocked").length, 2);
  assert.equal(G.sampleRound(heldout.slice(0, 4), { k: 10 }).length, 4);
});

test("undo clears the newest label; a relabel after an undo is the one that counts", () => {
  const ev = [
    { id: 1, verdict: "allowed", ms: 1000 },
    { id: 2, verdict: "blocked", category: "off_topic", ms: 2000 },
  ];
  assert.equal(G.lastLabeled(ev), 2);
  ev.push({ id: G.lastLabeled(ev), undo: true });
  assert.deepEqual([...G.replay(ev).keys()], [1]);
  ev.push({ id: 2, verdict: "allowed", ms: 500 });
  const m = G.replay(ev);
  assert.equal(m.get(2).verdict, "allowed");
  assert.deepEqual(G.commits(ev).map((x) => x.id), [1, 2]);
  // two undos in a row walk back two labels
  ev.push({ id: G.lastLabeled(ev), undo: true });
  ev.push({ id: G.lastLabeled(ev), undo: true });
  assert.equal(G.replay(ev).size, 0);
  assert.equal(G.lastLabeled(ev), null);
});

test("a label made again without an undo moves to the end of the commit order", () => {
  const ev = [{ id: "a", verdict: "allowed" }, { id: "b", verdict: "allowed" }, { id: "a", verdict: "blocked" }];
  assert.deepEqual(G.commits(ev).map((x) => `${x.id}:${x.verdict}`), ["b:allowed", "a:blocked"]);
});

test("points: 100 per decided answer, +50 under 8 s, a streak multiplier; unsure scores 0 and keeps the streak", () => {
  const fast = (v = "allowed") => ({ verdict: v, ms: 1000 });
  const s = G.score([fast(), fast(), fast(), fast(), fast(), fast("unsure"), { verdict: "blocked", ms: 9000 }]);
  assert.deepEqual(s.rows.map((r) => r.pts), [150, 150, 150, 150, 225, 0, 100]);
  assert.equal(s.best, 5);
  assert.equal(s.streak, 0);
  assert.equal(s.points, 925);
});

test("the median of what there is", () => {
  assert.equal(G.median([3, 1, 2]), 2);
  assert.equal(G.median([4, 1, 3, 2]), 2.5);
  assert.equal(G.median([undefined, 5]), 5);
  assert.equal(G.median([]), null);
});

const ITEMS = [
  { id: 0, text: "Do you have this jacket in M?", expected: "", note: "" },
  { id: 1, text: 'Write me a poem, "now"', expected: "", note: "from chat" },
  { id: 2, text: "Is shipping free?", expected: "allowed", category: "", note: "" },
  { id: 3, text: "Where is my order?", expected: "", note: "" },
];

test("labels as CSV: your label wins, unsure leaves expected empty, the file's own label stays", () => {
  const labels = G.replay([
    { id: 0, verdict: "allowed" },
    { id: 1, verdict: "blocked", category: "off_topic" },
    { id: 3, verdict: "unsure" },
  ]);
  const csv = G.labelsCsv(ITEMS, labels);
  const back = C.validate(C.parse(csv), { expectedOptional: true });
  assert.deepEqual(back.errors, []);
  assert.deepEqual(back.cases.map((c) => [c.message, c.expected, c.category, c.note]), [
    ["Do you have this jacket in M?", "allowed", "", ""],
    ['Write me a poem, "now"', "blocked", "off_topic", "from chat"],
    ["Is shipping free?", "allowed", "", ""],
    ["Where is my order?", "", "", "unsure"],
  ]);
  assert.match(csv.split("\r\n")[0], /^message,expected,category,note$/);
});

test("a race takes labeled rows only and counts the unsure and the unlabeled", () => {
  const labels = G.replay([{ id: 0, verdict: "blocked" }, { id: 3, verdict: "unsure" }]);
  const r = G.raceCases(ITEMS, labels);
  assert.deepEqual(r.cases.map((c) => [c.message, c.expected]), [["Do you have this jacket in M?", "blocked"], ["Is shipping free?", "allowed"]]);
  assert.equal(r.unsure, 1);
  assert.equal(r.unlabeled, 1);
});

test("you vs models: right out of n, unsure and failed calls are not right, best first", () => {
  const items = [{ id: "a", gold: "allowed" }, { id: "b", gold: "blocked" }, { id: "c", gold: "blocked" }];
  const labels = G.replay([
    { id: "a", verdict: "allowed", ms: 3000 }, { id: "b", verdict: "unsure", ms: 5000 }, { id: "c", verdict: "blocked", ms: 1000 },
  ]);
  const rows = G.versus(items, labels, [
    { key: "m1", name: "fast-model", rows: [{ index: 0, verdict: "allowed", ms: 400 }, { index: 1, verdict: "blocked", ms: 300 }, { index: 2, verdict: "blocked", ms: 200 }] },
    { key: "m2", name: "broken-model", rows: [{ index: 0, verdict: null, ms: 50 }, { index: 1, verdict: "allowed", ms: 60 }] },
  ]);
  assert.deepEqual(rows.map((r) => [r.name, r.right, r.n]), [["fast-model", 3, 3], ["You", 2, 3], ["broken-model", 0, 3]]);
  const you = rows.find((r) => r.you);
  assert.deepEqual(you.marks, ["right", "unsure", "right"]);
  assert.equal(you.p50ms, 3000);
  const broken = rows.find((r) => r.key === "m2");
  assert.deepEqual(broken.marks, ["failed", "wrong", "pending"]);
  assert.equal(broken.failed, 1);
  assert.equal(broken.pending, 1);
});

test("a tie on right answers goes to the faster one", () => {
  const items = [{ id: 0, gold: "allowed" }];
  const rows = G.versus(items, G.replay([{ id: 0, verdict: "allowed", ms: 4000 }]),
    [{ key: "m", name: "m", rows: [{ index: 0, verdict: "allowed", ms: 900 }] }]);
  assert.deepEqual(rows.map((r) => r.key), ["m", "you"]);
});

test("a file to label needs only a message column", () => {
  const v = C.validate(C.parse("message,expected\nhello,\nbye,unsure\nstop,blocked\n"), { expectedOptional: true });
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.cases.map((c) => c.expected), ["", "", "blocked"]);
  const only = C.validate(C.parse("Message\nhi there\n"), { expectedOptional: true });
  assert.deepEqual(only.cases.map((c) => [c.message, c.expected]), [["hi there", ""]]);
  // the race still insists on a label
  assert.match(C.validate(C.parse("message\nhi\n")).errors[0], /expected/);
});

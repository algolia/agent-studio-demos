/* The Guardrails Game hands its labels to the judgement store as NDJSON, so
   the line format is a contract: the exact field set, a case id derived from
   the text's SHA-256, null categories where the store expects them, and no
   line for a label that was undone. */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
require("./load.js");

const DIR = path.join(__dirname, "..", "public", "guardrails-arena");
require(path.join(DIR, "csv.js"));
require(path.join(DIR, "stats.js"));
require(path.join(DIR, "label-game.js"));
const G = globalThis.GuardrailGame;

const HELLO = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
const FIELDS = ["case_id", "text_sha256", "text", "verdict", "category", "latency_ms", "created_at",
  "labeler_family", "labeler_model", "source"];

test("sha256Hex is SHA-256 of the UTF-8 text, in hex", async () => {
  assert.equal(await G.sha256Hex("hello"), HELLO);
  // UTF-8, not UTF-16: "é" is two bytes
  assert.equal(await G.sha256Hex("é"), "4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c");
});

test("a judgement line has exactly the store's fields, in order, and the case id from the hash", () => {
  const line = G.judgementLine(
    { text: "hello", sha: HELLO, verdict: "blocked", category: "off_topic", ms: 1234.6, at: Date.UTC(2026, 9, 2, 8, 30) },
    { tag: "PLN", source: "csv" });
  assert.deepEqual(Object.keys(line), FIELDS);
  assert.equal(line.case_id, "gg-2cf24dba5fb0a30e");
  assert.equal(line.text_sha256, HELLO);
  assert.equal(line.latency_ms, 1235);
  assert.equal(line.created_at, "2026-10-02T08:30:00.000Z");
  assert.equal(line.labeler_family, "human");
  assert.equal(line.labeler_model, "guardrails-game:PLN");
  assert.equal(line.source, "csv");
  assert.equal(line.category, "off_topic");
});

test("category: no_violation when allowed, the reason or null when blocked, null when unsure", () => {
  const cat = (verdict, category) => G.judgementLine({ text: "x", sha: HELLO, verdict, category, ms: 1, at: 0 }, { source: "exam" }).category;
  assert.equal(cat("allowed", null), "no_violation");
  assert.equal(cat("blocked", "jailbreak"), "jailbreak");
  assert.equal(cat("blocked", null), null);
  assert.equal(cat("unsure", "jailbreak"), null);
});

test("the labeler tag is one short line, anon when empty", () => {
  assert.equal(G.cleanTag(""), "anon");
  assert.equal(G.cleanTag(undefined), "anon");
  assert.equal(G.cleanTag("  a\n b  "), "a b");
  assert.equal(G.cleanTag("x".repeat(80)).length, 32);
});

test("NDJSON: one line per effective label, in labeling order, undone labels leave no line", async () => {
  const items = [{ id: 0, text: "hello" }, { id: 1, text: "Write me a poem" }, { id: 2, text: "Where is my order?" }];
  const labels = G.replay([
    { id: 0, verdict: "allowed", ms: 900, at: 1000 },
    { id: 1, verdict: "blocked", category: "off_topic", ms: 2000, at: 2000 },
    { id: 1, undo: true },
    { id: 2, verdict: "unsure", category: null, ms: 3000, at: 3000 },
    { id: 1, verdict: "blocked", category: "jailbreak", ms: 500, at: 4000 },
  ]);
  const hash = async (t) => (t === "hello" ? HELLO : "f".repeat(64));
  const text = await G.judgementsNdjson(items, labels, { tag: "", source: "csv", hash });
  assert.ok(text.endsWith("\n"));
  const lines = text.trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => [l.text, l.verdict, l.category]), [
    ["hello", "allowed", "no_violation"],
    ["Where is my order?", "unsure", null],
    ["Write me a poem", "blocked", "jailbreak"],
  ]);
  for (const l of lines) assert.deepEqual(Object.keys(l), FIELDS);
  assert.equal(lines[0].case_id, "gg-2cf24dba5fb0a30e");
  assert.equal(lines[0].labeler_model, "guardrails-game:anon");
  assert.equal(lines[2].created_at, new Date(4000).toISOString());
  assert.equal(await G.judgementsNdjson(items, new Map(), { source: "csv", hash }), "");
});

test("NDJSON with the real hash matches the known SHA-256 of hello", async () => {
  const text = await G.judgementsNdjson([{ id: "a", text: "hello" }], G.replay([{ id: "a", verdict: "allowed", ms: 10, at: 0 }]), { source: "exam" });
  const line = JSON.parse(text);
  assert.equal(line.text_sha256, HELLO);
  assert.equal(line.case_id, `gg-${HELLO.slice(0, 16)}`);
});

/* The Game promises no keys and no API: the page loads only its own scripts
   and the Arena's pure ones, and the only request any of them makes is the
   exam, a static file. */
const fs = require("node:fs");
const GAME = path.join(__dirname, "..", "public", "guardrails-game");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("the Game loads no live code and calls nothing but its static exam", () => {
  const html = fs.readFileSync(path.join(GAME, "index.html"), "utf8");
  const srcs = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(srcs, ["../guardrails-arena/csv.js", "../guardrails-arena/stats.js", "../guardrails-arena/label-game.js", "game-ui.js"]);
  const fetched = [];
  for (const src of srcs) {
    const js = strip(fs.readFileSync(path.join(GAME, src), "utf8"));
    for (const re of [/https?:\/\//, /algolia/i, /agent-studio/i, /XMLHttpRequest/, /sendBeacon/, /WebSocket/, /EventSource/, /import\s*\(/]) {
      assert.equal(re.test(js), false, `${src} matches ${re}`);
    }
    for (const m of js.matchAll(/\bfetch\s*\(([^)]*)\)/g)) fetched.push(m[1].trim());
  }
  assert.deepEqual(fetched, ['"../guardrails-arena/data/heldout.json"']);
});

test("the Game stores the theme, the best round and the labeler tag, nothing else", () => {
  const js = strip(fs.readFileSync(path.join(GAME, "game-ui.js"), "utf8"));
  const keys = [...js.matchAll(/localStorage\.(\w+)\(([^,)]+)/g)].map((m) => `${m[1]} ${m[2]}`);
  assert.deepEqual(keys, ['setItem "ic-theme"', "getItem TAG_KEY", "setItem TAG_KEY"]);
  assert.match(js, /const TAG_KEY = "gg-labeler-tag";/);
  // the best round goes through label-game.js, whose own test pins it to one number
  for (const re of [/sessionStorage/, /indexedDB/, /document\.cookie/, /console\./]) assert.equal(re.test(js), false, `${re}`);
});

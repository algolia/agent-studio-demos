/* prefetch/: one race page, several use cases. Each page names its demo,
   and demos.mjs says which config block, starters and card fields that
   demo reads. */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const PUBLIC = path.join(__dirname, "..", "public");
const load = (rel) => import(pathToFileURL(path.join(PUBLIC, rel)).href);
const page = (rel) => fs.readFileSync(path.join(PUBLIC, "prefetch", rel), "utf8");
const SUB = [
  { demo: "askai", file: "askai/index.html", h1: "Ask AI on docs", block: "prefetchAskai" },
  { demo: "assist", file: "assist/index.html", h1: "AI Assist", block: "prefetchAssist" },
];

test("the catalog demo reads what the page always read", async () => {
  const d = await load("prefetch/demos.mjs");
  const p = await load("prefetch/compare.mjs");
  assert.deepEqual(d.DEMOS.catalog.blocks, ["prefetchDemo", "mainDemo"]);
  assert.equal(d.DEMOS.catalog.starters, p.STARTERS);
  assert.ok(d.DEMOS.catalog.placeholder.length > 0);
});

test("an unknown or missing demo name is the catalog page", async () => {
  const d = await load("prefetch/demos.mjs");
  assert.equal(d.demoOf(undefined), d.DEMOS.catalog);
  assert.equal(d.demoOf("nope"), d.DEMOS.catalog);
  assert.equal(d.demoOf("toString"), d.DEMOS.catalog, "no prototype key is a demo");
});

test("a page reads the first of its demo's blocks that is set, and no other", async () => {
  const p = await load("prefetch/compare.mjs");
  const root = { mainDemo: { appId: "M" }, other: { appId: "O" } };
  assert.equal(p.pageConfig(root, ["other"]).block.appId, "O");
  assert.equal(p.pageConfig(root, ["missing", "mainDemo"]).name, "mainDemo");
  assert.deepEqual(p.pageConfig({ mainDemo: { appId: "M" } }, ["other"]), { block: null, name: null },
    "no block of its own: live is unavailable rather than racing another demo's agents");
});

test("a demo's card fields sit under the block's own, and the block's index wins", async () => {
  const d = await load("prefetch/demos.mjs");
  const demo = { fields: { title: ["hierarchy.lvl1"] } };
  const cfg = d.demoConfig(demo, { appId: "A", indexName: "docs" });
  assert.equal(cfg.indexName, "docs");
  assert.deepEqual(cfg.fields, demo.fields);
  assert.deepEqual(d.demoConfig(demo, { fields: { title: "name" } }).fields, { title: "name" }, "a deploy's fields win");
  assert.equal(d.demoConfig(d.DEMOS.catalog, null).indexName, "products");
  assert.equal("fields" in d.demoConfig(d.DEMOS.catalog, {}), false);
});

test("the page names its demo, and its styles live in prefetch/style.css", () => {
  const html = page("index.html");
  assert.match(html, /<html lang="en" data-demo="albums">/);
  assert.match(html, /<link rel="stylesheet" href="style\.css">/);
  assert.doesNotMatch(html, /<style>/);
});

/* ── the sub-pages: one use case each ── */

test("every demo names its blocks, a placeholder, and starters that fit one line", async () => {
  const d = await load("prefetch/demos.mjs");
  const p = await load("prefetch/compare.mjs");
  assert.deepEqual(Object.keys(d.DEMOS), ["albums", "catalog", ...SUB.map((s) => s.demo)]);
  for (const s of [{ demo: "albums", block: "prefetchAlbums" }, ...SUB]) {
    const demo = d.DEMOS[s.demo];
    assert.deepEqual(demo.blocks, [s.block], `${s.demo} never falls back to another app's agents`);
    assert.ok(demo.placeholder.length > 0);
    assert.deepEqual(demo.starters.map((x) => x.fit), ["good", "good", "good", "poor"], "three good fits, one poor");
    for (const x of demo.starters) assert.equal(p.questionOf(x.text), x.text);
    assert.ok(Array.isArray(demo.fields.title) && demo.fields.title.length, "the cards name a title attribute");
  }
});

test("each sub-page names its demo, runs the one app.js, and links back to the race page", () => {
  for (const s of SUB) {
    const html = page(s.file);
    assert.match(html, new RegExp(`<html lang="en" data-demo="${s.demo}">`));
    assert.match(html, /<script type="module" src="\.\.\/app\.js"><\/script>/);
    assert.match(html, /<link rel="stylesheet" href="\.\.\/style\.css">/);
    assert.match(html, /<script src="\.\.\/\.\.\/shared\/config\.js"/);
    assert.match(html, /<p class="eyebrow"><a href="\.\.\/">Search prefetch<\/a><\/p>/);
    assert.match(html, new RegExp(`<h1>${s.h1}</h1>`));
    assert.doesNotMatch(html, /<style>/, "the styles live in prefetch/style.css");
  }
});

test("the sub-pages carry the same race markup as the race page's act 2", () => {
  const ids = (html) => [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const html = page("index.html");
  const act = html.slice(html.indexOf('<section class="pf-act" id="act-race"'), html.indexOf('id="act-tune"'));
  const base = ids(act).filter((id) => id !== "act-race" && id !== "race-h");
  for (const s of SUB) assert.deepEqual(ids(page(s.file)), base, s.file);
});

test("the copy claims no more than often sooner, with no em dash", () => {
  for (const s of SUB) {
    const html = page(s.file);
    assert.doesNotMatch(html, /\u2014|&mdash;/, `${s.file}: no em dash`);
    const prose = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
    assert.match(prose, /often starts sooner/);
    assert.doesNotMatch(prose, /\b(speedup|speeds? up|quicker|saves?|\d+(\.\d+)?\s*[x×])\b/i);
    for (const m of prose.matchAll(/\b(faster|sooner)\b/gi)) {
      assert.match(prose.slice(Math.max(0, m.index - 30), m.index), /\boften\b[^.]*$/i);
    }
    assert.match(html, /<footer[^>]*>[\s\S]*Timings vary from run to run\.[\s\S]*<\/footer>/);
  }
  const src = fs.readFileSync(path.join(PUBLIC, "prefetch", "demos.mjs"), "utf8");
  assert.doesNotMatch(src, /\u2014/);
});

test("the config template documents each sub-page block with the two variant keys", async () => {
  const c = await load("main-demo/configs.mjs");
  const p = await load("prefetch/compare.mjs");
  const src = fs.readFileSync(path.join(PUBLIC, "shared", "config.example.js"), "utf8");
  for (const s of SUB) {
    const at = src.indexOf(`// ${s.block}: {`);
    assert.ok(at > 0, s.block);
    for (const l of p.LANES) assert.ok(src.indexOf(c.configKey(l.toggles), at) > at, `${s.block}: ${l.label}`);
  }
});

test("the copy gate reads every sub-page", () => {
  const gate = fs.readFileSync(path.join(__dirname, "..", "scripts", "check-copy.js"), "utf8");
  for (const s of SUB) assert.ok(gate.includes(`"prefetch/${s.file}"`), s.file);
});

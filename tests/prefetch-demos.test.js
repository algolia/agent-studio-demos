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
  assert.match(html, /<html lang="en" data-demo="catalog">/);
  assert.match(html, /<link rel="stylesheet" href="style\.css">/);
  assert.doesNotMatch(html, /<style>/);
});

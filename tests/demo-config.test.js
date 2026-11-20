/* shared/demo-config.mjs: one default block, a demo's own block over it. And
   the contract with config.example.js: every block a demo names in demos.mjs
   is documented there, and each demo resolves a usable config from the
   template's default plus its blocks. */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const { loadExampleConfig } = require("./load.js");

const PUBLIC = path.join(__dirname, "..", "public");
const load = (f) => import(pathToFileURL(path.join(PUBLIC, f)).href);
const DEFAULT = { host: "https://h", appId: "APP", apiKey: "KEY", agentId: "AG", index: "IDX" };

test("a named block overrides only what differs; default fills the rest", async () => {
  const { blockFor } = await load("shared/demo-config.mjs");
  const { block, name } = blockFor(["tasks"], { default: DEFAULT, tasks: { agentId: "OWN" } });
  assert.equal(name, "tasks");
  assert.deepEqual({ ...block }, { ...DEFAULT, agentId: "OWN", agentStudioApiKey: "KEY" });
});

test("older top-level keys sit below default; default alone answers", async () => {
  const { blockFor } = await load("shared/demo-config.mjs");
  const root = { host: "https://old", appId: "OLD", apiKey: "OLDKEY", default: { appId: "APP" } };
  assert.deepEqual(blockFor(["tasks"], root), { block: { host: "https://old", appId: "APP", apiKey: "OLDKEY", agentStudioApiKey: "OLDKEY" }, name: null });
  assert.equal(blockFor(["x"], { default: DEFAULT }).block.index, "IDX");
  assert.deepEqual(blockFor(["x"], null), { block: null, name: null });
});

test("variants without an agentId take the merged block's", async () => {
  const { blockFor } = await load("shared/demo-config.mjs");
  const root = { default: DEFAULT, mainDemo: { variants: { a: { name: "n" }, b: { agentId: "B" } } } };
  const v = blockFor(["mainDemo"], root).block.variants;
  assert.equal(v.a.agentId, "AG");
  assert.equal(v.b.agentId, "B");
});

test("every block a demo names is documented in config.example.js", async () => {
  const { DEMOS } = await load("prefetch/demos.mjs");
  const doc = fs.readFileSync(path.join(PUBLIC, "shared", "config.example.js"), "utf8");
  const names = new Set(["tasks", ...Object.values(DEMOS).flatMap((d) => d.blocks)]);
  for (const n of names) assert.match(doc, new RegExp(`\\b${n}:\\s*\\{`), `config.example.js does not document the ${n} block`);
});

test("from config.example.js, every demo resolves a usable config", async () => {
  const { blockFor } = await load("shared/demo-config.mjs");
  const { DEMOS } = await load("prefetch/demos.mjs");
  const root = loadExampleConfig();
  for (const names of [["tasks"], ...Object.values(DEMOS).map((d) => d.blocks)]) {
    const { block } = blockFor(names, root);
    for (const f of ["host", "appId", "apiKey", "agentStudioApiKey", "agentId", "index"]) {
      assert.ok(block && block[f], `${names.join("/")} resolves no ${f}`);
    }
  }
});

test("tools/demo-config.mjs adds a block field by field and keeps the rest", async () => {
  const { withBlock, mergeBlock } = await import(pathToFileURL(path.join(__dirname, "..", "tools", "demo-config.mjs")).href);
  const src = 'window.DEMO_CONFIG = { host: "h", tasks: { appId: "A", apiKey: "K", index: "I" }, default: { appId: "OLD", agentId: "G" } };\n';
  const read = (s) => { const w = {}; new Function("window", s)(w); return w.DEMO_CONFIG; };
  const fields = mergeBlock(read(src), "default", read(src).tasks);
  const out = read(withBlock(withBlock(src, "default", fields), "default", { ...fields, index: "I2" }));
  assert.deepEqual(out.default, { appId: "A", agentId: "G", apiKey: "K", index: "I2" });
  assert.equal(out.tasks.apiKey, "K");
  assert.equal(out.host, "h");
  assert.throws(() => mergeBlock({}, "default", { appId: "" }), /empty/);
});

test("the prefetch race is live from default alone (agentId stands for each lane)", async () => {
  const { blockFor } = await load("shared/demo-config.mjs");
  const { liveReadiness } = await load("prefetch/compare.mjs");
  const live = liveReadiness(blockFor(["prefetchDemo", "mainDemo"], { default: DEFAULT }).block);
  assert.equal(live.ok, true);
  assert.ok(Object.values(live.variants).every((v) => v.agentId === "AG"));
});

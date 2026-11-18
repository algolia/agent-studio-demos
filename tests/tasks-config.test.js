/* tools/tasks-demo-config.mjs's only risky part: the text surgery on a real
   config.js. A botched block edit is a blank page for every visitor, so the
   append, the replace, and the refusal are what is checked here. The three
   live checks it runs before writing are the operator's smoke test. */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const load = () => import(pathToFileURL(path.join(__dirname, "..", "tools", "tasks-demo-config.mjs")).href);

const BLOCK = [
  "  tasks: {",
  '    host: "h",',
  '    appId: "a",',
  '    apiKey: "k",',
  '    agentId: "g",',
  '    index: "sephora",',
  "  },",
].join("\n");

const BASE = [
  "window.DEMO_CONFIG = {",
  '  host: "https://agent-studio.eu.algolia.com",',
  "  models: [",
  '    { id: "enablers" },',
  "  ],",
  "};",
  "",
].join("\n");

/** what the deploy does to the file: parse it, read the object back */
function parse(src) {
  const fn = new Function(`const window = {}; ${src}; return window.DEMO_CONFIG;`);
  return fn();
}

test("appends the block before the closing brace, and the file still parses", async () => {
  const { withTasksBlock } = await load();
  const out = withTasksBlock(BASE, BLOCK);
  assert.deepEqual(parse(out).tasks, { host: "h", appId: "a", apiKey: "k", agentId: "g", index: "sephora" });
  assert.deepEqual(parse(out).models, [{ id: "enablers" }], "the rest of the config survives");
});

test("a commented-out example block is not mistaken for the real one", async () => {
  const { withTasksBlock } = await load();
  const commented = BASE.replace("};", '  // tasks: {\n  //   host: "x",\n  // },\n};');
  const out = withTasksBlock(commented, BLOCK);
  assert.equal(out.split("tasks: {").length - 1, 2, "the comment stays, one real block is added");
  assert.equal(parse(out).tasks.host, "h");
});

test("replacing is idempotent: one block, no doubled comma", async () => {
  const { withTasksBlock } = await load();
  const once = withTasksBlock(BASE, BLOCK);
  const twice = withTasksBlock(once, BLOCK.replace('"h"', '"h2"'));
  assert.equal(twice.split("tasks: {").length - 1, 1);
  assert.equal(parse(twice).tasks.host, "h2");
  assert.ok(!/,\s*,/.test(twice), "no comma pile-up");
});

test("a file with no closing brace is refused, not guessed at", async () => {
  const { withTasksBlock } = await load();
  assert.throws(() => withTasksBlock("window.DEMO_CONFIG = {", BLOCK), /no closing/);
});

test("blockNames reads block names out, never values", async () => {
  const { blockNames } = await load();
  const deployed = [
    "window.DEMO_CONFIG = {",
    '  host: "https://agent-studio.eu.algolia.com",',
    '  appId: "APP",',
    '  apiKey: "a-secret-never-printed",',
    "  pii: {",
    '    agentId: "agent-2",',
    "  },",
    "};",
  ].join("\n");
  assert.deepEqual(blockNames(deployed), ["host", "appId", "apiKey", "pii"]);
});

test("adding the block to a production-shaped file keeps every block", async () => {
  const { withTasksBlock, blockNames } = await load();
  const deployed = [
    "window.DEMO_CONFIG = {",
    '  host: "https://agent-studio.eu.algolia.com",',
    '  apiKey: "search-key",',
    "  pii: {",
    '    agentId: "agent-2",',
    "  },",
    "};",
  ].join("\n");
  const out = withTasksBlock(deployed, BLOCK);
  assert.deepEqual(blockNames(out), ["host", "apiKey", "pii", "tasks"], "nothing dropped, tasks appended");
  assert.equal(parse(out).pii.agentId, "agent-2", "the other block still parses with its values");
});

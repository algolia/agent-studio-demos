/* tools/tasks-demo-config.mjs's only risky part: the edit it makes to a real
   config.js. A botched edit is a blank page for every visitor, and the file has
   more than one shape in the wild — a plain literal, marked assignment sections
   appended by the other provisioners, and a hand-written tasks block marked
   "(manual)". What is checked here is that the tool writes one tasks section and
   keeps everything else, with its values. */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const load = () => import(pathToFileURL(path.join(__dirname, "..", "tools", "tasks-demo-config.mjs")).href);

const FIELDS = {
  host: "https://agent-studio.eu.algolia.com",
  appId: "TDNMRH8LS3",
  apiKey: "search-key-not-real-0001",
  agentId: "0a6e05ef-b94e-4ecd-8210-779cbd510005",
  index: "sephora",
};

/** what the deploy does with the file: run it, read the object back */
function parse(src) {
  const win = {};
  new Function("window", src)(win);
  return win.DEMO_CONFIG;
}

const PLAIN = ['window.DEMO_CONFIG = {', '  host: "https://agent-studio.eu.algolia.com",', '  apiKey: "k",', "};", ""].join("\n");

// the shape a provisioner leaves behind: base literal, then marked sections
const WITH_PII = [
  "window.DEMO_CONFIG = {",
  '  host: "https://agent-studio.eu.algolia.com",',
  '  apiKey: "k",',
  "};",
  "",
  "// pii: begin (tools/pii-provision.mjs)",
  "window.DEMO_CONFIG = window.DEMO_CONFIG || {};",
  'window.DEMO_CONFIG.pii = {"region":"eu","agentId":"agent-2","model":"medium"};',
  "// pii: end",
  "",
].join("\n");

const MANUAL = [
  WITH_PII.replace(/\n$/, ""),
  "",
  "// tasks: begin (manual)",
  "window.DEMO_CONFIG.tasks = {",
  '  host: "http://localhost:8000",',
  '  apiKey: "a-stale-key",',
  "};",
  "// tasks: end",
  "",
].join("\n");

test("a plain config gains one marked section and still parses", async () => {
  const { withTasksBlock } = await load();
  const out = withTasksBlock(PLAIN, FIELDS);
  assert.deepEqual(parse(out).tasks, FIELDS);
  assert.equal(parse(out).apiKey, "k", "the rest of the config survives");
  assert.equal(out.match(/\/\/ tasks: begin/g).length, 1);
});

test("a production-shaped file keeps its pii section, values included", async () => {
  const { withTasksBlock } = await load();
  const out = withTasksBlock(WITH_PII, FIELDS);
  assert.deepEqual(parse(out).pii, { region: "eu", agentId: "agent-2", model: "medium" });
  assert.deepEqual(parse(out).tasks, FIELDS);
  assert.ok(out.indexOf("pii: begin") < out.indexOf("tasks: begin"), "pii stays where it was");
});

test("a hand-written (manual) section is replaced whole, not duplicated", async () => {
  const { withTasksBlock } = await load();
  const out = withTasksBlock(MANUAL, FIELDS);
  assert.equal(out.match(/\/\/ tasks: begin/g).length, 1, "one section");
  assert.equal(out.match(/\/\/ tasks: end/g).length, 1, "one end marker");
  assert.deepEqual(parse(out).tasks, FIELDS, "the stale host and key are gone");
  assert.ok(!out.includes("(manual)"), "the marker now names the tool that owns it");
  assert.ok(!out.includes("a-stale-key"), "the replaced section leaves nothing behind");
  assert.deepEqual(parse(out).pii.model, "medium", "the neighbor section is untouched");
});

test("replacing is idempotent", async () => {
  const { withTasksBlock } = await load();
  const once = withTasksBlock(PLAIN, FIELDS);
  const twice = withTasksBlock(once, { ...FIELDS, index: "sephora_v2" });
  assert.equal(twice.match(/\/\/ tasks: begin/g).length, 1);
  assert.equal(parse(twice).tasks.index, "sephora_v2");
  assert.equal(twice.match(/window.DEMO_CONFIG.tasks = \{/g).length, 1);
});

test("a section with no end marker is refused, not guessed at", async () => {
  const { withTasksBlock } = await load();
  const truncated = `${PLAIN.replace(/\n$/, "")}\n\n// tasks: begin (manual)\nwindow.DEMO_CONFIG.tasks = {`;
  assert.throws(() => withTasksBlock(truncated, FIELDS), /without its end marker/);
});

test("blockNames reads block names out, never values", async () => {
  const { blockNames } = await load();
  assert.deepEqual(blockNames(WITH_PII), ["host", "apiKey", "pii"]);
});

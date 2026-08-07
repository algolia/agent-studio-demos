/* config.example.js is the contract between a reader and the demos: whatever it
   documents is what app.js reads at startup. If a field is renamed on one side
   only, the demo fails in the browser with no build step to catch it — so the
   template's shape is checked here instead. */

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadExampleConfig } = require("./load.js");

const cfg = loadExampleConfig();

test("the template parses and carries every field app.js reads at startup", () => {
  for (const field of ["host", "appId", "apiKey", "summaryCard", "models", "budgets", "defaultBudget", "repoUrl"]) {
    assert.ok(field in cfg, `config.example.js is missing ${field}`);
  }
  assert.match(cfg.host, /^https:\/\//, "host must be an https origin");
  assert.ok(Array.isArray(cfg.models) && cfg.models.length > 0, "at least one model option");
  assert.ok(Array.isArray(cfg.budgets) && cfg.budgets.length > 0, "at least one budget option");
  for (const field of ["indexName", "summaryAgentId", "followupAgentId"]) {
    assert.ok(field in cfg.summaryCard, `summaryCard is missing ${field}`);
  }
  assert.equal(typeof cfg.compactAtRatio, "number");
  assert.ok(cfg.compactAtRatio > 0 && cfg.compactAtRatio < 1, "compactAtRatio is a share of the budget");
});

test("every model option can actually be called", () => {
  for (const m of cfg.models) {
    for (const field of ["id", "label", "agentId", "providerId", "model", "contextWindow"]) {
      assert.ok(m[field] !== undefined, `model ${m.id || "?"} is missing ${field}`);
    }
    assert.equal(typeof m.contextWindow, "number");
    assert.ok(m.contextWindow > 0, `model ${m.id} needs a real context window`);
  }
  const ids = cfg.models.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, "model ids must be unique — they key the picker");
});

test("the default budget is one of the offered budgets", () => {
  const values = cfg.budgets.map((b) => b.value);
  assert.ok(values.includes(cfg.defaultBudget), `defaultBudget ${cfg.defaultBudget} is not in budgets`);
});

test("the template holds placeholders, not somebody's real credentials", () => {
  assert.match(cfg.appId, /^YOUR_/, "appId in the template must stay a placeholder");
  assert.match(cfg.apiKey, /^YOUR_/, "apiKey in the template must stay a placeholder");
  assert.match(cfg.summaryCard.indexName, /^YOUR_/, "summaryCard indexName must stay a placeholder");
  assert.match(cfg.summaryCard.summaryAgentId, /^YOUR_/, "summaryCard summaryAgentId must stay a placeholder");
  assert.match(cfg.summaryCard.followupAgentId, /^YOUR_/, "summaryCard followupAgentId must stay a placeholder");
});

test("config.js is not committed", () => {
  const tracked = fs.readFileSync(path.join(__dirname, "..", ".gitignore"), "utf8");
  assert.match(tracked, /^config\.js$/m, ".gitignore must ignore config.js at any depth");
  assert.match(tracked, /^public\/shared\/config\.js$/m, ".gitignore must ignore the real config path");
});

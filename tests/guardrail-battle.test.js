/* The guardrail-battle page ships frozen results to a public site, so two
   things about its data are worth a test: nothing internal leaked into the
   snapshot, and the numbers it shows still carry their n and their interval. */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const DATA = path.join(__dirname, "..", "public", "guardrail-battle", "data");
const files = fs.readdirSync(DATA).filter((f) => f.endsWith(".json"));
const read = (f) => fs.readFileSync(path.join(DATA, f), "utf8");

const FORBIDDEN = [
  /algolia\.net/i, /enablers/i, /\/tmp\//, /vault/i, /\bglm/i, /gemma/i, /qwen/i,
  /"(?:small|large|xlarge)"/, /[\w.+-]+@[\w-]+\.[\w.]+/, /https?:\/\//, /localhost|127\.0\.0\.1/,
  /score_payload|run\.log|sqlite/i,
  /lululemon|gymshark|athleta|adidas|\bnike\b/i,
  // well-known brands: the synthetic shop names its rivals Brand A, Brand B, …
  /\b(?:marvel|disney|pixar|netflix|spotify|amazon|ebay|walmart|patagonia|north face|arc.teryx|decathlon|under armour|puma|reebok|new balance|asics|salomon|vuori|uniqlo|zara|starbucks|coca.cola|pepsi|openai|tiktok|instagram|youtube)\b/i,
];

test("the snapshots exist and stay small", () => {
  assert.deepEqual(files.sort(), ["heldout.json", "run.json"]);
  for (const f of files) {
    const bytes = fs.statSync(path.join(DATA, f)).size;
    assert.ok(bytes < 200 * 1024, `${f} is ${bytes} bytes`);
  }
});

test("nothing internal is in the snapshots", () => {
  for (const f of files) {
    const s = read(f);
    for (const re of FORBIDDEN) assert.equal(re.test(s), false, `${f} matches ${re}`);
  }
});

test("model names are neutral labels", () => {
  const run = JSON.parse(read("run.json"));
  assert.deepEqual(Object.values(run.models).sort(),
    ["classifier model", "generator model", "labeler model"]);
});

test("every held-out figure carries its n and a 95% interval around it", () => {
  const run = JSON.parse(read("run.json"));
  const within = (ci, y) => ci[0] <= y + 1e-9 && y <= ci[1] + 1e-9 && ci[0] >= 0 && ci[1] <= 1;
  for (const r of run.rounds) {
    const h = r.heldout;
    assert.equal(h.n, run.dataset.heldout);
    assert.equal(h.n_allowed + h.n_blocked, h.n);
    assert.ok(within(h.ba_ci95, h.balanced_accuracy), `r${r.round} balanced accuracy`);
    assert.ok(within(h.over_refusal_ci95, h.over_refusal), `r${r.round} over-refusal`);
    assert.ok(within(h.leak_ci95, h.leak), `r${r.round} leak`);
  }
  const s = run.heldout_summary;
  assert.equal(s.n, run.dataset.heldout);
  assert.equal(run.heldout_hard.length, run.paired.r0_wrong_final_right + run.paired.r0_right_final_wrong +
    run.heldout_hard.filter((x) => x.r0_pred !== x.gold && x.final_pred !== x.gold).length);
});

test("the shipped held-out set is the one the run scored", () => {
  const run = JSON.parse(read("run.json"));
  const { cases } = JSON.parse(read("heldout.json"));
  assert.equal(cases.length, run.heldout_summary.n);
  assert.equal(cases.filter((c) => c.r0 === c.gold).length, run.heldout_summary.r0_correct);
  assert.equal(cases.filter((c) => c.final === c.gold).length, run.heldout_summary.final_correct);
  for (const c of cases) {
    assert.ok(["allowed", "blocked"].includes(c.gold));
    assert.equal(c.gold === "allowed", c.category === "no_violation");
  }
});

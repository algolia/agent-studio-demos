/* public/pii/data/bank_faq.json and tools/pii-faq-seed.mjs: the FAQ the
   banking agent searches, and the script that writes it to bank_faq. */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const FAQ = JSON.parse(fs.readFileSync(path.join(ROOT, "public", "pii", "data", "bank_faq.json"), "utf8"));

test("the FAQ: ~30 records, EN and FR in pairs, every field, short answers", () => {
  assert.ok(FAQ.length >= 28 && FAQ.length <= 36, `${FAQ.length} records`);
  const ids = FAQ.map((r) => r.objectID);
  assert.equal(new Set(ids).size, ids.length, "unique objectIDs");
  for (const r of FAQ) {
    assert.deepEqual(Object.keys(r).sort(), ["answer", "category", "lang", "objectID", "question", "tags"], r.objectID);
    assert.ok(["en", "fr"].includes(r.lang), r.objectID);
    assert.ok(r.objectID.endsWith(`-${r.lang}`), r.objectID);
    assert.ok(Array.isArray(r.tags) && r.tags.length >= 3, r.objectID);
    assert.ok(r.answer.split(/\s+/).length <= 70, `${r.objectID} answer is short`);
    assert.ok(!/%|\d+[.,]\d+\s*%/.test(r.answer), `${r.objectID} quotes no rate`);
    assert.ok(!r.objectID.startsWith("_"), "the marker is the seed script's, not the data's");
  }
  for (const r of FAQ.filter((x) => x.lang === "en")) {
    const fr = FAQ.find((x) => x.objectID === r.objectID.replace(/-en$/, "-fr"));
    assert.ok(fr, `${r.objectID} has a French twin`);
    assert.equal(fr.category, r.category);
  }
  assert.ok(FAQ.filter((r) => r.category === "security").length >= 8, "fraud plus 3 security entries, both languages");
});

test("the FAQ carries no identifier the demo would flag", async () => {
  const { pathToFileURL } = require("node:url");
  const { detect } = await import(pathToFileURL(path.join(ROOT, "public", "pii", "detect.js")).href);
  for (const r of FAQ) assert.deepEqual(detect(`${r.question} ${r.answer}`), [], r.objectID);
});

/* ───────────────────────────────────────────────────────────────
   The seeded conversations, checked against themselves.

   The infinite-conversation demo puts numbers on screen — how many turns came
   before you arrived, how many tokens they are — and the honesty rule for that
   page is that every figure is derived from the committed JSON. So this file
   recomputes the countable ones and fails if the manifest and the file disagree.

   What it deliberately does not do: recompute `tokens`. That number is either
   the trim endpoint's own count or a local estimate, and this test can only
   check the second kind. It checks that `tokensSource` says which, and when the
   source is a local estimate it verifies the arithmetic — so the assertion
   never implies more than it can see.
   ─────────────────────────────────────────────────────────────── */

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "..", "public", "assets", "convs");
const read = (name) => JSON.parse(fs.readFileSync(path.join(DIR, name), "utf8"));

const index = read("index.json");
const textOf = (m) => (m.parts || []).filter((p) => p.type === "text").map((p) => p.text).join("");

test("the manifest lists the scenarios the demo offers", () => {
  assert.ok(Array.isArray(index.scenarios), "index.json has no scenarios array");
  assert.ok(index.scenarios.length >= 3, "the demo promises three registers, so three files");
  const slugs = index.scenarios.map((s) => s.slug);
  assert.strictEqual(new Set(slugs).size, slugs.length, "two scenarios share a slug");
  for (const s of index.scenarios) {
    assert.ok(fs.existsSync(path.join(DIR, s.file)), `${s.file} is listed and missing`);
  }
});

for (const entry of index.scenarios) {
  const conv = read(entry.file);

  test(`${entry.slug}: the manifest and the file agree on every countable figure`, () => {
    for (const key of ["slug", "title", "register", "blurb", "messageCount", "exchanges",
      "chars", "tokens"]) {
      assert.deepStrictEqual(entry[key], conv[key], `${key} differs between index.json and ${entry.file}`);
    }
  });

  test(`${entry.slug}: the counts are the ones the messages actually carry`, () => {
    assert.strictEqual(conv.messages.length, conv.messageCount, "messageCount is not the array length");
    assert.strictEqual(conv.exchanges, conv.messageCount / 2, "exchanges is not half the messages");
    const chars = conv.messages.reduce((n, m) => n + textOf(m).length, 0);
    assert.strictEqual(chars, conv.chars, "chars is not the sum of the message texts");
  });

  test(`${entry.slug}: it is a conversation — alternating, and ending on an answer`, () => {
    // the demo generates its suggestion chips from the last assistant message,
    // so a seed that ends on a question has nothing to suggest from
    assert.strictEqual(conv.messages[0].role, "user", "a seeded thread opens with the person");
    assert.strictEqual(conv.messages[conv.messages.length - 1].role, "assistant",
      "a seeded thread has to end on an answer");
    conv.messages.forEach((m, i) => {
      assert.strictEqual(m.role, i % 2 ? "assistant" : "user", `message ${i} breaks the alternation`);
    });
  });

  test(`${entry.slug}: every message is a v5 text message with something in it`, () => {
    conv.messages.forEach((m, i) => {
      assert.ok(Array.isArray(m.parts) && m.parts.length, `message ${i} has no parts`);
      m.parts.forEach((p) => assert.strictEqual(p.type, "text", `message ${i} has a non-text part`));
      assert.ok(textOf(m).trim().length > 40, `message ${i} is too short to be a real turn`);
    });
  });

  test(`${entry.slug}: the token figure says where it came from`, () => {
    assert.ok(Number.isInteger(conv.tokens) && conv.tokens > 0, "tokens is not a positive integer");
    assert.strictEqual(typeof conv.tokensSource, "string");
    assert.ok(conv.tokensSource.length > 10, "tokensSource has to name its source");

    const local = conv.tokensSource.match(/estimated locally at (\d+(?:\.\d+)?) chars per token/);
    if (local) {
      // the one kind this test can verify: check the arithmetic exactly
      assert.strictEqual(conv.tokens, Math.round(conv.chars / Number(local[1])),
        "the local estimate does not match its own stated ratio");
    } else {
      assert.match(conv.tokensSource, /context\/trim/,
        "a token figure is either the trim endpoint's or a stated local estimate");
    }
  });

  test(`${entry.slug}: it records how it was produced`, () => {
    assert.strictEqual(conv.schema, 1);
    assert.ok(conv.generated && typeof conv.generated.method === "string",
      "generated.method is what the page shows the reader about this seed");
    assert.ok(/self-play|composed offline/.test(conv.generated.method),
      `unrecognised generation method: ${conv.generated.method}`);
    assert.ok(typeof conv.opener === "string" && conv.opener.length > 10);
    assert.ok(Array.isArray(conv.starters) && conv.starters.length >= 3,
      "the first click needs somewhere to go before any answer has been generated");
  });

  test(`${entry.slug}: it is long enough to be the point of the demo`, () => {
    // the working budget the demo defaults to is 8,000 tokens; a seed that fits
    // inside it would demonstrate nothing
    assert.ok(conv.tokens > 8000 * 4,
      `${conv.tokens} tokens is not far enough past the demo's working budget`);
  });
}

test("the three scenarios are three different registers", () => {
  const registers = index.scenarios.map((s) => s.register);
  assert.strictEqual(new Set(registers).size, registers.length,
    "two scenarios share a register, so one of them is not earning its place");
});

/* shared/mic.js: the pure part (what counts as heard, what counts as final) and
   the promise that a browser without SpeechRecognition gets no button at all. */

"use strict";

const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

globalThis.window = globalThis;
require(path.join(__dirname, "..", "public", "shared", "mic.js"));

const heard = (text, isFinal) => Object.assign([{ transcript: text }], { isFinal });

test("transcript joins every result and is final only when all are", () => {
  assert.deepEqual(window.Mic.transcript([heard("red lip", false)]), { text: "red lip", final: false });
  assert.deepEqual(window.Mic.transcript([heard("red ", true), heard("lipstick", true)]), { text: "red lipstick", final: true });
  assert.deepEqual(window.Mic.transcript([heard("red ", true), heard("lip", false)]).final, false);
  assert.deepEqual(window.Mic.transcript([]), { text: "", final: false });
  assert.deepEqual(window.Mic.transcript(null), { text: "", final: false });
});

test("without SpeechRecognition, attach adds nothing", () => {
  assert.equal(window.Mic.supported, false);
  assert.equal(window.Mic.attach({ dataset: {} }), null);
});

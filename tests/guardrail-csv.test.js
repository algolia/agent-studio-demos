/* The CSV a reader brings is untrusted text, so the parser is held to the
   cases that break naive ones, and validation is held to reporting a bad row
   rather than guessing what it meant. */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
require("./load.js");

require(path.join(__dirname, "..", "public", "guardrail-battle", "csv.js"));
const C = globalThis.GuardrailCsv;

test("quoted fields keep their commas, quotes and line breaks", () => {
  const t = C.parse('\uFEFFmessage,expected\r\n"a, b ""c""\nd",allowed\r\nplain,blocked\n');
  assert.deepEqual(t, [["message", "expected"], ['a, b "c"\nd', "allowed"], ["plain", "blocked"]]);
});

test("blank lines are dropped and a missing final newline is fine", () => {
  assert.deepEqual(C.parse("a,b\n\n1,2"), [["a", "b"], ["1", "2"]]);
});

test("toCsv and parse round-trip", () => {
  const rows = [{ message: 'say "hi", then\nleave', expected: "blocked", category: "off_topic", note: "" }];
  const back = C.validate(C.parse(C.toCsv(rows, C.COLUMNS)));
  assert.deepEqual(back.errors, []);
  assert.deepEqual(back.cases, rows);
});

test("headers match without regard to case, extra columns are ignored", () => {
  const v = C.validate(C.parse("Note,MESSAGE,Expected,extra\nn1,hello,Allowed,x\n"));
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.cases, [{ message: "hello", expected: "allowed", category: "", note: "n1" }]);
});

test("a missing required column is named", () => {
  const v = C.validate(C.parse("text,expected\nhello,allowed\n"));
  assert.equal(v.cases.length, 0);
  assert.match(v.errors[0], /"message"/);
});

test("bad rows are reported by line and skipped, good rows kept", () => {
  const v = C.validate(C.parse("message,expected\nok,allowed\n,blocked\nhm,maybe\nfine,BLOCKED\n"));
  assert.equal(v.total, 4);
  assert.deepEqual(v.cases.map((c) => c.message), ["ok", "fine"]);
  assert.deepEqual(v.errors, ["Row 3: no message.", "Row 4: expected must be allowed or blocked."]);
});

test("an empty file says so", () => {
  assert.deepEqual(C.validate(C.parse("")).errors, ["The file is empty."]);
});

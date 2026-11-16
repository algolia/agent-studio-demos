/* pii: the structural-identifier detector and the filter modes.
   detect.js is an ES module the page imports; node:test reaches the same
   bytes through a dynamic import. */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const dir = path.join(__dirname, "..", "public", "pii");
const load = (f) => import(pathToFileURL(path.join(dir, f)).href);

const kinds = (findings) => findings.map((f) => `${f.entity}:${f.value}`);

test("each toolkit entity is found with its exact span", async () => {
  const d = await load("detect.js");
  const cases = [
    ["write to my.mail@example.com today", "EMAIL", "my.mail@example.com"],
    ["call me on +33 6 12 34 56 78 please", "PHONE", "+33 6 12 34 56 78"],
    ["card 4111 1111 1111 1111 was charged", "CREDIT_CARD", "4111 1111 1111 1111"],
    ["amex 378282246310005 here", "CREDIT_CARD", "378282246310005"],
    ["send it to DE89370400440532013000 now", "IBAN", "DE89370400440532013000"],
    ["login from 192.168.10.4 failed", "IP", "192.168.10.4"],
  ];
  for (const [text, entity, value] of cases) {
    const found = d.detect(text);
    assert.deepEqual(kinds(found), [`${entity}:${value}`], text);
    const f = found[0];
    assert.equal(text.slice(f.start, f.end), value);
  }
});

test("checksums reject look-alikes", async () => {
  const d = await load("detect.js");
  assert.deepEqual(d.detect("card 4111 1111 1111 1112 was charged"), [], "16 digits failing Luhn is not a card");
  assert.equal(d.luhn("4111111111111112"), false);
  assert.equal(d.validCreditCard("1111222233334444"), false, "passes Luhn, but no network issues a 1111 prefix");
  assert.deepEqual(d.detect("send it to DE89370400440532013001"), [], "mod-97 fails");
  assert.deepEqual(d.detect("send it to DE8937040044053201300"), [], "one char short for DE");
  assert.deepEqual(d.detect("version 300.168.10.4 shipped"), [], "an octet over 255 is not an IP");
  assert.deepEqual(d.detect("see arXiv 2506.12345 for the method"), [], "an arXiv id is not a phone");
  assert.deepEqual(d.detect("order 12345678 shipped"), [], "8 digits is too short for a phone");
  assert.equal(d.IBAN_COUNTRIES, 89);
});

test("a clean question passes through untouched in both modes", async () => {
  const d = await load("detect.js");
  const text = "What time do your branches open on Saturday?";
  for (const mode of ["redact", "block"]) {
    const r = d.filterMessage(text, mode);
    assert.deepEqual(r.findings, []);
    assert.equal(r.blocked, false);
    assert.equal(r.toModel, text);
    assert.equal(r.toLog, text);
  }
});

test("overlapping candidates resolve to one span: checksum beats phone, longer beats inner", async () => {
  const d = await load("detect.js");
  // 15 digits: both a valid phone count and a valid Amex; the checksum wins
  assert.deepEqual(kinds(d.detect("amex 3782 822463 10005")), ["CREDIT_CARD:3782 822463 10005"]);
  // the SSN extra beats the phone match on the very same span
  assert.deepEqual(kinds(d.detect("ssn 078-05-1120")), ["US_SSN:078-05-1120"]);
  // toolkit alone: the same span is a phone
  assert.deepEqual(kinds(d.detect("ssn 078-05-1120", { extras: false })), ["PHONE:078-05-1120"]);
  const kept = d.resolveOverlaps([
    { entity: "A", start: 0, end: 4, score: 1 },
    { entity: "B", start: 0, end: 10, score: 0.5 },
    { entity: "C", start: 5, end: 12, score: 1 },
    { entity: "D", start: 12, end: 14, score: 1 },
  ]);
  assert.deepEqual(kept.map((f) => f.entity), ["B", "D"]);
});

test("the SSN extra follows the never-issued rules", async () => {
  const d = await load("detect.js");
  assert.equal(d.validSsn("123-45-6789"), true);
  for (const bad of ["000-12-3456", "666-12-3456", "900-12-3456", "123-00-4567", "123-45-0000", "123456789"]) {
    assert.equal(d.validSsn(bad), false, bad);
  }
  // an invalid SSN is not called an SSN, though the toolkit still sees 9 digits
  assert.deepEqual(kinds(d.detect("ssn 666-12-3456")), ["PHONE:666-12-3456"]);
  assert.equal(d.detect("ssn 900-12-3456 x")[0].entity, "PHONE");
});

test("the account-number extra needs a nearby keyword", async () => {
  const d = await load("detect.js");
  assert.deepEqual(kinds(d.detect("my account number is 00123456")), ["ACCOUNT_NUMBER:00123456"]);
  assert.deepEqual(kinds(d.detect("acct # 4521-8830")), ["ACCOUNT_NUMBER:4521-8830"]);
  assert.deepEqual(d.detect("order 00123456 shipped"), [], "no keyword, no finding");
  assert.deepEqual(d.detect("account number for my sister, the old one, was 00123456"), [], "too many words between");
  assert.deepEqual(d.detect("my account number is 12345"), [], "under 6 digits");
});

test("the balance message: both extras, masked, and block refuses it", async () => {
  const d = await load("detect.js");
  const text = "Can you show me my account balance? My account number is 4521-8830-1127 and my social is 123-45-6789";
  const r = d.filterMessage(text, "redact");
  assert.deepEqual(kinds(r.findings), ["ACCOUNT_NUMBER:4521-8830-1127", "US_SSN:123-45-6789"]);
  assert.equal(r.toModel, "Can you show me my account balance? My account number is [ACCOUNT_NUMBER] and my social is [US_SSN]");
  assert.equal(r.toLog, r.toModel);
  const b = d.filterMessage(text, "block");
  assert.equal(b.blocked, true);
  assert.equal(b.toModel, null, "block sends nothing");
  assert.ok(!b.toLog.includes("4521") && !b.toLog.includes("6789"), "the log keeps masks only");
  const off = d.filterMessage(text, "off");
  assert.equal(off.toModel, text);
  // toolkit alone still catches both digit runs, as phones
  assert.deepEqual(d.detect(text, { extras: false }).map((f) => f.entity), ["PHONE", "PHONE"]);
});

test("redact is right-to-left safe and segments cover the text exactly", async () => {
  const d = await load("detect.js");
  const text = "mail a@b.co or c@d.org from 10.0.0.1";
  const f = d.detect(text);
  assert.equal(d.redact(text, f), "mail [EMAIL] or [EMAIL] from [IP]");
  const segs = d.segments(text, f);
  assert.equal(segs.map((s) => s.text).join(""), text);
  assert.deepEqual(segs.filter((s) => s.entity).map((s) => s.entity), ["EMAIL", "EMAIL", "IP"]);
  const masked = d.redact(text, f);
  assert.deepEqual(d.maskFindings(masked).map((m) => m.entity), ["EMAIL", "EMAIL", "IP"]);
  assert.deepEqual(d.detect(masked), [], "masks are not re-detected");
  assert.deepEqual(d.detect(null), []);
});

test("the mock agent echoes what it received: raw values on the left, masks on the right", async () => {
  const d = await load("detect.js");
  const { mockReply, BLOCK_REPLY } = await load("mock.js");
  const text = "Can you show me my account balance? My account number is 4521-8830-1127 and my social is 123-45-6789";
  const raw = mockReply(text);
  assert.equal(raw.intent, "balance");
  assert.ok(raw.text.includes("4521-8830-1127") && raw.text.includes("123-45-6789"));
  const masked = mockReply(d.filterMessage(text, "redact").toModel);
  assert.ok(masked.text.includes("[ACCOUNT_NUMBER]") && masked.text.includes("[US_SSN]"));
  assert.deepEqual(d.detect(masked.text), [], "nothing raw comes back from the filtered side");
  assert.equal(mockReply("What time do your branches open on Saturday?").intent, "hours");
  assert.equal(mockReply("Please send 250 EUR to DE89370400440532013000").intent, "transfer");
  assert.equal(mockReply("hello").intent, "fallback");
  assert.deepEqual(d.detect(BLOCK_REPLY), []);
  assert.deepEqual(mockReply(text), raw, "deterministic");
});

test("live mode: one completions call with the given text, key only in headers, stream read", async () => {
  const live = await load("live.js");
  const calls = [];
  const sse = [
    'data: {"type":"start"}',
    'data: {"type":"text-delta","id":"t","delta":"Hello "}',
    'data: {"type":"text-delta","id":"t","delta":"there."}',
    "data: [DONE]",
    "",
  ].join("\n");
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, text: async () => sse };
  };
  const creds = { region: "eu", appId: "APPID", apiKey: "k-test", agentId: "123e4567-e89b-42d3-a456-426614174000" };
  const r = await live.complete(fakeFetch, creds, "my account number is [ACCOUNT_NUMBER]");
  assert.deepEqual(r, { text: "Hello there.", error: null });
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, `https://agent-studio.eu.algolia.com/1/agents/${creds.agentId}/completions?${live.COMPLETION_QUERY}`);
  assert.ok(!url.includes("k-test"), "the key never goes in the URL");
  assert.equal(init.method, "POST");
  assert.equal(init.headers["X-Algolia-API-Key"], "k-test");
  assert.equal(init.credentials, "omit");
  assert.deepEqual(JSON.parse(init.body), { messages: [{ role: "user", parts: [{ type: "text", text: "my account number is [ACCOUNT_NUMBER]" }] }] });

  const denied = await live.complete(async () => ({ ok: false, status: 403, text: async () => "echo of the message" }), creds, "x");
  assert.deepEqual(denied, { text: "", error: "403: this key cannot do that" }, "a status sentence, never the body");
  const down = await live.complete(async () => { throw new TypeError("Failed to fetch"); }, creds, "x");
  assert.equal(down.error, "network or CORS");
  await assert.rejects(live.complete(fakeFetch, { ...creds, agentId: "../agents" }, "x"), /UUID/);
  await assert.rejects(live.complete(fakeFetch, { ...creds, region: "mars" }, "x"), /region/);
  assert.equal(calls.length, 1, "refused before fetch");
  assert.equal(live.readStream('data: {"type":"data-guardrail-violation","data":{}}\n').error, "blocked by the agent's guardrail");
});

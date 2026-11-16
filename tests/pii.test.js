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

const MOCK_CASES = [
  { text: "Can you show me my account balance? My account number is 4521-8830-1127 and my social is 123-45-6789",
    intent: "balance", lang: "en", kinds: "an account number and a social security number", step: "mobile app or online banking" },
  { text: "My card 4111 1111 1111 1111 was charged twice yesterday. Can you refund it?",
    intent: "dispute", lang: "en", kinds: "a card number", step: "Report a problem" },
  { text: "Please send 250 EUR to DE89370400440532013000 for the rent.",
    intent: "transfer", lang: "en", kinds: "an IBAN", step: "SEPA transfer" },
  { text: "Update my contact details: my.mail@example.com and +1 415-555-0132.",
    intent: "contact", lang: "en", kinds: "an email address and a phone number", step: "Open Profile" },
  { text: "Bonjour, quel est le solde de mon compte ? Mon numéro de sécu est 2 91 03 2A 004 123 68",
    intent: "balance", lang: "fr", kinds: "un numéro de sécurité sociale", step: "application mobile" },
  { text: "Ma carte 4111 1111 1111 1111 a été débitée deux fois hier, pouvez-vous me rembourser ?",
    intent: "dispute", lang: "fr", kinds: "un numéro de carte", step: "Signaler un problème" },
  { text: "Mi DNI es 39740125N, can you tell me how to transfer money?",
    intent: "transfer", lang: "en", kinds: "an ID number", step: "SEPA transfer" },
];

test("mock flows: raw is warned about and never repeated, masks are named in words, both answer the question", async () => {
  const d = await load("detect.js");
  const { mockReply } = await load("mock.js");
  for (const c of MOCK_CASES) {
    const raw = mockReply(c.text);
    assert.equal(raw.flow, "raw", c.text);
    assert.equal(raw.intent, c.intent, c.text);
    assert.equal(raw.lang, c.lang, c.text);
    for (const f of d.detect(c.text)) {
      for (const run of f.value.match(/\d{3,}/g) || []) assert.ok(!raw.text.includes(run), `raw reply never repeats ${run}`);
    }
    assert.match(raw.text, c.lang === "fr" ? /ne devrais jamais recevoir/ : /should never receive/);
    assert.ok(raw.text.includes(`(${c.kinds})`), raw.text);
    assert.ok(raw.text.includes(c.step), raw.text);

    const masked = mockReply(d.filterMessage(c.text, "redact").toModel);
    assert.equal(masked.flow, "masked");
    assert.equal(masked.intent, c.intent);
    assert.equal(masked.lang, c.lang);
    assert.ok(!/\[[A-Z_]+\]/.test(masked.text), `no mask echoed: ${masked.text}`);
    assert.deepEqual(d.detect(masked.text), [], "nothing raw comes back from the filtered side");
    assert.match(masked.text, c.lang === "fr" ? /ont été filtrées/ : /were filtered out/);
    assert.ok(masked.text.includes(`(${c.kinds})`), masked.text);
    assert.ok(masked.text.includes(c.step), masked.text);
    assert.notEqual(masked.text, raw.text);
    assert.deepEqual(mockReply(c.text), raw, "deterministic");
  }
});

test("mock: clean questions get the FAQ answer alone, in their language; block replies in kind", async () => {
  const d = await load("detect.js");
  const { mockReply, blockReply, langOf } = await load("mock.js");
  const clean = mockReply("What time do your branches open on Saturday?");
  assert.deepEqual([clean.intent, clean.flow, clean.lang], ["hours", "clean", "en"]);
  assert.ok(!/filtered|never receive/.test(clean.text));
  assert.equal(mockReply("Quels sont les horaires de votre agence le samedi ?").lang, "fr");
  assert.equal(mockReply("hello").intent, "fallback");
  assert.equal(langOf("[CREDIT_CARD] [IBAN] merci pour le virement"), "fr");
  const mixed = mockReply("Update my contact details: [EMAIL] and +1 415-555-0132.");
  assert.equal(mixed.flow, "raw", "a raw value the filter missed wins");
  assert.ok(mixed.text.includes("(an email address)") && mixed.text.includes("(a phone number)"));
  assert.match(blockReply("Ma carte est bloquée"), /Pour votre sécurité/);
  assert.match(blockReply("My card is blocked"), /For your security/);
  for (const t of [blockReply("x"), blockReply("ma carte")]) assert.deepEqual(d.detect(t), []);
});

test("mock FAQ answers are the opening of their bank_faq record, so mock and live read alike", async () => {
  const { INTENTS } = await load("mock.js");
  const faq = JSON.parse(require("node:fs").readFileSync(path.join(dir, "data", "bank_faq.json"), "utf8"));
  for (const i of INTENTS.filter((x) => x.faq)) {
    for (const lang of ["en", "fr"]) {
      const rec = faq.find((r) => r.objectID === `${i.faq}-${lang}`);
      assert.ok(rec, `${i.faq}-${lang}`);
      assert.ok(rec.answer.startsWith(i[lang]), `${i.id}/${lang} opens ${rec.objectID}`);
    }
  }
  assert.ok(!faq.some((r) => /balance|solde/i.test(r.objectID)), "balance has no FAQ entry, so its mock line has none");
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

test("every 'try it' sample is flagged with its own type and masks whole", async () => {
  const d = await load("detect.js");
  const { SAMPLES } = await load("samples.js");
  assert.deepEqual(Object.keys(SAMPLES), d.ENTITIES, "one sample row per type, in legend order");
  let n = 0;
  for (const [entity, values] of Object.entries(SAMPLES)) {
    assert.ok(values.length >= 3, `${entity} has at least 3 samples`);
    for (const v of values) {
      n++;
      const r = d.filterMessage(v, "redact");
      assert.deepEqual(r.findings.map((f) => f.entity), [entity], v);
      const keyed = ["ACCOUNT_NUMBER", ...d.GATED_ENTITIES].includes(entity);
      const expected = keyed ? v.replace(/\d[\d -]*\d$/, `[${entity}]`) : `[${entity}]`;
      assert.equal(r.toModel, expected, v);
    }
  }
  assert.equal(n, 40);
});

test("the config's pii block becomes the live agent; anything incomplete keeps the mock", async () => {
  const live = await load("live.js");
  const id = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
  const block = { region: "eu", host: live.HOSTS.eu, appId: "FAKEAPP01", agentStudioApiKey: "browser-key-not-real", agentId: id };
  assert.deepEqual(live.configAgent({ pii: block }), { region: "eu", appId: "FAKEAPP01", apiKey: "browser-key-not-real", agentId: id });
  assert.equal(live.configAgent({ pii: { ...block, region: undefined, host: `${live.HOSTS.us}/` } }).region, "us", "the host names the region");
  for (const cfg of [null, undefined, {}, { pii: null }, { pii: { ...block, agentId: "nope" } }, { pii: { ...block, agentStudioApiKey: "" } },
    { pii: { ...block, region: "ap", host: "https://example.com" } }]) {
    assert.equal(live.configAgent(cfg), null, JSON.stringify(cfg));
  }
});

test("the page loads config.js optionally and says where the live agent's filter runs", () => {
  const fs = require("node:fs");
  const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
  assert.match(html, /<script src="\.\.\/shared\/config\.js" onerror="window\.DEMO_CONFIG = window\.DEMO_CONFIG \|\| null"><\/script>/);
  assert.ok(html.indexOf("shared/config.js") < html.indexOf('src="app.js"'), "config before the page module");
  assert.match(html, /Algolia's managed LLM/);
  assert.match(html, /filter on the right still runs in this tab/);
  assert.match(html, /never an admin key/);
});

test("the header links to the pull request safely and the pull-request-only features say they are not live", () => {
  const fs = require("node:fs");
  const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
  const cta = html.match(/<a class="pr-cta"[^>]*>([\s\S]*?)<\/a>/);
  assert.ok(cta, "a pr-cta link exists");
  assert.match(cta[0], /href="https:\/\/github\.com\/algolia\/conversational-ai\/pull\/2059"/);
  assert.match(cta[0], /target="_blank"/);
  assert.match(cta[0], /rel="noopener noreferrer"/);
  assert.match(cta[1], /Comment on the PR/);
  assert.ok(html.indexOf('class="pr-cta"') < html.indexOf('id="compose"'), "the link sits above the demo");
  assert.match(html, /<dl class="ba"/);
  const inPr = html.match(/<section class="panel in-pr"[\s\S]*?<\/section>/);
  assert.ok(inPr, "the pull-request-only panel exists");
  assert.match(inPr[0], /not deployed yet/);
  assert.doesNotMatch(inPr[0], /blocked: IBAN/, "the old wording is gone");
  assert.match(inPr[0], /"type": "data-guardrail-violation"/);
  assert.match(inPr[0], /"category": "pii"/);
  assert.match(inPr[0], /sensitive personal data \(payment card number\)/);
  assert.match(inPr[0], /"entities": \["CREDIT_CARD"\]/);
  assert.match(inPr[0], /string values in that input\s+are redacted and the task runs/);
  assert.match(inPr[0], /"message": "Input blocked by guardrails"/);
  assert.match(inPr[0], /Schema errors never quote a value/);
});

/* A clean-room generator: our own inputs, each check computed from the public
   rule. The port's samples must be exactly what it makes. */
const DNI_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE";
const gen = {
  nir: (sex, yy, mm, dept, commune, order) => {
    const body = `${sex}${yy}${mm}${dept}${commune}${order}`;
    const n = Number(body.slice(0, 5) + body.slice(5, 7).replace("2A", "19").replace("2B", "18") + body.slice(7));
    return body + String(97 - (n % 97)).padStart(2, "0");
  },
  tax: (ten) => ten + String(Number(ten) % 511).padStart(3, "0"),
  luhn: (prefix) => {
    for (let c = 0; c < 10; c++) {
      const s = prefix + c;
      let t = 0;
      for (let i = 0; i < s.length; i++) {
        let x = Number(s[s.length - 1 - i]);
        if (i % 2) { x *= 2; if (x > 9) x -= 9; }
        t += x;
      }
      if (t % 10 === 0) return s;
    }
    return null;
  },
  dni: (n) => n + DNI_LETTERS[Number(n) % 23],
  nie: (l, n) => l + n + DNI_LETTERS[Number("XYZ".indexOf(l) + n) % 23],
};

test("French and Spanish samples are the generator's, and each validator holds the rule", async () => {
  const d = await load("detect.js");
  const { SAMPLES } = await load("samples.js");
  const siren = ["50832517", "40123456", "81234567"].map(gen.luhn);
  const made = {
    FR_NIR: [gen.nir(2, "91", "03", "2A", "004", "123"), gen.nir(1, "78", "11", "69", "123", "045"), gen.nir(2, "02", "06", "13", "055", "310")],
    FR_TAX_ID: ["1456789012", "0234567891", "2987654321"].map(gen.tax),
    FR_SIREN: siren,
    FR_SIRET: [gen.luhn(`${siren[0]}0001`), gen.luhn(`${siren[1]}0002`), gen.luhn(`${siren[2]}0013`)],
    ES_DNI: ["39740125", "87654321", "00451230"].map(gen.dni),
    ES_NIE: [gen.nie("X", "1234567"), gen.nie("Y", "7654321"), gen.nie("Z", "0451230")],
  };
  const compact = (v) => v.replace(/^(?:n° )?(?:siren|siret)(?: n°)?:? /i, "").replace(/[\s-]/g, "").toUpperCase();
  for (const e of d.PORT_ENTITIES) assert.deepEqual(SAMPLES[e].map(compact), made[e], e);

  // one digit off breaks every checksum
  const bump = (s, i) => s.slice(0, i) + ((Number(s[i]) + 1) % 10) + s.slice(i + 1);
  assert.equal(d.validNir(bump(made.FR_NIR[1], 14)), false);
  assert.equal(d.validNir("291032B00412368"), false, "2B counts as 18, so 2A's key fails");
  assert.equal(d.validNir(gen.nir(2, "91", "03", "2B", "004", "123")), true);
  assert.equal(d.validNir(gen.nir(5, "91", "03", "75", "004", "123")), false, "sex digit 5 is not issued");
  assert.equal(d.validFrTaxId(bump(made.FR_TAX_ID[0], 12)), false);
  assert.equal(d.validFrTaxId(gen.tax("5456789012")), false, "first digit 0 to 3");
  assert.equal(d.validSiren(bump(made.FR_SIREN[0], 3)), false);
  assert.equal(d.validSiret(bump(made.FR_SIRET[0], 13)), false);
  assert.equal(d.validSiret("35600000000047"), true, "La Poste: digit sum 25, divisible by 5, Luhn or not");
  assert.equal(d.validSiret("35600000000048"), false);
  assert.equal(d.validDni("39740125A"), false);
  assert.equal(d.validNie("W1234567L"), false);
});

test("SIREN and SIRET need their keyword; the ungated port fires bare, and extras off silences all", async () => {
  const d = await load("detect.js");
  const ents = (t, o) => d.detect(t, o).map((f) => f.entity);
  assert.deepEqual(ents("ref 508 325 172 please"), ["PHONE"], "a bare Luhn 9-digit number is not a SIREN");
  assert.deepEqual(ents("notre SIREN est le 508 325 172"), ["FR_SIREN"], "le, est: three words, no digit");
  assert.deepEqual(ents("SIREN de la société mère du groupe 508325172"), [], "too far from the keyword");
  assert.deepEqual(ents("siret 50832517200015"), ["FR_SIRET"]);
  assert.deepEqual(ents("siren 50832517200015"), [], "a SIRET after the SIREN keyword is neither");
  assert.deepEqual(ents("mon numéro de sécu est 2 91 03 2A 004 123 68"), ["FR_NIR"]);
  assert.deepEqual(ents("mi DNI es 39740125N y mi NIE X1234567L"), ["ES_DNI", "ES_NIE"]);
  assert.deepEqual(ents("2 91 03 2A 004 123 68 and 39740125N", { extras: false }), [], "the port rides on the extras switch");
});

test("the comparison strip counts what each side sent and stored, nothing invented", async () => {
  const d = await load("detect.js");
  const { compareSides } = await load("compare.js");
  const { mockReply } = await load("mock.js");
  const text = MOCK_CASES[0].text;
  const side = (mode) => {
    const f = d.filterMessage(text, mode);
    const reply = f.toModel == null ? "refused" : mockReply(f.toModel).text;
    return { sent: f.toModel, log: [f.toLog, reply] };
  };
  const rows = compareSides({ raw: side("off"), filtered: side("redact") });
  assert.deepEqual(rows.map((r) => r.slice(1)), [
    ["2 raw", "0 raw"],
    ["2 raw", "0 raw"],
    ["the numbers themselves, so it warns about them", "only that details were filtered"],
  ]);
  const blocked = compareSides({ raw: side("off"), filtered: side("block") });
  assert.equal(blocked[0][2], "0, nothing sent");
  assert.equal(blocked[2][2], "nothing, refused before the model");
  const echo = compareSides({ raw: { sent: text, log: [text, "Noted 123-45-6789"] }, filtered: side("redact") });
  assert.equal(echo[1][1], "3 raw", "an agent that echoes a number adds to the log count");
  const clean = compareSides({ raw: { sent: "hi", log: ["hi"] }, filtered: { sent: "hi", log: ["hi"] } });
  assert.deepEqual(clean.map((r) => r.slice(1)), [["0 raw", "0 raw"], ["0 raw", "0 raw"], ["a message with no identifier", "a message with no identifier"]]);
  const off = compareSides({ raw: side("off"), filtered: side("redact") }, { extras: false });
  assert.equal(off[0][1], "2 raw", "with extras off the toolkit still sees the two as phone numbers");
});

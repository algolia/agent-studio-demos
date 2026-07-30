#!/usr/bin/env node
/* ───────────────────────────────────────────────────────────────
   index-passages.js — push the passages to an Algolia index.

   Settings first, then records, because settings applied afterwards mean a
   reindex. Zero dependencies: the two REST calls this needs are three lines of
   `fetch` each, and adding a client library to a repo that has no package.json
   would cost more than it saves.

     node scripts/index-passages.js --lang fr           # dry run — calls nothing
     node scripts/index-passages.js --lang fr --push    # settings + records, for real
     node scripts/index-passages.js --lang fr --push --settings-only
     node scripts/index-passages.js --lang fr --push --records-only

   ── One knob, and it is the language ─────────────────────────────
   `--lang` (or ALGOLIA_INDEX_LANG) is REQUIRED, and it decides all three things
   at once: which index is written, which records go to it, and which settings it
   gets. There is no separate index-name argument, on purpose.

   This script used to default to `public_domain_books` when no name was given,
   which is exactly the shape of accident worth designing out: the application
   holding this index holds ~95 unrelated production indices, and a `--push`
   whose env var failed to reach the process wrote the default. A name and a
   record filter as two knobs can disagree with each other; one knob cannot. So:

     en → public_domain_books        (the original index, unsuffixed)
     xx → public_domain_books_xx

   and INDEX_RE re-checks the derived name before any call goes out. A language
   this script has no settings for is refused rather than guessed at.

   ── Why one index per language ───────────────────────────────────
   `indexLanguages` is a settings-global: it cannot vary per record, and CJK
   segmentation requires the CJK language be declared on the index itself. So
   Japanese and Chinese cannot share an index, and once the shelf is split for
   those two there is no reason to leave the rest mixed.

   scripts/index-settings-languages.json holds the per-language overlay on top of
   index-settings.json. Every language there names itself explicitly in
   `ignorePlurals` and `removeStopWords` rather than passing bare `true`: bare
   true resolves against `queryLanguages`, so on a mixed index it applies English
   plural rules to French and matches "chaise" against "chaises" where the
   English rule is the wrong one to apply. English keeps the bare `true` it was
   built with — with queryLanguages: ["en"] and only English on the index the two
   are the same value, and rewriting it would put a phantom diff in front of the
   next maintainer who reads this file against the live index.

   Typo tolerance is not in the overlay because it does not apply to logographic
   scripts at all: there is no edit distance over Han characters that means what
   it means over a Latin word. ja and zh get the same `text:40` snippet setting as
   everyone else — Algolia caps a snippet at 5,000 logograms, an order of
   magnitude above any passage here.

   ── The credential boundary ──────────────────────────────────────
   `ALGOLIA_APP_ID` and `ALGOLIA_WRITE_API_KEY` are read from the environment, or
   from a gitignored .env at the repo root (see .env.example) — not from a flag,
   never printed, and never logged. A write key is not demo furniture: it can
   delete an index, which is why it lives here and never in the browser config.
   The deployed site carries exactly one credential, a search-only key, built on
   the runner from the DEMO_CONFIG_JS repository variable.

   A dry run needs no credentials at all and is the DEFAULT, which is the
   deliberate resolution of an otherwise circular rule ("--dry-run must exit 0
   without credentials" versus "no credentials is an error"): the mode that sends
   nothing asks for nothing. If credentials happen to be present, a dry run uses
   them for one read-only GET so it can show a real diff against the index's
   current settings; without them it prints the whole payload instead and says so.
   Only `--push` requires credentials, and if they are missing it exits with a
   message naming both variables rather than a stack trace.

   ── Why these settings ───────────────────────────────────────────
   The payload lives in scripts/index-settings.json so it is reviewable as data.
   Every value there differs from an Algolia default on purpose:

     attributesForFaceting      EMPTY, on purpose, and it did not start that way.
                                The Algolia MCP server introspects this list and
                                generates one `facet_<attribute>` tool parameter
                                per faceted attribute. With ["book","author",
                                "chapter"] declared, the model reached for
                                `facet_book: "Moby-Dick; or, The Whale"` and every
                                call died with "'Moby-Dick; or, The Whale' is not
                                valid under any of the given schemas" — seven
                                times in one turn, after which the agent told the
                                reader it could not find the passage. Since
                                `book,author` is a searchable attribute, the title
                                belongs in the query text, where it works. No
                                faceted attributes, no facet parameters, no
                                schema for the model to fail.
     unordered(text)            The default ranks matches near the start of an
                                attribute higher. On a 200-word prose passage
                                that is an arbitrary penalty on the second half
                                of the paragraph, so the position bias comes off.
     advancedSyntax: true       Quoted exact-phrase queries — "off with her
                                head" — are the whole point of a needle question.
     removeWordsIfNoResults     "lastWords". Algolia's own guidance for
                                LLM-generated natural-language queries: degrade a
                                verbose question instead of returning nothing.
     removeStopWords,           Both scoped by queryLanguages: ["en"]. The
     ignorePlurals              documented recommendation for full-sentence
                                queries; unscoped they invite cross-language
                                false matches.
     attributesToSnippet        "text:40". The default snippet is ten words,
                                which is too short to read as a citation.
     minProximity: 2            Two relevant terms in prose legitimately sit a
                                few words apart. This one is reasoned rather than
                                documented, and is worth revisiting with data.
     customRanking              asc(position) — within one book, earlier passages
                                first, so ties break in reading order.
     ranking                    Left at the default order. Reordering the ranking
                                formula speculatively is how relevance regresses.

   ── distinct: settings versus query ──────────────────────────────
   `attributeForDistinct` is settings-only; `distinct` can be overridden per
   query. So the index fixes the attribute to `book` and leaves `distinct: false`
   as the default, and the caller decides per query: pass `distinct: 1` to sweep
   the whole shelf and get one passage per book, pass nothing to dig inside one
   book and get several passages from it. Same index, two behaviours, no second
   copy of the data.
   ─────────────────────────────────────────────────────────────── */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { loadEnv, describeEnv } = require("./env.js");

const ROOT = path.join(__dirname, "..");
const PASSAGES = path.join(ROOT, "passages.jsonl");
const SETTINGS = path.join(__dirname, "index-settings.json");
const LANG_SETTINGS = path.join(__dirname, "index-settings-languages.json");

/** Algolia's guidance is 1,000–10,000 records per batch, or ~10MB, whichever first */
const BATCH_RECORDS = 1000;
const BATCH_BYTES = 10 * 1024 * 1024;

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const PUSH = has("--push");
const SETTINGS_ONLY = has("--settings-only");
const RECORDS_ONLY = has("--records-only");

/* ── The one knob ──────────────────────────────────────────────────
   Language in, index name out. Nothing else in this file decides where a record
   goes, so the filter and the destination cannot come apart. ── */

/** the only names this script is ever allowed to write */
const INDEX_RE = /^public_domain_books(_[a-z]{2})?$/;

const flagValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
};

const LANGS = JSON.parse(fs.readFileSync(LANG_SETTINGS, "utf8"));
const LANG = flagValue("--lang") || process.env.ALGOLIA_INDEX_LANG || null;

function requireLang() {
  const known = Object.keys(LANGS).join(", ");
  if (!LANG) {
    console.error(
      "Which language? This script needs one, and it is the only argument that\n" +
      "decides anything:\n" +
      "\n" +
      "  node scripts/index-passages.js --lang fr [--push]\n" +
      "  ALGOLIA_INDEX_LANG=fr node scripts/index-passages.js [--push]\n" +
      "\n" +
      `Known: ${known}\n` +
      "\n" +
      "There is no default. The application behind these credentials holds ~95\n" +
      "unrelated production indices, and a default destination is the one bug in\n" +
      "this script that could not be undone.");
    process.exit(2);
  }
  if (!LANGS[LANG]) {
    console.error(`No settings for language "${LANG}". Known: ${known}\n\n` +
      `Add it to ${path.relative(ROOT, LANG_SETTINGS)} first — an index built with ` +
      "another language's\nanalysis is worse than no index.");
    process.exit(2);
  }
  return LANG;
}

/** en keeps the original unsuffixed name; every other language is suffixed */
const indexNameFor = (lang) =>
  lang === "en" ? "public_domain_books" : `public_domain_books_${lang}`;

/**
 * The guard is deliberately downstream of the derivation rather than instead of
 * it: `indexNameFor` is the rule, this is the assertion that the rule held. A
 * name that fails here is a bug in this file, not bad input.
 */
function checkIndexName(name) {
  if (INDEX_RE.test(name)) return name;
  throw new Error(`refusing to touch "${name}" — this script only ever writes ` +
    `indices matching ${INDEX_RE}`);
}

/** base settings with the language overlay on top */
function settingsFor(lang) {
  return Object.assign(JSON.parse(fs.readFileSync(SETTINGS, "utf8")), LANGS[lang]);
}

/* Resolved once, at load, so there is exactly one destination in this process and
   every message below can name it. Missing or unknown language exits here. */
const INDEX_LANG = requireLang();
const INDEX_NAME = checkIndexName(indexNameFor(INDEX_LANG));

/* ── Credentials ───────────────────────────────────────────────────
   Read once, held in one place, never rendered. `credentials()` returns null
   rather than throwing, so a dry run can carry on without them. ── */

function credentials() {
  const note = describeEnv(loadEnv());
  if (note) console.log(note + "\n");
  const appId = process.env.ALGOLIA_APP_ID;
  const apiKey = process.env.ALGOLIA_WRITE_API_KEY;
  if (!appId || !apiKey) return null;
  return { appId, apiKey };
}

function requireCredentials() {
  const creds = credentials();
  if (creds) return creds;
  console.error(
    "Missing credentials. --push needs both of these in the environment:\n" +
    "\n" +
    "  ALGOLIA_APP_ID          the application id of the app to write to\n" +
    "  ALGOLIA_WRITE_API_KEY   a key with addObject and editSettings on that app\n" +
    "\n" +
    "Export them, or copy .env.example to .env and fill it in (.env is gitignored).\n" +
    "Neither value is ever printed. Use a key scoped to\n" +
    "this one index; a search-only key will not do, and an admin key is more than\n" +
    "this script needs.\n" +
    "\n" +
    "Run without --push for a dry run, which needs no credentials at all.");
  process.exit(2);
}

/**
 * One REST call. The key goes in a header and the header object is never returned
 * or logged, so there is no path by which it reaches stdout.
 */
async function call(creds, method, urlPath, body) {
  const url = `https://${creds.appId}.algolia.net${urlPath}`;
  const res = await fetch(url, {
    method,
    headers: {
      "content-type": "application/json",
      "x-algolia-application-id": creds.appId,
      "x-algolia-api-key": creds.apiKey,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* keep the raw body */ }
  if (!res.ok) {
    const detail = (json && (json.message || json.error)) || text.slice(0, 300);
    throw new Error(`${method} ${urlPath} → ${res.status} ${res.statusText}: ${detail}`);
  }
  return json;
}

/* ── Input ─────────────────────────────────────────────────────── */

function loadSettings() {
  return settingsFor(INDEX_LANG);
}

/**
 * Only this language's records. passages.jsonl carries the whole shelf in every
 * language it has, and `lang` on the record is what decides — not the order of
 * the file, and not the book's slug.
 */
function loadPassages() {
  if (!fs.existsSync(PASSAGES)) {
    console.error(`No ${path.relative(ROOT, PASSAGES)}. Build it first:\n\n` +
      "  node scripts/build-passages.js\n");
    process.exit(2);
  }
  const records = [];
  let skipped = 0;
  for (const line of fs.readFileSync(PASSAGES, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    if (record.lang === INDEX_LANG) records.push(record);
    else skipped += 1;
  }
  if (!records.length) {
    console.error(`No records with lang: "${INDEX_LANG}" in ` +
      `${path.relative(ROOT, PASSAGES)} (${skipped} in other languages).\n\n` +
      "Rebuild it — an empty push would leave the index carrying whatever was\n" +
      "there before, which is the one outcome worse than failing:\n\n" +
      "  node scripts/build-passages.js\n");
    process.exit(2);
  }
  console.log(`${records.length} of ${records.length + skipped} passages carry ` +
    `lang: "${INDEX_LANG}" — the rest belong to other indices\n`);
  return records;
}

/**
 * Records grouped into requests. Settings are applied before any of these, so a
 * batch never lands in an index that would have to be rebuilt afterwards.
 */
function batches(records) {
  const out = [];
  let cur = [];
  let bytes = 0;
  for (const record of records) {
    const size = Buffer.byteLength(JSON.stringify(record), "utf8") + 40; // + envelope
    if (cur.length && (cur.length >= BATCH_RECORDS || bytes + size > BATCH_BYTES)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(record);
    bytes += size;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** `updateObject` is the documented upsert: the objectID in the body is the key */
const asRequests = (chunk) => chunk.map((body) => ({ action: "updateObject", body }));

/* ── Reporting ─────────────────────────────────────────────────── */

const num = (n) => n.toLocaleString("en-US");
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)}MB`;

/**
 * Equal for the purposes of a settings diff. The extra clause is not cosmetic: an
 * empty list sent to Algolia comes back as null, so `attributesForFaceting: []`
 * reported itself as a pending change on every index forever — including the
 * English one, which has carried the value since it was built. A diff that always
 * shows one change teaches a reader to skip the diff.
 */
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b) ||
  (isEmptyList(a) && isEmptyList(b));

const isEmptyList = (v) => v === null || (Array.isArray(v) && v.length === 0);

/**
 * What would change. With the current settings in hand this is a real diff; with
 * nothing to compare against it is the payload, which is the honest version of
 * "diff" when there is no left-hand side.
 */
function printSettingsPlan(settings, current, reason) {
  console.log(`PUT /1/indexes/${INDEX_NAME}/settings`);
  if (!current) {
    console.log(`  no current settings to diff against (${reason || "none were read"}), ` +
      "so this is the whole payload:");
    for (const [k, v] of Object.entries(settings)) {
      console.log(`    ${k}: ${JSON.stringify(v)}`);
    }
    return;
  }
  const changes = Object.entries(settings).filter(([k, v]) => !same(current[k], v));
  if (!changes.length) {
    console.log("  no change — the index already carries every one of these values");
    return;
  }
  console.log(`  ${changes.length} of ${Object.keys(settings).length} settings would change:`);
  for (const [k, v] of changes) {
    console.log(`    ${k}: ${JSON.stringify(current[k] === undefined ? null : current[k])}` +
      `  →  ${JSON.stringify(v)}`);
  }
}

function printRecordsPlan(records, chunks) {
  const totalBytes = records.reduce(
    (n, r) => n + Buffer.byteLength(JSON.stringify(r), "utf8"), 0);
  const books = new Set(records.map((r) => r.book));
  console.log(`\nPOST /1/indexes/${INDEX_NAME}/batch  ×${chunks.length}`);
  console.log(`  ${num(records.length)} records from ${books.size} books · ${mb(totalBytes)} total`);
  console.log(`  ${chunks.length} batch${chunks.length === 1 ? "" : "es"} of at most ` +
    `${num(BATCH_RECORDS)} records or ${mb(BATCH_BYTES)}, action: updateObject`);
  console.log(`  batch sizes: ${chunks.slice(0, 3).map((c) => num(c.length)).join(", ")}` +
    `${chunks.length > 3 ? `, … , ${num(chunks[chunks.length - 1].length)}` : ""}`);
  console.log("\n  first record, exactly as it would be sent:");
  const first = { ...records[0] };
  if (first.text.length > 300) first.text = `${first.text.slice(0, 300)}…`;
  for (const line of JSON.stringify({ action: "updateObject", body: first }, null, 2).split("\n")) {
    console.log(`    ${line}`);
  }
}

/* ── Main ──────────────────────────────────────────────────────── */

async function main() {
  const settings = loadSettings();
  const records = RECORDS_ONLY || !SETTINGS_ONLY ? loadPassages() : [];
  const chunks = batches(records);

  if (!PUSH) {
    const creds = credentials();
    console.log(`Dry run — nothing is sent. Language: ${INDEX_LANG} · index: ${INDEX_NAME}\n`);
    let current = null;
    let reason = "no credentials in the environment, and reading them is the only way to diff";
    if (creds) {
      console.log("credentials found in the environment; reading the index's current settings\n");
      try {
        current = await call(creds, "GET", `/1/indexes/${INDEX_NAME}/settings`);
      } catch (e) {
        // A 404 here is the ordinary first-run case — the index does not exist yet —
        // and saying so beats blaming the credentials that were plainly just used.
        const head = e.message.split(":")[0];
        reason = /404/.test(head) ? `the index does not exist yet — ${head}` : head;
        console.log(`  could not read current settings (${head}), showing the payload instead\n`);
      }
    }
    if (!RECORDS_ONLY) printSettingsPlan(settings, current, reason);
    if (!SETTINGS_ONLY) printRecordsPlan(records, chunks);
    console.log("\nNothing was written. Re-run with --push, and with ALGOLIA_APP_ID and " +
      "ALGOLIA_WRITE_API_KEY set, to apply this.");
    return;
  }

  const creds = requireCredentials();

  if (!RECORDS_ONLY) {
    console.log(`Applying settings to ${INDEX_NAME}…`);
    const out = await call(creds, "PUT", `/1/indexes/${INDEX_NAME}/settings`, settings);
    console.log(`  taskID ${out.taskID}`);
  }

  if (!SETTINGS_ONLY) {
    console.log(`Sending ${num(records.length)} records in ${chunks.length} batches…`);
    let done = 0;
    for (let i = 0; i < chunks.length; i++) {
      const out = await call(creds, "POST", `/1/indexes/${INDEX_NAME}/batch`,
        { requests: asRequests(chunks[i]) });
      done += chunks[i].length;
      console.log(`  batch ${i + 1}/${chunks.length} · ${num(done)}/${num(records.length)} ` +
        `records · taskID ${out.taskID}`);
    }
    console.log("Indexing tasks are queued, not finished — Algolia applies them " +
      "asynchronously. Watch the task ids above if you need to wait for one.");
  }
}

main().catch((e) => {
  // the message, never the request: a thrown fetch error must not carry a header
  console.error(e.message);
  process.exitCode = 1;
});

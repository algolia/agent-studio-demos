#!/usr/bin/env node
/* ───────────────────────────────────────────────────────────────
   index-passages.js — push the passages to an Algolia index.

   Settings first, then records, because settings applied afterwards mean a
   reindex. Zero dependencies: the two REST calls this needs are three lines of
   `fetch` each, and adding a client library to a repo that has no package.json
   would cost more than it saves.

     node scripts/index-passages.js                  # dry run — calls nothing
     node scripts/index-passages.js --push           # settings + records, for real
     node scripts/index-passages.js --push --settings-only
     node scripts/index-passages.js --push --records-only

   ── The credential boundary ──────────────────────────────────────
   `ALGOLIA_APP_ID` and `ALGOLIA_WRITE_API_KEY` are read from the environment and
   from nowhere else — not from a file, not from a flag, never printed, and never
   logged. A write key is not demo furniture: it can delete an index.

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

const ROOT = path.join(__dirname, "..");
const PASSAGES = path.join(ROOT, "passages.jsonl");
const SETTINGS = path.join(__dirname, "index-settings.json");

const INDEX_NAME = process.env.ALGOLIA_INDEX_NAME || "public_domain_books";

/** Algolia's guidance is 1,000–10,000 records per batch, or ~10MB, whichever first */
const BATCH_RECORDS = 1000;
const BATCH_BYTES = 10 * 1024 * 1024;

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const PUSH = has("--push");
const SETTINGS_ONLY = has("--settings-only");
const RECORDS_ONLY = has("--records-only");

/* ── Credentials ───────────────────────────────────────────────────
   Read once, held in one place, never rendered. `credentials()` returns null
   rather than throwing, so a dry run can carry on without them. ── */

function credentials() {
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
    "Neither is read from a file and neither is ever printed. Use a key scoped to\n" +
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
  return JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
}

function loadPassages() {
  if (!fs.existsSync(PASSAGES)) {
    console.error(`No ${path.relative(ROOT, PASSAGES)}. Build it first:\n\n` +
      "  node scripts/build-passages.js\n");
    process.exit(2);
  }
  const records = [];
  for (const line of fs.readFileSync(PASSAGES, "utf8").split("\n")) {
    if (line.trim()) records.push(JSON.parse(line));
  }
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

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * What would change. With the current settings in hand this is a real diff; with
 * nothing to compare against it is the payload, which is the honest version of
 * "diff" when there is no left-hand side.
 */
function printSettingsPlan(settings, current) {
  console.log(`PUT /1/indexes/${INDEX_NAME}/settings`);
  if (!current) {
    console.log("  no current settings read (that needs credentials), so this is the whole payload:");
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
    console.log(`Dry run — nothing is sent. Index: ${INDEX_NAME}\n`);
    let current = null;
    if (creds) {
      console.log("credentials found in the environment; reading the index's current settings\n");
      try {
        current = await call(creds, "GET", `/1/indexes/${INDEX_NAME}/settings`);
      } catch (e) {
        console.log(`  could not read current settings (${e.message.split(":")[0]}), ` +
          "showing the payload instead\n");
      }
    }
    if (!RECORDS_ONLY) printSettingsPlan(settings, current);
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

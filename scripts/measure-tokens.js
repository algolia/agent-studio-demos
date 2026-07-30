#!/usr/bin/env node
/* ───────────────────────────────────────────────────────────────
   measure-tokens.js — how many characters buy one token, per language.

   The English shelf carries one number, 3.0 chars per token, and it was measured
   rather than assumed: Alice is 144,600 characters and /context/trim answered
   48,116 tokens. That measurement does not travel. A tokenizer trained mostly on
   English text spends far more tokens per character on Cyrillic than on Latin,
   and a Han character is often a token by itself — so reusing 3.0 across seven
   languages would not blur a label, it would move a book into the wrong regime
   and mis-state the bill.

   So: one real sample per language, sent to the same endpoint the demo uses.

     node scripts/measure-tokens.js                 # every book on both shelves
     node scripts/measure-tokens.js --lang ja       # one language
     node scripts/measure-tokens.js --book faust
     node scripts/measure-tokens.js --sample 20000 --offset 0.5

   ── The method, so the numbers can be re-derived ─────────────────
   One sample per BOOK, not per language, because the ratio turns out to belong to
   the text at least as much as to the tongue it is in: Alice is 3.01 characters
   per token and Moby-Dick is 3.70, both English. Averaging those into one
   "English" number and printing it on a tile would be a figure measured from a
   book the reader is not looking at.

   Each sample is SAMPLE characters (default 50,000) taken from 20% of the way
   into the file. The offset is not decoration — the first pages of a Gutenberg
   text are a title page, a translator's note or, in the Japanese file, a
   paragraph of English from the digitizer, and none of those is the language
   being measured. Within one book the ratio is stable: measured at 20%, 50% and
   70% it moves by about a percent, so one slice is enough and where it starts
   barely matters.

   The slice is taken with String.slice, by CHARACTER. A byte offset would cut a
   multi-byte character in half and the endpoint would count the replacement
   character instead — a small error in Latin text and a systematic one in exactly
   the languages this script exists to measure.

   `messages` carries the sample as a single user turn, AI SDK v5 shaped, and
   /context/trim with no constraints is a pure token probe: no LLM behind it, no
   summary, nothing charged. The number read back is stats.tokensBeforeEstimate.

   The method is checked against the one figure already committed: Alice whole,
   `--book alice-in-wonderland --offset 0 --sample 200000`, answers 48,099 tokens
   for 144,600 characters — 3.006, which is where books.js got its 3.

   ── Credentials ──────────────────────────────────────────────────
   ALGOLIA_APP_ID and ALGOLIA_WRITE_API_KEY from the environment or .env, exactly
   as the other scripts here. If the app id is present but that key is refused,
   the gitignored public/shared/config.js is tried as a fallback — it holds the
   search-only key the deployed site already uses against this endpoint. Neither
   value is printed either way.
   ─────────────────────────────────────────────────────────────── */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { loadEnv, describeEnv } = require("./env.js");

const ROOT = path.join(__dirname, "..");
const TEXTS = path.join(ROOT, "public", "assets", "texts");
const CONFIG = path.join(ROOT, "public", "shared", "config.js");

const argv = process.argv.slice(2);
const flagValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
};

const ONLY = flagValue("--lang");
const BOOK = flagValue("--book");
const SAMPLE = Number(flagValue("--sample") || 50000);
/** far enough in to be past a title page, near enough that it is still the book */
const OFFSET_RATIO = flagValue("--offset") === null ? 0.2 : Number(flagValue("--offset"));

/** the shelf, read exactly as the browser reads it */
function loadShelf() {
  globalThis.window = globalThis;
  require(path.join(ROOT, "public", "shared", "books.js"));
  if (!globalThis.DEMO_BOOKS) throw new Error("books.js did not publish window.DEMO_BOOKS");
  const shelf = globalThis.DEMO_BOOKS;
  return [...(shelf.booksI18n || []), ...shelf.books]
    .map((b) => ({ slug: b.slug, lang: b.lang || "en", known: b.charsPerToken }));
}

/* ── The call ──────────────────────────────────────────────────── */

const HOST = process.env.AGENT_STUDIO_HOST || "https://agent-studio.eu.algolia.com";

/**
 * A browser user-agent header, because the edge in front of this host answers 403
 * to a bare client. Nothing about the request is browser-specific otherwise.
 */
const UA = "Mozilla/5.0 (agent-studio-demos scripts/measure-tokens.js)";

/** the search-only key the site already ships, read but never printed */
function configCredentials() {
  if (!fs.existsSync(CONFIG)) return null;
  globalThis.window = globalThis;
  require(CONFIG);
  const cfg = globalThis.DEMO_CONFIG;
  if (!cfg || !cfg.appId || !cfg.apiKey) return null;
  return { appId: cfg.appId, apiKey: cfg.apiKey, host: cfg.host || HOST, from: "config.js" };
}

function envCredentials() {
  const appId = process.env.ALGOLIA_APP_ID;
  const apiKey = process.env.ALGOLIA_WRITE_API_KEY;
  if (!appId || !apiKey) return null;
  return { appId, apiKey, host: HOST, from: ".env" };
}

async function tokensOf(creds, text) {
  const res = await fetch(`${creds.host}/1/unstable/context/trim`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": UA,
      "X-Algolia-Application-Id": creds.appId,
      "X-Algolia-API-Key": creds.apiKey,
    },
    body: JSON.stringify({
      messages: [{ role: "user", parts: [{ type: "text", text }] }],
    }),
  });
  const body = await res.text();
  if (!res.ok) {
    const err = new Error(`/1/unstable/context/trim → ${res.status} ${res.statusText}: ` +
      body.slice(0, 200));
    err.status = res.status;
    throw err;
  }
  const json = JSON.parse(body);
  const n = json && json.stats && json.stats.tokensBeforeEstimate;
  if (!Number.isFinite(n)) throw new Error("the response carries no stats.tokensBeforeEstimate");
  return n;
}

/* ── Sampling ──────────────────────────────────────────────────── */

/** SAMPLE characters from OFFSET_RATIO of the way in, cut on character boundaries */
function sampleOf(slug) {
  const text = fs.readFileSync(path.join(TEXTS, `${slug}.txt`), "utf8");
  const from = Math.floor(text.length * OFFSET_RATIO);
  return { sample: text.slice(from, from + SAMPLE), total: text.length, from };
}

/* ── Reporting ─────────────────────────────────────────────────── */

const num = (n) => n.toLocaleString("en-US");

function table(rows) {
  const head = ["lang", "book", "sample chars", "tokens", "chars/token", "manifest"];
  const body = rows.map((r) => [
    r.lang, r.slug, num(r.chars), num(r.tokens), r.ratio.toFixed(3),
    r.known === undefined ? "—"
      : Math.abs(r.known - r.ratio) < 0.05 ? "ok" : `says ${r.known}`,
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((row) => row[i].length)));
  const line = (c) => c.map((v, i) => (i < 2 ? v.padEnd(w[i]) : v.padStart(w[i]))).join("  ");
  console.log(line(head));
  console.log(w.map((n) => "─".repeat(n)).join("  "));
  for (const row of body) console.log(line(row));
}

/**
 * The spread within one language, which is the number that says how much a
 * per-language constant would have cost. Printed rather than hidden because it is
 * the argument for measuring per book.
 */
function spread(rows) {
  const byLang = new Map();
  for (const r of rows) {
    if (!byLang.has(r.lang)) byLang.set(r.lang, []);
    byLang.get(r.lang).push(r);
  }
  const many = [...byLang].filter(([, rs]) => rs.length > 1);
  if (!many.length) return;
  console.log("\nwithin one language, book to book:");
  for (const [lang, rs] of many) {
    const lo = Math.min(...rs.map((r) => r.ratio));
    const hi = Math.max(...rs.map((r) => r.ratio));
    console.log(`  ${lang}: ${lo.toFixed(2)}–${hi.toFixed(2)} across ` +
      `${rs.length} books · ${((hi / lo - 1) * 100).toFixed(0)}% apart`);
  }
}

/* ── Main ──────────────────────────────────────────────────────── */

async function main() {
  const note = describeEnv(loadEnv());
  if (note) console.log(`${note}\n`);

  let creds = envCredentials() || configCredentials();
  if (!creds) {
    console.error("No credentials. This needs ALGOLIA_APP_ID and ALGOLIA_WRITE_API_KEY\n" +
      "in the environment or .env, or a filled-in public/shared/config.js.");
    process.exit(2);
  }

  let shelf = loadShelf();
  if (ONLY) shelf = shelf.filter((b) => b.lang === ONLY);
  if (BOOK) shelf = shelf.filter((b) => b.slug === BOOK);
  if (!shelf.length) {
    console.error(`Nothing to measure for ${ONLY ? `lang "${ONLY}"` : ""}` +
      `${BOOK ? ` book "${BOOK}"` : ""} — check public/shared/books.js.`);
    process.exit(2);
  }

  console.log(`${SAMPLE.toLocaleString("en-US")}-character samples from ` +
    `${Math.round(OFFSET_RATIO * 100)}% into each file, via ` +
    `POST /1/unstable/context/trim (credentials from ${creds.from})\n`);

  const rows = [];
  for (const book of shelf) {
    const { sample } = sampleOf(book.slug);
    let tokens;
    try {
      tokens = await tokensOf(creds, sample);
    } catch (e) {
      // one retry on the other credential, then give up: a 403 here is usually the
      // key's ACLs rather than the endpoint, and saying which one was tried helps
      if (creds.from === ".env" && e.status === 403 && configCredentials()) {
        creds = configCredentials();
        console.log(`  the .env key was refused (403); retrying with ${creds.from}\n`);
        tokens = await tokensOf(creds, sample);
      } else {
        throw e;
      }
    }
    rows.push({
      lang: book.lang,
      slug: book.slug,
      known: book.known,
      chars: sample.length,
      tokens,
      ratio: sample.length / tokens,
    });
  }

  table(rows);
  spread(rows);
  console.log("\ncharsPerToken for public/shared/books.js:");
  for (const r of rows) console.log(`  ${r.slug}: ${r.ratio.toFixed(2)}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});

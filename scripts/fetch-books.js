#!/usr/bin/env node
/* ───────────────────────────────────────────────────────────────
   fetch-books.js — how the shelf stays reproducible.

   The texts under public/assets/texts/ are committed, because a demo that
   downloads a million characters on first paint is not a demo. But committed
   files rot: nobody can tell, a year later, whether a stray edit crept into
   Moby-Dick. So the transform that produced them is written down here, and it is
   deterministic:

     1. fetch https://www.gutenberg.org/cache/epub/<id>/pg<id>.txt
     2. normalize CRLF and lone CR to LF
     3. drop everything up to and including the "*** START OF TH… ***" line
     4. drop everything from the "*** END OF TH… ***" line onward
     5. trim leading and trailing whitespace, end with exactly one newline

   Nothing else. Title pages, chapter headings, the translators' own spelling and
   the hard wrap at ~72 columns are all left as Gutenberg serves them — a demo
   that quietly rewrites its source cannot be checked against it.

   ── Two sources, because one work is not on Gutenberg ────────────
   The multilingual shelf adds eight originals from Gutenberg and one that is not
   there as plain text at all: Достоевский's Белые ночи, which comes from
   ru.wikisource.org as a page of wikitext. A book's `source` field says which
   path it took, and the wikitext transform — twelve steps, every one of them a
   removal — lives in scripts/wikisource.js beside the licence reasoning that
   makes it necessary. Both paths end the same way: a UTF-8 .txt under
   public/assets/texts/, counted here, checked against the manifest.

   Run it and it is a no-op: a text already on disk is left alone, byte for byte.
   `--force` re-derives every file from the raw download, which is the check that
   matters — `git status` clean afterwards means the committed texts really are
   what this script produces.

   Raw downloads are cached OUTSIDE the repo (see CACHE below) so re-running
   costs nothing and no 11MB of unstripped source ever lands in the tree.

     node scripts/fetch-books.js              # fill in what is missing, count everything
     node scripts/fetch-books.js --force      # re-derive every text from the raw source
     node scripts/fetch-books.js --no-network # fail rather than download

   The table it prints is the source of truth for the `words` and `chars` fields
   in public/shared/books.js. When they disagree, this script says so and exits
   non-zero: the manifest is quoting a number that is not in the file.
   ─────────────────────────────────────────────────────────────── */

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ws = require("./wikisource.js");

const ROOT = path.join(__dirname, "..");
const TEXTS = path.join(ROOT, "public", "assets", "texts");

/**
 * Both hosts want to know who is calling, and Wikimedia's policy asks for a
 * descriptive one by name. A default Node user-agent also collects 403s from
 * edge filters that assume a bare client is not a person's tool.
 */
const UA = "agent-studio-demos/1.0 (public-domain shelf builder; " +
  "https://github.com/algolia/agent-studio-demos)";

/** Raw Gutenberg downloads, outside the repo. Override with GUTENBERG_CACHE. */
const CACHE = process.env.GUTENBERG_CACHE ||
  path.join(os.tmpdir(), "agent-studio-demos-gutenberg");

const argv = process.argv.slice(2);
const FORCE = argv.includes("--force");
const OFFLINE = argv.includes("--no-network");

/* ── The manifest, read as the browser reads it ──────────────────────
   books.js is a plain browser script that assigns window.DEMO_BOOKS. Pointing
   `window` at globalThis is the whole shim — the same trick tests/load.js uses,
   for the same reason: this script and the browser must agree about the shelf. */

function loadShelf() {
  globalThis.window = globalThis;
  require(path.join(ROOT, "public", "shared", "books.js"));
  if (!globalThis.DEMO_BOOKS) throw new Error("books.js did not publish window.DEMO_BOOKS");
  return globalThis.DEMO_BOOKS;
}

/**
 * Both shelves, in one list. `booksI18n` is a separate export because nothing
 * renders it yet, but a text is a text: it is fetched, counted and checked the
 * same way, and leaving it out of this loop would mean a file nobody verifies.
 */
const everyBook = (shelf) => [...shelf.books, ...(shelf.booksI18n || [])];

/** the shelf's own default, stated once: a book without a `source` is Gutenberg's */
const sourceOf = (book) => book.source || "gutenberg";

/* ── The transform ─────────────────────────────────────────────── */

const START_RE = /^\*\*\*\s*START OF TH.*\*\*\*\s*$/m;
const END_RE = /^\*\*\*\s*END OF TH.*\*\*\*\s*$/m;

/**
 * Gutenberg boilerplate off, nothing else touched. Both markers are required:
 * a file missing one is a file whose shape this script does not understand, and
 * guessing at the boundary would silently ship a licence header inside a book.
 */
function strip(raw, label) {
  const nl = raw.replace(/\r\n?/g, "\n");
  const start = nl.search(START_RE);
  if (start < 0) throw new Error(`${label}: no "*** START OF TH… ***" line`);
  const end = nl.search(END_RE);
  if (end < 0) throw new Error(`${label}: no "*** END OF TH… ***" line`);
  if (end <= start) throw new Error(`${label}: END marker precedes START`);
  const bodyStart = nl.indexOf("\n", start) + 1;
  return nl.slice(bodyStart, end).trim() + "\n";
}

/** the test's own counting rule, so the two can never disagree about a figure */
const countWords = (text) => text.split(/\s+/).filter(Boolean).length;

/* ── Fetching ──────────────────────────────────────────────────── */

const rawUrl = (book) => sourceOf(book) === "wikisource"
  ? ws.contentUrl(book.sourceHost, book.sourceTitle)
  : `https://www.gutenberg.org/cache/epub/${book.gutenbergId}/pg${book.gutenbergId}.txt`;

/** where a raw download is cached — one file per book, named by its source */
const cachePath = (book) => path.join(CACHE, sourceOf(book) === "wikisource"
  ? `ws-${book.slug}.json`
  : `pg${book.gutenbergId}.txt`);

async function rawText(book) {
  const cached = cachePath(book);
  if (fs.existsSync(cached)) return { text: fs.readFileSync(cached, "utf8"), from: "cache" };
  if (OFFLINE) throw new Error(`${book.slug}: not cached and --no-network was passed`);
  const url = rawUrl(book);
  const res = await fetch(url, { redirect: "follow", headers: { "user-agent": UA } });
  if (!res.ok) throw new Error(`${book.slug}: ${url} answered ${res.status} ${res.statusText}`);
  const text = await res.text();
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(cached, text);
  return { text, from: "downloaded" };
}

/**
 * Raw source in, the committed text out, whichever source it came from. Both
 * branches are pure functions of the bytes cached above, which is what makes
 * `--force` a real check rather than a re-download.
 */
function derive(raw, book) {
  if (sourceOf(book) !== "wikisource") return strip(raw, book.slug);
  return ws.toText(ws.pageContent(JSON.parse(raw), book.sourceTitle));
}

/* ── Reporting ─────────────────────────────────────────────────── */

const num = (n) => n.toLocaleString("en-US");

function table(rows) {
  const head = ["book", "lang", "source", "words", "chars", "manifest", "status"];
  const body = rows.map((r) => [
    r.slug,
    r.lang,
    r.gutenbergId === null ? r.source : `#${r.gutenbergId}`,
    num(r.words),
    num(r.chars),
    r.agrees ? "ok" : `words ${num(r.manifestWords)} · chars ${num(r.manifestChars)}`,
    r.status,
  ]);
  const widths = head.map((h, i) =>
    Math.max(h.length, ...body.map((row) => row[i].length)));
  const pads = [false, false, false, true, true, true, false];
  const line = (cells) => cells.map((c, i) =>
    (pads[i] ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join("  ");
  console.log(line(head));
  console.log(widths.map((w) => "─".repeat(w)).join("  "));
  for (const row of body) console.log(line(row));
}

/* ── Main ──────────────────────────────────────────────────────── */

async function main() {
  const shelf = loadShelf();
  fs.mkdirSync(TEXTS, { recursive: true });

  const rows = [];
  let wrote = 0;
  let changed = 0;

  for (const book of everyBook(shelf)) {
    const file = path.join(TEXTS, `${book.slug}.txt`);
    const had = fs.existsSync(file);
    let status;

    if (had && !FORCE) {
      status = "on disk";
    } else {
      const { text: raw, from } = await rawText(book);
      const derived = derive(raw, book);
      const before = had ? fs.readFileSync(file, "utf8") : null;
      if (before === derived) {
        status = `identical · ${from}`;
      } else {
        fs.writeFileSync(file, derived);
        status = `${had ? "rewritten" : "written"} · ${from}`;
        wrote += 1;
        if (had) changed += 1;
      }
    }

    const text = fs.readFileSync(file, "utf8");
    const words = countWords(text);
    rows.push({
      slug: book.slug,
      lang: book.lang || "en",
      source: sourceOf(book) === "wikisource" ? book.sourceHost : "gutenberg",
      gutenbergId: book.gutenbergId === undefined ? null : book.gutenbergId,
      words,
      chars: text.length,
      manifestWords: book.words,
      manifestChars: book.chars,
      agrees: book.words === words && book.chars === text.length,
      status,
    });
  }

  table(rows);

  const totalWords = rows.reduce((n, r) => n + r.words, 0);
  const totalChars = rows.reduce((n, r) => n + r.chars, 0);
  console.log(`\n${rows.length} books · ${num(totalWords)} words · ${num(totalChars)} characters`);
  console.log(`raw cache: ${CACHE}`);
  if (wrote) console.log(`${wrote} file${wrote === 1 ? "" : "s"} written` +
    (changed ? ` (${changed} already existed and differed — check the diff)` : ""));
  else console.log("nothing written — every text on disk is what this script produces");

  const off = rows.filter((r) => !r.agrees);
  if (off.length) {
    console.error(`\n${off.length} manifest entr${off.length === 1 ? "y" : "ies"} quote a count ` +
      `the file does not have. Update public/shared/books.js with the words/chars above:`);
    for (const r of off) {
      console.error(`  ${r.slug}: words ${num(r.words)}, chars ${num(r.chars)}`);
    }
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});

#!/usr/bin/env node
/* ───────────────────────────────────────────────────────────────
   build-passages.js — the shelf, cut into searchable passages.

   The demo's argument is that some questions have an answer sitting in one place
   and some do not. The first kind is what a search index is for, and this is the
   step that makes one possible: sixteen books in, one JSONL file out, one record
   per passage.

   Three rules shape a passage, and all three are about not lying to the reader
   of a search result:

     1. 150–300 words. Short enough that a hit is a citation rather than a
        chapter, long enough that it still reads as prose.
     2. Paragraph boundaries first. A passage that starts mid-paragraph reads as
        broken text, so paragraphs are packed whole until the next one would push
        the passage over.
     3. Never mid-sentence. A paragraph longer than the maximum is cut on
        sentence boundaries instead. Only when a single SENTENCE is longer than
        the maximum does a character-blind split happen — see LAST RESORT below,
        and Ulysses, which is where it happens.

   Chapter detection is per book and deliberately not clever. Sixteen Gutenberg
   editions use eleven different heading conventions, some of them ambiguous
   against their own prose, so each book gets a rule it can actually satisfy and
   anything that cannot be detected is recorded as `chapter: null` with a note
   printed in the summary. An invented structure is worse than an absent one: a
   facet nobody can trust is a facet that makes every result suspect.

     node scripts/build-passages.js            # writes passages.jsonl
     node scripts/build-passages.js --headings # print detected headings and stop

   passages.jsonl is gitignored: it is derived from committed inputs by committed
   code, and at ~11MB of text it belongs in a build step, not in a diff.
   ─────────────────────────────────────────────────────────────── */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const TEXTS = path.join(ROOT, "public", "assets", "texts");
const OUT = path.join(ROOT, "passages.jsonl");

/** the record-size ceiling this script asserts, well under Algolia's own limit */
const MAX_RECORD_BYTES = 10 * 1024;

const MIN_WORDS = 150;
const MAX_WORDS = 300;

/**
 * How much prose a heading has to own before it counts as a section rather than a
 * contents entry. A bare "has anything after it" test is not enough: three of
 * these editions interrupt their own contents list — Moby-Dick wraps its longest
 * chapter titles onto a second line, War and Peace prints "BOOK TWO: 1805"
 * between chapter groups, Ulysses prints "— II —" — and each interruption leaves
 * the entry before it looking like a real chapter. None of those fragments is
 * 200 characters long, and no real section is shorter. Aesop, whose shortest
 * fable is a few lines, overrides it.
 */
const MIN_SECTION_PROSE = 200;

const argv = process.argv.slice(2);
const HEADINGS_ONLY = argv.includes("--headings");

function loadShelf() {
  globalThis.window = globalThis;
  require(path.join(ROOT, "public", "shared", "books.js"));
  if (!globalThis.DEMO_BOOKS) throw new Error("books.js did not publish window.DEMO_BOOKS");
  return globalThis.DEMO_BOOKS;
}

/* ── Chapter detection ─────────────────────────────────────────────
   Each rule is a function over the file's lines returning
   `[{ line, title }]` in document order. `title` is the printed title when the
   heading carries one beyond its number, and null when it does not — Jane Eyre's
   chapters are numbered and nothing else, and inventing a title for them would
   be inventing structure.

   Every rule is deliberately lenient about leading whitespace, because the
   tables of contents in these editions are indented copies of the same lines.
   Stripping the contents is one shared step afterwards (see dropContents), not
   sixteen fragile anchors. ── */

const ROMAN = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };

function romanToInt(s) {
  let n = 0;
  const u = s.toUpperCase();
  for (let i = 0; i < u.length; i++) {
    const v = ROMAN[u[i]] || 0;
    const next = ROMAN[u[i + 1]] || 0;
    n += v < next ? -v : v;
  }
  return n;
}

/** the number a heading carries, arabic or roman, or null when it carries none */
function headingNumber(s) {
  const t = String(s || "").trim();
  if (/^\d+$/.test(t)) return Number(t);
  if (/^[IVXLCDM]+$/i.test(t)) return romanToInt(t);
  return null;
}

/** the next non-blank line after i, trimmed — how several editions carry titles */
function nextNonBlank(lines, i) {
  for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
    const t = lines[j].trim();
    if (t) return t;
  }
  return "";
}

/**
 * Is this short line a title, or is it the first line of the chapter's prose?
 * Titles in these editions are short, have no internal comma, and are not
 * sentences. Getting it wrong in the cautious direction costs a chapterTitle;
 * getting it wrong the other way puts a sentence of the book into a facet.
 */
function looksLikeTitle(s) {
  if (!s || s.length > 60) return false;
  if (/,\s/.test(s)) return false;
  if (/[,;:]$/.test(s)) return false;
  return /^[A-Z“"(_]/.test(s);
}

/** italics markers and a trailing full stop are typography, not part of the title */
const cleanTitle = (s) => s.replace(/^_+|_+$/g, "").replace(/\.$/, "").trim() || null;

/** heading = a line matching `re`; group 1 is the number, group 2 the title */
const byPattern = (re, { titleFromNextLine = false } = {}) => (lines) => {
  const found = [];
  lines.forEach((raw, i) => {
    // matched on the trimmed line: the tables of contents in these editions are
    // indented copies of the same headings, and dropContents removes those
    const m = re.exec(raw.trim());
    if (!m) return;
    let title = (m[2] || "").trim();
    if (!title && titleFromNextLine) {
      const nxt = nextNonBlank(lines, i);
      if (looksLikeTitle(nxt)) title = nxt;
    }
    found.push({ line: i, num: headingNumber(m[1]), title: title ? cleanTitle(title) : null });
  });
  return found;
};

/**
 * For the two collections whose sections are titles rather than numbers. A
 * heading here is an isolated short line: blank lines above and below, no
 * terminal punctuation, and not a line of prose that happens to be short. It is
 * a heuristic and it is allowed to be — the alternative for a book of three
 * hundred separately-titled fables is no structure at all.
 */
const isolatedTitles = ({ minBlankBefore = 3, minBlankAfter = 2, maxLen = 70 }) => (lines) => {
  /**
   * Blank lines between `i` and the nearest non-blank line in direction `dir`.
   * Running off either end of the file counts as an unbounded run — there really
   * is nothing there — and the loop stops rather than counting past the array,
   * which is the whole reason this is a for and not a while.
   */
  const blankRun = (i, dir) => {
    let n = 0;
    for (let j = i + dir; j >= 0 && j < lines.length; j += dir) {
      if (lines[j].trim() !== "") return n;
      n += 1;
    }
    return Infinity;
  };
  const runBefore = (i) => blankRun(i, -1);
  const runAfter = (i) => blankRun(i, +1);
  const found = [];
  lines.forEach((raw, i) => {
    const t = raw.trim();
    if (!t || t.length < 3 || t.length > maxLen) return;
    if (!/^[A-Z“"(]/.test(t)) return;
    if (/[.!?,;:]$/.test(t)) return;
    if (runBefore(i) < minBlankBefore || runAfter(i) < minBlankAfter) return;
    found.push({ line: i, num: null, title: t });
  });
  return found;
};

const CHAPTERS = {
  "the-yellow-wallpaper": {
    detect: () => [],
    note: "one unbroken diary — the source has no chapter divisions, so every " +
      "passage carries chapter: null rather than a number this script made up",
  },
  "narrative-of-frederick-douglass": {
    detect: byPattern(/^(?:CHAPTER\s+([IVXLC]+)|APPENDIX)$/),
    note: "numbered chapters plus the closing appendix; the prefatory letters are " +
      "not headed and fall under chapter: null",
  },
  "aesops-fables": {
    detect: isolatedTitles({ minBlankBefore: 3, minBlankAfter: 2 }),
    minProse: 60,
    note: "three hundred separately titled fables, detected as isolated title " +
      "lines — the front matter and the closing alphabetical index come through " +
      "as sections of their own",
  },
  "the-awakening": {
    detect: byPattern(/^([IVXLC]+|[A-Z][A-Z’'.\- ]{2,60})$/),
    note: "roman numerals for the novel's chapters, then the selected short " +
      "stories, whose all-capital titles are picked up as sections too",
  },
  "the-souls-of-black-folk": {
    detect: byPattern(/^([IVXLC]+)\.$/, { titleFromNextLine: true }),
    note: "numeral on one line, essay title on the next",
  },
  "anne-of-green-gables": {
    detect: byPattern(/^CHAPTER\s+([IVXLC]+)\.?\s+(.*)$/),
    note: "numbered chapters with titles on the same line",
  },
  "arabian-nights": {
    detect: isolatedTitles({ minBlankBefore: 2, minBlankAfter: 1, maxLen: 80 }),
    minProse: 60,
    note: "story titles, detected as isolated title lines. The nesting is NOT " +
      "captured: a tale told inside another tale reads here as a section of its " +
      "own, which is exactly the structure a flat index cannot represent",
  },
  "pride-and-prejudice": {
    detect: byPattern(/^(?:Chapter|CHAPTER)\s+([IVXLC]+)\.?\]?$/),
    note: "numbered chapters; the first is printed 'Chapter I.]' in this edition",
  },
  "dracula": {
    detect: byPattern(/^CHAPTER\s+([IVXLC]+)\.?\s*(.*)$/, { titleFromNextLine: true }),
    note: "numbered chapters; the body prints no title, so chapterTitle is taken " +
      "from the document label under each heading — whose diary or letter it is",
  },
  "jane-eyre": {
    detect: byPattern(/^CHAPTER\s+([IVXLC]+)(?:—(.*))?$/),
    note: "numbered chapters with no titles at all, so chapterTitle is null " +
      "throughout rather than a repeat of the number",
  },
  "ulysses": {
    detect: byPattern(/^\[\s*(\d+)\s*\]$/),
    note: "eighteen bracketed episodes, unnamed in this edition — the Homeric " +
      "titles are editorial and are not in the file, so they are not invented here",
  },
  "war-and-peace": {
    detect: byPattern(/^CHAPTER\s+([IVXLC]+)$/),
    note: "the printed chapter numbers restart with each of the fifteen books, so " +
      "`chapter` is the section's index in reading order rather than the number " +
      "on the page",
  },
  "alice-in-wonderland": {
    detect: byPattern(/^CHAPTER\s+([IVXLC]+)\.\s*(.*)$/, { titleFromNextLine: true }),
    note: "numbered chapters, title on the following line in the body",
  },
  "the-time-machine": {
    detect: byPattern(/^([IVXLC]+)\.$/, { titleFromNextLine: true }),
    note: "numeral on one line, section title on the next",
  },
  "frankenstein": {
    detect: byPattern(/^(?:Letter|Chapter)\s+(\d+)$/),
    note: "four letters and then numbered chapters, all detected the same way",
  },
  "moby-dick": {
    detect: byPattern(/^(?:CHAPTER\s+(\d+)\.\s*(.*)|Epilogue)$/),
    note: "numbered chapters with titles, plus the epilogue",
  },
};

/**
 * A table of contents is a stack of list items, and the thing that makes it one
 * is not indentation or distance — it is that there is no prose between one entry
 * and the next. So: a heading with nothing but blank lines and other headings
 * before the following heading is a list item, and goes.
 *
 * That rule alone leaves one straggler, and Moby-Dick is where it shows. Its
 * contents ends with "Epilogue", and five hundred lines of ETYMOLOGY and EXTRACTS
 * sit between that entry and chapter 1 — prose, so the entry survives as a
 * section labelled "Epilogue" at the front of the book. The second rule catches
 * it by reading the numbers: a leading heading that cannot possibly precede the
 * heading after it (an unnumbered epilogue before chapter 1, or chapter 9 before
 * chapter 2) is a leftover from the list.
 */
function dropContents(found, lines, minProse) {
  if (found.length < 2) return found;
  const headingLine = new Set(found.map((f) => f.line));
  const proseBetween = (a, b) => {
    let n = 0;
    for (let j = a + 1; j < b; j++) {
      const t = lines[j].trim();
      if (t && !headingLine.has(j)) n += t.length;
      if (n >= minProse) return true;
    }
    return false;
  };

  // the last heading owns the tail of the file, so it is never a list item
  const kept = found.filter((f, i) =>
    i === found.length - 1 || proseBetween(f.line, found[i + 1].line));

  while (kept.length >= 2) {
    const a = kept[0].num;
    const b = kept[1].num;
    const cannotPrecede = (a === null && b !== null) || (a !== null && b !== null && a > b);
    if (!cannotPrecede) break;
    kept.shift();
  }
  return kept.length ? kept : found.slice(-1);
}

/* ── Splitting ─────────────────────────────────────────────────── */

const words = (s) => s.split(/\s+/).filter(Boolean);
const wordCount = (s) => words(s).length;

/** sentence ends: terminal punctuation, optional closing quote, then whitespace */
const SENTENCE_END = /(?<=[.!?…][)"'’”]?)\s+/;

/**
 * LAST RESORT. Ulysses' final episode is two sentences of about twenty thousand
 * words each, with no full stop between them: there is no sentence boundary to
 * cut on, so this cuts on a word boundary instead and that is the honest thing to
 * report. It is the only place in the shelf where a passage can begin mid-clause,
 * and the summary counts how often it happened.
 */
let lastResortCuts = 0;

function splitLongParagraph(para) {
  const out = [];
  let cur = [];
  let n = 0;
  for (const sentence of para.split(SENTENCE_END)) {
    const c = wordCount(sentence);
    if (c > MAX_WORDS) {
      if (cur.length) { out.push(cur.join(" ")); cur = []; n = 0; }
      const w = words(sentence);
      for (let i = 0; i < w.length; i += MAX_WORDS) {
        out.push(w.slice(i, i + MAX_WORDS).join(" "));
        lastResortCuts += 1;
      }
      continue;
    }
    if (n + c > MAX_WORDS && cur.length) { out.push(cur.join(" ")); cur = []; n = 0; }
    cur.push(sentence);
    n += c;
  }
  if (cur.length) out.push(cur.join(" "));
  return out;
}

/**
 * Paragraphs packed into 150–300-word passages. A paragraph is never broken
 * unless it is longer than a whole passage on its own. A section's tail is
 * allowed to be short — a forty-word closing paragraph is a fair search result —
 * but not this short: Aesop prints each moral in its own paragraph, so a long
 * fable was leaving "Look before you leap." stranded as a record of its own.
 * Anything under this many words is merged back into the passage it belongs to,
 * at the cost of letting that one run over the maximum, which is the lesser wrong.
 */
const TAIL_MIN_WORDS = 40;

function passagesOf(text) {
  const units = [];
  for (const para of text.split(/\n{2,}/)) {
    const p = para.trim();
    if (!p) continue;
    if (wordCount(p) > MAX_WORDS) units.push(...splitLongParagraph(p));
    else units.push(p);
  }

  const out = [];
  let cur = [];
  let n = 0;
  for (const unit of units) {
    const c = wordCount(unit);
    if (n && n + c > MAX_WORDS) { out.push(cur.join("\n\n")); cur = []; n = 0; }
    cur.push(unit);
    n += c;
    if (n >= MIN_WORDS) { out.push(cur.join("\n\n")); cur = []; n = 0; }
  }
  if (cur.length) out.push(cur.join("\n\n"));

  if (out.length > 1 && wordCount(out[out.length - 1]) < TAIL_MIN_WORDS) {
    const tail = out.pop();
    out[out.length - 1] += `\n\n${tail}`;
  }
  return out;
}

/* ── Records ───────────────────────────────────────────────────── */

const pad = (n, w) => String(n).padStart(w, "0");

function buildBook(book) {
  const file = path.join(TEXTS, `${book.slug}.txt`);
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split("\n");

  // character offset of every line, so the contents-stripper can measure gaps
  const offsets = [];
  let at = 0;
  for (const line of lines) { offsets.push(at); at += line.length + 1; }

  const rule = CHAPTERS[book.slug];
  if (!rule) throw new Error(`${book.slug}: no chapter rule — add one to CHAPTERS`);
  const headings = dropContents(rule.detect(lines), lines, rule.minProse ?? MIN_SECTION_PROSE);

  /** [{ chapter, chapterTitle, text }] — the front matter is chapter null */
  const sections = [];
  if (!headings.length) {
    sections.push({ chapter: null, chapterTitle: null, text });
  } else {
    const first = offsets[headings[0].line];
    if (first > 0) sections.push({ chapter: null, chapterTitle: null, text: text.slice(0, first) });
    headings.forEach((h, i) => {
      const from = offsets[h.line] + lines[h.line].length + 1;
      const to = i + 1 < headings.length ? offsets[headings[i + 1].line] : text.length;
      sections.push({ chapter: i + 1, chapterTitle: h.title, text: text.slice(from, to) });
    });
  }

  const records = [];
  let position = 0;
  let oversize = 0;
  let maxBytes = 0;
  for (const section of sections) {
    for (const passage of passagesOf(section.text)) {
      position += 1;
      const record = {
        objectID: `${book.slug}_ch-${section.chapter === null ? "none" : pad(section.chapter, 3)}_p-${pad(position, 4)}`,
        book: book.title,
        author: book.author,
        gutenbergId: book.gutenbergId,
        chapter: section.chapter,
        chapterTitle: section.chapterTitle,
        position,
        text: passage,
        wordCount: wordCount(passage),
      };
      const bytes = Buffer.byteLength(JSON.stringify(record), "utf8");
      maxBytes = Math.max(maxBytes, bytes);
      if (bytes > MAX_RECORD_BYTES) oversize += 1;
      records.push(record);
    }
  }

  const totalWords = records.reduce((n, r) => n + r.wordCount, 0);
  return {
    book,
    records,
    chapters: headings.length,
    unchaptered: records.filter((r) => r.chapter === null).length,
    meanWords: records.length ? totalWords / records.length : 0,
    maxBytes,
    oversize,
    note: rule.note,
    firstHeadings: headings.slice(0, 3),
    lastHeadings: headings.slice(-2),
  };
}

/* ── Reporting ─────────────────────────────────────────────────── */

const num = (n) => n.toLocaleString("en-US");

function table(rows) {
  const head = ["book", "records", "chapters", "no chapter", "mean words", "max bytes"];
  const body = rows.map((r) => [
    r.book.slug, num(r.records.length), num(r.chapters), num(r.unchaptered),
    r.meanWords.toFixed(0), num(r.maxBytes),
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((row) => row[i].length)));
  const line = (c) => c.map((v, i) => (i === 0 ? v.padEnd(w[i]) : v.padStart(w[i]))).join("  ");
  console.log(line(head));
  console.log(w.map((n) => "─".repeat(n)).join("  "));
  for (const row of body) console.log(line(row));
}

function main() {
  const shelf = loadShelf();
  const rows = shelf.books.map(buildBook);

  if (HEADINGS_ONLY) {
    for (const r of rows) {
      console.log(`\n${r.book.slug} — ${r.chapters} sections`);
      for (const h of r.firstHeadings) console.log(`   first: ${JSON.stringify(h)}`);
      for (const h of r.lastHeadings) console.log(`   last:  ${JSON.stringify(h)}`);
    }
    return;
  }

  const out = fs.createWriteStream(OUT, { encoding: "utf8" });
  let total = 0;
  for (const r of rows) {
    for (const record of r.records) { out.write(`${JSON.stringify(record)}\n`); total += 1; }
  }
  out.end();

  table(rows);

  const totalWords = rows.reduce((n, r) => n + r.records.reduce((m, x) => m + x.wordCount, 0), 0);
  const maxBytes = Math.max(...rows.map((r) => r.maxBytes));
  const biggest = rows.find((r) => r.maxBytes === maxBytes);
  const oversize = rows.reduce((n, r) => n + r.oversize, 0);
  const unchaptered = rows.reduce((n, r) => n + r.unchaptered, 0);

  console.log(`\n${num(total)} passages · ${num(totalWords)} words · mean ` +
    `${(totalWords / total).toFixed(0)} words per passage`);
  console.log(`largest record ${num(maxBytes)} bytes (${biggest.book.slug}), ceiling ` +
    `${num(MAX_RECORD_BYTES)} — ${oversize === 0 ? "none over" : `${num(oversize)} OVER`}`);
  console.log(`${num(unchaptered)} passages carry chapter: null · ` +
    `${num(lastResortCuts)} passage${lastResortCuts === 1 ? "" : "s"} began mid-sentence ` +
    `because a single sentence was longer than ${MAX_WORDS} words`);
  console.log(`written to ${path.relative(ROOT, OUT)} (gitignored)`);

  console.log("\nwhat each book's chapter numbers mean:");
  for (const r of rows) console.log(`  ${r.book.slug}: ${r.note}`);

  if (oversize > 0) {
    console.error(`\n${oversize} record(s) exceed ${num(MAX_RECORD_BYTES)} bytes.`);
    process.exitCode = 1;
  }
}

try {
  main();
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}

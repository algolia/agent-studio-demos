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
 * The same range for a script with no spaces in it, measured in characters — see
 * the METRIC note above the packer. 250–550 characters of Japanese or Chinese is
 * comparable token mass to 150–300 English words: measured against
 * /context/trim, a Han character costs about three times what a Latin one does.
 */
const MIN_CHARS = 250;
const MAX_CHARS = 550;

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

/**
 * heading = a line matching `re`; group 1 is the number, group 2 the title.
 *
 * `ordinals` exists for exactly one line on the shelf and it is load-bearing.
 * Cervantes prints "Capítulo primero." and then "Capítulo II.", so chapter one's
 * number reads as null — and dropContents, seeing a null it cannot place before a
 * 2, drops that heading as a leftover contents entry. The whole first chapter of
 * Don Quijote then becomes front matter. One word in a table fixes it, and it
 * belongs here rather than in headingNumber: "primero" is a number in Spanish
 * chapter headings and nowhere else this script looks.
 */
const byPattern = (re, { titleFromNextLine = false, ordinals = null } = {}) => (lines) => {
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
    const word = String(m[1] || "").trim().toLowerCase();
    const num = (ordinals && ordinals[word] !== undefined)
      ? ordinals[word]
      : headingNumber(m[1]);
    found.push({ line: i, num, title: title ? cleanTitle(title) : null });
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
const isolatedTitles = ({
  minBlankBefore = 3,
  minBlankAfter = 2,
  maxLen = 70,
  /**
   * What a title is allowed to start with. The default is the Latin alphabet plus
   * the quotes an English title can open on, and it stays the default so the
   * sixteen English books' output does not move. Белые ночи needs \p{Lu}, because
   * "Ночь первая" is capitalised in a script this class does not name.
   */
  initial = /^[A-Z“"(]/,
  /**
   * A title has no comma in it. Off by default — the two English collections that
   * use this rule were tuned without it — and on for Russian, where it is what
   * separates a section heading from a line of narration that happens to sit alone
   * between two blank lines.
   */
  noComma = false,
}) => (lines) => {
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
    if (!initial.test(t)) return;
    if (/[.!?,;:]$/.test(t)) return;
    if (noComma && /,/.test(t)) return;
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

  /* ── The multilingual shelf ────────────────────────────────────────
     Nine more editions, nine more conventions, and none of them English. Two
     things carry over unchanged: a rule each book can actually satisfy, and
     `chapter: null` wherever nothing can be detected. An invented structure is
     worse than an absent one in any language. ── */

  "don-quijote": {
    detect: byPattern(/^Cap[ií]tulo\s+(primero|[IVXLC]+)\.?\s*(.*)$/i, { ordinals: { primero: 1 } }),
    note: "«Capítulo primero» and then roman numerals, in both parts. The printed " +
      "numbers restart at the second part, so `chapter` is the section's index in " +
      "reading order rather than the number on the page",
  },
  faust: {
    detect: isolatedTitles({ minBlankBefore: 2, minBlankAfter: 1, maxLen: 45 }),
    minProse: 120,
    note: "scenes, not chapters, detected as isolated title lines — «Nacht», «Vor " +
      "dem Tor», «Auerbachs Keller in Leipzig». Speaker names are not headings and " +
      "are not treated as any: they carry a full stop and no blank line after them",
  },
  zarathustra: {
    detect: isolatedTitles({ minBlankBefore: 2, minBlankAfter: 1, maxLen: 60 }),
    minProse: 120,
    note: "the named speeches («Von den drei Verwandlungen»), detected as isolated " +
      "title lines. The four parts are headings too and read here as sections of " +
      "their own, which is the structure a flat index cannot represent",
  },
  "divina-commedia": {
    detect: byPattern(/^(?:Canto\s+([IVXLC]+)\.?|(INFERNO|PURGATORIO|PARADISO))$/),
    note: "a hundred cantos exactly. Canto numbers restart in each of the three " +
      "parts, so `chapter` is the section's index in reading order rather than the " +
      "number printed on the page. INFERNO, PURGATORIO and PARADISO are matched as " +
      "headings and then dropped as contents entries, because each is followed " +
      "immediately by its first canto with no prose in between — which is what a " +
      "part title is",
  },
  "madame-bovary": {
    detect: byPattern(/^([IVXLC]+)$/),
    note: "bare roman numerals, restarting in each of the three parts — so `chapter` " +
      "is the section's index in reading order, not the number printed on the page. " +
      "The part titles themselves are not detected and fall under chapter: null",
  },
  "fleurs-du-mal": {
    detect: isolatedTitles({ minBlankBefore: 2, minBlankAfter: 1, maxLen: 45 }),
    minProse: 60,
    note: "one section per poem, detected from the all-capital titles as isolated " +
      "lines. The préface and the section titles («SPLEEN ET IDÉAL») come through " +
      "as sections of their own",
  },
  rashomon: {
    detect: () => [],
    note: "one short story, unbroken — the source has no divisions, so every " +
      "passage carries chapter: null rather than a number this script made up. The " +
      "digitizer's English note at the top is part of the file and is indexed with it",
  },
  "honglou-meng": {
    // \s covers the IDEOGRAPHIC SPACE this edition puts between 回 and the title
    detect: byPattern(/^第([一二三四五六七八九十百零〇]+)回(?:$|\s+(.{0,40}))$/),
    note: "a hundred and twenty 回, numbered in Chinese numerals. Two guards, both " +
      "earned: the 回 must be followed by a space or the end of the line, because the " +
      "prose refers back to «第四回中…» and «第二回了…» mid-sentence; and the title is " +
      "capped at forty characters, because a heading is a short line or it is " +
      "narration. Chapter forty-five prints its title twice and the second copy is " +
      "dropped as a contents entry, having no prose in front of it",
  },
  "belye-nochi": {
    detect: isolatedTitles({
      minBlankBefore: 1, minBlankAfter: 1, maxLen: 24,
      initial: /^\p{Lu}/u, noComma: true,
    }),
    note: "four nights and a morning, from the Wikisource page's own == headings ==. " +
      "The wikitext transform leaves each one alone on its line, which is what makes " +
      "them findable the same way the English collections' titles are",
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

/* ── Splitting ─────────────────────────────────────────────────────
   The rules at the top of this file are about not lying to the reader of a search
   result, and one of them does not survive leaving English: "150–300 words"
   assumes whitespace separates words. Japanese and Chinese do not write spaces,
   so `text.split(/\s+/)` returns ONE word for a whole page of 紅樓夢 — a
   200,000-character paragraph that no packer would ever cut, and a `wordCount: 1`
   on every record.

   So the packer is parameterised by a METRIC rather than special-cased: what to
   measure, how big a passage should be, and where the sentence boundaries are.
   Latin-script languages keep counting words and the numbers below are unchanged.
   ja and zh count CHARACTERS instead, 250–550 of them, which is comparable token
   mass — a Han character costs roughly a token on its own, so 250–550 characters
   sits in the same range as 150–300 English words.

   Everything else holds in both: paragraphs are packed whole where they fit, a
   paragraph too long for one passage is cut on sentence boundaries, and only a
   single SENTENCE longer than the maximum is cut blind. ── */

const words = (s) => s.split(/\s+/).filter(Boolean);
const wordCount = (s) => words(s).length;

/** sentence ends: terminal punctuation, optional closing quote, then whitespace */
const SENTENCE_END = /(?<=[.!?…][)"'’”]?)\s+/;

/**
 * The same idea in Japanese and Chinese, where it needs different pieces: the
 * terminal marks are 。！？…, a closing quote 」』】〉》 belongs to the sentence it
 * closes, and there is no trailing whitespace to anchor on — CJK text runs
 * straight into the next sentence, so the boundary is zero-width. A lookbehind
 * split would leave empty pieces, so this walks the string instead.
 */
/**
 * The terminal marks, and the fourth one is not the obvious one. 羅生門 ends its
 * sentences with 。 as expected, but this edition of 紅樓夢 mostly does not: it
 * prints ．— FULLWIDTH FULL STOP, U+FF0E — 21,285 times against 7,886 for 。. Left
 * out, four fifths of the Chinese passages ended mid-sentence, and the packer had
 * no boundary to prefer, so it fell back on the blind cut. Counted from the file
 * rather than assumed from the language, which is the only way this was ever going
 * to be right.
 */
const CJK_END = /[。．！？…]/;
const CJK_CLOSER = /[」』】〉》）"'’”]/;

function cjkSentences(para) {
  const out = [];
  let start = 0;
  for (let i = 0; i < para.length; i++) {
    if (!CJK_END.test(para[i])) continue;
    let end = i + 1;
    while (end < para.length && (CJK_END.test(para[end]) || CJK_CLOSER.test(para[end]))) end += 1;
    out.push(para.slice(start, end));
    start = end;
    i = end - 1;
  }
  if (start < para.length) out.push(para.slice(start));
  return out.filter((s) => s.trim());
}

/**
 * LAST RESORT. Ulysses' final episode is two sentences of about twenty thousand
 * words each, with no full stop between them: there is no sentence boundary to
 * cut on, so this cuts on a word boundary instead and that is the honest thing to
 * report. It is the only place in the shelf where a passage can begin mid-clause,
 * and the summary counts how often it happened.
 */
let lastResortCuts = 0;

/**
 * A section's tail is allowed to be short — a forty-word closing paragraph is a
 * fair search result — but not this short: Aesop prints each moral in its own
 * paragraph, so a long fable was leaving "Look before you leap." stranded as a
 * record of its own. Anything under this is merged back into the passage it
 * belongs to, at the cost of letting that one run over the maximum, which is the
 * lesser wrong.
 */
const TAIL_MIN_WORDS = 40;
const TAIL_MIN_CHARS = 90;

/** ja and zh, the two languages on this shelf whose script carries no spaces */
const CJK_LANGS = new Set(["ja", "zh"]);

const WORD_METRIC = {
  unit: "words",
  size: wordCount,
  min: MIN_WORDS,
  max: MAX_WORDS,
  tailMin: TAIL_MIN_WORDS,
  sentences: (para) => para.split(SENTENCE_END),
  /** the blind cut, on whatever this metric's atoms are */
  chop: (s, max) => {
    const w = words(s);
    const out = [];
    for (let i = 0; i < w.length; i += max) out.push(w.slice(i, i + max).join(" "));
    return out;
  },
  join: " ",
};

const CHAR_METRIC = {
  unit: "characters",
  size: (s) => s.length,
  min: MIN_CHARS,
  max: MAX_CHARS,
  tailMin: TAIL_MIN_CHARS,
  sentences: cjkSentences,
  chop: (s, max) => {
    const out = [];
    for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max));
    return out;
  },
  join: "",
};

const metricFor = (lang) => (CJK_LANGS.has(lang) ? CHAR_METRIC : WORD_METRIC);

function splitLongParagraph(para, m) {
  const out = [];
  let cur = [];
  let n = 0;
  for (const sentence of m.sentences(para)) {
    const c = m.size(sentence);
    if (c > m.max) {
      if (cur.length) { out.push(cur.join(m.join)); cur = []; n = 0; }
      for (const piece of m.chop(sentence, m.max)) {
        out.push(piece);
        lastResortCuts += 1;
      }
      continue;
    }
    if (n + c > m.max && cur.length) { out.push(cur.join(m.join)); cur = []; n = 0; }
    cur.push(sentence);
    n += c;
  }
  if (cur.length) out.push(cur.join(m.join));
  return out;
}

/**
 * Paragraphs packed into passages of m.min–m.max. A paragraph is never broken
 * unless it is longer than a whole passage on its own.
 */
function passagesOf(text, m = WORD_METRIC) {
  const units = [];
  for (const para of text.split(/\n{2,}/)) {
    const p = para.trim();
    if (!p) continue;
    if (m.size(p) > m.max) units.push(...splitLongParagraph(p, m));
    else units.push(p);
  }

  const out = [];
  let cur = [];
  let n = 0;
  for (const unit of units) {
    const c = m.size(unit);
    if (n && n + c > m.max) { out.push(cur.join("\n\n")); cur = []; n = 0; }
    cur.push(unit);
    n += c;
    if (n >= m.min) { out.push(cur.join("\n\n")); cur = []; n = 0; }
  }
  if (cur.length) out.push(cur.join("\n\n"));

  if (out.length > 1 && m.size(out[out.length - 1]) < m.tailMin) {
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
  const lang = book.lang || "en";
  const metric = metricFor(lang);

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
    for (const passage of passagesOf(section.text, metric)) {
      position += 1;
      const record = {
        objectID: `${book.slug}_ch-${section.chapter === null ? "none" : pad(section.chapter, 3)}_p-${pad(position, 4)}`,
        book: book.title,
        author: book.author,
        /**
         * `lang` is what index-passages.js routes on, so it is on every record
         * including the English ones. `source` names where the text came from;
         * gutenbergId is null for the work that is not on Gutenberg at all.
         */
        lang,
        source: book.source || "gutenberg",
        gutenbergId: book.gutenbergId === undefined ? null : book.gutenbergId,
        chapter: section.chapter,
        chapterTitle: section.chapterTitle,
        position,
        text: passage,
        /**
         * Both counts, on every record in every language. `wordCount` on a
         * Japanese passage is whitespace-based and therefore close to 1 — true,
         * and useless — so `charCount` is the one that means something there.
         * Emitting both everywhere beats a schema that changes shape by language:
         * a caller reading `charCount` gets an answer for Moby-Dick too.
         */
        wordCount: wordCount(passage),
        charCount: passage.length,
      };
      const bytes = Buffer.byteLength(JSON.stringify(record), "utf8");
      maxBytes = Math.max(maxBytes, bytes);
      if (bytes > MAX_RECORD_BYTES) oversize += 1;
      records.push(record);
    }
  }

  const total = records.reduce((n, r) => n + metric.size(r.text), 0);
  return {
    book,
    lang,
    metric,
    records,
    chapters: headings.length,
    unchaptered: records.filter((r) => r.chapter === null).length,
    meanSize: records.length ? total / records.length : 0,
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
  const head = ["book", "lang", "records", "chapters", "no chapter", "mean size", "max bytes"];
  const body = rows.map((r) => [
    r.book.slug, r.lang, num(r.records.length), num(r.chapters), num(r.unchaptered),
    `${r.meanSize.toFixed(0)} ${r.metric.unit === "words" ? "w" : "ch"}`, num(r.maxBytes),
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((row) => row[i].length)));
  const line = (c) => c.map((v, i) => (i < 2 ? v.padEnd(w[i]) : v.padStart(w[i]))).join("  ");
  console.log(line(head));
  console.log(w.map((n) => "─".repeat(n)).join("  "));
  for (const row of body) console.log(line(row));
}

/** one line per index this file will feed, which is the number that matters next */
function byLanguage(rows) {
  const langs = new Map();
  for (const r of rows) {
    if (!langs.has(r.lang)) langs.set(r.lang, { records: 0, books: 0 });
    const bucket = langs.get(r.lang);
    bucket.records += r.records.length;
    bucket.books += 1;
  }
  console.log("\npassages per index:");
  for (const [lang, b] of langs) {
    const name = lang === "en" ? "public_domain_books" : `public_domain_books_${lang}`;
    console.log(`  ${name.padEnd(24)} ${num(b.records).padStart(7)} passages · ` +
      `${b.books} book${b.books === 1 ? "" : "s"}`);
  }
}

function main() {
  const shelf = loadShelf();
  const rows = [...shelf.books, ...(shelf.booksI18n || [])].map(buildBook);

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
    `because one sentence was longer than a whole passage ` +
    `(${MAX_WORDS} words, or ${MAX_CHARS} characters in ja and zh)`);
  byLanguage(rows);
  console.log(`\nwritten to ${path.relative(ROOT, OUT)} (gitignored)`);

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

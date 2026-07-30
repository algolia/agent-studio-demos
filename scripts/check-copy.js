#!/usr/bin/env node
/* ───────────────────────────────────────────────────────────────
   check-copy.js — is the page still readable?

     node scripts/check-copy.js            # report and gate
     node scripts/check-copy.js --verbose  # also list every long sentence
     node scripts/check-copy.js --fix      # glue em-dashes and number–unit pairs

   ── The rule this enforces ───────────────────────────────────────
   Two numbers, and one exemption:

     Under two minutes to read the whole page.
     Ninth-grade reading level, and that is a ceiling, not a target.
     The conversation is exempt.

   The exemption matters. These demos put whole novels into a chat — Ulysses is
   in there — so the words the model and the reader exchange are as hard as
   literature gets, and that is the point. What must stay simple is everything
   the PAGE says in its own voice: headings, blurbs, labels, tooltips. A reader
   who cannot get through the explanation never reaches the demo.

   Two minutes at an unhurried 200 words per minute is 400 words. Tooltips are
   counted separately and given a larger budget, because nobody reads all of
   them — they are opt-in depth, which is exactly where the hard sentences
   belong. What is measured strictly is what a visitor cannot avoid reading.

   Grade level is Flesch–Kincaid. It is a crude instrument: it counts syllables
   and sentence lengths and knows nothing about whether a sentence makes sense.
   It cannot be gamed into good writing, but it reliably catches the thing we
   actually keep doing wrong — a sixty-word sentence with three subordinate
   clauses and four abstract nouns. Treat a failure as a prompt to reread, not
   as an instruction to delete every comma.
   ─────────────────────────────────────────────────────────────── */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const VERBOSE = process.argv.includes("--verbose");
const FIX = process.argv.includes("--fix");
const ROOT = path.join(__dirname, "..");

/** Two minutes at 200 wpm, and a looser ceiling for opt-in tooltip depth */
const LIMITS = {
  visibleWords: 400,
  visibleGrade: 9,
  tooltipWords: 900,
  tooltipGrade: 11,
  sentenceWords: 34,
  // One tooltip is one thought. Past about forty words it stops being a hint and
  // becomes an essay in a box that vanishes when the pointer moves — which is the
  // worst place on the page to put anything a reader needs. A tooltip over this
  // length is a signal that the thing wants to be shown, not explained: a number,
  // a state change, a bar that moves. See docs/_DESIGN.md.
  perTooltipWords: 40,
  // Most of this site's copy is not in the HTML at all: tooltips, event notes and
  // card text are written from JS at render time. Those strings get a slightly
  // larger cap than a tooltip because some of them are on-page notes rather than
  // hover panels — but the same principle holds, and fifty words of anything is
  // no longer a note.
  jsRunWords: 50,
};

const PAGES = ["index.html", "chat-with-book/index.html", "infinite-conversation/index.html"];
const JS_FILES = [
  "chat-with-book/app.js", "infinite-conversation/app.js",
  "shared/meter.js", "shared/books.js", "shared/compactor.js", "shared/md.js",
];

/* ── Text extraction ──────────────────────────────────────────── */

const decode = (s) => s
  .replace(/&mdash;|&#8212;/g, "—").replace(/&nbsp;|&#160;/g, " ")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#39;|&rsquo;/g, "'");

/**
 * Prose only — and that distinction is the whole reason this script is honest.
 *
 * A first version measured every string on the page, which mixed sentences in
 * with button labels and step headings ("Fetch", "2 · Pick the engine"). Dozens
 * of two-word fragments drag the words-per-sentence average down, so a page whose
 * opening paragraph genuinely loses the reader scored a comfortable grade 8.9.
 * The fragments are not the problem and never were. What has to stay simple is
 * the connected prose: paragraphs, headings, list items.
 */
function extract(html) {
  // tooltips first: they live in attributes, so stripping tags would eat them
  const tooltips = [...html.matchAll(/data-tip="([^"]*)"/g)].map((m) => decode(m[1]));
  let s = html.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  // a <pre>/<code> block is a wire payload, not prose the reader has to parse
  s = s.replace(/<(pre|code)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");

  const blocks = [...s.matchAll(/<(p|li|h1|h2|h3)\b[^>]*>([\s\S]*?)<\/\1>/gi)]
    .map((m) => decode(m[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim())
    .filter(Boolean);

  return { blocks, tooltips };
}

// A quote inside a regex literal (`/"/g`) opens a phantom "literal" that swallows
// code until the next real quote. Code is recognizable; prose never carries these
// tokens, and the formula strings they also exclude are meant for the tooltip's
// code slot, not for reading as sentences. Shared by the scanner and the fixer —
// whatever the scanner would refuse to measure, the fixer refuses to touch.
const codeish = /[;{}]|=>|<\/|\breturn\b|\bconst\b|\bfunction\b| = /;

/**
 * The page's copy is mostly NOT in the HTML: tooltips, event notes and card text
 * are template literals in app.js, assembled at render time. This pulls every
 * string-literal run out of a JS file — literals separated only by `+` and
 * whitespace are one run, because that is one string to the reader — with
 * `${…}` interpolations reduced to a space. Approximate by construction (a
 * quoted word inside a comment can open a phantom literal), which is why runs
 * are only *reported* over a generous cap rather than parsed exactly.
 */
function extractJsRuns(src) {
  // "The conversation is exempt" applies in JS too: a prompt sent to the model is
  // conversation, not page voice. Code brackets such text between
  // `/* check-copy: off */` and `/* check-copy: on */`, and it is skipped here.
  let s = src.replace(/\/\*\s*check-copy:\s*off\s*\*\/[\s\S]*?\/\*\s*check-copy:\s*on\s*\*\//g, " ");
  s = s.replace(/\/\*[\s\S]*?\*\//g, " ");
  s = s.replace(/^\s*\/\/.*$/gm, " ");
  // A backtick or quote inside a regex literal is not a delimiter, but a scanner
  // with no parser cannot tell — and one of them inverts every literal boundary
  // after it, silently, to the end of the file. That is not the harmless kind of
  // approximation: one such backtick, in the Markdown-stripping regex of peekOf,
  // left this gate reading 597 of chat-with-book/app.js's 3,613 words — 16% of the
  // file it was hired to measure. So regex bodies are blanked first, where
  // an operand cannot appear (after `( , = ! & | [ ; {` or at the start of a
  // line), keeping their length so the run-joining offsets still line up.
  s = s.replace(/([(,=!&|[;{]\s*)\/(?![*/])(?:\[[^\]\n]*\]|\\.|[^/\n\\[])+\/[gimsuy]*/g,
    (m, pre) => pre + " ".repeat(m.length - pre.length));
  // Single-quoted literals are skipped on purpose: this codebase writes prose in
  // double quotes and backticks, while apostrophes in trailing comments ("don't")
  // would open phantom single-quote literals that swallow whole stretches of code.
  const lit = /`(?:[^`\\]|\\.)*`|"(?:[^"\n\\]|\\.)*"/g;
  const runs = [];
  let current = null, lastEnd = -1;
  for (const m of [...s.matchAll(lit)]) {
    const text = m[0].slice(1, -1)
      .replace(/\$\{[^}]*\}/g, " ")
      .replace(/\\n|\\u00a0/g, " ")
      // a closing block tag ends a run the same way it ends a paragraph on
      // screen — three <p>s built in one template are three texts, not one
      .replace(/<\/(?:p|li|h[1-6])>/gi, "\u0000")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const glue = lastEnd >= 0 ? s.slice(lastEnd, m.index) : null;
    if (current !== null && glue !== null && /^[\s+]*$/.test(glue)) {
      current = `${current} ${text}`.trim();
    } else {
      if (current) runs.push(current);
      current = text;
    }
    lastEnd = m.index + m[0].length;
  }
  if (current) runs.push(current);
  return runs
    .flatMap((r) => r.split("\u0000"))
    .map((r) => r.replace(/\s+/g, " ").trim())
    .filter((r) => r && !codeish.test(r));
}

/* ── Wrap hygiene ─────────────────────────────────────────────────
   Where a line breaks is the browser's decision, and CSS carries most of the
   instructions (text-wrap in shared/tokens.css; inline code spans never break
   inside prose). Two atoms CSS cannot see still split badly at some width: an
   em-dash left free to open a line, and a unit orphaned from its number
   ("200k / window"). Both are mechanical, so both are linted — and writable:

     node scripts/check-copy.js --fix

   glues them in place, as `&nbsp;` in HTML and as a `\u00a0` escape inside JS
   string literals. Each pattern only ever tightens an existing single space,
   so the fix is idempotent and never reflows a source line. There is no
   "correct" render to screenshot — the same paragraph wraps differently at
   every width — which is exactly why the protection lives in the text itself. */

const UNIT = "(?:tokens?|tok|characters?|chars?|words?|window|exchanges?|turns?" +
  "|calls?|sections?|passages?|messages?|hits?|min)";
const GLUE = [
  // "shredder —" can break before the dash and open the next line with "—"
  { re: /(\S)( )(—)/g },
  // "200k window" can strand the unit; `}` is a closing interpolation in JS,
  // so "${fmt(peak)} tokens" is glued the same way a literal number is
  { re: new RegExp(`(\\d[\\d,.]*[kKmM%]?|\\})( )(${UNIT})\\b`, "g") },
];

const glue = (text, nbsp, onCount) =>
  GLUE.reduce((t, { re }) => t.replace(re, (_, a, _sp, b) => (onCount(), a + nbsp + b)), text);

/** Everything the page renders is fixable; script, style and comments are not. */
function glueHtml(src) {
  let count = 0;
  const out = src
    .split(/(<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<!--[\s\S]*?-->)/)
    .map((part, i) => (i % 2 ? part : glue(part, "&nbsp;", () => count++)))
    .join("");
  return { out, count };
}

/** Prose string literals only — exempt regions, comments and codeish phantoms
    are skipped on the same terms the scanner skips them. */
function glueJs(src) {
  let count = 0;
  const spans = [];
  const spanRes = [
    /\/\*\s*check-copy:\s*off\s*\*\/[\s\S]*?\/\*\s*check-copy:\s*on\s*\*\//g,
    /\/\*[\s\S]*?\*\//g,
    /^[ \t]*\/\/.*$/gm,
  ];
  for (const re of spanRes) {
    for (const m of src.matchAll(re)) spans.push([m.index, m.index + m[0].length]);
  }
  const skip = (i) => spans.some(([a, b]) => i >= a && i < b);
  const out = src.replace(/`(?:[^`\\]|\\.)*`|"(?:[^"\n\\]|\\.)*"/g, (lit, offset) => {
    if (skip(offset)) return lit;
    const gist = lit.slice(1, -1).replace(/\$\{[^}]*\}/g, " ").replace(/<[^>]+>/g, " ");
    if (codeish.test(gist)) return lit;
    return lit[0] + glue(lit.slice(1, -1), "\\u00a0", () => count++) + lit[0];
  });
  return { out, count };
}

/** lint or write, depending on --fix; either way the report loop gets one line */
function glueFile(file, rel, fixer) {
  const { out, count } = fixer(fs.readFileSync(file, "utf8"));
  if (!count) return;
  if (FIX) {
    fs.writeFileSync(file, out);
    console.log(`  glued     ${count} breakable spot${count === 1 ? "" : "s"}`);
  } else {
    fail.push(`${rel}: ${count} breakable em-dash / number–unit spot(s) — ` +
      "run node scripts/check-copy.js --fix");
  }
}

/* ── Readability ──────────────────────────────────────────────── */

/** Vowel-group syllables, with the usual silent-e and -le corrections. */
function syllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  if (w.length <= 3) return 1;
  let s = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "");
  const groups = s.match(/[aeiouy]{1,2}/g);
  let n = groups ? groups.length : 1;
  if (/(?:[^aeiouy]le|[^aeiou]y)$/.test(w)) n = Math.max(n, 2);
  return Math.max(1, n);
}

const sentencesOf = (text) => text
  .split(/(?<=[.!?])\s+(?=[A-Z“"(])|(?<=[.!?])$/)
  .map((x) => x.trim()).filter((x) => x.split(/\s+/).filter(Boolean).length > 2);

const wordsOf = (text) => text.split(/\s+/).map((w) => w.replace(/^[^\w]+|[^\w]+$/g, "")).filter(Boolean);

/** a heading or label: short and never punctuated as a sentence */
const isLabel = (block) => !/[.!?…]/.test(block) && wordsOf(block).length < 8;

/**
 * Blocks are scored one at a time, never glued. An earlier version joined all
 * blocks into one string before splitting sentences, and since headings carry no
 * terminal punctuation, "Algolia Agent Studio · unstable" fused with the next
 * heading and the first paragraph into a fake 43-word "sentence" — inflating the
 * grade as surely as the all-strings version deflated it. Labels are counted in
 * the reading time (a reader does read them) and excluded from the grade (they
 * are not sentences, in either direction).
 */
function score(blocks) {
  const list = Array.isArray(blocks) ? blocks : [blocks];
  const words = wordsOf(list.join(" "));
  const sents = list.filter((b) => !isLabel(b)).flatMap(sentencesOf);
  const base = {
    words: words.length, sentences: sents.length, wordsPerSentence: 0,
    grade: 0, ease: 100, readMinutes: words.length / 200, longest: [],
  };
  if (!sents.length || !words.length) return base;
  const proseWords = sents.flatMap(wordsOf);
  const syl = proseWords.reduce((a, w) => a + syllables(w), 0);
  const wps = proseWords.length / sents.length;
  const spw = syl / proseWords.length;
  return {
    ...base,
    wordsPerSentence: wps,
    grade: 0.39 * wps + 11.8 * spw - 15.59,
    ease: 206.835 - 1.015 * wps - 84.6 * spw,
    longest: sents
      .map((s) => ({ s, n: wordsOf(s).length }))
      .filter((x) => x.n > LIMITS.sentenceWords)
      .sort((a, b) => b.n - a.n),
  };
}

/* ── Report ───────────────────────────────────────────────────── */

const fail = [];
const pad = (n, w = 6) => String(n).padStart(w);

for (const rel of PAGES) {
  const file = path.join(ROOT, "public", rel);
  if (!fs.existsSync(file)) continue;
  const { blocks, tooltips } = extract(fs.readFileSync(file, "utf8"));
  const v = score(blocks);
  const t = score(tooltips);

  console.log(`\n${rel}`);
  console.log(`  visible   ${pad(v.words)} words · ${v.readMinutes.toFixed(1)} min · ` +
    `grade ${v.grade.toFixed(1)} · ease ${v.ease.toFixed(0)} · ` +
    `${v.wordsPerSentence.toFixed(1)} words/sentence`);
  console.log(`  tooltips  ${pad(t.words)} words · ${tooltips.length} of them · ` +
    `grade ${t.grade.toFixed(1)}`);
  glueFile(file, rel, glueHtml);

  if (v.words > LIMITS.visibleWords) {
    fail.push(`${rel}: ${v.words} visible words, budget ${LIMITS.visibleWords} ` +
      `(${v.readMinutes.toFixed(1)} min — the page must read in under two)`);
  }
  if (v.grade > LIMITS.visibleGrade) {
    fail.push(`${rel}: visible copy reads at grade ${v.grade.toFixed(1)}, ceiling ` +
      `${LIMITS.visibleGrade}`);
  }
  if (t.words > LIMITS.tooltipWords) {
    fail.push(`${rel}: ${t.words} words of tooltips, budget ${LIMITS.tooltipWords}`);
  }
  const essays = tooltips
    .map((x) => ({ x, n: wordsOf(x).length }))
    .filter((o) => o.n > LIMITS.perTooltipWords)
    .sort((a, b) => b.n - a.n);
  if (essays.length) {
    console.log(`  ${essays.length} tooltip${essays.length === 1 ? "" : "s"} over ` +
      `${LIMITS.perTooltipWords} words — each one is asking to be shown instead:`);
    for (const { x, n } of essays.slice(0, VERBOSE ? 99 : 3)) {
      console.log(`    ${pad(n, 3)}w  ${x.slice(0, 120)}…`);
    }
    fail.push(`${rel}: ${essays.length} tooltip(s) longer than ${LIMITS.perTooltipWords} words ` +
      `(worst: ${essays[0].n}) — show it, do not explain it`);
  }
  if (t.grade > LIMITS.tooltipGrade) {
    fail.push(`${rel}: tooltips read at grade ${t.grade.toFixed(1)}, ceiling ${LIMITS.tooltipGrade}`);
  }

  const long = v.longest.concat(VERBOSE ? t.longest : []);
  if (long.length) {
    console.log(`  ${long.length} sentence${long.length === 1 ? "" : "s"} over ` +
      `${LIMITS.sentenceWords} words:`);
    for (const { s, n } of long.slice(0, VERBOSE ? 99 : 4)) {
      console.log(`    ${pad(n, 3)}w  ${s.slice(0, 150)}${s.length > 150 ? "…" : ""}`);
    }
  }
}

/* ── The copy that lives in JS ────────────────────────────────────
   Tooltips, event notes and card text are assembled at render time, so the HTML
   scan above never sees them — and they are where this site actually talks. Each
   string-literal run is held to jsRunWords. Interpolations count as one word,
   which flatters the run: the rendered text is always longer than what is
   measured here. ─────────────────────────────────────────────── */

for (const rel of JS_FILES) {
  const file = path.join(ROOT, "public", rel);
  if (!fs.existsSync(file)) continue;
  const runs = extractJsRuns(fs.readFileSync(file, "utf8"));
  const over = runs
    .map((x) => ({ x, n: wordsOf(x).length }))
    .filter((o) => o.n > LIMITS.jsRunWords)
    .sort((a, b) => b.n - a.n);
  const total = runs.reduce((a, r) => a + wordsOf(r).length, 0);
  console.log(`\n${rel}`);
  console.log(`  strings   ${pad(total)} words · ${runs.length} runs · longest ` +
    `${runs.length ? Math.max(...runs.map((r) => wordsOf(r).length)) : 0}w`);
  glueFile(file, rel, glueJs);
  if (over.length) {
    console.log(`  ${over.length} run${over.length === 1 ? "" : "s"} over ` +
      `${LIMITS.jsRunWords} words — each is asking to be shown instead:`);
    for (const { x, n } of over.slice(0, VERBOSE ? 99 : 3)) {
      console.log(`    ${pad(n, 3)}w  ${x.slice(0, 120)}…`);
    }
    fail.push(`${rel}: ${over.length} JS string run(s) longer than ${LIMITS.jsRunWords} words ` +
      `(worst: ${over[0].n}) — show it, do not explain it`);
  }
}

console.log("");
if (fail.length) {
  console.error("Copy is over budget:\n");
  for (const f of fail) console.error(`  ${f}`);
  console.error("\nThe conversation is exempt from this. The page's own voice is not.");
  process.exit(1);
}
console.log("Copy is within budget: under two minutes, ninth grade or simpler.");

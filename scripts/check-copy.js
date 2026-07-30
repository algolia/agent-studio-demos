#!/usr/bin/env node
/* ───────────────────────────────────────────────────────────────
   check-copy.js — is the page still readable?

     node scripts/check-copy.js            # report and gate
     node scripts/check-copy.js --verbose  # also list every long sentence

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
};

const PAGES = ["index.html", "chat-with-book/index.html", "infinite-conversation/index.html"];

/* ── Text extraction ──────────────────────────────────────────── */

const decode = (s) => s
  .replace(/&mdash;|&#8212;/g, "—").replace(/&nbsp;|&#160;/g, " ")
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

  return { visible: blocks.join(" "), blocks, tooltips };
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

function score(text) {
  const sents = sentencesOf(text);
  const words = wordsOf(text);
  if (!sents.length || !words.length) return { words: words.length, sentences: 0, grade: 0, ease: 100 };
  const syl = words.reduce((a, w) => a + syllables(w), 0);
  const wps = words.length / sents.length;
  const spw = syl / words.length;
  return {
    words: words.length,
    sentences: sents.length,
    wordsPerSentence: wps,
    grade: 0.39 * wps + 11.8 * spw - 15.59,
    ease: 206.835 - 1.015 * wps - 84.6 * spw,
    readMinutes: words.length / 200,
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
  const { visible, tooltips } = extract(fs.readFileSync(file, "utf8"));
  const v = score(visible);
  const t = score(tooltips.join(" "));

  console.log(`\n${rel}`);
  console.log(`  visible   ${pad(v.words)} words · ${v.readMinutes.toFixed(1)} min · ` +
    `grade ${v.grade.toFixed(1)} · ease ${v.ease.toFixed(0)} · ` +
    `${v.wordsPerSentence.toFixed(1)} words/sentence`);
  console.log(`  tooltips  ${pad(t.words)} words · ${tooltips.length} of them · ` +
    `grade ${t.grade.toFixed(1)}`);

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

console.log("");
if (fail.length) {
  console.error("Copy is over budget:\n");
  for (const f of fail) console.error(`  ${f}`);
  console.error("\nThe conversation is exempt from this. The page's own voice is not.");
  process.exit(1);
}
console.log("Copy is within budget: under two minutes, ninth grade or simpler.");

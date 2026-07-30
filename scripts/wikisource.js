/* ───────────────────────────────────────────────────────────────
   wikisource.js — wikitext in, prose out.

   One work on the shelf is not on Project Gutenberg as plain text: Достоевский's
   Белые ночи. It is on ru.wikisource.org, as a single page of wikitext, and that
   is a different input with a different licence story, so it gets its own
   transform rather than a special case inside fetch-books.js.

   ── What is public domain here, and what is not ──────────────────
   The novel is public domain: 1848, and the page's own {{Отексте}} template
   carries PD-RusEmpire. Wikisource's CC BY-SA covers the editorial layer that
   community wrote on top — footnotes, source notes, navigation, the epigraph
   box's markup — and every one of those is a template, a <ref>, or a nav div.
   This transform removes all three, which is why it needs no attribution: what
   survives is the 1848 text and nothing a Wikisource editor wrote.

   That is also why the removals are structural rather than a list of titles to
   skip. A rule like "drop the {{Отексте}} header" would go stale the day someone
   renames the template; "drop every balanced {{…}}" cannot.

   ── The steps ────────────────────────────────────────────────────
   In order, and nothing else:

     1. normalize CRLF and lone CR to LF
     2. drop <ref>…</ref>, <ref …/>, <references/> — the editorial footnote layer
     3. drop HTML comments and the ws-noexport divs (print/nav furniture)
     4. <br> becomes a line break, then every remaining tag goes
     5. drop balanced {{templates}}, innermost first, so nesting cannot survive
     6. drop [[Категория:…]], [[Файл:…]] and [[xx:…]] interlanguage links
     7. [[target|text]] → text, [[target]] → target
     8. [http://… text] → text
     9. ''italic'' and '''bold''' lose their quotes
    10. == Heading == becomes the heading alone, on its own line
    11. &#160; and &nbsp; become ordinary spaces — the source writes them before
        em-dashes, and a non-breaking space inside a search index is a character
        no query will ever type
    12. collapse three or more newlines to two, trim, end with one newline

   The prose itself — spelling, punctuation, paragraph breaks — is untouched, for
   the same reason fetch-books.js leaves Gutenberg's hard wrap alone: a demo that
   quietly rewrites its source cannot be checked against it.

   Pre-reform orthography lives on separate /ДО subpages on Wikisource. This never
   visits them; the modern-orthography page is the one a Russian query will match.
   ─────────────────────────────────────────────────────────────── */

"use strict";

/** the MediaWiki API call that returns one page's raw wikitext */
function contentUrl(host, title) {
  const params = new URLSearchParams({
    action: "query",
    prop: "revisions",
    rvprop: "content",
    rvslots: "main",
    format: "json",
    formatversion: "2",
    titles: title,
  });
  return `https://${host}/w/api.php?${params}`;
}

/**
 * The wikitext of one page, from the shape `action=query&prop=revisions` returns.
 * Throws rather than returning empty on a missing page: a shelf entry pointing at
 * a title that does not exist is a manifest bug, and an empty file would hide it.
 *
 * `prop=extracts&explaintext=1` is the obvious-looking alternative and it does not
 * work on Wikisource — on this page it answers with a footnote heading and nothing
 * else. The revisions slot is the whole text or an error.
 */
function pageContent(json, title) {
  const pages = (json && json.query && json.query.pages) || [];
  const page = pages.find((p) => p.title === title) || pages[0];
  if (!page || page.missing) throw new Error(`${title}: no such page`);
  const content = page.revisions && page.revisions[0] &&
    page.revisions[0].slots && page.revisions[0].slots.main &&
    page.revisions[0].slots.main.content;
  if (!content) throw new Error(`${title}: the revision carries no main slot content`);
  return content;
}

/**
 * Balanced {{…}} removal, innermost first. A single regex cannot do this: the
 * {{Отексте}} header on this page contains {{Отечественные записки}} which
 * contains {{РНБ}}, and a non-greedy match stops at the first `}}` it meets,
 * leaving the outer template's tail behind as loose text in the middle of the
 * novel's first page. Repeat-until-stable over "a {{…}} with no {{ inside it}}"
 * peels the nest from the inside out and terminates because each pass is strictly
 * shorter.
 */
function dropTemplates(s) {
  const INNERMOST = /\{\{(?:[^{}]|\}(?!\})|\{(?!\{))*\}\}/g;
  let out = s;
  for (let i = 0; i < 20; i++) {
    const next = out.replace(INNERMOST, "");
    if (next === out) return next;
    out = next;
  }
  return out;
}

/** the namespaces that are furniture rather than text, plus interlanguage links */
const DROPPED_LINK = /^(Категория|Category|Файл|File|Изображение|Image|[a-z]{2,3}(-[a-z]+)?):/;

const ENTITIES = [
  [/&#160;|&nbsp;/g, " "],
  [/&mdash;|&#8212;/g, "—"],
  [/&ndash;|&#8211;/g, "–"],
  [/&laquo;/g, "«"], [/&raquo;/g, "»"],
  [/&quot;/g, "\""],
  [/&lt;/g, "<"], [/&gt;/g, ">"],
  [/&amp;/g, "&"],
];

/** wikitext → the prose it renders to. The twelve steps in the header, in order. */
function toText(wikitext) {
  let s = String(wikitext).replace(/\r\n?/g, "\n");

  s = s.replace(/<ref\b[^>]*\/>/gi, "");
  s = s.replace(/<ref\b[^>]*>[\s\S]*?<\/ref>/gi, "");
  s = s.replace(/<references\b[^>]*\/>/gi, "");
  s = s.replace(/<references\b[^>]*>[\s\S]*?<\/references>/gi, "");

  s = s.replace(/<!--[\s\S]*?-->/g, "");
  // the print/navigation furniture: prev-next boxes and headers carry this class
  s = s.replace(/<div\b[^>]*class="[^"]*ws-noexport[^"]*"[^>]*>[\s\S]*?<\/div>/gi, "");

  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/?[a-z][^>]*>/gi, "");

  s = dropTemplates(s);

  s = s.replace(/\[\[([^\][|]*)(?:\|([^\][]*))?\]\]/g, (_m, target, text) =>
    (DROPPED_LINK.test(target.trim()) ? "" : (text === undefined ? target : text)));
  s = s.replace(/\[(?:https?:|\/\/)\S+\s+([^\]]*)\]/g, "$1");
  s = s.replace(/\[(?:https?:|\/\/)\S+\]/g, "");

  s = s.replace(/'{2,5}/g, "");

  // the heading alone, on its own line, with blank lines around it — which is how
  // a chapter heading looks in every other file on this shelf
  s = s.replace(/^[ \t]*(=+)[ \t]*(.*?)[ \t]*\1[ \t]*$/gm, (_m, _eq, title) => `\n${title.trim()}\n`);

  for (const [re, to] of ENTITIES) s = s.replace(re, to);

  // trailing spaces are an artefact of the removals above, not the source's
  s = s.split("\n").map((line) => line.replace(/[ \t]+$/, "")).join("\n");
  s = s.replace(/\n{3,}/g, "\n\n");

  return `${s.trim()}\n`;
}

module.exports = { contentUrl, pageContent, toText, dropTemplates };

/* The bookshelf claims things about files: that they exist, that they are the
   book the tile names, that the word count beside them is the word count of the
   text. A tile that quotes a number nobody measured is the same sin as a meter
   that hides the summarizer's bill, so the numbers are checked against the
   committed files here rather than trusted.

   The chips get a shape check and one content check each: a needle question's
   subject has to appear in the book. It cannot verify that an answer is
   satisfying, but it does catch the failure that matters — a suggested question
   whose premise is not in the text at all, which reads to a visitor as the
   product being unable to answer. */

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadBooks } = require("./load.js");

const SHELF = loadBooks();
const TEXTS = path.join(__dirname, "..", "public", "assets", "texts");

const read = (slug) => fs.readFileSync(path.join(TEXTS, `${slug}.txt`), "utf8");

test("four books, each with the fields a tile and a fetch need", () => {
  assert.equal(SHELF.books.length, 4);
  for (const b of SHELF.books) {
    for (const field of ["slug", "title", "author", "year", "gutenbergId", "words", "chars", "hook", "chips"]) {
      assert.ok(b[field] !== undefined, `${b.slug || "?"} is missing ${field}`);
    }
    assert.match(b.slug, /^[a-z0-9-]+$/, "a slug is also a filename");
    assert.equal(typeof b.year, "number");
    assert.ok(b.year > 1700 && b.year < 1950, `${b.slug}: ${b.year} is not a plausible year`);
    assert.equal(SHELF.bookUrl(b), `/assets/texts/${b.slug}.txt`);
    assert.equal(SHELF.findBook(b.slug), b);
  }
  const slugs = SHELF.books.map((b) => b.slug);
  assert.equal(new Set(slugs).size, slugs.length, "slugs key the shelf, so they are unique");
  assert.equal(SHELF.findBook("no-such-book"), null);
});

test("every book on the shelf is on disk, and stripped of its licence wrapper", () => {
  for (const b of SHELF.books) {
    const text = read(b.slug);
    assert.ok(text.length > 100000, `${b.slug} is suspiciously short`);
    assert.doesNotMatch(text, /PROJECT GUTENBERG EBOOK/,
      `${b.slug} still carries a Gutenberg boundary marker`);
    assert.doesNotMatch(text, /START: FULL LICENSE/, `${b.slug} still carries the licence`);
    assert.doesNotMatch(text, /\r/, `${b.slug} has CRLF line endings`);
  }
});

test("the counted figures on the tiles are the files' own", () => {
  for (const b of SHELF.books) {
    const text = read(b.slug);
    const words = text.split(/\s+/).filter(Boolean).length;
    assert.equal(b.chars, text.length, `${b.slug}: chars does not match the file`);
    assert.equal(b.words, words, `${b.slug}: words does not match the file`);
  }
});

test("each book is the book its tile names", () => {
  // the opening lines of each text carry their own title page
  const opening = (slug) => read(slug).slice(0, 400).toLowerCase();
  assert.match(opening("alice-in-wonderland"), /alice’s adventures in wonderland/);
  assert.match(opening("the-time-machine"), /the time machine/);
  assert.match(opening("frankenstein"), /frankenstein/);
  assert.match(opening("moby-dick"), /moby-dick/);
});

test("every book offers both families of question, four to six in all", () => {
  for (const b of SHELF.books) {
    assert.ok(b.chips.length >= 4 && b.chips.length <= 6,
      `${b.slug} has ${b.chips.length} chips; the shelf shows four to six`);
    const kinds = b.chips.map((c) => c.kind);
    assert.ok(kinds.includes("needle"), `${b.slug} has no needle question`);
    assert.ok(kinds.includes("arc"), `${b.slug} has no arc question`);
    for (const c of b.chips) {
      assert.ok(["needle", "arc"].includes(c.kind), `${b.slug}: unknown chip kind ${c.kind}`);
      assert.ok(c.text.length > 30, `${b.slug}: "${c.text}" is too short to be a real question`);
      // a question mark or a full stop: some of the arc prompts are instructions
      // ("compare how…"), which is a fair way to ask for a whole-book reading
      assert.match(c.text, /[?.]$/, `${b.slug}: "${c.text}" is not a finished sentence`);
      // the pill wears the handle and sends the question, so both have to exist
      assert.ok(c.short && c.short.length <= 30, `${b.slug}: "${c.short}" is not a short handle`);
      assert.ok(c.short.length < c.text.length, `${b.slug}: the handle is not shorter`);
    }
  }
});

test("every needle question's subject is actually in its book", () => {
  // one distinctive phrase per needle question, checked against the text — the
  // premise, not the answer
  const PREMISES = {
    "alice-in-wonderland": ["DRINK ME", "EAT ME", "raven like a writing-desk", "Off with her head"],
    "the-time-machine": ["Eight Hundred and Two Thousand", "Morlock", "matches", "Eloi"],
    "frankenstein": ["Paradise Lost", "Plutarch", "Werter", "wedding-night", "glacier"],
    "moby-dick": ["nail it to the mast", "gold ounce", "Mapple", "Jonah", "coffin life-buoy"],
  };
  for (const [slug, phrases] of Object.entries(PREMISES)) {
    // whitespace is collapsed first: the source is hard-wrapped at ~72 columns,
    // so half of these phrases straddle a line break in the file
    const text = read(slug).replace(/\s+/g, " ");
    for (const phrase of phrases) {
      assert.ok(text.includes(phrase), `${slug} does not contain "${phrase}"`);
    }
  }
});

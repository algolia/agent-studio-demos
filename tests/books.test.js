/* The bookshelf claims things about files: that they exist, that they are the
   book the tile names, that the word count beside them is the word count of the
   text. A tile that quotes a number nobody measured is the same sin as a meter
   that hides the summarizer's bill, so the numbers are checked against the
   committed files here rather than trusted.

   The chips get a shape check and one content check each: a needle question's
   subject has to appear in the book. It cannot verify that an answer is
   satisfying, but it does catch the failure that matters — a suggested question
   whose premise is not in the text at all, which reads to a visitor as the
   product being unable to answer.

   And the regime labels get their own suite. Those labels are money-adjacent
   copy — "≈ $2.09", "asks before it spends" — derived from the book's size and
   the config rather than written down per book, so the thing worth testing is
   the derivation: the two thresholds, the cost gate, and the fact that changing
   the config changes the verdict. A hardcoded verdict would need no test and
   would quietly go stale; this one cannot. */

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadBooks } = require("./load.js");

const SHELF = loadBooks();
const TEXTS = path.join(__dirname, "..", "public", "assets", "texts");

const read = (slug) => fs.readFileSync(path.join(TEXTS, `${slug}.txt`), "utf8");

test("sixteen books, each with the fields a tile and a fetch need", () => {
  assert.equal(SHELF.books.length, 16);
  for (const b of SHELF.books) {
    for (const field of ["slug", "title", "author", "year", "gutenbergId", "words", "chars", "hook", "chips"]) {
      assert.ok(b[field] !== undefined, `${b.slug || "?"} is missing ${field}`);
    }
    assert.match(b.slug, /^[a-z0-9-]+$/, "a slug is also a filename");
    assert.equal(typeof b.year, "number");
    // `year` is this EDITION's year, not the work's: the Æsop is Townsend's 1867
    // translation and the Nights is Lang's 1898 selection, which is what the file
    // actually holds. Dating the fables to 500 BCE would guard nothing.
    assert.ok(b.year > 1700 && b.year < 1950, `${b.slug}: ${b.year} is not a plausible edition year`);
    assert.equal(SHELF.bookUrl(b), `/assets/texts/${b.slug}.txt`);
    assert.equal(SHELF.findBook(b.slug), b);
  }
  const slugs = SHELF.books.map((b) => b.slug);
  assert.equal(new Set(slugs).size, slugs.length, "slugs key the shelf, so they are unique");
  const ids = SHELF.books.map((b) => b.gutenbergId);
  assert.equal(new Set(ids).size, ids.length, "one shelf entry per Gutenberg ebook");
  assert.equal(SHELF.findBook("no-such-book"), null);
});

test("every book on the shelf is on disk, and stripped of its licence wrapper", () => {
  for (const b of SHELF.books) {
    const text = read(b.slug);
    // The Yellow Wallpaper is the floor at ~31k characters — a short story, and
    // still four times the working budget, which is the point of shelving it.
    assert.ok(text.length > 25000, `${b.slug} is suspiciously short`);
    assert.doesNotMatch(text, /PROJECT GUTENBERG EBOOK/,
      `${b.slug} still carries a Gutenberg boundary marker`);
    assert.doesNotMatch(text, /START: FULL LICENSE/, `${b.slug} still carries the licence`);
    assert.doesNotMatch(text, /\r/, `${b.slug} has CRLF line endings`);
    assert.ok(text.endsWith("\n") && !text.endsWith("\n\n"),
      `${b.slug} does not end in exactly one newline`);
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
  // Each text opens with its own title page. 4,000 characters rather than 400
  // because a couple of these editions lead with an illustrated publisher's
  // plate — Pride and Prejudice spends most of a page on George Allen of
  // Charing Cross Road before it gets to Austen.
  const opening = (slug) => read(slug).slice(0, 4000).toLowerCase();
  const NAMES = {
    "the-yellow-wallpaper": "the yellow wallpaper",
    "narrative-of-frederick-douglass": "frederick douglass",
    "aesops-fables": "æsop’s fables",
    "the-awakening": "the awakening",
    "the-souls-of-black-folk": "the souls of black folk",
    "anne-of-green-gables": "anne of green gables",
    "arabian-nights": "the arabian nights entertainments",
    "pride-and-prejudice": "pride and prejudice",
    "dracula": "dracula",
    "jane-eyre": "jane eyre",
    "ulysses": "ulysses",
    "war-and-peace": "war and peace",
    "alice-in-wonderland": "alice’s adventures in wonderland",
    "the-time-machine": "the time machine",
    "frankenstein": "frankenstein",
    "moby-dick": "moby-dick",
  };
  for (const b of SHELF.books) {
    const name = NAMES[b.slug];
    assert.ok(name, `${b.slug} has no title-page phrase to check against`);
    assert.ok(opening(b.slug).includes(name), `${b.slug} does not open by naming "${name}"`);
  }
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
  // premise, not the answer. Two lessons are baked into this list: Lang's
  // selection of the Nights has no Ali Baba and no "Open, Sesame" in it, and the
  // Maude War and Peace transliterates with accents ("Anna Pávlovna"), so both
  // were corrected here rather than shipped as questions the book cannot answer.
  const PREMISES = {
    "the-yellow-wallpaper": ["John is a physician", "phosphates", "smooch", "creeping"],
    "narrative-of-frederick-douglass": ["Mrs. Auld", "Baltimore", "Covey", "Columbian Orator"],
    "aesops-fables": ["The Fox and the Grapes", "The Grapes are sour", "The Shepherd’s Boy and the Wolf",
      "Wolf! Wolf!", "The Hen and the Golden Eggs"],
    "the-awakening": ["Allez vous-en", "pigeon house", "Edna"],
    "the-souls-of-black-folk": ["double-consciousness", "Booker T. Washington"],
    "anne-of-green-gables": ["Carrots", "slate", "Anodyne Liniment", "Mrs. Allan"],
    "arabian-nights": ["The Story of the Fisherman", "genius", "the vase",
      "Aladdin and the Wonderful Lamp"],
    "pride-and-prejudice": ["In vain have I struggled", "Hunsford",
      "the last man in the world whom I could ever be prevailed on to marry",
      "Lady Catherine de Bourgh", "shades of Pemberley"],
    "dracula": ["Demeter", "Whitby", "the log", "Renfield", "The blood is the life"],
    "jane-eyre": ["red-room", "impediment", "Thornfield", "Bertha"],
    "ulysses": ["metempsychosis", "Plumtree", "potted meat", "What is home without"],
    "war-and-peace": ["Anna Pávlovna", "Pierre", "Platón Karatáev"],
    "alice-in-wonderland": ["DRINK ME", "EAT ME", "raven like a writing-desk", "Off with her head"],
    "the-time-machine": ["Eight Hundred and Two Thousand", "Morlock", "matches", "Eloi"],
    "frankenstein": ["Paradise Lost", "Plutarch", "Werter", "wedding-night", "glacier"],
    "moby-dick": ["nail it to the mast", "gold ounce", "Mapple", "Jonah", "coffin life-buoy"],
  };
  for (const b of SHELF.books) {
    assert.ok(PREMISES[b.slug], `${b.slug} has no verified premises`);
  }
  for (const [slug, phrases] of Object.entries(PREMISES)) {
    // whitespace is collapsed first: the source is hard-wrapped at ~72 columns,
    // so half of these phrases straddle a line break in the file
    const text = read(slug).replace(/\s+/g, " ");
    for (const phrase of phrases) {
      assert.ok(text.includes(phrase), `${slug} does not contain "${phrase}"`);
    }
  }
});

/* ── The regime helper ───────────────────────────────────────────── */

const { estimate, regimeOf, groupByRegime, SHELF_DEFAULTS, REGIMES, REGIME_ORDER } = SHELF;

/** a book of exactly this many tokens, at the default ratio */
const bookOf = (tokens) => ({ slug: "synthetic", chars: Math.round(tokens * SHELF_DEFAULTS.charsPerToken) });

test("the shelf's measured regimes, book by book", () => {
  // The figures this table asserts were measured on 2026-07-29 against the
  // committed files at 4.6 chars per token, a 200,000-token window and the
  // default 8,000-token budget. It is here so that a change to the derivation
  // has to be argued for rather than absorbed.
  const EXPECTED = {
    "the-yellow-wallpaper": ["budget-compact", 6847, 1, 1],
    "alice-in-wonderland": ["budget-compact", 31435, 1, 1],
    "the-time-machine": ["budget-compact", 39065, 1, 1],
    "narrative-of-frederick-douglass": ["budget-compact", 48694, 1, 1],
    "aesops-fables": ["budget-compact", 52969, 1, 1],
    "the-awakening": ["budget-compact", 78132, 2, 1],
    "the-souls-of-black-folk": ["budget-compact", 86743, 2, 1],
    "frankenstein": ["budget-compact", 91160, 2, 1],
    "anne-of-green-gables": ["budget-compact", 121988, 3, 1],
    "arabian-nights": ["budget-compact", 129964, 3, 1],
    "pride-and-prejudice": ["budget-compact", 158416, 3, 1],
    "dracula": ["oversize-fold", 183889, 4, 5],
    "jane-eyre": ["oversize-fold", 222257, 4, 5],
    "moby-dick": ["oversize-fold", 264987, 5, 6],
    "ulysses": ["cost-gated", 330371, 6, 7],
    "war-and-peace": ["cost-gated", 697451, 12, 13],
  };
  for (const b of SHELF.books) {
    const want = EXPECTED[b.slug];
    assert.ok(want, `${b.slug} is not in the measured table`);
    const est = estimate(b);
    const got = [est.regime, est.tokens, est.foldSections, est.compactCalls];
    assert.deepEqual(got, want, `${b.slug}: ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`);
  }
});

test("every book on this shelf compacts at the default budget", () => {
  // the always-on floor, stated as a test so it cannot quietly stop being true
  for (const b of SHELF.books) {
    const est = estimate(b);
    assert.ok(est.compactCalls >= 1, `${b.slug} would make no summarizer call`);
    assert.ok(est.tokens > est.autoCompactAt, `${b.slug} is under the auto-compaction threshold`);
    assert.notEqual(est.regime, "fits-budget");
  }
});

test("the fold threshold belongs to the sendable side", () => {
  const at = estimate(bookOf(SHELF_DEFAULTS.contextWindow * SHELF_DEFAULTS.oversizeAtRatio));
  assert.equal(at.oversizeAt, 160000);
  assert.equal(at.foldsOnArrival, false, "a payload exactly at the limit still fits");
  assert.equal(at.regime, "budget-compact");

  const over = estimate(bookOf(160000 + 200));
  assert.equal(over.foldsOnArrival, true);
  assert.equal(over.regime, "oversize-fold");
});

test("the auto-compaction threshold belongs to the quiet side", () => {
  const at = estimate(bookOf(SHELF_DEFAULTS.workingBudget * SHELF_DEFAULTS.compactAtRatio));
  assert.equal(at.autoCompactAt, 5600);
  assert.equal(at.compactCalls, 0);
  assert.equal(at.regime, "fits-budget");
  assert.equal(at.price, "no summarizer call");

  const over = estimate(bookOf(5601));
  assert.equal(over.compactCalls, 1);
  assert.equal(over.regime, "budget-compact");
});

test("the cost gate only ever applies to a book that folds", () => {
  // an expensive book that still fits the window is not gated: the gate is about
  // the fold's bill, and a book that fits makes one call whatever it costs
  const gated = estimate(bookOf(300000), { costGateUsd: 0.5 });
  assert.equal(gated.regime, "cost-gated");
  assert.equal(gated.costGated, true);

  const cheapGate = estimate(bookOf(300000), { costGateUsd: 5 });
  assert.equal(cheapGate.regime, "oversize-fold");
  assert.equal(cheapGate.costGated, false);

  // 150k tokens is $0.45 — over a $0.10 gate, but it never folds, so never gated
  const fitsButPricey = estimate(bookOf(150000), { costGateUsd: 0.1 });
  assert.ok(fitsButPricey.usd > 0.1);
  assert.equal(fitsButPricey.foldsOnArrival, false);
  assert.equal(fitsButPricey.costGated, false);
  assert.equal(fitsButPricey.regime, "budget-compact");
});

test("the gate is a boundary, not a range", () => {
  const exactly = estimate(bookOf(200000), { costGateUsd: 0.6 });
  assert.equal(exactly.usd, 0.6);
  assert.equal(exactly.costGated, false, "exactly at the gate is not over it");
  assert.equal(estimate(bookOf(200001), { costGateUsd: 0.6 }).costGated, true);
});

test("the verdict follows the config, which is why it is derived", () => {
  const wallpaper = SHELF.findBook("the-yellow-wallpaper");
  const pp = SHELF.findBook("pride-and-prejudice");
  const moby = SHELF.findBook("moby-dick");

  // raise the working budget past the book and nothing compacts any more
  assert.equal(regimeOf(wallpaper), "budget-compact");
  assert.equal(regimeOf(wallpaper, { workingBudget: 200000 }), "fits-budget");

  // shrink the model window and the book that "just fits" stops fitting
  assert.equal(regimeOf(pp), "budget-compact");
  assert.equal(regimeOf(pp, { contextWindow: 100000 }), "oversize-fold");

  // and the gate is a number, not a name: drop it and the stress test gates too
  assert.equal(regimeOf(moby), "oversize-fold");
  assert.equal(regimeOf(moby, { costGateUsd: 0.5 }), "cost-gated");

  // a cheaper model moves the bill without moving the mechanism
  const cheap = estimate(moby, { usdPerMillionTokens: 0.5 });
  assert.equal(cheap.regime, "oversize-fold");
  assert.equal(cheap.usdLabel, "$0.13");
  assert.equal(cheap.foldSections, estimate(moby).foldSections);

  // the ratio the page measures re-prices everything
  const measured = estimate(moby, { charsPerToken: 2.7 });
  assert.ok(measured.tokens > estimate(moby).tokens);
  assert.equal(measured.charsPerToken, 2.7);
});

test("the copy a tile prints says what happens and what it costs", () => {
  const est = estimate(SHELF.findBook("war-and-peace"));
  assert.equal(est.what, "folds into 12 parts on arrival");
  assert.equal(est.price, "~13 summarizer calls ≈ $2.09");
  assert.equal(est.line, "folds into 12 parts on arrival · ~13 summarizer calls ≈ $2.09");

  const one = estimate(SHELF.findBook("aesops-fables"));
  assert.equal(one.line, "compacts on your first question · ~1 summarizer call ≈ $0.16");

  // singular and plural both read as English, and a sub-cent bill is not "$0.00"
  assert.equal(estimate(bookOf(200000)).what, "folds into 4 parts on arrival");
  assert.equal(SHELF.usdLabel(0.004), "under a cent");
  assert.equal(SHELF.usdLabel(0), "$0.00");
  assert.equal(SHELF.usdLabel(2.0925), "$2.09");
});

test("grouping covers the shelf exactly once, cheapest regime first", () => {
  const groups = groupByRegime();
  assert.deepEqual(groups.map((g) => g.regime), ["budget-compact", "oversize-fold", "cost-gated"],
    "an empty regime prints no heading");
  const seen = groups.flatMap((g) => g.entries.map((e) => e.book.slug));
  assert.equal(seen.length, SHELF.books.length);
  assert.equal(new Set(seen).size, SHELF.books.length, "no book appears in two groups");
  for (const g of groups) {
    assert.ok(g.copy && g.copy.heading && g.copy.note, `${g.regime} has no heading copy`);
    const sizes = g.entries.map((e) => e.est.tokens);
    assert.deepEqual(sizes, sizes.slice().sort((a, b) => a - b), `${g.regime} is not smallest-first`);
  }
  assert.deepEqual(Object.keys(REGIMES).sort(), REGIME_ORDER.slice().sort(),
    "every regime the helper can return has copy, and vice versa");
});

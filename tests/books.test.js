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


/* ── The multilingual shelf ────────────────────────────────────────
   Nine originals in seven languages, and the same claims to check: the files
   exist, they are the works the tiles name, the counts are counted, and every
   needle question's premise is in the text. Two claims are new, and both are the
   reason this shelf is separate from the other one:

     it is STAGED. `books` is still sixteen and `findBook` still only knows those
     sixteen, because nothing renders the multilingual shelf yet. If a later
     change quietly merges the two, these assertions are what says so.

     the ratios are MEASURED. Every entry carries its own `charsPerToken`, and it
     is not the 3.0 that English carries — for the Japanese and Chinese files it
     is around 0.3, meaning three tokens per character. That number decides which
     regime a book lands in, so it is tested as a table rather than trusted.

   One thing genuinely has to differ, and pretending otherwise would be the
   dishonest option: the "a question shorter than 30 characters is not a real
   question" rule is about English. 「通靈寶玉是什麼來歷？」 is a whole question in
   twelve characters. So the floor is per script, and it is written down as such
   rather than smuggled in by padding the Chinese out to thirty. ── */

const I18N = SHELF.booksI18n;

/** ja and zh write no spaces, so a complete question is far shorter on the page */
const CJK = new Set(["ja", "zh"]);
const minQuestionChars = (lang) => (CJK.has(lang) ? 12 : 30);

test("nine works in seven languages, staged and not wired", () => {
  assert.equal(I18N.length, 9);
  const fields = ["slug", "title", "author", "year", "lang", "indexName", "source",
    "gutenbergId", "words", "chars", "charsPerToken", "hook", "chips"];
  for (const b of I18N) {
    for (const field of fields) {
      assert.ok(b[field] !== undefined, `${b.slug || "?"} is missing ${field}`);
    }
    assert.match(b.slug, /^[a-z0-9-]+$/, "a slug is also a filename");
    assert.match(b.lang, /^[a-z]{2}$/, `${b.slug}: lang is an ISO 639-1 code`);
    assert.equal(b.indexName, `public_domain_books_${b.lang}`,
      `${b.slug}: the index name is derived from the language, so it has to match it`);
    assert.equal(typeof b.charsPerToken, "number");
    assert.ok(b.charsPerToken > 0 && b.charsPerToken < 10,
      `${b.slug}: ${b.charsPerToken} is not a plausible chars-per-token ratio`);
    assert.equal(typeof b.year, "number");
    // `year` here is the WORK's year, not an edition's — these are originals, not
    // translations — so the window opens on Dante rather than on 1700.
    assert.ok(b.year > 1300 && b.year < 1950, `${b.slug}: ${b.year} is not a plausible year`);
    assert.equal(SHELF.bookUrl(b), `/assets/texts/${b.slug}.txt`);
    assert.ok(["gutenberg", "wikisource"].includes(b.source), `${b.slug}: unknown source`);
    // one implies the other: a Gutenberg text has an ebook number and the
    // Wikisource one cannot have, so a null id is not a missing field
    if (b.source === "wikisource") {
      assert.equal(b.gutenbergId, null, `${b.slug} is not on Gutenberg`);
      assert.ok(b.sourceHost && b.sourceTitle, `${b.slug}: no Wikisource page to re-fetch`);
    } else {
      assert.equal(typeof b.gutenbergId, "number", `${b.slug}: no Gutenberg id`);
    }
  }

  const slugs = I18N.map((b) => b.slug);
  assert.equal(new Set(slugs).size, slugs.length, "slugs key the shelf, so they are unique");
  // and unique ACROSS both shelves, because a slug is a filename under one folder
  const all = [...SHELF.books, ...I18N].map((b) => b.slug);
  assert.equal(new Set(all).size, all.length, "the two shelves share a texts folder");
  assert.equal(new Set(I18N.map((b) => b.lang)).size, 7, "seven languages, seven indices");

  // the staging tripwire: merging the shelves has to be a deliberate act
  assert.equal(SHELF.books.length, 16, "the English shelf did not grow");
  for (const b of I18N) {
    assert.equal(SHELF.findBook(b.slug), null, `${b.slug} is reachable through findBook`);
  }
});

test("every multilingual text is on disk, and stripped of its wrapper", () => {
  for (const b of I18N) {
    const text = read(b.slug);
    // 羅生門 is the floor at ~6,600 characters and it is the point of shelving it:
    // a text far under the working budget in characters and far over it in tokens.
    assert.ok(text.length > 6000, `${b.slug} is suspiciously short`);
    assert.doesNotMatch(text, /PROJECT GUTENBERG EBOOK/,
      `${b.slug} still carries a Gutenberg boundary marker`);
    assert.doesNotMatch(text, /START: FULL LICENSE/, `${b.slug} still carries the licence`);
    assert.doesNotMatch(text, /\r/, `${b.slug} has CRLF line endings`);
    assert.ok(text.endsWith("\n") && !text.endsWith("\n\n"),
      `${b.slug} does not end in exactly one newline`);
    if (b.source === "wikisource") {
      // the editorial layer is what the CC BY-SA covers, so none of it may survive
      assert.doesNotMatch(text, /\{\{|\}\}/, `${b.slug} still carries a wikitext template`);
      assert.doesNotMatch(text, /\[\[|\]\]/, `${b.slug} still carries a wiki link`);
      assert.doesNotMatch(text, /<ref|<\/ref>|<references/, `${b.slug} still carries a footnote`);
      assert.doesNotMatch(text, /^=+.*=+$/m, `${b.slug} still carries a wikitext heading`);
      assert.doesNotMatch(text, /&(?:nbsp|#160|amp|quot|lt|gt);/,
        `${b.slug} still carries an HTML entity`);
      assert.doesNotMatch(text, /\u00a0/, `${b.slug} kept a non-breaking space no query will type`);
    }
  }
});

test("the counted figures on the multilingual tiles are the files' own", () => {
  for (const b of I18N) {
    const text = read(b.slug);
    const words = text.split(/\s+/).filter(Boolean).length;
    assert.equal(b.chars, text.length, `${b.slug}: chars does not match the file`);
    assert.equal(b.words, words, `${b.slug}: words does not match the file`);
  }
  // and the number that shows why `words` stops being the useful figure: 羅生門 has
  // 6,597 characters and 256 whitespace-separated "words", which is not a word count
  const rashomon = I18N.find((b) => b.slug === "rashomon");
  assert.ok(rashomon.chars / rashomon.words > 20,
    "if this ratio is ordinary, the Japanese text is not Japanese any more");
});

test("each multilingual book is the book its tile names", () => {
  const opening = (slug) => read(slug).slice(0, 4000).toLowerCase();
  const NAMES = {
    rashomon: "羅生門",
    "fleurs-du-mal": "les fleurs du mal",
    faust: "faust",
    // the Wikisource transform strips the {{Отексте}} header, so this file has no
    // title page at all: it opens on its first section heading, which is as much
    // self-identification as the text itself carries
    "belye-nochi": "ночь первая",
    zarathustra: "also sprach zarathustra",
    "divina-commedia": "la divina commedia",
    "madame-bovary": "madame bovary",
    // this edition prints no title page either and opens straight into 第一回,
    // where the first paragraph names the work by its other title, 《石頭記》.
    // 紅樓夢 itself first appears 29,699 characters in.
    "honglou-meng": "石頭記",
    "don-quijote": "don quijote de la mancha",
  };
  for (const b of I18N) {
    const name = NAMES[b.slug];
    assert.ok(name, `${b.slug} has no title-page phrase to check against`);
    assert.ok(opening(b.slug).includes(name), `${b.slug} does not open by naming "${name}"`);
  }
});

test("every multilingual book offers both families of question", () => {
  for (const b of I18N) {
    // 羅生門 is 6,597 characters: one needle and one arc is the whole book covered,
    // and a fourth question about a nine-paragraph story would be padding
    assert.ok(b.chips.length >= 2 && b.chips.length <= 6,
      `${b.slug} has ${b.chips.length} chips`);
    const kinds = b.chips.map((c) => c.kind);
    assert.ok(kinds.includes("needle"), `${b.slug} has no needle question`);
    assert.ok(kinds.includes("arc"), `${b.slug} has no arc question`);
    for (const c of b.chips) {
      assert.ok(["needle", "arc"].includes(c.kind), `${b.slug}: unknown chip kind ${c.kind}`);
      const floor = minQuestionChars(b.lang);
      assert.ok(c.text.length > floor,
        `${b.slug}: "${c.text}" is under ${floor} characters, the floor for ${b.lang}`);
      assert.match(c.text, /[?？.。]$/, `${b.slug}: "${c.text}" is not a finished sentence`);
      // the handle is the page's own voice and the page speaks English
      assert.ok(c.short && c.short.length <= 30, `${b.slug}: "${c.short}" is not a short handle`);
      assert.match(c.short, /^[\x20-\x7e]+$/, `${b.slug}: "${c.short}" is not an English handle`);
      assert.ok(c.short.length < c.text.length, `${b.slug}: the handle is not shorter`);
    }
  }
});

test("every multilingual needle question's subject is actually in its book", () => {
  // one distinctive phrase per needle question, checked against the committed file
  // — the premise, not the answer. Two of these were corrected by running this:
  // Dante's gate reads "voi ch’intrate" with a curly apostrophe, so the phrase
  // stops before it, and Baudelaire's poem titles are printed in capitals, so
  // "Albatros" alone is not in the file while "L'ALBATROS" is.
  const PREMISES = {
    rashomon: ["老婆", "下人", "羅生門"],
    "fleurs-du-mal": ["AU LECTEUR", "Hypocrite lecteur", "L'ALBATROS", "prince des nuées"],
    faust: ["Verweile doch", "Wette", "des Pudels Kern", "Studierzimmer"],
    "belye-nochi": ["Настенька", "канал", "булавк"],
    zarathustra: ["Von den drei Verwandlungen", "Kameel", "Seiltänzer"],
    "divina-commedia": ["Lasciate ogne speranza", "Ugolino"],
    "madame-bovary": ["Charbovari", "comices agricoles"],
    "honglou-meng": ["通靈寶玉", "太虛幻境", "警幻仙"],
    "don-quijote": ["molinos de viento", "yelmo de Mambrino"],
  };
  for (const b of I18N) {
    assert.ok(PREMISES[b.slug], `${b.slug} has no verified premises`);
  }
  for (const [slug, phrases] of Object.entries(PREMISES)) {
    const text = read(slug).replace(/\s+/g, " ");
    for (const phrase of phrases) {
      assert.ok(text.includes(phrase), `${slug} does not contain "${phrase}"`);
    }
  }
});


/* ── The regime helper ─────────────────────────────────────────────
   Two fixtures stand in for the price list so this file never has to import the
   meter: they are shaped exactly like `DemoMeter.priceOf()`'s return, which is
   what `estimate` reads. One is a placeholder rate (the default model has no
   published price), one is a real list price, and the difference has to show up
   in the copy — that is the point of testing it. ── */

const { estimate, regimeOf, groupByRegime, SHELF_DEFAULTS, REGIMES, REGIME_ORDER } = SHELF;

const PLACEHOLDER_RATE = { label: "Enablers small", inPerMTok: 0.1, outPerMTok: 0.1, placeholder: true };
const LIST_RATE = { label: "claude-haiku-4.5", inPerMTok: 1.0, outPerMTok: 5.0 };

/** a book of exactly this many tokens, at the default ratio */
const bookOf = (tokens) => ({ slug: "synthetic", chars: Math.round(tokens * SHELF_DEFAULTS.charsPerToken) });

test("the shelf's measured regimes, book by book", () => {
  // Measured on 2026-07-29 against the committed files at 3 chars per token —
  // itself measured, not assumed: Alice is 144,600 characters and /context/trim
  // reported 48,116 tokens for it. Window 200,000, working budget 8,000. The
  // table is here so a change to the derivation has to be argued for rather than
  // absorbed: it moved once already, when the ratio turned out to be 3 and not
  // 4.6, and eight books changed regime.
  const EXPECTED = {
    "the-yellow-wallpaper": ["budget-compact", 10499, 1, 1],
    "alice-in-wonderland": ["budget-compact", 48200, 1, 1],
    "the-time-machine": ["budget-compact", 59900, 1, 1],
    "narrative-of-frederick-douglass": ["budget-compact", 74665, 2, 1],
    "aesops-fables": ["budget-compact", 81219, 2, 1],
    "the-awakening": ["budget-compact", 119802, 2, 1],
    "the-souls-of-black-folk": ["budget-compact", 133005, 3, 1],
    "frankenstein": ["budget-compact", 139779, 3, 1],
    "anne-of-green-gables": ["oversize-fold", 187048, 4, 5],
    "arabian-nights": ["oversize-fold", 199279, 4, 5],
    "pride-and-prejudice": ["oversize-fold", 242905, 5, 6],
    "dracula": ["oversize-fold", 281963, 5, 6],
    "jane-eyre": ["oversize-fold", 340793, 6, 7],
    "moby-dick": ["oversize-fold", 406313, 7, 8],
    "ulysses": ["oversize-fold", 506569, 9, 10],
    "war-and-peace": ["oversize-fold", 1069424, 18, 19],
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

test("half the shelf is now too large to send in one piece", () => {
  const folds = SHELF.books.filter((b) => estimate(b).foldsOnArrival).map((b) => b.slug).sort();
  assert.deepEqual(folds, [
    "anne-of-green-gables", "arabian-nights", "dracula", "jane-eyre",
    "moby-dick", "pride-and-prejudice", "ulysses", "war-and-peace",
  ]);
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

test("with no rate configured, no dollar figure is invented", () => {
  const est = estimate(SHELF.findBook("war-and-peace"));
  assert.equal(SHELF_DEFAULTS.price, null, "the shelf ships without a price of its own");
  assert.equal(est.usd, null);
  assert.equal(est.rate, null);
  assert.equal(est.rateNote, null);
  assert.equal(est.usdLabel, "cost depends on the model");
  assert.equal(est.price, "~19 summarizer calls · cost depends on the model");
  assert.equal(est.costGated, false, "an unknown bill is never gated — there is nothing to gate on");
});

test("the bill follows the model the visitor picked", () => {
  const wp = SHELF.findBook("war-and-peace");
  const cheap = estimate(wp, { price: PLACEHOLDER_RATE });
  const dear = estimate(wp, { price: LIST_RATE });

  // 1,069,424 tokens × $0.10 / MTok, and the same book at ten times the rate
  assert.equal(cheap.usdLabel, "$0.1069");
  assert.equal(dear.usdLabel, "$1.07");
  // the mechanism does not depend on the price, only the decision does
  assert.equal(cheap.foldSections, dear.foldSections);
  assert.equal(cheap.what, dear.what);
  assert.equal(cheap.costGated, false);
  assert.equal(dear.costGated, true);
});

test("a placeholder rate is labelled as one, on the tile itself", () => {
  const wp = SHELF.findBook("war-and-peace");
  assert.match(estimate(wp, { price: PLACEHOLDER_RATE }).price, /at an illustrative rate$/);
  assert.match(estimate(wp, { price: LIST_RATE }).price, /at a list price$/);
  assert.equal(estimate(wp, { price: PLACEHOLDER_RATE }).rateNote, "an illustrative rate");
  assert.equal(estimate(wp, { price: LIST_RATE }).rateNote, "a list price");
});

test("nothing on the shelf asks for a confirm at the default model's rate", () => {
  // the honest consequence of a $0.10/MTok rate: the most expensive book here is
  // ~11 cents, and putting a confirm in front of 11 cents is theatre
  for (const b of SHELF.books) {
    assert.equal(estimate(b, { price: PLACEHOLDER_RATE }).costGated, false, b.slug);
  }
});

test("switching to a pricier model raises the confirm by itself", () => {
  const gated = SHELF.books
    .filter((b) => estimate(b, { price: LIST_RATE }).costGated)
    .map((b) => b.slug);
  assert.deepEqual(gated, ["ulysses", "war-and-peace"]);
  for (const slug of gated) {
    assert.equal(regimeOf(SHELF.findBook(slug), { price: LIST_RATE }), "cost-gated");
  }
});

test("the gate is a boundary, not a range", () => {
  // 5,000,000 tokens at $0.10 / MTok is exactly $0.50, the default threshold
  const at = estimate(bookOf(5000000), { price: PLACEHOLDER_RATE });
  assert.equal(at.usd, 0.5);
  assert.equal(at.costGated, false, "exactly at the threshold is not over it");
  assert.equal(estimate(bookOf(5000001), { price: PLACEHOLDER_RATE }).costGated, true);
});

test("the gate is about money, not about mechanism", () => {
  // a book that fits the window whole still spends real money on its one compact
  // call, so an expensive one asks first even though it never folds
  const fits = estimate(bookOf(150000), { price: LIST_RATE, costConfirmUsd: 0.1 });
  assert.equal(fits.foldsOnArrival, false);
  assert.equal(fits.compactCalls, 1);
  assert.equal(fits.costGated, true);
  assert.equal(fits.regime, "cost-gated");
  // and a book that folds but costs nothing does not ask
  const free = estimate(bookOf(400000), { price: PLACEHOLDER_RATE });
  assert.equal(free.foldsOnArrival, true);
  assert.equal(free.costGated, false);
  assert.equal(free.regime, "oversize-fold");
});

test("the verdict follows the config, which is why it is derived", () => {
  const wallpaper = SHELF.findBook("the-yellow-wallpaper");
  const frank = SHELF.findBook("frankenstein");
  const moby = SHELF.findBook("moby-dick");

  // raise the working budget past the book and nothing compacts any more
  assert.equal(regimeOf(wallpaper), "budget-compact");
  assert.equal(regimeOf(wallpaper, { workingBudget: 200000 }), "fits-budget");

  // shrink the model window and the largest book that still fits stops fitting
  assert.equal(regimeOf(frank), "budget-compact");
  assert.equal(regimeOf(frank, { contextWindow: 100000 }), "oversize-fold");

  // the threshold is a number, not a name: lower it and the stress test asks first
  assert.equal(regimeOf(moby, { price: PLACEHOLDER_RATE }), "oversize-fold");
  assert.equal(regimeOf(moby, { price: PLACEHOLDER_RATE, costConfirmUsd: 0.01 }), "cost-gated");

  // the ratio the page measures re-prices everything
  const measured = estimate(moby, { charsPerToken: 4.6 });
  assert.ok(measured.tokens < estimate(moby).tokens);
  assert.equal(measured.charsPerToken, 4.6);
  assert.equal(estimate(moby).charsPerToken, 3);
});

test("the copy a tile prints says what happens and what it costs", () => {
  const est = estimate(SHELF.findBook("war-and-peace"), { price: PLACEHOLDER_RATE });
  assert.equal(est.what, "folds into 18 parts on arrival");
  assert.equal(est.price, "~19 summarizer calls ≈ $0.1069 at an illustrative rate");
  assert.equal(est.line,
    "folds into 18 parts on arrival · ~19 summarizer calls ≈ $0.1069 at an illustrative rate");

  const one = estimate(SHELF.findBook("aesops-fables"), { price: PLACEHOLDER_RATE });
  assert.equal(one.line,
    "compacts on your first question · ~1 summarizer call ≈ $0.0081 at an illustrative rate");

  // singular and plural both read as English
  assert.equal(estimate(bookOf(200000)).what, "folds into 4 parts on arrival");
  assert.equal(estimate(bookOf(161000)).what, "folds into 3 parts on arrival");

  // the money formatter is the meter's rule — four decimals under a dollar, two
  // above — and a caller may hand in the meter's own so the two cannot drift
  assert.equal(SHELF.formatUsd(0.0042), "$0.0042");
  assert.equal(SHELF.formatUsd(2.0925), "$2.09");
  assert.equal(SHELF.formatUsd(0), "$0.0000");
  assert.equal(
    estimate(SHELF.findBook("war-and-peace"), { price: LIST_RATE, formatUsd: (v) => `~${v.toFixed(1)} dollars` }).price,
    "~19 summarizer calls ≈ ~1.1 dollars at a list price");
});

/* ── The measured ratios, and what they cost ───────────────────────
   `estimate` now reads a per-book `charsPerToken` when the book carries one. Three
   things have to hold and only the first is obvious: the book's number is used,
   an explicit `opts` still beats it, and the English shelf — which carries no such
   field — is untouched. ── */

test("a book's own ratio beats the shelf default", () => {
  const zh = SHELF.booksI18n.find((b) => b.slug === "honglou-meng");
  assert.equal(estimate(zh).charsPerToken, 0.3);
  assert.equal(estimate(zh).tokens, Math.round(zh.chars / 0.3));

  // the English shelf carries no per-book ratio, so it still gets the default —
  // this is the assertion that says the change was backward-compatible
  const moby = SHELF.findBook("moby-dick");
  assert.equal(moby.charsPerToken, undefined);
  assert.equal(estimate(moby).charsPerToken, SHELF_DEFAULTS.charsPerToken);
  assert.equal(estimate(moby).charsPerToken, 3);
});

test("an explicit ratio beats the book's own", () => {
  // the precedence that matters and the one a passing suite could hide: a live
  // conversation re-measures on every probe, and that measurement is newer than
  // anything written in the manifest, so it has to win.
  const zh = SHELF.booksI18n.find((b) => b.slug === "honglou-meng");
  assert.equal(estimate(zh, { charsPerToken: 3 }).charsPerToken, 3);
  assert.equal(estimate(zh, { charsPerToken: 3 }).tokens, Math.round(zh.chars / 3));
  // and the book's value is not consulted at all when one is passed
  assert.notEqual(estimate(zh, { charsPerToken: 3 }).tokens, estimate(zh).tokens);
  // other options keep working alongside it
  assert.equal(estimate(zh, { charsPerToken: 3, workingBudget: 5000000 }).regime, "oversize-fold");
});

test("the multilingual shelf's measured regimes, book by book", () => {
  // Measured on 2026-07-30 with scripts/measure-tokens.js, one 50,000-character
  // sample per book through /1/unstable/context/trim. The table is here for the
  // same reason the English one is: a change to the derivation has to be argued
  // for rather than absorbed.
  const EXPECTED = {
    rashomon: ["budget-compact", 20616, 1, 1],
    "fleurs-du-mal": ["budget-compact", 62424, 2, 1],
    faust: ["budget-compact", 70582, 2, 1],
    zarathustra: ["oversize-fold", 179638, 3, 4],
    "divina-commedia": ["oversize-fold", 239323, 4, 5],
    "belye-nochi": ["oversize-fold", 261631, 5, 6],
    "madame-bovary": ["oversize-fold", 293443, 5, 6],
    "don-quijote": ["oversize-fold", 811818, 14, 15],
    "honglou-meng": ["oversize-fold", 3020297, 51, 52],
  };
  for (const b of SHELF.booksI18n) {
    const want = EXPECTED[b.slug];
    assert.ok(want, `${b.slug} is not in the measured table`);
    const est = estimate(b);
    const got = [est.regime, est.tokens, est.foldSections, est.compactCalls];
    assert.deepEqual(got, want, `${b.slug}: ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`);
  }
});

test("the measured ratio is what puts three books in the right regime", () => {
  // The whole argument for measuring per language, as two numbers rather than a
  // paragraph. Reusing English's 3.0 does not blur a label; it puts 羅生門 in the
  // group whose heading is "small enough that nothing happens" — a 6,600-character
  // story that in fact costs 20,616 tokens and folds nothing, and Белые ночи in the
  // group that is sent whole when it cannot be.
  const asEnglish = (b) => estimate(b, { charsPerToken: 3 });
  const ja = SHELF.booksI18n.find((b) => b.slug === "rashomon");
  assert.equal(estimate(ja).regime, "budget-compact");
  assert.equal(asEnglish(ja).regime, "fits-budget");
  assert.equal(asEnglish(ja).compactCalls, 0, "the wrong ratio hides a summarizer call");

  const ru = SHELF.booksI18n.find((b) => b.slug === "belye-nochi");
  assert.equal(estimate(ru).regime, "oversize-fold");
  assert.equal(asEnglish(ru).regime, "budget-compact");
  assert.equal(asEnglish(ru).foldsOnArrival, false, "the wrong ratio says this fits the window");
  assert.equal(estimate(ru).foldsOnArrival, true);

  // and one where it makes no difference, so the claim stays honest: 紅樓夢 is far
  // over the ceiling at either ratio, it only folds into fifty-one parts instead
  // of six
  const zh = SHELF.booksI18n.find((b) => b.slug === "honglou-meng");
  assert.equal(estimate(zh).regime, asEnglish(zh).regime);
  assert.ok(estimate(zh).foldSections > asEnglish(zh).foldSections * 5);
});

test("grouping still covers only the English shelf", () => {
  // groupByRegime reads BOOKS, and that is what "staged, not wired" means in code
  const seen = groupByRegime().flatMap((g) => g.entries.map((e) => e.book.slug));
  assert.equal(seen.length, 16);
  for (const b of SHELF.booksI18n) {
    assert.ok(!seen.includes(b.slug), `${b.slug} is being grouped and rendered`);
  }
});

test("grouping covers the shelf exactly once, cheapest regime first", () => {
  const groups = groupByRegime();
  assert.deepEqual(groups.map((g) => g.regime), ["budget-compact", "oversize-fold"],
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

  // the gate opens a third group without touching the manifest
  assert.deepEqual(groupByRegime({ price: LIST_RATE }).map((g) => g.regime),
    ["budget-compact", "oversize-fold", "cost-gated"]);
});

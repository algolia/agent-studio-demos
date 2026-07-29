/* ───────────────────────────────────────────────────────────────
   books.js — the bookshelf.

   Four public-domain books, downloaded from Project Gutenberg, stripped of
   their licence header and footer and committed under /assets/texts. Nothing
   else about the texts was edited: the title pages, chapter headings and the
   authors' own spelling are as Gutenberg serves them, because a demo that
   quietly rewrites its source cannot be checked against it.

   `chars` and `words` are counted from the committed file, not estimated — the
   tile's token figure is derived from `chars` by whatever chars-per-token ratio
   the page has measured so far, so it sharpens after the first trim probe
   instead of repeating a guess.

   The chips are questions with answers in the text. They come in two families
   and the distinction is the whole thesis of this demo:

     needle  one fact, one scene, one line. A search index answers this well:
             the phrase is either in the document or it is not.
     arc     the shape of the whole thing. No single passage holds the answer,
             so retrieval has nothing to retrieve — this is what carrying the
             book in context is for.

   Every needle question below was checked against the committed file before it
   was written down. A suggested question whose premise is not in the book reads
   as the product failing to answer, which is the one failure mode a demo cannot
   afford.

   Loaded as a plain script, like every other shared module here: no build step,
   and the tests can require this file unchanged.
   ─────────────────────────────────────────────────────────────── */

(function (global) {
  "use strict";

  const BOOKS = [
    {
      slug: "alice-in-wonderland",
      title: "Alice's Adventures in Wonderland",
      author: "Lewis Carroll",
      year: 1865,
      gutenbergId: 11,
      words: 26525,
      chars: 144600,
      hook: "the warm-up — short enough to read, long enough to overflow a small budget",
      chips: [
        { kind: "needle", short: "the bottle and the cake", text: "What is written on the bottle Alice drinks from, and on the cake she finds afterwards?" },
        { kind: "needle", short: "the Hatter's riddle", text: "What riddle does the Hatter ask at the tea party, and does anyone ever answer it?" },
        { kind: "needle", short: "off with her head", text: "What does the Queen of Hearts shout whenever she is crossed, and does anyone actually lose their head?" },
        { kind: "arc", short: "growing and shrinking", text: "Alice keeps changing size — how does the book use that as its running joke about growing up?" },
        { kind: "arc", short: "manners, start to trial", text: "Compare how politely Alice speaks to the creatures early on with how she speaks by the trial." },
      ],
    },
    {
      slug: "the-time-machine",
      title: "The Time Machine",
      author: "H. G. Wells",
      year: 1895,
      gutenbergId: 35,
      words: 32454,
      chars: 179699,
      hook: "one voice, one evening — a story told inside another story",
      chips: [
        { kind: "needle", short: "what year the dials read", text: "What year do the dials of the machine record when the Traveller first stops?" },
        { kind: "needle", short: "holding off the Morlocks", text: "What does the Traveller strike to hold the Morlocks back in the dark, and what happens when they run out?" },
        { kind: "needle", short: "the two peoples", text: "What are the two peoples of the far future called, and which of them lives underground?" },
        { kind: "arc", short: "the listeners' scepticism", text: "The tale is told at a dinner table — how does the listeners' scepticism shift from the first chapter to the epilogue?" },
        { kind: "arc", short: "paradise turning dark", text: "How does the future turn from a paradise into something worse as the Traveller learns more about it?" },
      ],
    },
    {
      slug: "frankenstein",
      title: "Frankenstein; or, The Modern Prometheus",
      author: "Mary Wollstonecraft Shelley",
      year: 1818,
      gutenbergId: 84,
      words: 75042,
      chars: 419337,
      hook: "three narrators nested inside each other, and none of them neutral",
      chips: [
        { kind: "needle", short: "the three books", text: "Which three books does the creature find, and what does he take from each of them?" },
        { kind: "needle", short: "the bargain on the glacier", text: "What does the creature promise Victor on the glacier in exchange for a companion?" },
        { kind: "needle", short: "the wedding-night threat", text: "What threat does the creature make about the wedding night, and who does he actually kill?" },
        { kind: "arc", short: "three narrators, one story", text: "Three narrators tell this story — Walton, Victor, the creature. How does each one undercut the others?" },
        { kind: "arc", short: "where sympathy moves", text: "At what point does sympathy move from Victor to the creature, and what moves it?" },
      ],
    },
    {
      slug: "moby-dick",
      title: "Moby-Dick; or, The Whale",
      author: "Herman Melville",
      year: 1851,
      gutenbergId: 2701,
      words: 212796,
      chars: 1218939,
      hook: "the stress test — 213k words, folded in sections before a single one is sent",
      chips: [
        { kind: "needle", short: "nailed to the mast", text: "What does Ahab nail to the mast, and what does he promise for it?" },
        { kind: "needle", short: "Father Mapple's sermon", text: "What does Father Mapple preach on before the voyage, and what does he say Jonah's sin was?" },
        { kind: "needle", short: "what saves Ishmael", text: "What keeps Ishmael afloat after the Pequod goes down, and whose was it?" },
        { kind: "arc", short: "tone, first page to last", text: "How does Ishmael's tone change from the first chapter to the last?" },
        { kind: "arc", short: "where the voyage turns", text: "The crew signs on for an ordinary whaling voyage — where does the ship's purpose turn into Ahab's hunt?" },
      ],
    },
  ];

  /** Root-absolute: the deployable root is `public/`, so this path holds for
      every demo on the site regardless of how deep its own folder sits. */
  function bookUrl(book) {
    return `/assets/texts/${book.slug}.txt`;
  }

  function findBook(slug) {
    return BOOKS.find((b) => b.slug === slug) || null;
  }

  global.DEMO_BOOKS = { books: BOOKS, bookUrl, findBook };
})(window);

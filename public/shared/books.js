/* ───────────────────────────────────────────────────────────────
   books.js — the bookshelf.

   Sixteen public-domain books, downloaded from Project Gutenberg, stripped of
   their licence header and footer and committed under /assets/texts. Nothing
   else about the texts was edited: the title pages, chapter headings and the
   translators' own spelling are as Gutenberg serves them, because a demo that
   quietly rewrites its source cannot be checked against it. `scripts/fetch-books.js`
   is that download-and-strip step written down, so any file here can be
   re-derived and diffed against what is committed.

   `chars` and `words` are counted from the committed file, not estimated —
   `tests/books.test.js` re-counts both and fails if a tile quotes a number the
   file does not have. Run `node scripts/fetch-books.js` and it prints the
   figures to paste in.

   The chips are questions with answers in the text. They come in two families
   and the distinction is the whole thesis of this demo:

     needle  one fact, one scene, one line. A search index answers this well:
             the phrase is either in the document or it is not.
     arc     the shape of the whole thing. No single passage holds the answer,
             so retrieval has nothing to retrieve — this is what carrying the
             book in context is for.

   Every needle question below was checked against the committed file before it
   was written down, with whitespace collapsed first (the source is hard-wrapped
   at ~72 columns, so half of these phrases straddle a line break). A suggested
   question whose premise is not in the book reads as the product failing to
   answer, which is the one failure mode a demo cannot afford.

   Loaded as a plain script, like every other shared module here: no build step,
   and the tests can require this file unchanged.
   ─────────────────────────────────────────────────────────────── */

(function (global) {
  "use strict";

  const BOOKS = [
    {
      slug: "the-yellow-wallpaper",
      title: "The Yellow Wallpaper",
      author: "Charlotte Perkins Gilman",
      year: 1892,
      gutenbergId: 1952,
      words: 6085,
      chars: 31498,
      hook: "the smallest thing on the shelf, and still too big for an 8k budget",
      chips: [
        { kind: "needle", short: "what John prescribes", text: "John is a physician\u00a0— what does he decide is wrong with his wife, and what does he prescribe for it?" },
        { kind: "needle", short: "the smooch on the wall", text: "There is a long smooch low down on the wall. What does the narrator work out has been making it?" },
        { kind: "arc", short: "the diary tightening", text: "The whole story is her secret journal\u00a0— how does the writing itself change from the first entry to the last?" },
        { kind: "arc", short: "the room as diagnosis", text: "How do the descriptions of the nursery\u00a0— the bars, the nailed bedstead, the torn paper\u00a0— track what is happening to her?" },
      ],
    },
    {
      slug: "narrative-of-frederick-douglass",
      title: "Narrative of the Life of Frederick Douglass",
      author: "Frederick Douglass",
      year: 1845,
      gutenbergId: 23,
      words: 40750,
      chars: 223994,
      hook: "a first-person argument, and every step of it is evidence",
      chips: [
        { kind: "needle", short: "who taught him letters", text: "Who begins teaching Douglass to read in Baltimore, and what makes her stop?" },
        { kind: "needle", short: "the fight with Covey", text: "What happens when Douglass finally fights back against Covey, and what does Covey do about it afterwards?" },
        { kind: "arc", short: "reading as the road out", text: "Douglass ties literacy to freedom again and again\u00a0— trace how that argument builds across the whole narrative." },
        { kind: "arc", short: "why the appendix exists", text: "How does the tone of the closing appendix on religion differ from the narrative it follows, and why does he add it?" },
      ],
    },
    {
      slug: "aesops-fables",
      title: "Three Hundred Æsop's Fables",
      author: "Aesop (trans. G. F. Townsend)",
      year: 1867,
      gutenbergId: 21,
      words: 44877,
      chars: 243658,
      hook: "three hundred separate fables\u00a0— the one book on this shelf where search should win outright",
      chips: [
        { kind: "needle", short: "what the fox says", text: "In The Fox and the Grapes, what exactly does the fox say as she turns away?" },
        { kind: "needle", short: "the boy's false alarms", text: "In The Shepherd's Boy and the Wolf, what does the boy shout, and what happens the time the wolf is real?" },
        { kind: "needle", short: "the golden eggs", text: "What does the man do to the hen that lays the golden eggs, and what does he get for it?" },
        { kind: "arc", short: "clever or good", text: "Across all three hundred fables, how often is the winner the clever one rather than the good one?" },
        { kind: "arc", short: "typecast animals", text: "Which animals does this collection cast as fools and which as schemers? Judge it across the whole book, not one fable." },
      ],
    },
    {
      slug: "the-awakening",
      title: "The Awakening",
      author: "Kate Chopin",
      year: 1899,
      gutenbergId: 160,
      words: 64028,
      chars: 359407,
      hook: "the Gutenberg edition carries Chopin's selected short stories after the novel, and they are in this file too",
      chips: [
        { kind: "needle", short: "the parrot's phrase", text: "What does the caged parrot in the opening scene keep repeating, and who is driven off by it?" },
        { kind: "needle", short: "the pigeon house", text: "What is the pigeon house, and why does Edna move into it?" },
        { kind: "arc", short: "two possible futures", text: "Adèle Ratignolle and Mademoiselle Reisz are two futures on offer\u00a0— how does the book set them against each other?" },
        { kind: "arc", short: "first swim to last", text: "How does Edna's sense of her own life change between the first swim at Grand Isle and the closing chapter?" },
      ],
    },
    {
      slug: "the-souls-of-black-folk",
      title: "The Souls of Black Folk",
      author: "W. E. B. Du Bois",
      year: 1903,
      gutenbergId: 408,
      words: 68628,
      chars: 399016,
      hook: "essays, a short story and printed music in one volume",
      chips: [
        { kind: "needle", short: "double-consciousness", text: "Where does Du Bois introduce double-consciousness, and how does he define it?" },
        { kind: "needle", short: "against Washington", text: "What is Du Bois's specific objection to Booker T. Washington's programme?" },
        { kind: "arc", short: "the Veil, essay by essay", text: "The Veil runs through every chapter\u00a0— how does what it stands for shift from the first essay to the sorrow songs?" },
        { kind: "arc", short: "what holds it together", text: "This book is argument, memoir, a short story and musical notation at once. What holds it together as one book?" },
      ],
    },
    {
      slug: "anne-of-green-gables",
      title: "Anne of Green Gables",
      author: "L. M. Montgomery",
      year: 1908,
      gutenbergId: 45,
      words: 102501,
      chars: 561144,
      hook: "the first book on the shelf too large to send in one piece",
      chips: [
        { kind: "needle", short: "carrots and the slate", text: "What does Anne do when Gilbert Blythe calls her Carrots?" },
        { kind: "needle", short: "the cake for Mrs. Allan", text: "What ruins the cake Anne bakes for Mrs. Allan, and how does she find out?" },
        { kind: "arc", short: "Marilla, softening", text: "How does Marilla's feeling for Anne change over the course of the book, and which moments move it?" },
        { kind: "arc", short: "imagination, scrape by scrape", text: "Anne's imagination causes every disaster and also rescues her\u00a0— trace that pattern through the whole novel." },
      ],
    },
    {
      slug: "arabian-nights",
      title: "The Arabian Nights Entertainments",
      author: "selected by Andrew Lang",
      year: 1898,
      gutenbergId: 128,
      words: 111597,
      chars: 597836,
      hook: "stories inside stories inside stories\u00a0— the frame is the thing retrieval cannot see",
      chips: [
        { kind: "needle", short: "the fisherman's net", text: "In The Story of the Fisherman, what does the fisherman bring up in his net, and how does he get the genius back into it?" },
        { kind: "needle", short: "Aladdin in the cave", text: "In Aladdin and the Wonderful Lamp, what does the magician want out of the cave, and why does Aladdin refuse to hand it over?" },
        { kind: "arc", short: "how many tellers deep", text: "By the time you reach the story of the Barber's Fifth Brother, how many storytellers are nested inside each other, and who is each one talking to?" },
        { kind: "arc", short: "told to stay alive", text: "Scheherazade tells stories to postpone her own death, and her characters do the same to postpone theirs. How does that shape the whole collection?" },
      ],
    },
    {
      slug: "pride-and-prejudice",
      title: "Pride and Prejudice",
      author: "Jane Austen",
      year: 1813,
      gutenbergId: 1342,
      words: 127359,
      chars: 728714,
      hook: "the most-read novel in English, and long past the size a single request can carry",
      chips: [
        { kind: "needle", short: "the first proposal", text: "How does Darcy open his first proposal at Hunsford, and what does Elizabeth say back to him?" },
        { kind: "needle", short: "Lady Catherine's visit", text: "What does Lady Catherine de Bourgh come to Longbourn to demand, and how does that visit backfire on her?" },
        { kind: "arc", short: "who is proud, who prejudiced", text: "Both words in the title are charges that land on both leads\u00a0— trace who learns which one is theirs." },
        { kind: "arc", short: "Elizabeth re-reading Darcy", text: "How does Elizabeth's judgment of Darcy change across the novel, and what actually changes it?" },
      ],
    },
    {
      slug: "dracula",
      title: "Dracula",
      author: "Bram Stoker",
      year: 1897,
      gutenbergId: 345,
      words: 161321,
      chars: 845890,
      hook: "letters, diaries, telegrams and news cuttings\u00a0— a novel assembled from documents",
      chips: [
        { kind: "needle", short: "the Demeter's log", text: "What does the log found aboard the Demeter at Whitby record about the voyage?" },
        { kind: "needle", short: "Renfield's collection", text: "What does Renfield keep in his cell at the asylum, and what does he say about blood?" },
        { kind: "arc", short: "a novel made of documents", text: "The book is assembled from diaries, letters, telegrams and news cuttings. How does that assembly change what a reader can trust?" },
        { kind: "arc", short: "from Lucy to Mina", text: "How does the hunt shift from being about Lucy to being about Mina, and what changes in the group along the way?" },
      ],
    },
    {
      slug: "jane-eyre",
      title: "Jane Eyre: An Autobiography",
      author: "Charlotte Brontë",
      year: 1847,
      gutenbergId: 1260,
      words: 185390,
      chars: 1022380,
      hook: "five houses, one narrator, and she is arguing with you the whole way",
      chips: [
        { kind: "needle", short: "the red-room", text: "What lands Jane in the red-room at Gateshead, and what happens to her while she is shut in it?" },
        { kind: "needle", short: "the interrupted wedding", text: "Who interrupts Jane's wedding, on what grounds, and what is she taken upstairs to see afterwards?" },
        { kind: "arc", short: "five houses, five Janes", text: "Gateshead, Lowood, Thornfield, Moor House, Ferndean\u00a0— how does each place change what Jane wants?" },
        { kind: "arc", short: "two refusals", text: "Jane refuses Rochester once and St. John Rivers once. What is she refusing each time, and is it the same refusal?" },
      ],
    },
    {
      slug: "ulysses",
      title: "Ulysses",
      author: "James Joyce",
      year: 1922,
      gutenbergId: 4300,
      words: 265059,
      chars: 1519708,
      hook: "one day, eighteen episodes, a different prose style in each\u00a0— and the ingest bill to match",
      chips: [
        { kind: "needle", short: "the word Molly asks about", text: "What word does Molly ask Bloom to explain at breakfast, and how does he explain it to her?" },
        { kind: "needle", short: "the potted meat ad", text: "What does the Plumtree's potted meat advertisement say, and why does Bloom keep coming back to it?" },
        { kind: "arc", short: "eighteen styles", text: "Every episode is written differently. How does the prose itself change from the Martello tower to the last chapter?" },
        { kind: "arc", short: "Bloom and Stephen circling", text: "Bloom and Stephen cross Dublin all day before they meet. Where do they finally meet, and what do they make of each other?" },
      ],
    },
    {
      slug: "war-and-peace",
      title: "War and Peace",
      author: "Leo Tolstoy (trans. L. and A. Maude)",
      year: 1869,
      gutenbergId: 2600,
      words: 563286,
      chars: 3208273,
      hook: "the biggest thing here by a factor of two, and the most expensive click on the page",
      chips: [
        { kind: "needle", short: "the soirée that opens it", text: "Whose Petersburg soirée opens the book, and which guest talks out of turn at it?" },
        { kind: "needle", short: "Karatáev in captivity", text: "What does Platón Karatáev teach Pierre while the two of them are prisoners?" },
        { kind: "arc", short: "who decides a battle", text: "Tolstoy keeps arguing that no commander really directs a battle. How does that argument build from Austerlitz to Borodinó?" },
        { kind: "arc", short: "Pierre and Natásha arriving", text: "Pierre and Natásha both spend the book trying to be someone other than themselves. Where do they end up, and what got them there?" },
      ],
    },
    {
      slug: "alice-in-wonderland",
      title: "Alice's Adventures in Wonderland",
      author: "Lewis Carroll",
      year: 1865,
      gutenbergId: 11,
      words: 26525,
      chars: 144600,
      hook: "the warm-up\u00a0— short enough to read, long enough to overflow a small budget",
      chips: [
        { kind: "needle", short: "the bottle and the cake", text: "What is written on the bottle Alice drinks from, and on the cake she finds afterwards?" },
        { kind: "needle", short: "the Hatter's riddle", text: "What riddle does the Hatter ask at the tea party, and does anyone ever answer it?" },
        { kind: "needle", short: "off with her head", text: "What does the Queen of Hearts shout whenever she is crossed, and does anyone actually lose their head?" },
        { kind: "arc", short: "growing and shrinking", text: "Alice keeps changing size\u00a0— how does the book use that as its running joke about growing up?" },
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
      hook: "one voice, one evening\u00a0— a story told inside another story",
      chips: [
        { kind: "needle", short: "what year the dials read", text: "What year do the dials of the machine record when the Traveller first stops?" },
        { kind: "needle", short: "holding off the Morlocks", text: "What does the Traveller strike to hold the Morlocks back in the dark, and what happens when they run out?" },
        { kind: "needle", short: "the two peoples", text: "What are the two peoples of the far future called, and which of them lives underground?" },
        { kind: "arc", short: "the listeners' scepticism", text: "The tale is told at a dinner table\u00a0— how does the listeners' scepticism shift from the first chapter to the epilogue?" },
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
        { kind: "arc", short: "three narrators, one story", text: "Three narrators tell this story\u00a0— Walton, Victor, the creature. How does each one undercut the others?" },
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
      hook: "the stress test\u00a0— 213k\u00a0words, folded in sections before a single one is sent",
      chips: [
        { kind: "needle", short: "nailed to the mast", text: "What does Ahab nail to the mast, and what does he promise for it?" },
        { kind: "needle", short: "Father Mapple's sermon", text: "What does Father Mapple preach on before the voyage, and what does he say Jonah's sin was?" },
        { kind: "needle", short: "what saves Ishmael", text: "What keeps Ishmael afloat after the Pequod goes down, and whose was it?" },
        { kind: "arc", short: "tone, first page to last", text: "How does Ishmael's tone change from the first chapter to the last?" },
        { kind: "arc", short: "where the voyage turns", text: "The crew signs on for an ordinary whaling voyage\u00a0— where does the ship's purpose turn into Ahab's hunt?" },
      ],
    },
  ];

  /* ── What happens when you click, and what it costs ────────────────
     A tile that says only "561,144 characters" tells a reader nothing they can
     act on. What they want to know is: will this fold, how many API calls is
     that, and what will it cost me. All three are derivable from the size and
     the config, so they are derived — there is no per-book verdict written down
     anywhere in this file. Change the working budget, the model window or the
     price and every label on the shelf changes with it, which is the only way a
     label like this stays true.

     Two thresholds, and conflating them is the mistake to avoid:

       auto-compaction     fires at compactAtRatio × workingBudget. The working
                           budget is a demo device — small on purpose so the
                           fold is observable. At the default 8,000 that is
                           5,600 tokens, which EVERY book here is over. The
                           always-on floor, not an edge case.

       hierarchical fold   fires at oversizeAtRatio × the model's REAL window,
                           the ceiling the provider enforces. At the default
                           0.8 × 200,000 that is 160,000 tokens, which only the
                           four biggest books reach. Past it nothing can be
                           sent, and a single compact call would overflow the
                           summarizer the same way — so the document is
                           summarized in sections first.

     `charsPerToken` defaults to 3, and that number was measured rather than
     assumed: Alice's committed text is 144,600 characters and /context/trim
     reported 48,116 tokens for it on the default model, which is 3.006 chars per
     token. It is deliberately NOT the 4 that config.js carries as its pre-probe
     fold-sizing fallback — that one only has to keep a section small enough to
     summarize, where guessing high is harmless. Here a wrong ratio moves a book
     into the wrong regime, so it is the measurement. A live conversation
     re-measures on every probe; pass that ratio in and the labels sharpen.

     The money is not a constant either. It comes from the price of whichever
     model is selected — `DemoMeter.priceOf(name)` returns exactly the object
     `opts.price` wants — because a bill quoted at a rate the visitor is not
     paying is worse than no bill. The default model's rate is a PLACEHOLDER
     (meter.js says so in those words), so the copy below says so too. ── */

  const SHELF_DEFAULTS = {
    /** the model's real published window — the provider's hard ceiling */
    contextWindow: 200000,
    /** share of that window above which a document is folded on arrival */
    oversizeAtRatio: 0.8,
    /** the demo's working budget, which the meter fills against */
    workingBudget: 8000,
    /** share of the working budget at which auto-compaction fires */
    compactAtRatio: 0.7,
    /** measured against /context/trim on Alice, 144,600 chars → 48,116 tokens */
    charsPerToken: 3,
    /** target size of one section handed to the summarizer (CFG.foldChunkTokens) */
    foldSectionTokens: 60000,
    /**
     * A price object shaped like DemoMeter.priceOf()'s return:
     * { label, inPerMTok, outPerMTok, placeholder }. Null means no rate is known,
     * and then no dollar figure is invented — the copy says the cost depends on
     * the model instead of quoting a number nobody set.
     */
    price: null,
    /**
     * Above this estimated ingest cost a book asks before it spends. It is
     * compared against the estimate AT THE SELECTED MODEL'S RATE, so the gate is
     * a function of what the visitor actually chose: on the default model's
     * $0.10/MTok nothing here reaches it, and switching to a pricier model makes
     * the confirm appear on the largest books by itself.
     */
    costConfirmUsd: 0.5,
    /** mirrors meter.js's `usd`, so a tile and the cost strip agree to the digit */
    formatUsd: defaultFormatUsd,
  };

  /** 4 decimals under a dollar, 2 above — the same rule as the meter's `usd` */
  function defaultFormatUsd(v) {
    const n = Number.isFinite(v) ? v : 0;
    return `$${Math.abs(n) < 1 ? n.toFixed(4) : n.toFixed(2)}`;
  }

  /** the four regimes, with the copy a grouped shelf needs for each */
  const REGIMES = {
    "fits-budget": {
      label: "fits the budget",
      heading: "Small enough that nothing happens",
      note: "Under the auto-compaction threshold: the whole text rides along untouched, " +
        "no summarizer call. At the default 8,000-token budget nothing lands here\u00a0— " +
        "raise the budget and books start arriving.",
    },
    "budget-compact": {
      label: "compacts on your first question",
      heading: "Sent whole, then compacted on your first question",
      note: "These fit the model's real window in one piece, so nothing folds on " +
        "arrival. They are far over the working budget, though\u00a0— the first question " +
        "triggers one summarizer call over the whole text.",
    },
    "oversize-fold": {
      label: "folds on arrival",
      heading: "Too large to send at all\u00a0— folded on arrival",
      note: "Past 0.8 × the real window nothing can be sent\u00a0— one compact call would " +
        "overflow the summarizer too. So: summarized in sections on arrival, joined " +
        "into one digest. Every section stays reopenable.",
    },
    "cost-gated": {
      label: "asks before it spends",
      heading: "Worth reading the price before you click",
      note: "Same mechanics as above, with a bill worth a decision: the summarizer " +
        "reads every word once, on your credentials, so these ask first. Which books " +
        "land here depends on the model\u00a0— change it and this group changes.",
    },
  };

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  /**
   * Everything a tile needs to price itself, derived from `book.chars` and the
   * config. Pass any subset of SHELF_DEFAULTS to override.
   *
   * → { regime, tokens, foldsOnArrival, foldSections, compactCalls, usd,
   *     usdLabel, rateNote, costGated, oversizeAt, autoCompactAt, what, price,
   *     line, charsPerToken, price object echoed as `rate` }
   */
  function estimate(book, opts) {
    const cfg = Object.assign({}, SHELF_DEFAULTS, opts || {});
    const tokens = Math.round(book.chars / cfg.charsPerToken);
    const oversizeAt = Math.round(cfg.contextWindow * cfg.oversizeAtRatio);
    const autoCompactAt = Math.round(cfg.workingBudget * cfg.compactAtRatio);

    const foldsOnArrival = tokens > oversizeAt;
    /** how many sections the fold would cut this into — a pure function of size */
    const foldSections = Math.max(1, Math.ceil(tokens / cfg.foldSectionTokens));

    /**
     * A folded document costs one call per section plus one reduce call that
     * joins the summaries. A document that fits is sent whole and compacted
     * once, by the auto-compaction the budget triggers — and if it is under even
     * that threshold, never at all.
     */
    const compactCalls = foldsOnArrival
      ? foldSections + 1
      : (tokens > autoCompactAt ? 1 : 0);

    /* The summarizer reads the whole text once either way, which is what this
       bill is: input tokens at the selected model's input rate. The reduce pass
       reads only the section summaries, a rounding error beside the book itself,
       and output tokens are capped small by config. Estimate, not invoice. */
    const rate = cfg.price || null;
    const usd = rate ? (tokens * rate.inPerMTok) / 1e6 : null;
    /**
     * Money only. A cheap book that folds is one click; an expensive book is a
     * decision whether or not it folds, because it is the visitor's provider
     * account either way.
     */
    const costGated = usd !== null && usd > cfg.costConfirmUsd;

    const regime = costGated ? "cost-gated"
      : foldsOnArrival ? "oversize-fold"
        : compactCalls > 0 ? "budget-compact" : "fits-budget";

    const what = foldsOnArrival
      ? `folds into ${plural(foldSections, "part", "parts")} on arrival`
      : compactCalls > 0
        ? "compacts on your first question"
        : "fits the working budget whole";

    /* "illustrative" is not decoration: the default model has no published price,
       so its rate in meter.js is a placeholder. A figure derived from a made-up
       rate has to carry that on its face, not only in a tooltip. */
    const rateNote = rate ? (rate.placeholder ? "an illustrative rate" : "a list price") : null;
    const calls = plural(compactCalls, "summarizer call", "summarizer calls");
    const price = compactCalls === 0
      ? "no summarizer call"
      : usd === null
        ? `~${calls} · cost depends on the model`
        : `~${calls} ≈ ${cfg.formatUsd(usd)} at ${rateNote}`;

    return {
      regime,
      tokens,
      charsPerToken: cfg.charsPerToken,
      oversizeAt,
      autoCompactAt,
      foldsOnArrival,
      foldSections,
      compactCalls,
      rate,
      rateNote,
      usd,
      usdLabel: usd === null ? "cost depends on the model" : cfg.formatUsd(usd),
      costGated,
      costConfirmUsd: cfg.costConfirmUsd,
      what,
      price,
      line: `${what} · ${price}`,
    };
  }

  /** just the verdict, for grouping */
  function regimeOf(book, opts) {
    return estimate(book, opts).regime;
  }

  /**
   * The shelf in reading order for a grouped view: cheapest regime first, and
   * within a group smallest book first. Returns only the groups that have books
   * in them, so an empty regime never prints a heading with nothing under it.
   */
  const REGIME_ORDER = ["fits-budget", "budget-compact", "oversize-fold", "cost-gated"];

  function groupByRegime(opts) {
    const buckets = new Map();
    for (const book of BOOKS) {
      const est = estimate(book, opts);
      if (!buckets.has(est.regime)) buckets.set(est.regime, []);
      buckets.get(est.regime).push({ book, est });
    }
    return REGIME_ORDER
      .filter((key) => buckets.has(key))
      .map((key) => ({
        regime: key,
        copy: REGIMES[key],
        entries: buckets.get(key).sort((a, b) => a.est.tokens - b.est.tokens),
      }));
  }

  /** Root-absolute: the deployable root is `public/`, so this path holds for
      every demo on the site regardless of how deep its own folder sits. */
  function bookUrl(book) {
    return `/assets/texts/${book.slug}.txt`;
  }

  function findBook(slug) {
    return BOOKS.find((b) => b.slug === slug) || null;
  }

  global.DEMO_BOOKS = {
    books: BOOKS,
    bookUrl,
    findBook,
    SHELF_DEFAULTS,
    REGIMES,
    REGIME_ORDER,
    estimate,
    regimeOf,
    groupByRegime,
    formatUsd: defaultFormatUsd,
  };
})(window);

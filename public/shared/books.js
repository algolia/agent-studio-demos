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

   `charsPerToken` is measured per BOOK, through /context/trim, by
   `scripts/measure-tokens.js`. Not per language: English alone runs from 2.98 on
   Alice to 4.02 on The Time Machine, a 35% spread, so a tile priced at the shelf
   average is priced from a book the reader is not looking at. The spread is not
   cosmetic — one shared 3.0 was folding the Nights, which at its own 3.95 fits
   the window whole.

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
      charsPerToken: 3.50,
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
      charsPerToken: 3.97,
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
      charsPerToken: 3.62,
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
      charsPerToken: 3.62,
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
      charsPerToken: 3.90,
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
      charsPerToken: 3.27,
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
      charsPerToken: 3.95,
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
      charsPerToken: 3.84,
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
      charsPerToken: 3.79,
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
      charsPerToken: 3.63,
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
      charsPerToken: 3.42,
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
      charsPerToken: 3.41,
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
      charsPerToken: 2.98,
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
      charsPerToken: 4.02,
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
      charsPerToken: 3.94,
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
      charsPerToken: 3.70,
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

  /* ── The multilingual shelf ────────────────────────────────────────
     Nine works in seven languages, none of them a translation: this is the shelf
     that asks whether any of the above generalises past English.

     It stays a SEPARATE array now that the page renders it. `books` is the
     English shelf and `groupByRegime` groups that one; the originals get their
     own section, because "grouped by what happens when you click" and "in the
     language it was written in" are two different sorts and stacking them would
     scatter nine books across four headings.

     Two fields the English shelf does not carry:

       lang           ISO 639-1, and the reason there is more than one index.
                      `indexLanguages` is a settings-global — it cannot vary per
                      record — and CJK segmentation only happens when the CJK
                      language is declared on the index itself. So ja and zh
                      cannot share, and once split for those two there is no
                      reason to leave the rest mixed.
       indexName      where this book's passages live. Derived from `lang`, and
                      written down anyway: a UI that has to reconstruct a
                      destination is a UI that can get it wrong.

     `charsPerToken` is measured here exactly as it is on the English shelf, and
     the numbers are a different order of magnitude: around 0.3 for ja and zh,
     three tokens to the character. A wrong ratio does not just blur a label, it
     moves a book into the wrong regime.

     `year` here is the WORK's year of publication, not an edition's. The English
     shelf dates its files to the edition because half of them are translations
     whose language is the translator's; these are originals, so the work's own
     date is both the honest number and the interesting one — 1321 to 1927.

     `source` says where the text came from. Eight are Gutenberg. Белые ночи is
     not on Gutenberg as plain text at all, so it comes from ru.wikisource.org as
     wikitext, and `gutenbergId` is null for it. The novel is public domain (1848,
     PD-RusEmpire); Wikisource's CC BY-SA covers the editorial layer — footnotes,
     source notes, navigation — and scripts/wikisource.js removes all of it.

     Needle questions are in the book's own language, because they are sent to the
     model and that is the demo: a Japanese question about a Japanese text, hitting
     an index with Japanese segmentation. The `short` handle and the `hook` stay in
     English — those are the page's own voice, and the page speaks English. ── */

  const BOOKS_I18N = [
    {
      slug: "rashomon",
      lang: "ja",
      indexName: "public_domain_books_ja",
      title: "羅生門",
      author: "芥川龍之介",
      year: 1915,
      source: "gutenberg",
      gutenbergId: 1982,
      words: 256,
      chars: 6597,
      charsPerToken: 0.32,
      hook: "6,597\u00a0characters and almost no spaces — counting words stops working here",
      chips: [
        { kind: "needle", short: "the old woman upstairs", text: "羅生門の楼の上で、下人は老婆が死人に何をしているところを見つけましたか。" },
        { kind: "arc", short: "hunger against theft", text: "下人の心が飢えと盗みのあいだをどう動いていくか、話の始めから終わりまで追ってください。" },
      ],
    },
    {
      slug: "fleurs-du-mal",
      lang: "fr",
      indexName: "public_domain_books_fr",
      title: "Les Fleurs du Mal",
      author: "Charles Baudelaire",
      year: 1857,
      source: "gutenberg",
      gutenbergId: 6099,
      words: 24759,
      chars: 155437,
      charsPerToken: 2.49,
      hook: "poems, not chapters — a hundred short sections instead of one long argument",
      chips: [
        { kind: "needle", short: "the reader addressed", text: "Par quels mots le poème liminaire Au lecteur s'adresse-t-il au lecteur, tout à la fin?" },
        { kind: "needle", short: "the albatross", text: "Dans L'Albatros, à quoi le poète est-il comparé, et qu'est-ce qui le rend maladroit à terre?" },
        { kind: "arc", short: "spleen against ideal", text: "Le recueil oppose le spleen et l'idéal. Comment cette tension se déplace-t-elle d'une section à l'autre?" },
        { kind: "arc", short: "the city as a subject", text: "Comment Paris apparaît-il à travers le recueil entier, plutôt que dans un seul poème?" },
      ],
    },
    {
      slug: "faust",
      lang: "de",
      indexName: "public_domain_books_de",
      title: "Faust: Der Tragödie erster Teil",
      author: "Johann Wolfgang von Goethe",
      year: 1808,
      source: "gutenberg",
      gutenbergId: 2229,
      words: 30658,
      chars: 187749,
      charsPerToken: 2.66,
      hook: "a verse drama: speakers and stage directions where the others have paragraphs",
      chips: [
        { kind: "needle", short: "the wager's words", text: "Mit welchen Worten beschreibt Faust den Augenblick, für den er seine Wette verlieren würde?" },
        { kind: "needle", short: "the poodle", text: "Was stellt sich als der Kern des schwarzen Pudels heraus, den Faust in sein Studierzimmer mitnimmt?" },
        { kind: "arc", short: "Gretchen's descent", text: "Verfolge Gretchens Weg von der ersten Begegnung auf der Straße bis zur Szene im Kerker." },
        { kind: "arc", short: "who has the upper hand", text: "Wer führt im ersten Teil wen, Faust oder Mephistopheles? Begründe es über das ganze Stück." },
      ],
    },
    {
      slug: "belye-nochi",
      lang: "ru",
      indexName: "public_domain_books_ru",
      title: "Белые ночи",
      author: "Фёдор Михайлович Достоевский",
      year: 1848,
      source: "wikisource",
      sourceHost: "ru.wikisource.org",
      sourceTitle: "Белые ночи (Достоевский)",
      gutenbergId: null,
      words: 17457,
      chars: 102036,
      charsPerToken: 0.39,
      hook: "the one text here that is not on Gutenberg — Wikisource, footnotes stripped",
      chips: [
        { kind: "needle", short: "her name", text: "Как зовут девушку, которую рассказчик встречает у канала, и когда она называет своё имя?" },
        { kind: "needle", short: "pinned to grandmother", text: "Каким образом бабушка удерживала Настеньку дома, чтобы та никуда не уходила?" },
        { kind: "arc", short: "four nights and a morning", text: "Проследи, как меняется настроение рассказчика от первой ночи до утра, ночь за ночью." },
        { kind: "arc", short: "the dreamer explained", text: "Рассказчик называет себя мечтателем. Как повесть объясняет этот характер на всём своём протяжении?" },
      ],
    },
    {
      slug: "zarathustra",
      lang: "de",
      indexName: "public_domain_books_de",
      title: "Also sprach Zarathustra",
      author: "Friedrich Nietzsche",
      year: 1885,
      source: "gutenberg",
      gutenbergId: 7205,
      words: 82955,
      chars: 519153,
      charsPerToken: 2.89,
      hook: "printed in Nietzsche's own 1885 spelling, which is not modern German",
      chips: [
        { kind: "needle", short: "the three changes", text: "Welche drei Verwandlungen des Geistes nennt Zarathustra, und in welcher Reihenfolge?" },
        { kind: "needle", short: "the tightrope walker", text: "Was geschieht mit dem Seiltänzer auf dem Markt, und was sagt Zarathustra danach zu ihm?" },
        { kind: "arc", short: "one claim, then a book", text: "Zarathustra sagt früh, Gott sei todt. Wie baut das Buch von dieser Stelle an alles Weitere darauf?" },
        { kind: "arc", short: "the last man", text: "Wie stellt das Buch den letzten Menschen dem Übermenschen gegenüber, über alle Teile hinweg?" },
      ],
    },
    {
      slug: "divina-commedia",
      lang: "it",
      indexName: "public_domain_books_it",
      title: "La Divina Commedia",
      author: "Dante Alighieri",
      year: 1321,
      source: "gutenberg",
      gutenbergId: 1000,
      words: 97779,
      chars: 533690,
      charsPerToken: 2.23,
      hook: "a hundred cantos of terza rima, where the line breaks are the structure",
      chips: [
        { kind: "needle", short: "the gate's words", text: "Che cosa è scritto sopra la porta dell'Inferno, e come reagisce Dante quando la legge?" },
        { kind: "needle", short: "Ugolino in the ice", text: "Che cosa racconta il conte Ugolino a Dante nel ghiaccio, e che cosa fa mentre parla?" },
        { kind: "arc", short: "where the guide changes", text: "Segui il passaggio delle guide, da Virgilio a Beatrice: dove avviene, e perché proprio lì?" },
        { kind: "arc", short: "light, canto by canto", text: "Come cambia la luce dalla selva oscura fino all'ultimo canto del Paradiso?" },
      ],
    },
    {
      slug: "madame-bovary",
      lang: "fr",
      indexName: "public_domain_books_fr",
      title: "Madame Bovary",
      author: "Gustave Flaubert",
      year: 1857,
      source: "gutenberg",
      gutenbergId: 14155,
      words: 112516,
      chars: 683723,
      charsPerToken: 2.33,
      hook: "long French paragraphs, so a passage here holds more than one in verse does",
      chips: [
        { kind: "needle", short: "his mangled name", text: "Comment le nouvel élève prononce-t-il son nom devant la classe, au premier chapitre?" },
        { kind: "needle", short: "the agricultural show", text: "Que se passe-t-il entre Emma et Rodolphe pendant les comices agricoles?" },
        { kind: "arc", short: "debt closing in", text: "Retrace comment les dettes d'Emma s'accumulent, de la première dépense chez Lheureux à la fin." },
        { kind: "arc", short: "Charles all along", text: "Comment le roman traite-t-il Charles, du premier chapitre au dernier? Juge-le sur l'ensemble." },
      ],
    },
    {
      slug: "honglou-meng",
      lang: "zh",
      indexName: "public_domain_books_zh",
      title: "紅樓夢",
      author: "曹雪芹",
      year: 1791,
      source: "gutenberg",
      gutenbergId: 24264,
      words: 35000,
      chars: 906089,
      charsPerToken: 0.30,
      hook: "906k\u00a0characters of traditional Chinese in 424 paragraphs — long ones",
      chips: [
        { kind: "needle", short: "the jade", text: "通靈寶玉是什麼來歷？賈寶玉為什麼一生下來就帶著它？" },
        { kind: "needle", short: "the dream in chapter five", text: "賈寶玉在太虛幻境裡看見了什麼？警幻仙姑又給他看了哪些冊子？" },
        { kind: "arc", short: "the garden's decline", text: "大觀園從建成到衰敗經歷了哪些變化？請就整部書來看，不要只看一回。" },
        { kind: "arc", short: "who is telling this", text: "這部書的敘事聲音從第一回到最後一回有什麼變化？" },
      ],
    },
    {
      slug: "don-quijote",
      lang: "es",
      indexName: "public_domain_books_es",
      title: "El ingenioso hidalgo don Quijote de la Mancha",
      author: "Miguel de Cervantes Saavedra",
      year: 1615,
      source: "gutenberg",
      gutenbergId: 2000,
      words: 386614,
      chars: 2110727,
      charsPerToken: 2.60,
      hook: "the largest work on either shelf but War and Peace — both parts, one file",
      chips: [
        { kind: "needle", short: "the windmills", text: "¿Qué cree don Quijote que son los molinos de viento, y cómo acaba su ataque al primero?" },
        { kind: "needle", short: "Mambrino's helmet", text: "¿Qué objeto corriente toma don Quijote por el yelmo de Mambrino, y a quién se lo quita?" },
        { kind: "arc", short: "knight and squire", text: "Sigue cómo cambia la relación entre don Quijote y Sancho desde la primera salida hasta el final." },
        { kind: "arc", short: "part one inside part two", text: "En la segunda parte los personajes ya han leído la primera. ¿Cómo cambia eso el tono del libro?" },
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
                           0.8 × 200,000 that is 160,000 tokens, which seven of
                           the sixteen reach. Past it nothing can be
                           sent, and a single compact call would overflow the
                           summarizer the same way — so the document is
                           summarized in sections first.

     `charsPerToken` comes from the book itself; this default only serves a book
     that has none — a pasted document, a fetched page — and it was measured
     rather than assumed: Alice's committed text is 144,600 characters and
     /context/trim reported 48,116 tokens for it on the default model, which is
     3.006 chars per token. It is deliberately NOT the 4 that config.js carries as
     its pre-probe fold-sizing fallback — that one only has to keep a section small enough to
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
    /**
     * The other line, and the reason there are two: money alone lets a cheap
     * model make a big thing look free. 紅樓夢 is 3,020,297 tokens and 51
     * summarizer calls; at the default $0.10/MTok that is $0.30, under the money
     * line, and it would start without a word — the largest fold on the shelf,
     * unannounced.
     *
     * 500,000 tokens is 2.5 times the default window: past it a fold is a
     * deliberate act rather than a big book. Deliberately NOT low enough to catch
     * Moby-Dick (329,443) or Ulysses (444,359) — those are the demo's own hero
     * flows and a confirm in front of them would be the theatre the money line
     * was careful to avoid. Three books reach it: Don Quijote (811,818), War and
     * Peace (940,843) and 紅樓夢.
     *
     * Unlike the money line this one holds with no rate configured at all. A
     * price nobody set cannot be compared; three million tokens can.
     */
    costConfirmTokens: 500000,
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
        "reads every word once, on your credentials, so these ask first. Two lines put a " +
        "book here: the money at the model you picked, or half a million tokens whatever " +
        "the rate. Change the model and the money line moves this group; the token line " +
        "does not move.",
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
  /**
   * Precedence, highest first, and the middle rule is the one that was wrong:
   *
   *   opts.charsPerToken         an explicit override. A caller who says a number
   *                              outright means it — pasted text, a fetched page,
   *                              a test fixture.
   *   book.charsPerToken         THIS book's own measurement, and it beats the
   *                              live probe. See below.
   *   opts.probedCharsPerToken   what the live conversation measured through
   *                              /context/trim on the document it ingested.
   *   SHELF_DEFAULTS             text that arrived from nowhere.
   *
   * A live probe is a calibration for the language it was taken in, not a fact
   * about the shelf. It used to be passed as `charsPerToken` and it outranked
   * every book, which meant reading one English book rewrote every other tile:
   * 紅樓夢 read 3,020,297 tokens before an ingest and 230,620 after one, because
   * 3.0 chars per token is right for Melville and wrong by a factor of ten for
   * Chinese. The comment three hundred lines above already said what that costs —
   * "a wrong ratio moves a book into the wrong regime" — and it moved 紅樓夢 out
   * of the group that asks before it spends, which is the one place on this page
   * where being wrong costs somebody money.
   *
   * So the probe now refines only text that has no measurement of its own. Every
   * book on both shelves has one, measured through the same endpoint by
   * scripts/measure-tokens.js — for a given book that is a better number than a
   * probe of a different book anyway, even in the same language: Ulysses is 2.98
   * and Moby-Dick 3.62, both English, twenty per cent apart.
   */
  function configFor(book, opts) {
    const cfg = Object.assign({}, SHELF_DEFAULTS);
    const o = opts || {};
    cfg.charsPerTokenSource = "default";
    if (typeof o.probedCharsPerToken === "number" && o.probedCharsPerToken > 0) {
      cfg.charsPerToken = o.probedCharsPerToken;
      cfg.charsPerTokenSource = "probe";
    }
    if (book && typeof book.charsPerToken === "number") {
      cfg.charsPerToken = book.charsPerToken;
      cfg.charsPerTokenSource = "book";
    }
    Object.assign(cfg, o);
    if (typeof o.charsPerToken === "number") cfg.charsPerTokenSource = "explicit";
    return cfg;
  }

  function estimate(book, opts) {
    const cfg = configFor(book, opts);
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
     * Two lines, whichever trips first. A cheap book that folds is one click; an
     * expensive book is a decision whether or not it folds, because it is the
     * visitor's provider account either way — that is the money line. And a
     * three-million-token fold is a decision at any rate, which is the token
     * line: cheap models are exactly what make a big thing look free.
     *
     * `costGatedBy` names what tripped, so the copy can lead with the figure that
     * is the reason. Money wins when both trip: it is the older claim and the one
     * the reader's own account answers for.
     */
    const overMoney = usd !== null && usd > cfg.costConfirmUsd;
    const overTokens = tokens > cfg.costConfirmTokens;
    const costGated = overMoney || overTokens;
    const costGatedBy = overMoney ? "money" : (overTokens ? "tokens" : null);

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
      /** "book" | "probe" | "explicit" | "default" — the tile says which */
      charsPerTokenSource: cfg.charsPerTokenSource,
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
      costGatedBy,
      costConfirmUsd: cfg.costConfirmUsd,
      costConfirmTokens: cfg.costConfirmTokens,
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

  /**
   * The originals in one list, priced, smallest first — the same shape
   * `groupByRegime` returns for one group. They are NOT grouped by regime: seven
   * of the nine fold, so four headings would be one heading with a queue behind
   * it, and the sort a reader wants here is the cheap ones first.
   */
  function originals(opts) {
    return BOOKS_I18N
      .map((book) => ({ book, est: estimate(book, opts) }))
      .sort((a, b) => a.est.tokens - b.est.tokens);
  }

  /** Root-absolute: the deployable root is `public/`, so this path holds for
      every demo on the site regardless of how deep its own folder sits. */
  function bookUrl(book) {
    return `/assets/texts/${book.slug}.txt`;
  }

  function findBook(slug) {
    return BOOKS.find((b) => b.slug === slug) || null;
  }

  /** either shelf, by slug — what a click on any tile resolves through */
  function anyBook(slug) {
    return findBook(slug) || BOOKS_I18N.find((b) => b.slug === slug) || null;
  }

  /**
   * The language a retrieved passage is in, worked out from the book it names.
   *
   * The live English index predates the `lang` field, so a hit from it carries no
   * language of its own — and backfilling 11,115 records to restate a fact the
   * manifest already knows would be a write for nothing. A title is the join key:
   * it is what the tool returns and what the shelf is keyed on.
   */
  function langOfTitle(title) {
    const want = String(title == null ? "" : title).trim();
    if (!want) return null;
    const hit = BOOKS_I18N.concat(BOOKS).find((b) => b.title === want);
    return hit ? (hit.lang || "en") : null;
  }

  /** every index the search tool is bound to: English first, then one per language */
  function indexNames() {
    const seen = ["public_domain_books"];
    for (const b of BOOKS_I18N) if (!seen.includes(b.indexName)) seen.push(b.indexName);
    return seen;
  }

  /** what the whole searchable shelf is, derived so a label cannot go stale */
  function shelfSpan() {
    return {
      books: BOOKS.length + BOOKS_I18N.length,
      languages: indexNames().length,
    };
  }

  global.DEMO_BOOKS = {
    books: BOOKS,
    /** the originals, in their own languages, rendered as their own section */
    booksI18n: BOOKS_I18N,
    bookUrl,
    findBook,
    anyBook,
    originals,
    langOfTitle,
    indexNames,
    shelfSpan,
    SHELF_DEFAULTS,
    REGIMES,
    REGIME_ORDER,
    estimate,
    regimeOf,
    groupByRegime,
    formatUsd: defaultFormatUsd,
  };
})(window);

# Contributing

Small demos, small rules. The two context demos need no build step or dependency;
the React InstantSearch Search summary demo has a pinned npm build so its source
can stay readable while Cloudflare still serves one static root.

## Run it locally

```bash
# 1 · credentials — copy the template, then fill in your own values
cp public/shared/config.example.js public/shared/config.js
$EDITOR public/shared/config.js

# 2 · build the React InstantSearch demo
npm ci
npm run build:summary-card

# 3 · serve the deployable root
python3 -m http.server 8766 --directory public

# 4 · open http://127.0.0.1:8766/
```

Serve over `http://`, never open the file over `file://` — the demos load their
config and shared modules with relative paths, which a `file://` origin blocks.

`config.example.js` documents every field. Each demo degrades honestly without a
config: it renders a notice telling the reader to create the file rather than
failing silently.

## Never commit config.js

`public/shared/config.js` holds credentials and is gitignored at every depth. The
same goes for anything else that carries a key: no key in a source file, in a
screenshot, in a pasted log, or in a commit message.

These pages call the Agent Studio API straight from the browser so the wire log
can show every request, which means whatever key you configure is readable by
anyone who opens devtools. Use a key scoped to exactly what the demo needs, and
put a backend in front of it before shipping anything like this.

## The checks

CI runs these, and so should you before pushing:

```bash
npm ci
npm run build:summary-card
npx eslint .                  # flat config, zero dependencies
node --test tests/*.test.js   # node:test, no framework
node scripts/check-copy.js    # copy budgets
```

eslint takes the repo root, not a list of directories: `public/`, `tests/`,
`scripts/` and `tools/` all need linting and all declare their own globals in
`eslint.config.js`, so a path list is one more thing to forget when a folder is
added. Pass `tests/*.test.js` as a glob rather than `tests/` — the directory form
is broken on Node 23.

Both are green on a clean checkout with no `config.js` present — the tests read
`config.example.js`, and eslint ignores the real config. If a gate passes for you
and fails in CI, the likeliest cause is something in your working copy that is not
in the repo.

`eslint.config.js` writes its rules out by name instead of extending
`eslint:recommended`, because `@eslint/js` is not resolvable when eslint arrives
through `npx` with no local `node_modules`. Add globals to the list there rather
than sprinkling `/* global */` comments.

## Adding a demo

1. For a plain demo, `mkdir public/<demo-slug>` and write an `index.html` that links
   `../shared/tokens.css` first, then its own `style.css`.
2. For a React demo, put source under `demos/<demo-slug>/` and add a pinned build
   script that emits into `public/<demo-slug>/`.
3. Reuse the demo kit in `public/shared/` rather than vendoring copies where it fits.
4. A plain demo's stylesheet never redeclares a token from `tokens.css`.
5. Add a card to `public/index.html`: pitch, status, and the endpoints it exercises.

## The demo kit

`public/shared/` is what the next plain demo starts from. Every module is a plain
browser script that publishes one global — no build step, no imports, and the
tests `require()` the same bytes the browser loads (`tests/load.js`). Load them
with `<script src>` before the demo's own `app.js`. React demos may use npm
dependencies in their isolated source tree, but their generated output must still
land under `public/`.

Auto-compaction stays **on by default** in every demo built on this kit. A demo
that overflows in front of a visitor is not demonstrating anything.

### `tokens.css` — palette and base primitives

One declaration per token, both themes inside it via `light-dark()`. Violet is
action; pink (`--crease`) is the fold and everything the fold makes possible.

### `md.js` → `window.renderMarkdown(src)`

Escapes first, then renders the small part of Markdown a chat answer uses.
Returns HTML safe to assign to `innerHTML`; link targets are allow-listed.

### `meter.js` → `window.DemoMeter`

The cost strip: what a conversation really spent, against what it would have cost
with no context management. Pure model, separate renderer.

| Member | What it does |
| --- | --- |
| `freshCost()` | a zeroed cost object — the shape a demo accumulates into |
| `priceOf(modelName)` | published per-MTok rates; longest key match, so dated model ids resolve |
| `priceLine(price)` | one sentence naming the rate and where the number came from |
| `charge(cost, side, inTok, outTok, price)` | bills one call to `"real"` or `"naive"`, returns the dollar value, touches nothing else |
| `meterView(cost, { modelWindow, modelLabel, price })` | **the pure one**: a view model, including which of the two modes the strip is in |
| `tileCopy` | the tooltip copy, keyed by tile — bind it with the page's own tooltip engine |
| `createStrip(els)` | `{ render(view), reset() }`; `els` names nodes by role (`naiveUsd`, `savedUsd`, `unlockedValue`, `opEquals`, …) |
| `usd`, `fmt`, `signedTokens`, `shortTokens` | the formatters, so the strip and the wire log cannot disagree about a figure |

Its styling travels with it in `meter.css`, which declares no token of its own.
Link order is `tokens.css`, `meter.css`, then the demo's `style.css` — that last
position is what lets a demo adjust the strip without editing the shared file.

The two modes are why `meterView` exists apart from the renderer:

- **feasible** — the largest single naive payload still fits the model's real
  window, so `view.saved` is `naive − real`. Negative is allowed, and framed as
  "paying itself back".
- **impossible** — that payload is larger than the window, so the provider would
  refuse the naive run outright. `view.saved` is `null`, `view.unlocked` carries
  the copy, and nothing subtracts anywhere. A dollar delta against a request that
  cannot be made is the flattering reading and the weaker one.

The boundary belongs to the feasible side: a payload exactly the size of the
window fits. `tests/meter.test.js` holds both modes, the boundary, and the state
a demo hits first — an oversize document ingested before any question, where both
dollar totals are still zero.

The cost object stays the demo's own: its `app.js` decides what counts as a turn,
calls `charge` per API call, and hands `meterView(...)` to the strip.

### `books.js` → `window.DEMO_BOOKS`

Sixteen public-domain books under `public/assets/texts/`, with counted
`chars`/`words` and the needle/arc suggestion chips.

| Member | What it does |
| --- | --- |
| `books` | the manifest — slug, title, author, year, `gutenbergId`, counts, hook, chips |
| `bookUrl(book)` | root-absolute path to the text, so it resolves from any demo folder |
| `findBook(slug)` | one book or `null` |
| `SHELF_DEFAULTS` | window, ratios, budget, section size, `price`, `costConfirmUsd` |
| `estimate(book, opts)` | **the derived one**: tokens, regime, fold sections, summarizer calls, dollars, and the sentence a tile prints |
| `regimeOf(book, opts)` | just the verdict, for grouping |
| `groupByRegime(opts)` | the shelf in reading order, grouped, with each group's heading copy |
| `REGIMES`, `REGIME_ORDER` | the four regimes and the copy for each |
| `formatUsd(n)` | the meter's money rule, so a tile and the cost strip agree |

`estimate` is where the honesty lives. No per-book verdict is written down: the
regime, the call count and the bill all come from `book.chars` and whatever
`opts` says about the model window, the working budget, the chars-per-token ratio
and the price. Pass `DemoMeter.priceOf(model)` as `opts.price` and the figure
tracks the model picker; pass nothing and it quotes no dollars at all rather than
inventing a rate. A placeholder rate is labelled as one on the tile itself.

The counts are checked against the files in `tests/books.test.js`, and so are the
regime boundaries — edit a text or move a threshold and that file names what
changed.

### `compactor.js` → `window.DemoCompactor`

The auto-compact loop, as a driver that owns no state. It lived inside
`chat-with-book` for as long as that demo was its only caller;
`infinite-conversation` needs the same loop, so it is cut into the kit.

| Member | What it does |
| --- | --- |
| `threshold(budget, ratio)` | the token count at which compaction fires |
| `shouldCompact(tokens, budget, ratio)` | the decision, boundary inclusive |
| `planPass({ weights, keepLast, maxPayload })` | **the pure one**: how much of the oldest end one `context/compact` call should take — `{ cut, tokens, oversize, remaining }`, or `null` when nothing is foldable |
| `createCompactor(deps)` | `{ now(), afterTurn(), needed(), plan(), threshold(), folds, busy }` |

```
createCompactor({
  history(),                       // → { messages, weights, tokens }  read live
  probe(messages),                 // → { tokens }           (context/trim)
  compact(messages, opts),         // → { messages, stats }  (context/compact)
  budget(), ratio(), keepLast(), maxPayload(),   the thresholds, read live
  onPass(meta),                    // optional narration, before the call goes out
  onHistory(messages, stats, meta), // the demo swaps its own history and redraws
  onCharge(stats, meta),           // the demo bills the summarizer to the meter
})  →  { now(), afterTurn() }
```

`now()` is the visitor pressing a button: it folds once and then keeps folding
while the conversation is still over. `afterTurn()` is the automatic one: it
folds only when the threshold has been crossed. The contract with the demo is
one sentence — by the time `onHistory` returns, `history()` answers with what it
was handed. The driver re-reads it before every pass rather than keeping a copy,
and `weights` is passed to `planPass` rather than stored, because that parallel
array is exactly the entanglement this file exists not to inherit.

It folds **repeatedly**, not once. A thread that arrives 235k tokens long cannot
be summarized in a single call: that payload has to fit the summarizer's own
window too. So a pass takes as much of the oldest end as fits under
`maxPayload`, and the next pass folds its summary in with the next stretch — one
summary stays at the head of the history rather than a stack of them.

Two things it refuses to do, both of them money:

- a pass that reclaimed nothing ends the run, because the next one will reclaim
  nothing either;
- a plan that would fold only the summary the last pass wrote is recognised
  *before* the call goes out, not after paying to find out.

`tests/compactor.test.js` holds the threshold boundary, the protected tail, the
single-message-over-cap case, a full multi-pass run against stub endpoints, and
both refusals.

Still not extracted, and still `chat-with-book`'s own subject matter: sectioned
*parallel* folds of one oversized document, and keeping each section's original
text so it can be reopened later.

## Adding a book

1. Find it on [Project Gutenberg](https://www.gutenberg.org/) and note the ebook
   number. It has to be public domain and it has to have a plain-text edition.
2. Add an entry to `BOOKS` in `public/shared/books.js` with the slug, title,
   author, the edition's `year`, the `gutenbergId`, a one-line `hook`, and
   `words: 0, chars: 0` as placeholders.
3. Run the fetcher. It downloads, strips the licence wrapper, writes
   `public/assets/texts/<slug>.txt`, and exits non-zero naming the real counts:

   ```bash
   node scripts/fetch-books.js
   ```

4. Paste those two numbers into the manifest and run it again. It should now be a
   no-op — nothing written, every count agreeing.
5. Write the chips: two or three needle questions and one or two arc questions.
   **Verify every needle premise against the committed file before you write the
   question**, with whitespace collapsed first — the texts are hard-wrapped at
   ~72 columns, so half of any interesting phrase straddles a line break and a
   bare `rg` will report a false negative:

   ```bash
   node -e 'const t=require("fs").readFileSync("public/assets/texts/<slug>.txt","utf8").replace(/\s+/g," ");
     for (const p of ["your phrase","another"]) console.log(t.includes(p)?"Y":"n", p)'
   ```

   Two real examples of why: Andrew Lang's selection of the *Arabian Nights* has
   no Ali Baba and no "Open, Sesame" in it, and the Maude *War and Peace*
   transliterates with accents, so a question about "Platon Karataev" would have
   been a question the book cannot answer.
6. Add the verified phrases to `PREMISES` in `tests/books.test.js`, add the
   book's title-page phrase to `NAMES` in the same file, and add its measured row
   to the regime table there. Then run both gates.
7. If you also want it searchable, rebuild the passages — see below.

Add the chapter-detection rule for the new book to `CHAPTERS` in
`scripts/build-passages.js` at the same time, and check the section count it
reports against the book's real chapter count. If the edition's headings cannot
be detected reliably, leave the rule returning `[]` with a note: `chapter: null`
is a true statement about the file, an invented chapter number is not.

## The search index

Some questions have an answer sitting in one place and some do not. The first
kind is what a search index is for, and two scripts build one. Neither needs
anything installed.

```bash
# 1 · cut the shelf into passages → passages.jsonl (gitignored)
node scripts/build-passages.js

# 2 · see exactly what would be sent, for one language. This is the default
#     mode and it needs no credentials, because it calls nothing.
node scripts/index-passages.js --lang fr
```

`build-passages.js` packs whole paragraphs into 150–300-word passages and cuts a
too-long paragraph on sentence boundaries, never mid-sentence — except where a
single sentence is longer than a passage, which happens 101 times across the shelf
and is counted in the summary rather than hidden. It prints records per book,
chapter counts, mean size and the largest record, and it fails if any record
passes 10KB.

Japanese and Chinese are packed by CHARACTER instead, 250–550 of them, because
`split(/\s+/)` over a script that writes no spaces returns one "word" for a whole
page. Every record carries both `wordCount` and `charCount` so a caller never has
to know which. Sentence boundaries there are `。！？…` — and `．`, which is not a
typo: this edition of 紅樓夢 prints FULLWIDTH FULL STOP 21,285 times against 7,886
for `。`, and leaving it out sent four fifths of the Chinese passages through the
blind cut.

### One index per language

`indexLanguages` is a settings-global — it cannot vary per record — and CJK
segmentation only happens when the CJK language is declared on the index itself.
So `ja` and `zh` cannot share an index, and once the shelf is split for those two
there is no reason to leave the rest mixed:

```
en → public_domain_books        fr de es it ru ja zh → public_domain_books_<lang>
```

`--lang` is required and it is the only knob: it picks the destination, filters
`passages.jsonl` by the record's own `lang`, and selects the settings. There is no
index-name argument. A name and a filter as two arguments can disagree with each
other, and the application behind these credentials holds ~95 unrelated
production indices, so the old default destination was designed out rather than
documented around.

`index-passages.js` applies `scripts/index-settings.json` with the
`scripts/index-settings-languages.json` overlay on top, and then batches the
records — in that order, because settings applied afterwards mean a reindex. A
real run needs two environment variables and reads them from nowhere else — not
from a flag, and neither is ever printed:

```bash
ALGOLIA_APP_ID=… ALGOLIA_WRITE_API_KEY=… node scripts/index-passages.js --lang fr --push
```

`ALGOLIA_WRITE_API_KEY` wants `addObject` and `editSettings` on that one index. A
search-only key will not do; an admin key is more than this needs. Run `--push`
without them and the script names both variables and exits 2.

Every language in the overlay names itself in `ignorePlurals` and
`removeStopWords` rather than passing bare `true`: bare true resolves against
`queryLanguages`, so on a mixed index it applies one language's plural rules to
another's text. English keeps the bare `true` it was built with, which is the same
value when the index holds one language. `de` also gets
`decompoundedAttributes`. Typo tolerance is not in the overlay at all — it does
not apply to logographic scripts, so there is nothing to set and nothing to lean
on.

The settings are data on purpose, so they can be reviewed as data; the reasons
they differ from Algolia's defaults are in a comment block at the top of the
script.

**One rule worth knowing before you query it**: `attributeForDistinct` is
settings-only and `distinct` is per-query. So the index fixes
`attributeForDistinct: "book"` and leaves `distinct: false` as its default, and
the caller decides per search — pass `distinct: 1` to sweep the whole shelf and
get one passage per book, pass nothing to dig inside one book and get several
passages from it. One index, both behaviours, no second copy of the data.

## Adding a config field

Give it a default in the demo's `app.js` so an older `config.js` keeps working,
document it in `config.example.js`, and — if the deployed site needs it — remember
that production reads the whole file from the `DEMO_CONFIG_JS` repository
variable, so that variable has to be refreshed too:

```bash
gh variable set DEMO_CONFIG_JS --repo algolia/agent-studio-demos \
  < public/shared/config.js
```

## PR flow

1. Branch off `main`.
2. Run both gates locally.
3. Open a PR — the template asks for what/why, screenshots for anything visual,
   and the checklist above.
4. CI runs lint and tests on the PR. A merge to `main` deploys to
   <https://agent-studio-demos.pages.dev/> on its own.

## Unstable endpoints

The context APIs these demos use (`/1/unstable/context/trim`,
`/1/unstable/context/compact`) are unstable and can change without notice. When
one moves, fixing the demo is the fix — there is no compatibility layer to write.

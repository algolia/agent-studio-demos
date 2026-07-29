# Contributing

Small demos, small rules. There is no build step and no dependency to install — a
clone, a config file and a static server are the whole setup.

## Run it locally

```bash
# 1 · credentials — copy the template, then fill in your own values
cp public/shared/config.example.js public/shared/config.js
$EDITOR public/shared/config.js

# 2 · serve the deployable root
python3 -m http.server 8766 --directory public

# 3 · open http://127.0.0.1:8766/
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

## The two gates

CI runs exactly these, and so should you before pushing:

```bash
npx eslint public/ tests/ eslint.config.js   # flat config, zero dependencies
node --test tests/*.test.js                  # node:test, no framework
```

Both are green on a clean checkout with no `config.js` present — the tests read
`config.example.js`, and eslint ignores the real config. If a gate passes for you
and fails in CI, the likeliest cause is something in your working copy that is not
in the repo.

`eslint.config.js` writes its rules out by name instead of extending
`eslint:recommended`, because `@eslint/js` is not resolvable when eslint arrives
through `npx` with no local `node_modules`. Add globals to the list there rather
than sprinkling `/* global */` comments.

## Adding a demo

1. `mkdir public/<demo-slug>` and write an `index.html` that links
   `../shared/tokens.css` first, then its own `style.css`.
2. Reuse the demo kit in `public/shared/` rather than vendoring copies.
3. A demo's stylesheet never redeclares a token from `tokens.css`.
4. Add a card to `public/index.html`: pitch, status, and the endpoints it exercises.

## The demo kit

`public/shared/` is what the next demo starts from. Every module is a plain
browser script that publishes one global — no build step, no imports, and the
tests `require()` the same bytes the browser loads (`tests/load.js`). Load them
with `<script src>` before the demo's own `app.js`.

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

`{ books, bookUrl(book), findBook(slug) }`. Four public-domain books under
`public/assets/texts/`, with counted `chars`/`words` and the needle/arc
suggestion chips. `bookUrl` is root-absolute, so it resolves from any demo
folder. The counts are checked against the files themselves in
`tests/books.test.js` — edit a text and that test names the number to update.

### Not extracted: the auto-compact loop

The *decision* is one line in `chat-with-book/app.js`:

```js
if (state.tokens >= currentWindow() * CFG.compactAtRatio) await runCompact({ auto: true });
```

`runCompact` itself is not shareable as it stands: it is welded to that demo's
`messages`/`kinds`/`weights` arrays, its fold record, its ledger bands and its
chat bubbles. Moving it into the kit would export the entanglement rather than
the idea.

The seam to cut, when a second demo needs it, is a driver that owns none of that
state and calls back into it:

```
createCompactor({
  probe(messages),                 // → { tokens }           (context/trim)
  compact(messages, opts),         // → { messages, stats }  (context/compact)
  budget(), ratio(),               // the thresholds, read live
  onHistory(messages, stats),      // the demo swaps its own history and redraws
  onCharge(stats),                 // the demo bills the summarizer to the meter
})  →  { afterTurn(), now() }
```

Everything the current loop does beyond that — sectioned folds for payloads too
large for a single compact call, keeping each section's original text so it can
be reopened later — is `chat-with-book`'s own subject matter, and should stay
there until a second demo asks for the same thing.

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

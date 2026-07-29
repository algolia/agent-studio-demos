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

`{ books, bookUrl(book), findBook(slug) }`. Four public-domain books under
`public/assets/texts/`, with counted `chars`/`words` and the needle/arc
suggestion chips. `bookUrl` is root-absolute, so it resolves from any demo
folder. The counts are checked against the files themselves in
`tests/books.test.js` — edit a text and that test names the number to update.

### `compactor.js` → `window.DemoCompactor`

The auto-compact loop, as a driver that owns no state. This section used to
record the seam and argue for leaving it uncut; `infinite-conversation` is the
second demo that needed it, so it is cut.

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

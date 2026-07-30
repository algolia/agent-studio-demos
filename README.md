# Agent Studio demos

[![CI](https://github.com/algolia/agent-studio-demos/actions/workflows/ci.yml/badge.svg)](https://github.com/algolia/agent-studio-demos/actions/workflows/ci.yml)
[![Deploy](https://github.com/algolia/agent-studio-demos/actions/workflows/deploy.yml/badge.svg)](https://github.com/algolia/agent-studio-demos/actions/workflows/deploy.yml)

Small, self-contained single-page demos of the [Algolia Agent Studio](https://www.algolia.com/doc/guides/algolia-ai/agent-studio) context APIs. No build step, no framework, no bundler — every demo is plain HTML, CSS and JavaScript served as static files.

Live at **<https://agent-studio-demos.pages.dev/>**, one demo per path. Every push to `main` deploys it.

| Demo | Path | Status |
| --- | --- | --- |
| Chat with a book | `/chat-with-book/` | Live |
| Infinite conversation | `/infinite-conversation/` | Live |

## Layout

```text
public/                     the deployable root — this is what Cloudflare Pages serves
  index.html                landing page, one card per demo
  shared/                   the demo kit — see CONTRIBUTING.md § The demo kit
    tokens.css              the design language: colors, fonts, spacing, base primitives
    md.js                   vendored sanitizing markdown renderer (window.renderMarkdown)
    meter.js                the cost strip: cost model, mode switch, rendering (window.DemoMeter)
    meter.css               the cost strip's styling, linked after tokens.css
    books.js                the bookshelf manifest and its suggestion chips (window.DEMO_BOOKS)
    compactor.js            the auto-compact loop, as a stateless driver (window.DemoCompactor)
    config.example.js       template for local credentials — copy it, never edit it in place
    config.js               your real credentials (gitignored, never committed)
  assets/texts/             25 public-domain works, plain text, source boilerplate removed
  assets/convs/             three seeded conversations, plus the manifest every figure derives from
  chat-with-book/           index.html + app.js + style.css
  infinite-conversation/    index.html + app.js + style.css
scripts/                    node, zero dependencies — see § The shelf and § The search index
  fetch-books.js            download, strip and count the texts, from either source
  wikisource.js             wikitext → prose, for the one work not on Gutenberg
  build-passages.js         cut the texts into passages → passages.jsonl
  index-passages.js         apply settings and push one language's passages (dry run by default)
  index-settings.json       the index settings, as reviewable data
  index-settings-languages.json  the per-language overlay on those settings
  measure-tokens.js         characters per token, per book, via /context/trim
tools/                      node, zero dependencies — bakes the seeded conversations
tests/                      node:test smoke tests — no framework, no install
eslint.config.js            flat config, rules written out, zero dependencies
.github/workflows/          ci.yml (lint + tests), deploy.yml (Cloudflare Pages)
```

Each demo links `../shared/tokens.css` first, then any shared stylesheet it uses (`meter.css`), then its own `style.css`. A demo's stylesheet never redeclares a token; the landing page uses nothing but `tokens.css`.

## The shelf

Sixteen books are committed under `public/assets/texts/` as plain text, from *The
Yellow Wallpaper* at 6,085 words to *War and Peace* at 563,286. All sixteen are
[Project Gutenberg](https://www.gutenberg.org/) ebooks in the public domain in the
United States; each file is Gutenberg's own text with the licence header and footer
removed and nothing else edited, so any claim a demo makes about a book can be
checked against the file. `scripts/fetch-books.js` is that download-and-strip step
written down — run it with `--force` and it re-derives all sixteen files and reports
them identical.

The shelf is grouped by what loading a book will do, and each tile says so before
you click it:

| Regime | What happens | On the shelf |
| --- | --- | --- |
| **budget-compact** | fits the model window whole, exceeds the working budget, so one summarizer call on the first question | the eight smaller books |
| **oversize-fold** | past 0.8 × the model's real window, so summarized in *N* parts on arrival, then compacted as you chat | the eight larger books |
| **cost-gated** | an estimate big enough to be worth a decision, so it asks before it spends | model-dependent — none at the default rate |

None of that is written down per book. `window.DEMO_BOOKS.estimate(book, opts)`
derives it from the book's character count and the config in force: the model's
window decides what folds, its price decides what a fold costs, the budget decides
where compaction fires, and the token count comes from a chars-per-token ratio the
page re-measures on every trim probe. Change the model or the budget and the groups
rearrange.

**Ingesting a big book costs real money.** The summarizer reads every word once, on
your own provider credentials, and that is a per-click cost rather than a one-off:
*War and Peace* is about 1.07M tokens through the fold. At the default model's rate
that is roughly eleven cents and at ten times the rate it is a dollar and change, so
each tile carries its own estimate and the expensive ones ask first. The figures are
estimates — the API does not report the summarizer's own token usage — and where the
rate behind one is a placeholder rather than a published price, the tile says so.

## Run it locally

```bash
# 1 · credentials — copy the template, then fill in your own values
cp public/shared/config.example.js public/shared/config.js
$EDITOR public/shared/config.js

# 2 · serve the deployable root (any static server works)
python3 -m http.server 8766 --bind 127.0.0.1 --directory public

# 3 · open it
# http://127.0.0.1:8766/
```

Open a file over `http://`, not `file://` — the demos load their config and shared modules with relative paths, which a `file://` origin blocks.

## How config works

`public/shared/config.js` defines a single global, `window.DEMO_CONFIG`, read once at startup. It carries:

- **`host`, `appId`, `apiKey`** — which Agent Studio deployment to call and with what credentials.
- **`models`** — the entries offered in the model picker: an agent id, a provider id, the model name, its context window, and a per-million-token price used by the cost meter.
- **`budgets`, `defaultBudget`, `compactAtRatio`, `keepLastMessages`** — the working budget the meter fills against, and when auto-compaction fires.
- Optional tuning for hierarchical folding — chunk size, fold depth, unfold limits. Everything has a default in `app.js`, so an older config keeps working.

`config.example.js` documents every field. It is committed; `config.js` is in `.gitignore` at every depth and must never be committed.

**These pages call the API directly from the browser** so the wire log can show you every request. That means the key is visible to anyone who opens devtools. Use a key scoped to exactly what the demo needs, and put a backend in front of it before shipping anything like this.

## Checks

Two gates, both runnable verbatim on a laptop with nothing installed:

```bash
npx eslint public/ tests/ eslint.config.js   # flat config, rules written out by name
node --test tests/*.test.js                  # node:test, no framework
```

CI runs exactly these on every pull request and on `main`. Both are green on a clean
checkout with no `config.js` present — the tests read `config.example.js`, and eslint
ignores the real config — so a local run covers the same files as CI.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the PR flow.

## Deploy

The site is static: `public/` is the build output, there is no build command, and
`.github/workflows/deploy.yml` publishes it to Cloudflare Pages on every push to `main`
(or on demand, via **Actions → Deploy → Run workflow**).

`public/shared/config.js` is gitignored, so it is not in the repo and a plain checkout
cannot deploy a working site. A demo that loads without it does not break — it renders a
short notice telling the reader to create the file — but it does not demo anything either.
So the workflow writes that file before uploading, from a repository **variable**.

What must exist on the repo for a deploy to succeed:

| Kind | Name | What it holds |
| --- | --- | --- |
| Secret | `CLOUDFLARE_API_TOKEN` | Cloudflare token, **Edit Cloudflare Workers** template. Dashboard → My Profile → API Tokens → Create Token. |
| Variable | `DEMO_CONFIG_JS` | The entire contents of a working `public/shared/config.js`. |

The account id (`CLOUDFLARE_ACCOUNT_ID`) is inline in the workflow — an account id
identifies, it does not authorise.

```bash
gh secret set CLOUDFLARE_API_TOKEN --repo algolia/agent-studio-demos
gh variable set DEMO_CONFIG_JS --repo algolia/agent-studio-demos < public/shared/config.js
```

**One variable, not one per field.** The config is a nested structure — several model
entries of up to ten fields each, a reader-proxy object, a dozen fold-tuning scalars.
Reassembling that from ~40 variables would put a second copy of its shape inside the
workflow, and adding a model would mean editing the workflow. Holding the whole file
means the deployed config is identical to the one that already works locally; the cost is
that changing a config field means refreshing the variable, which is the `gh variable set`
line above.

It is a variable rather than a secret on purpose: the key inside is an intentionally
public, demo-scoped key that any visitor can read from devtools anyway, and secrets are
masked in logs — which makes a malformed config impossible to diagnose. The workflow
syntax-checks the file it writes and asserts `host`, `appId`, `apiKey` and at least one
model are present, so a truncated variable fails with a readable message instead of a
blank page.

Whatever key you configure ends up readable in the browser. Scope it accordingly.

You can still deploy by hand from a working copy — `config.js` is uploaded even though it
is untracked:

```bash
npx wrangler@4 pages deploy public/ --project-name agent-studio-demos
```

## Adding a demo

1. `mkdir public/<demo-slug>` and write an `index.html` that links `../shared/tokens.css`.
2. Reuse the demo kit in `public/shared/` rather than vendoring copies — the meter and the
   bookshelf are already shared; [CONTRIBUTING.md](CONTRIBUTING.md#the-demo-kit) documents
   the API of each module.
3. Add a card to `public/index.html` — pitch, status, and the endpoints it exercises.

## Unstable endpoints

The context APIs these demos use (`/1/unstable/context/trim`, `/1/unstable/context/compact`) are unstable and can change without notice.

# Agent Studio demos

[![CI](https://github.com/algolia/agent-studio-demos/actions/workflows/ci.yml/badge.svg)](https://github.com/algolia/agent-studio-demos/actions/workflows/ci.yml)
[![Deploy](https://github.com/algolia/agent-studio-demos/actions/workflows/deploy.yml/badge.svg)](https://github.com/algolia/agent-studio-demos/actions/workflows/deploy.yml)

Small, self-contained single-page demos of the [Algolia Agent Studio](https://www.algolia.com/doc/guides/algolia-ai/agent-studio) context APIs. No build step, no framework, no bundler — every demo is plain HTML, CSS and JavaScript served as static files.

Live at **<https://agent-studio-demos.pages.dev/>**, one demo per path. Every push to `main` deploys it.

| Demo | Path | Status |
| --- | --- | --- |
| Jev picks the attributes | `/jev-attributes/` | Local (needs its proxy) |
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

Nine more are shelved separately, under **In the original**: works in French,
German, Spanish, Italian, Russian, Japanese and Chinese, none of them a
translation. Eight of the nine are Gutenberg too; *Белые ночи* is not there as
plain text at all and comes from ru.wikisource.org, with the editorial layer its
licence covers stripped by `scripts/wikisource.js`. Each language gets its own
Algolia index, because `indexLanguages` is a settings-global and CJK segmentation
only happens when the index declares the language — 紅樓夢 cannot share one with
*Faust*. The search tool is bound to all eight, and the Algolia MCP server turns
that into one tool per index, so the model picks a language by picking a tool.
Their suggested questions are in the book's own language, and the page's chrome
follows the reader's: eight languages in the masthead picker, and the choice rides
on every request as a short note asking the model to answer in it.

`charsPerToken` is measured per book, not per language, through `/context/trim`
(`scripts/measure-tokens.js`). English alone runs 2.98 on *Alice* to 4.02 on *The
Time Machine* — a 35% spread inside one tongue — and Japanese runs about 0.32,
three tokens to the character. It is not a rounding detail: one shared 3.0 was
folding the *Arabian Nights*, which at its own 3.95 fits the window whole.

The shelf is grouped by what loading a book will do, and each tile says so before
you click it:

| Regime | What happens | On the shelf |
| --- | --- | --- |
| **budget-compact** | fits the model window whole, exceeds the working budget, so one summarizer call on the first question | the nine smaller books |
| **oversize-fold** | past 0.8 × the model's real window, so summarized in *N* parts on arrival, then compacted as you chat | the seven larger books |
| **cost-gated** | an estimate big enough to be worth a decision, so it asks before it spends | model-dependent — none at the default rate |

None of that is written down per book. `window.DEMO_BOOKS.estimate(book, opts)`
derives it from the book's character count and the config in force: the model's
window decides what folds, its price decides what a fold costs, the budget decides
where compaction fires, and the token count comes from a chars-per-token ratio the
page re-measures on every trim probe. Change the model or the budget and the groups
rearrange.

**Ingesting a big book costs real money.** The summarizer reads every word once, on
your own provider credentials, and that is a per-click cost rather than a one-off:
*War and Peace* is about 941k tokens through the fold. At the default model's rate
that is roughly nine cents and at ten times the rate it is ninety-four, so
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

## Jev picks the attributes

`/jev-attributes/` asks one question two ways. Algolia finds the countries the
question names. Both lanes send the same model the same hits and the same system
prompt: **FULL** sends each record whole, **JEV-FILTERED** sends only the
attributes Jev kept. Jev is TypeSafe's typed-question model (`jev-1.13.0`, `POST
/v1/systemone`): one request carries 13 yes/no (`noul`) questions, "does
answering need the *Geography* section?", one per section, and every section at
P(yes) ≥ 0.5 is kept. At depth **Fields**, a second request asks the same of
each field inside the kept sections. Token counts are the LLM API's own
`usage`, never estimated.

### Why the Factbook

The CIA World Factbook (via [factbook/factbook.json](https://github.com/factbook/factbook.json),
CC0; the text itself is a US-government work in the public domain) is the
shape this demo needs: 255 records, one schema, 13 sections, ~130 fields each,
and almost every question needs one or two sections. The edition is the last
one: the CIA retired the Factbook in February 2026, and the mirror's checkout
used here is commit `144d697` (2026-09-11). Weighed and rejected: the books
index (passages, so the question is *which passage*, not *which attribute*), a
Gutenberg book (that is chunking), and a product catalog (few attributes per
record, so little to strip).

### Data and index

```bash
git clone --depth 1 https://github.com/factbook/factbook.json.git /tmp/fb   # 13 MB
node scripts/build-factbook.mjs /tmp/fb       # → factbook.jsonl, gitignored
node scripts/index-factbook.mjs --push        # settings, then records
```

- One record per entity, keyed `Section.Field`, plus `objectID` (the GEC code),
  `name`, `aliases` and `region`. Oceans and the World entry are left out (other
  schema). 255 records, 32,503 fields, 6.9 MB; the biggest is the United States
  at 49 KB, the median 29 KB.
- **Trimmed:** 218 fields longer than 1,500 characters are cut with an ellipsis
  (Introduction 141, Military and Security 45, Government 26, Space 3, one each
  in People and Society, Economy, Geography). HTML is stripped and entities decoded.
- **Index name wart:** the app's keys are scoped to `esci_*`, so
  `demo_factbook` is refused (403, "Index not allowed with this API key") and
  the records live in **`esci_demo_factbook`**. The indexer and the proxy try
  `demo_factbook` first, so widening the key moves both with no code change.
  If neither index answers, the proxy searches `factbook.jsonl` locally and the
  page says so.
- Only `name` and `aliases` are searchable, all words optional, stop words off;
  the proxy keeps the hits that match the most words, on the name, with the
  fewest typos. Searches send `analytics: false`.

### Run it

```bash
vault login -method=oidc                      # Enablers token for the LLM, once a day
node tools/jev-attributes/server.mjs          # → http://127.0.0.1:8795/jev-attributes/
```

The proxy (`tools/jev-attributes/`) holds every key: Algolia from
`~/.local/state/prefetch.env` (`ESCI_APP`, `ESCI_READ`; `ESCI_WRITE` for the
indexer only), Jev from `JEV_API_KEY` in the agentic-evals `.env`, Enablers from
the Vault login (tier `enablers`, alias `medium`, `max_tokens` 16384). It never
serves `shared/config.js`. The page needs the proxy, so it is local only:
Cloudflare Pages serves static files. `?q=…&depth=fields` opens a run directly.

**Data rule.** Jev is an external vendor: only public or synthetic text may go
to it. The page says so above the question box.

### Measured (2026-10-01, one run each, `medium` = gemma-4-31b-it-nvfp4)

Input tokens are the API's. Jev is the time of its request(s). Lanes run at the
same time on a shared gateway with a fresh cache salt each (no prefix-cache
hits), so the latency columns are single noisy samples, not a benchmark.

| Question | Full in | Sections in | Saving | Jev | Fields in | Saving | Jev (2 calls) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Peru's GDP growth | 10,647 | 2,101 | −80% | 350 ms | 331 | −97% | 484 ms |
| Which countries border Austria? | 9,886 | 931 | −91% | 296 ms | 353 | −96% | 465 ms |
| Compare Japan and Germany military spending | 23,014 | 5,870 | −74% | 210 ms | 756 | −97% | 430 ms |
| What languages are spoken in Switzerland? | 9,935 | 1,950 | −80% | 251 ms | 320 | −97% | 468 ms |
| Population over 65 in Italy | 11,452 | 1,866 | −84% | 232 ms | 353 | −97% | 531 ms |
| Main exports of Chile | 10,547 | 2,045 | −81% | 220 ms | 239 | −98% | 519 ms |
| What is the capital of Burma? | 10,169 | 2,303 | −77% | 222 ms | 241 | −98% | 439 ms |
| How many airports does Kenya have? | 10,088 | 306 | −97% | 206 ms | 137 | −99% | 426 ms |

Jev kept the section a reader would pick in all eight (Economy + Military and
Security for the Japan/Germany comparison). Answers: the page's check found
every figure and name of the full answer in the filtered one in 15 of 16 runs;
the miss is wording (the filtered Burma answer says "Burmese capital", not
"Burma"). Read side by side, the answers agree; the other differences are
wording too ("top five export commodities" vs "main export commodities"). The page's check is a text
match on figures and capitalized names, not a fact check, and says so.
First token, full vs filtered at depth Fields: 1.4–3.7 s vs 0.25–1.4 s.

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

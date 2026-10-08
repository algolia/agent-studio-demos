# Agent Studio demos

[![CI](https://github.com/algolia/agent-studio-demos/actions/workflows/ci.yml/badge.svg)](https://github.com/algolia/agent-studio-demos/actions/workflows/ci.yml)
[![Deploy](https://github.com/algolia/agent-studio-demos/actions/workflows/deploy.yml/badge.svg)](https://github.com/algolia/agent-studio-demos/actions/workflows/deploy.yml)

Small, self-contained single-page demos of the [Algolia Agent Studio](https://www.algolia.com/doc/guides/algolia-ai/agent-studio) context APIs. No build step, no framework, no bundler — every demo is plain HTML, CSS and JavaScript served as static files.

Live at **<https://agent-studio-demos.pages.dev/>**, one demo per path. Every push to `main` deploys it.

| Demo | Path | Status |
| --- | --- | --- |
| What is Agent Studio? | `/main-demo/` | Production, once its two agents are provisioned |
| Jev trims the record | `/jev-attributes/` | Local; public with your own key once this site forwards it |
| Chat with a book | `/chat-with-book/` | Live |
| Infinite conversation | `/infinite-conversation/` | Live |
| Guardrails Arena | `/guardrails-arena/` | Live |
| Guardrails Game | `/guardrails-game/` | Static, no keys |
| Mémoires | `/memoires/` | Live |

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
  main-demo/                index.html + app.js + lane.js + style.css, and six .mjs modules
  guardrails-arena/         index.html + app.js + style.css, and data/ with frozen results
  guardrails-game/          index.html + game-ui.js, on the Arena's csv.js, stats.js and label-game.js
  memoires/                 index.html + shared.js, three memory configurations side by side
scripts/                    node, zero dependencies — see § The shelf and § The search index
  fetch-books.js            download, strip and count the texts, from either source
  wikisource.js             wikitext → prose, for the one work not on Gutenberg
  build-passages.js         cut the texts into passages → passages.jsonl
  index-passages.js         apply settings and push one language's passages (dry run by default)
  index-settings.json       the index settings, as reviewable data
  index-settings-languages.json  the per-language overlay on those settings
  measure-tokens.js         characters per token, per book, via /context/trim
tools/                      node, zero dependencies — bakes the seeded conversations,
                            and main-demo-provision.mjs creates the main demo's agents
tests/                      node:test smoke tests — no framework, no install
functions/relay/            passes a jev-attributes visitor's key on to TypeSafe, a Cloudflare Pages Function (off unless RELAY_ENABLED=1)
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

## The main demo

`/main-demo/` answers "What is Agent Studio?" with a shopping assistant. You ask
for a product, the agent searches a products index, and it answers with its
picks grouped on cards. The chat is the InstantSearch
[Chat widget](https://www.algolia.com/doc/api-reference/widgets/chat/react), bound
to an agent with a search tool and the Grouped Results tool.

**Search prefetch** means Agent Studio searches the index with your message
before the model starts, and hands the model those hits, so it can often answer
without asking for a search itself.

**RAG race** mode is where you see it. Two lanes get the same question at the
same moment: lane A runs `DEMO_main-demo-base` (prefetch off), lane B
`DEMO_main-demo-prefetch` (prefetch on, the shipped defaults), two agents that
differ in that one block, on Agent Studio production. Each lane draws its own
timeline (first byte, first token, every search and model call, full paint).
The scoreboard puts both lanes' model calls, tool calls, first token, full paint
and tokens side by side. A race repeats 1 to 10 times, and the board shows medians and how
often each lane won. Prefetch loses too: on a question with a budget or an age
in it, the raw sentence finds little, and the model searches anyway.

### Run it locally

1. Create the two agents once, on production or on a backend of your own (see
   [Provision the agents](#provision-the-agents)).
2. Fill `mainDemo` in `public/shared/config.js` (see `config.example.js`):
   `region` (or `host`), `appId`, `indexName`, a search-only key in
   `searchApiKey` and `agentStudioApiKey`, and `fields` if your records name
   their attributes differently.
3. Serve `public/` (see [Run it locally](#run-it-locally)) and open `/main-demo/`.

The page talks to `mainDemo.host` when it is set, else to production in
`mainDemo.region` (`eu`: `https://agent-studio.eu.algolia.com`, `us`:
`https://agent-studio.us.algolia.com`), else to `http://127.0.0.1:8000`.

No backend? The page still opens: with nothing answering at that host, or with
`?fixture=1`, the lanes replay a recorded stream and label every number as a
replay.

### Provision the agents

`tools/main-demo-provision.mjs` creates the race's two agents, or adopts them
when they exist. On production it runs behind a fence: it creates only agents
named `DEMO_…` or `EVAL_…`, writes only agents named `DEMO_main-demo-…`, and
refuses a base agent whose provider is not named `TEST_…`. The variants copy the
base's provider, model, tools and prompt.

```bash
# the first run: find the app's region, create the base, then the prefetch arm
APP_ID=… ADMIN_KEY=… node tools/main-demo-provision.mjs --region auto \
  --seed --provider TEST_… --model … --print-config > variants.config.json
```

- `--region auto` asks both production hosts and keeps the one that lists the
  app's providers, then prints the `mainDemo.region` to set. `--region eu` or
  `--region us` skips the question.
- `--seed` creates `DEMO_main-demo-base` when there is none: the products
  index with the search and Grouped Results tools, the shopping prompt, Algolia
  MCP on, prefetch off. Without `--provider` it lists the app's `TEST_`
  providers to pick from.
- `--dry-run` reads and plans, and writes nothing.
- A second run creates nothing. It reports an agent the shipped backend would
  read differently (Algolia MCP off, prefetch keys it ignores), and
  `--converge` rewrites that agent's config, then republishes it.
- The key stays in the environment. Neither the progress lines nor the map
  print it.

On a backend of your own, `MAIN_DEMO_HOST=http://127.0.0.1:8000` replaces
`--region`, and the fence is off.

### How a lane picks its agent

It is the one page here built on ES modules: React 19, React InstantSearch
7.50.1 and `algoliasearch` 5.59.0 load from esm.sh through an import map, with
pinned versions and no build step.

A lane's toggles (search prefetch, memory, guardrails, suggestions) select an
**agent variant**; they never PATCH a live agent. Prefetch off is its own
variant, an agent whose `searchPrefetch` is `false`: the completions call takes
no per-request override.

The provisioning script copies `DEMO_main-demo-base`, layers each variant's
config on top, adopts any agent that already carries the variant's name, and
writes `public/main-demo/variants.json` (gitignored). By default it makes the
race's two arms. A combination outside them is added with
`--add 'prefetch=1,memory=1,guardrails=0,suggestions=0'`, and the page prints
that exact line, for the host it talks to, when a lane asks for a variant
nobody created. An edited config gets its own `DEMO_main-demo-<hash>` agent; the
page creates it only on a local backend, and on production it prints the
command instead.

A prefetch variant carries the block Agent Studio ships (conversational-ai
`docs/SEARCH_PREFETCH.md`), under the `searchPrefetch` key. The race's prefetch
arm sets only `enabled`, so it runs on the defaults:

```json
{ "searchPrefetch": { "enabled": true, "indexName": null, "conversationWindow": 1,
  "minInformativeTokens": 2, "hitsPerPage": null, "timeoutMs": 1000 } }
```

The lane's editor holds those six fields and no others.

Each prefetch turn streams one `data-search_prefetch` part: `decision`,
`nbHits`, `latencyMs`, `toolName`, `index`, and `toolCallId` when the hits
reached the model. The hits ride on the visible search tool call with that id,
which the lane draws as the passive search. Whether the model searched anyway
is read off the same stream: a search call of its own after an injected
prefetch.

### Public mode

The deployed page needs two things in its config, and nothing else changes:

- **one search-only key**: ACL `search`, the products index only, with an
  expiry. The browser sends it twice, as `searchApiKey` for InstantSearch and as
  `agentStudioApiKey` on `/completions`, so every visitor can read it.
- **the agents map**, in `mainDemo.variants`. `variants.json` is gitignored, so a
  deploy has none; the page reads `mainDemo.variants` when it is present and
  fetches `variants.json` only when it is not.

To point the public page at a backend:

1. Provision the agents there, and print the map as JSON (agent ids and names,
   never a key; progress goes to stderr), as in
   [Provision the agents](#provision-the-agents).
2. Mint the search-only key.
3. Add a `mainDemo` block to the deploy config: `region` (or `host`), `appId`,
   `indexName`, `fields`, the key in both key fields, and the printed map as
   `variants`. Production answers CORS for any origin.
4. Refresh `DEMO_CONFIG_JS` from that file (see [Deploy](#deploy)), and the next
   push to `main` serves it.

## Jev trims the record

`/jev-attributes/` trims the context an agent would read, twice, on one
catalog. **Jev** (TypeSafe System One, `jev-1.13.0`, `POST /v1/systemone`)
makes every cut; no LLM answers anything on this page, and the sizes are the
evidence.

- **Records.** A topical question ("Which Gulf countries export the most
  oil?") brings back ten countries. Jev answers one `noul` question per hit,
  in one request: does `` `records.<objectID>` `` help answer `` `question` ``?
  The state is `{question, records: {<objectID>: {name, text}}}`, and the
  criterion is contrastive (a record helps when its text answers or bears
  directly on the question; a country merely in the same region does not). A
  record is kept at P(yes) ≥ 0.5, and the likeliest one is always kept. On
  screen, ten cards in Algolia order, each as wide as its full record; a
  P(yes) bar grows on each, the dropped ones dim and fold, and the counter
  rolls from ten records to the kept ones.
- **Fields.** For a question that names countries, Jev answers 13 `noul`
  questions in one request, one per section, plus a `main` choice, from the
  question and the section descriptions only (`{question, sections: {id:
  description}}`), never a record. A section is kept at P(yes) ≥ 0.5, and the
  `main` pick is always kept. Each record is drawn as 13 stacked blocks, each
  as tall as its characters; the dropped blocks fold away.
- **Both** (the default) runs Records, then Fields on the likeliest three kept
  records. The fields request holds no record, so one call serves all three.
  The readout at the end reads: the ten hits in full, then after records,
  then after fields, in characters and ≈ tokens.

**What Jev sees** (Records and Both) picks the `text` Jev reads per record:
the name only, the name and the first 300 characters of
`Introduction.Background` (cut on a word), or the name and the snippets
Algolia matched (`_snippetResult`, the default). The line under it counts the
records request for the hits on screen, so flipping the toggle shows what
each view costs before you ask again. Measured on "Which Gulf countries export
the most oil?": ≈ 969 tokens for names only, ≈ 1,737 with the background
excerpt, ≈ 2,362 with snippets (Jev's own count for the snippet request:
2,548 input tokens).

**Reading the numbers.** Fields and characters are counted from the record
(characters of each `"Section.Field":value` as JSON, search keys and snippets
excluded); tokens are characters ÷ 4, and the page says "≈" and "estimated"
wherever it shows one. The input and output tokens in each Jev step are Jev's
own `usage`.

**One question, one multi-query.** Search sends Algolia's `queries` endpoint
one request: a query per name phrase in the question (capitalised runs of up
to three words, possessives stripped, stop words skipped, split on commas and
"and"; on `name` and `aliases` only), then the whole question. Hits are joined
by objectID, names first, capped at 10 for Records and Both and at 3 for
Fields. So "What can Peru, Germany, and Lebanon's neighbors have in common?"
brings back all three named records. The Search step shows how many queries
ran and how many records came back.

**The whole record.** Click a record card, or a record's name in the fields
stage, and a modal fetches the record with `getObject` (the browser's search
key in public mode, `/api/object` in local mode) and shows every section and
field. What Jev read is marked "seen by Jev": the name and the snippet or
background excerpt in the records stage; in the fields stage, the 13 section
descriptions and nothing of the record. Once the fields stage has run, kept
and dropped sections are marked too. A line counts both sides in characters
and ≈ tokens.

**Cache.** Jev's answers are kept in the browser, keyed by a SHA-256 of the
request as sent (model, state, questions), in memory and mirrored to
`localStorage` under one slot, capped at 200 entries, oldest out. Asking the
same thing again shows "cached" on the Jev step, the first call's time struck
through, and "0 tokens, cached". The key card has a "Clear cache" link.

Out of scope: a multi-hop loop that plans 10 to 25 searches is an agent, not
this page; it belongs to the Agent Studio race demo.

The study below is why Jev is the one engine: the levered fields request
covered 64 of 64 questions.

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
node scripts/index-factbook.mjs --push --settings-only   # settings only
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
- **Searchable:** `name`, `aliases`, then `unordered(Introduction.Background)`,
  `unordered(Geography.Location)`, `unordered(Economy.Economic overview)` and
  `unordered(Geography.Major rivers (by length in km))` (no prose field names
  the Danube). `attributesToSnippet` holds those four at 40 words,
  `restrictHighlightAndSnippetArrays` is off, `removeWordsIfNoResults` is
  `allOptional`, typo tolerance is on, stop words are removed. A fields query
  restricts itself to `name` and `aliases`, as before; a records query makes
  every word optional (`optionalWords`). Searches send `analytics: false`.
  `node scripts/index-factbook.mjs --push --settings-only` pushes these
  settings and sends no record.

### Run it: two modes

```bash
node tools/jev-attributes/server.mjs                  # LOCAL  → http://127.0.0.1:8795/jev-attributes/
PORT=8796 node tools/jev-attributes/server.mjs --public   # PUBLIC, as deployed
```

**LOCAL** is the maintainer's machine. The server holds the keys: Algolia from
`~/.local/state/prefetch.env` (`ESCI_APP`, `ESCI_READ`; `ESCI_WRITE` for the
indexer only) and Jev from `JEV_API_KEY` in the agentic-evals `.env`. It
answers `/api/status` (how the page knows it is local), searches for the page
at `/api/search`, fetches whole records at `/api/object`, and adds the owner's Jev key to any `/relay/*` call that
carries none. The key card shrinks to one line: "Key held by the local
server". It never serves `shared/config.js`. Because it adds a key, it binds
loopback only (it refuses to start on another `HOST`) and answers 403 to any
`Host` header but `127.0.0.1`, `localhost` or `[::1]` on its own port, so a
DNS-rebinding page cannot reach the key.

Both modes send the page's headers from `public/_headers`, the same file
Cloudflare Pages applies: a Content-Security-Policy (scripts from the site
only, `frame-ancestors 'none'`; connections to the site and Algolia) and
`X-Frame-Options: DENY`.

**PUBLIC** is the deployed page. Visitors paste their own Jev key in the key
card, under the hero. The key stays in the browser: in memory by default, or,
if the visitor picks it, in `sessionStorage` or `localStorage`
(`public/jev-attributes/byok.mjs`, every call wrapped). The card shows whether
a key is set, and its expiry when the key is a JWT. Ask stays disabled until a
key is set. `--public` runs the server the way Pages would: no key of its
own, no `/api`, `shared/config.js` served.

`?q=…` fills the question in and waits for a click on **Ask**: every run
sends a question to Jev on someone's key, so a link never starts one.

### Why this site forwards the Jev call: CORS, measured 2026-10-01

| Endpoint | Preflight from a browser origin | `fetch` from the page |
| --- | --- | --- |
| `api.typesafe.ai/v1/systemone` | 400 "Disallowed CORS origin" for every origin tried (`agent-studio-demos.pages.dev`, `127.0.0.1`, `localhost`, `typesafe.ai`, `null`) | blocked |
| `<app>-dsn.algolia.net` (search) | 200, `Access-Control-Allow-Origin: *` | works |

So search runs in the browser. TypeSafe does not answer browsers directly, so
this site forwards the visitor's key to it: the Jev call goes through
`functions/relay/[[path]].js`, a Cloudflare Pages Function on the site's own
origin. It is stateless and small enough to audit:

- one route, `typesafe/systemone`, with a fixed upstream URL, POST only;
  anything else is 404 or 405
- same-origin callers only; a request without `Authorization: Bearer …` is
  refused, and no key is ever added (the local server's injection is in
  `server.mjs`, not in the forwarding function)
- forwards `Content-Type` and `Authorization` only: no cookies, no client IP
  headers; the body is capped at 512 KB and streamed back as the vendor sent it
- no logging, no KV, no cache: there is no `console` in the file (eslint has no
  `console` global there, and a test greps for it), and every response is
  `Cache-Control: no-store`
- **The forwarding is off until the site sets `RELAY_ENABLED=1`; it holds no
  key of its own, it only passes the visitor's key through.** Merging and
  deploying does not turn it on.

What the forwarding cannot promise: Cloudflare terminates TLS for it, as it does for
the static site, so the key passes through Cloudflare's edge in a header.
Workers logs are off unless the project enables them; keep them off.

While forwarding is off, the page checks once at startup (a keyless POST
answers 404 while it is off and 401 while it is on), shows no key field, says
"Forwarding is off on this site" in one line, and keeps Ask disabled.

#### Before turning forwarding on

Setting `RELAY_ENABLED=1` puts a key-forwarding endpoint on a public origin.
Neither of these is built yet; each is the owner's call, and both come first:

- [ ] **Who may call it:** Cloudflare Access in front of `/jev-attributes/*`
      and `/relay/*` (Okta, Algolia staff only), or Turnstile on the page with
      the forwarding function checking the token.
- [ ] **How often:** a WAF rate-limiting rule on `/relay/*`, per IP, so a
      stolen tab cannot turn this site into a free proxy.

### Search in public mode: a secured key

```bash
node scripts/factbook-secured-key.mjs     # appends a jevAttributes block to public/shared/config.js
node scripts/factbook-secured-key.mjs --days 30   # a shorter life than the default 90 days
```

The page holds a **secured** API key: an HMAC-SHA256 of
`restrictIndices=demo_factbook,esci_demo_factbook&analytics=false&clickAnalytics=false&validUntil=<unix time>`,
keyed with the search-only parent `ESCI_READ`, generated on the maintainer's
machine. The parent never reaches a browser. Before deriving, the script reads
the parent's ACL (`GET /1/keys/<parent>`, the only API call it makes with the
parent) and refuses unless it is exactly `search`: a secured key carries every
right of its parent. It prints the expiry date, and writes it as a comment in
the block. The script checks the key before writing it: on 2026-10-01 `esci_demo_factbook` answered 200,
`demo_factbook` 403 (the parent is scoped to `esci_*`) and an index outside the
restriction 403. It writes the block to the gitignored `config.js` (creating
it if absent, refusing to write twice); for the deploy, refresh the
`DEMO_CONFIG_JS` variable from that file. Widening the parent to
`demo_factbook` needs no new code: both names are in the restriction and the
page tries `demo_factbook` first.

**Regenerate before it expires** (90 days by default; after `validUntil`
Algolia answers 403 and the page's search fails):

1. Delete the `jevAttributes` block from `public/shared/config.js` (the
   script refuses to write a second one).
2. `node scripts/factbook-secured-key.mjs`, and read the new expiry it prints.
3. `gh variable set DEMO_CONFIG_JS --repo algolia/agent-studio-demos < public/shared/config.js`,
   then run **Actions → Deploy**.

A secured key cannot be revoked on its own. To stop one before its expiry,
rotate the parent `ESCI_READ`: every key derived from it stops with it.

**Data rule.** Jev is an outside vendor: only public or synthetic text may go
to it. It receives the question and the section descriptions, never a record
(a test pins this). The key card and the footer name the vendor.

### Measured: five questions (2026-10-02, LOCAL, one run each)

What the page showed. *Kept* is the section Jev kept, with its P(yes).
Characters are counted; tokens are characters ÷ 4, an estimate. *Jev* is the
time of the one request from the browser, forwarded by the local server; Jev's own
usage was 3,535 to 3,537 input and 366 or 367 output tokens on each.

| Question | Record | Kept | Fields | Characters | ≈ tokens, estimated | Jev |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| Peru's GDP growth | Peru | Economy 0.98 | 32 of 158 | 6,035 of 35,919 (17%) | 1,509 of 8,980 | 302 ms |
| Which countries border Austria? | Austria | Geography 0.99 | 20 of 150 | 3,054 of 34,642 (9%) | 764 of 8,661 | 233 ms |
| Compare Japan and Germany military spending | Japan | Military and Security 0.99 | 7 of 151 | 3,353 of 37,957 (9%) | 838 of 9,489 | 250 ms |
| | Germany | Military and Security 0.99 | 7 of 158 | 4,320 of 43,146 (10%) | 1,080 of 10,787 | (same call) |
| What languages are spoken in Switzerland? | Switzerland | People and Society 0.99 | 33 of 148 | 5,351 of 33,984 (16%) | 1,338 of 8,496 | 280 ms |
| How many airports does Kenya have? | Kenya | Transportation 0.99 | 5 of 154 | 500 of 34,780 (1%) | 125 of 8,695 | 301 ms |

One Jev call serves every record on screen: it reads the question and the
section descriptions, not the records, so Japan and Germany share one answer.
These questions are easy on purpose. The harder test is the study below.

### Which engine keeps the right sections? (64 questions)

`node tools/jev-attributes/study.mjs` scores the section choice on 64 synthetic
questions labelled by hand (`study-questions.json`); a question is covered when
each thing it needs has a section kept. 95% bootstrap CIs, 10k resamples; every
row is in `study-results.json`.

| Engine | Covered | Sections kept | p50 |
| --- | --- | ---: | ---: |
| Jev, levered request | 100% (64 of 64) | 1.25 | 260 ms |
| Jev, v1 request | 96.9% [92.2, 100] | 1.31 | 239 ms |
| LLM picker (`small`) | 98.4% [95.3, 100] | 1.19 | 155 ms |
| Keywords | 90.6% [82.8, 96.9], by keeping all 13 on 22 questions | 5.31 | 2 ms |
| Embeddings | 87.5% [78.1, 95.3] | 1.34 | 30 ms |
| Laya, compact request | 70.3% [59.4, 81.3] | 1.09 | 2.2 s |
| Laya, Jev's levered request | 37.5% [26.6, 50.0] | 1.13 | 8.9 s |

Levered vs v1 Jev is +3.1 pp [0.0, 7.8], not significant at this n. Laya's
usage is ~512 tokens per question whatever the state holds, so the levered
state reaches it cut short; Jev bills the state once per request. Write-ups:
conversational-ai `docs/systemone/jev/attribute_selection_2026-10-01.md` and
`docs/systemone/laya/attribute_selection_2026-10-01.md`. The arms other than
Jev live next to the study, in `tools/jev-attributes/arms.mjs`; the
embeddings row was measured in a browser, with an engine the page no longer
ships.

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

**Functions.** `wrangler pages deploy public/` also compiles `functions/` from
the directory it runs in (the repo root, in CI), so the function that forwards
jev-attributes keys to TypeSafe ships with every deploy. It answers 404 until the Pages project has the
environment variable `RELAY_ENABLED=1` (Dashboard → Pages → agent-studio-demos →
Settings → Variables). Turn it on only when the public mode should work; turn
Workers logs off for the project if they are on.

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

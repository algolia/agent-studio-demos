# Demos consolidation — investigation & conclusions

**Date:** 2026-10-08 · **Method:** 7-agent investigation (1 public census, 2 code scans, 1 ICP analysis, 1 demo vision, 1 mergeability review, 1 report build), then a mechanical spot-check of the highest-stakes claims (key-file hits verified by pattern presence only — no key values read or printed; nested repo and `memoires` divergence verified directly).

Companion artifact: `orchestration-report/index.html` (untracked, self-contained single-page visual report of the same findings).

---

## Executive summary

- **What exists publicly:** 13 demo surfaces found; the public-demo story is concentrated in one place — the `algolia/agent-studio-demos` repo and its Cloudflare Pages site (7 demos, 5+ fully live) — plus one self-host app repo (`agentic-demos-labs`, "Spencer & Williams"). The **marketing product page hosts zero live demos** (only a demo-request CTA and the Orange customer story). A dozen further demo/experiment repos exist behind private/internal visibility.
- **What we have on disk:** two collections, complementary rather than overlapping. `agent-studio-demos` is a disciplined, zero-dependency, CI-gated public site; `conversational-ai/demos` (standalone repo `algolia/genai-demos`) is an unpolished internal workshop — two real products, several frozen prototypes, **hardcoded live API keys**, a nested git repo, no unified build.
- **Mergeability:** mergeable, but only as a **deliberate curation project, not a folder move**. Of ~17 demos across both trees: ~8 worth keeping, 3–4 needing a canonical pick, 4–5 better archived than merged.
- **Cost:** **≈72–154 human hours** (≈2–4 engineer-weeks, one person familiar with the stack). The cost is dominated by trust work (credentials, copy gates, endpoint policy) — not by the mechanical move.
- **Hard preconditions:** strip **and rotate** two live API keys hardcoded at six sites (they are permanently in `genai-demos` git history → forces a clean import); land the currently **uncommitted `feat/main-demo` work** (13 modified, 14 untracked files); triage `haystack/` and `haystack26` out of any first wave; decide a key-exposure policy before more pages share the origin.
- **What to build next:** 8 demo ideas across 5 ICPs, two threads running through the strongest ones — *the honest ledger* (cost/tokens/provenance as first-class UI) and *flip to their data before the coffee arrives*.

---

## Part 1 — Public census: what Agent Studio demos exist?

Sources checked: GitHub org sweep (`gh search repos --owner algolia agent studio` — 17 repos incl. private/internal; 200 public repos keyword-filtered), `agent-studio-demos` repo contents + README, the live Pages site, `gh search code` (docsearch, agentic-demos-labs), the `algolia/skills` README, InstantSearch examples tree, the local `docs-new` checkout (`rg 'agent studio'`), docs link/playground greps, and several `algolia.com` product URLs (three guesses 404'd before landing on `/products/ai/agent-studio`).

| # | Demo | Where | Status |
|---|---|---|---|
| 1 | **What is Agent Studio? (main-demo)** | github — `algolia/agent-studio-demos` | live — retail two-lane setup (prefetch on/off RAG race), full provisioning tooling |
| 2 | **Jev trims the record (jev-attributes)** | github — Pages site | live, BYOK relay off unless `RELAY_ENABLED=1`; "Local; public with your own key" |
| 3 | **Chat with a book (chat-with-book)** | github — Pages site | live — 25 public-domain books, context folding at window scale |
| 4 | **Infinite conversation** | github — Pages site | live — shared compactor auto-shortens the thread |
| 5 | **Guardrails Arena (guardrails-arena)** | github — Pages site | live — multi-model guardrail comparison on frozen results |
| 6 | **Guardrails Game (guardrails-game)** | github — Pages site | live, static — keyboard-driven guardrail labeling game |
| 7 | **Mémoires (memoires)** | github — Pages site | live — three memory configurations side by side |
| 8 | **Spencer and Williams (agentic-demos-labs)** | github — public repo | example code, self-host — Next.js multi-vertical e-commerce platform, shopping agent + guardrail agent, streamed `displayResults` carousels |
| 9 | Dashboard playground + Response Playground | public-docs | docs-only (login-gated product feature) |
| 10 | **DocSearch Ask AI** | github — `algolia/docsearch` | live product integration on Agent Studio — largest public end-user surface, not a standalone demo |
| 11 | InstantSearch chat customization guides | public-docs | docs-only — 3 guides with snippets; the full e-commerce chat demo repo (`agent-studio-instantsearch`) is **private** |
| 12 | Agent Studio product page | algolia.com | marketing only — no live demos, demo-request CTA + Orange story |
| 13 | SDK quickstart / getting-started | public-docs | docs-only; companion `agent-studio-ai-sdk` repo is internal |

**Coverage verdict:** public demos are heavily concentrated in `agent-studio-demos` + `agentic-demos-labs`. The marketing family is the thinnest — the product page carries no live demo at all. Docs are rich in how-to content but host no runnable demo apps. Behind private/internal visibility sit candidate consolidation targets: `agent-studio-instantsearch`, `agent-studio-ai-sdk`, `agent-studio-ab-testing`, `events-assistant`, `power-merch-studio`, `filter-detection-demo`, `hackathon-agent-studio-weather-assistant`, `agentic-evals`, and others.

Notable drift found: the local checkout (`feat/main-demo`) carries uncommitted work (`haystack/`, jev-attributes modules, `shared/wire-log.mjs`) that neither the public README nor the live site reflect.

---

## Part 2 — Code scan A: `agent-studio-demos` (branch `feat/main-demo`, working tree as-is)

Upstream `github.com/algolia/agent-studio-demos`, live at `https://agent-studio-demos.pages.dev/`.

| Demo | Entry | ≈Lines | Tech | State |
|---|---|---|---|---|
| Landing page | `public/index.html` | 349 | static + tokens.css | Live |
| main-demo | `public/main-demo/index.html` | 2 770 | only ES-module demo: React 19 + react-instantsearch + algoliasearch from esm.sh via pinned import map; lane.js + 7 .mjs modules | Live on a review build; Settings/presets/twin-provisioning uncommitted |
| jev-attributes | `public/jev-attributes/index.html` | 1 760 | plain ES modules + 7 .mjs (engine, comparison, atlas, context-view…); shared transports | Live but gated on relay hardening; large uncommitted feature set |
| chat-with-book | `public/chat-with-book/index.html` | 6 220 | one 4 540-line IIFE app.js; shared config/i18n/md/meter/books | Live; largest & oldest demo |
| infinite-conversation | `public/infinite-conversation/index.html` | 2 280 | plain JS + shared compactor/meter | Live |
| guardrail-battle | `public/guardrail-battle/index.html` | 2 870 | plain JS IIFEs; frozen JSON results; live tab takes visitor key | Live |
| memoires | `public/memoires/index.html` | 2 030 | self-contained inline JS — **breaks house style** (Tailwind CDN, no tokens.css) | Live; re-host of the genai-demos original |
| haystack (untracked) | `haystack/demo/static/index.html` + `demo/proxy.py` | 6 150 | Python proxy + static app against staging EU; identity bridging; bench harness sibling | Talk workspace (2026-09-16); holds credential references — merge candidate only after heavy triage |

**Shared layer** (`public/shared/`): `tokens.css` (design language; every demo except memoires), `config.example.js` → `window.DEMO_CONFIG` (gitignored, synthesized at deploy from the `DEMO_CONFIG_JS` repo variable), `meter.js`+`meter.css` (pure cost strip, contract-tested in `tests/meter.test.js` — honesty rules are contract), `md.js` (sanitizing markdown), `books.js`, `compactor.js`, `i18n.js` (8 languages, the only check-copy exemption besides model talk), `key-store.mjs` (named visitor credentials, forget, injected storage), `system-one.mjs`, `generation.mjs`, `wire-log.mjs`, `format.mjs`. Plus: `functions/relay/[[path]].js` (stateless key pass-through, inert until `RELAY_ENABLED=1`), `tools/main-demo-provision.mjs` + `main-demo-twin.mjs` (`--list/--twin-of/--prune`, marker-scoped `DEMO_` deletes), `tools/jev-attributes/*` (local credential-injecting server + 64-question study harness), `guardrail-battle/data/*.json` (~240 KB frozen results).

**Known duplication:** the tooltip engine `tip(node, text, code, opts)` is **verbatim-duplicated** at `chat-with-book/app.js:2087` and `infinite-conversation/app.js:518` (CLAUDE.md: "change both or neither") — first dedupe target.

**Build & deploy:** zero-dependency by policy (no package.json, no bundler). `public/` is the deployable root; push to `main` → `deploy.yml` writes `public/shared/config.js` from `DEMO_CONFIG_JS` (node --check + shape assertions, also emits `public/jev-attributes/config.js`), then `wrangler pages deploy` (compiles `functions/`). Three CI gates on every PR: `npx eslint .`, `node --test tests/*.test.js` (~4 100 lines across 22 files, green without config.js), `node scripts/check-copy.js` (400 words/page, grade 9, 40/tooltip). Local: `cp config.example.js config.js` + any static server. Off-repo state: `CLOUDFLARE_API_TOKEN` secret, `DEMO_CONFIG_JS` variable, per-demo provisioning (agents, Factbook index, injected jev search key expiring 2027-10-06, books pipeline).

**Key risks:** deploy-time config synthesis must carry over in any merge; real credentials on disk outside git (repo-root `.env` referenced by haystack — never printed); meter.js contract must be re-run on any refactor; the relay ships with every deploy and one variable flips a public key-proxy; several pages deliberately expose keys in the browser (main-demo, memoires admin-ish key, guardrail-battle visitor admin key) with backend proxying done only in haystack; unstable-endpoint coupling (`/1/unstable/context/*`, raw `/1/agents` writes from the page); memoires is a design-system outlier; **the whole feature set is uncommitted**; landing-page cards are copy-gate-coupled.

---

## Part 3 — Code scan B: `conversational-ai/demos` (standalone repo `algolia/genai-demos`, branch `fix/update-config-and-verbose`)

8 381 tracked files, ignored by the parent `conversational-ai` repo. A mixed collection: two npm/JS apps, five zero-build static demos, one Vite multi-agent demo, one Marp deck (untracked symlink), two OpenAPI snapshots, one abandoned skeleton.

| Demo | Entry | ≈Lines | Tech | State |
|---|---|---|---|---|
| **algobot-cli** | `src/cli.js` (npm, published as `algobot-ai`) | 25 000 | Node CommonJS, Ink/React TUI, Commander, Jest (598 tests); embeds nested Python repo `algolia-agent-cli` (own `.git`) | Working, actively developed to 2026-03; the most production-grade piece |
| **context-management** | `index.html` (+ `lab/` FastAPI Poetry app, port 8771) | 5 600 | vanilla ES module (3 360-line app.js); lab = FastAPI/httpx/matplotlib/SQLite A/B harness over compaction strategies | Working; **the intellectual ancestor of the meter/tooltips**; local config.js holds real credentials |
| **memoires** | `comparison.html` + `extraction.html` | 4 100 | vanilla JS + Tailwind CDN; Python token scripts | Working (branch tip 2026-03; uncommitted demo2→extraction renames); **original of repo A's memoires**, with a "View PR" banner and two-demo nav |
| deepresearch | `src/index.html` (Vite, prebuilt `dist/`) | 5 900 | vanilla modules + Vite + Tailwind + Playwright | Prototype (2025-10); carries a 21 MB analysis JSON, 8 139 tracked files |
| shopping_assistant | `index.html` | 640 | vanilla ES module, marked.js | Working, frozen 2025-07; expects FastAPI backend on `localhost:8000` |
| style_studio | `index.html` | 1 090 | vanilla JS, CSS grid | Working, frozen 2026-01; Recommend tool × 5 models; expects `localhost:8000` |
| agent_chat_demo | `src/main.jsx` (Vite, :5173) | 240 | React + Vite, `.env` credentials | Working (2025-10); minimal `useChat` reference app |
| haystack26 | `deck/deck.html` — **symlink** into `conversational-ai/tasks/talk_haystack26_2026-09-09/stage` | 1 300 | Marp static build | Deck works; untracked; real sources live in the parent repo |
| azure_foundry.html | single file | 837 | Tailwind CDN page | Prototype; one-off provider content-filter tester |
| product_coach | `index.html` | 210 | skeleton | **Abandoned** — app.js it loads does not exist; empty dirs |
| rag-openapi*.json | two spec snapshots | — | OpenAPI 3.1 | Stale reference data (2025-12 / 2026-01) |

**Shared components:** the demos-copy `memoires/shared.js` (forked from repo A's); the whole `memoires/` folder (duplicated in repo A); context-management's cost-meter/tooltip/honest-savings design language (reimplemented — not imported — in repo A); two drifted OpenAPI snapshots of the same RAG spec; the hardcoded "demo credentials" pattern (see collisions); the nested `algolia-agent-cli` repo.

**Build & deploy:** no unified build — five different run models (direct-open static, two Vite apps, npm CLI with publish pipeline, Poetry FastAPI lab, Marp deck). Everything runs locally against dev/staging backends; the repo has no deploy pipeline of consequence.

**Key risks:** hardcoded live credentials (see below); haystack26 symlink with a 0600-perms `config.local.js` holding real keys adjacent; divergent memoires copies; dataset weight (21 MB JSON, dist/ artifacts, 589 KB `examples-scale.js`); nested git repo; five build systems; rotted content (product_coach, stale specs, README covering 2 of ~11 entries); hardcoded environment URLs everywhere (`agent-studio.eu.algolia.com`, `conversational-ai-dev.algolia.com`, `localhost:8000`); no license headers on most static demos.

---

## Part 4 — ICP analysis (inferred, medium confidence)

No public ICP/segmentation statement was found in the fetched docs; ICPs are derived from who would buy what the existing demos demonstrate. Public evidence is shallower than intended — several guide sub-pages and marketing pages 404'd at `.md` URLs. Buyer titles are archetypes; ICP 5 is an internal-user profile kept because the repo's own tooling is unambiguously built for that audience.

1. **Head of Search & Discovery at an existing Algolia e-commerce customer.** Director/senior EM owning search & merchandising at a mid-to-large retailer on Algolia indices. Pains: chat bolted on next to search rather than grounded in the live catalog; opaque latency/token cost ("what did this cost and is it fast?" has no answer); InstantSearch integration looks like a months-long project; nothing to show internal stakeholders on *their* catalog. Evaluates: the shopping assistant on a real index, the InstantSearch Chat widget, above all the **RAG race** (prefetch on/off medians), and "wiring a team's own agent" (twin provisioning + Settings without shipping keys).
2. **AI platform engineer accountable for token spend and context hygiene.** Senior/staff on an AI enablement team owning LLM cost and context strategy. Pains: 80–90% of input tokens are unrequested payload; no honest way to measure what attribute selection saves (procurement by vibes); unstable-context-API sharp edges. Evaluates: an A/B where the *only* variable is context selection, with a 0–5 judge, exact character counts, real usage, negative savings shown negative, and honest behavior under failure.
3. **Product engineer building document and knowledge assistants.** Founding/full-stack engineer in edtech/legal-tech/publishing/vendor-support; corpus 1M+ chars vs a 200k window, often multilingual. Pains: naive chunking destroys structure; unbounded threads; cold-start opening questions hand-written and drifting; CJK tokenization surprises (±35% within a language). Evaluates: a visible fold pipeline (Moby-Dick hierarchical trim in front of the user), per-question cost before spend, auto-compaction keeping 252-turn threads alive, one index per language.
4. **AI reliability / governance lead choosing models and guardrails.** ML platform/reliability engineer in finance/health/travel/regulated retail, defending a model+guardrail pick. Pains: leaderboards don't answer "does *this* model obey *our* rules on *our* data"; anecdotes instead of statistics; manual 10-model evaluation is weeks of YAML; no auditor-visible artifact. Evaluates: a race of up to 10 models on the same rules against their own app, with reruns, paired tests, 95% intervals, frozen reproducible results — failures shown, not just pass rates.
5. **Algolia solutions engineer / AI sales enablement.** SE/field engineer needing demos that flip to the customer's index within a meeting. Pains: stock demos get the polite nod; twin-agent provisioning is manual; keys must never leak across demo links; demo sprawl. Evaluates: `--list/--twin-of/--prune` with dry-run, presets carrying app/index/agent but never keys, fixtures labeled as replay, endpoint-naming demo cards.

---

## Part 5 — Demo vision: 8 ideas across the 5 ICPs

**Themes.** (1) **The honest ledger** — cost, tokens and data provenance on screen as first-class UI, not footnote. This is what separates Agent Studio demos from every "look, it streams!" LLM demo, and it is already house style (meter.js honesty contract, RAG-race medians, negative-savings rules). (2) **Flip to their data before the coffee arrives** — collapsing the gap between "vendor demo on toy data" and "working on my index in this meeting", the single most repeated evaluation criterion across ICPs 1, 3 and 5. The flip thread closes deals; the ledger thread keeps procurement honest.

| Idea | ICP | Pitch (short) | Showcases | ≈Effort |
|---|---|---|---|---|
| **Payload Autopsy — a context workbench** | 2 | Paste your own worst tool-result payload; watch `/context/compact` vs `/context/trim` vs format variants fight over it in real time; keep the exact surviving characters; a zero saving reads zero, not marketing zero. | arbitrary operator payloads; honest failure display; measured format deltas as a live lab; wire log | ≈14 h |
| **The Per-Turn Receipt — a phone bill for your agent** | 2 | Replay a real conversation, get the itemized bill (search usage per turn, tokens, prefetch/compaction savings) plus a projected monthly cost at your traffic; flip variables and watch the bill move. | `/usage` as a per-turn ledger; prefetch toggle with before/after cost; ≈-marked projections; frozen replayable conversations | ≈10 h |
| **The Returns Desk — an assistant that lives after checkout** | 1 | Every demo is a shopping assistant; nobody shows the 11 pm assistant customers actually need — where is my order, does this fit my printer. An agent grounded on order/shipping/FAQ indices proves Agent Studio is a post-purchase platform. | multi-index grounding beyond the catalog; tool-call transparency; WISMO memory across updates; fixture mode | ≈20 h |
| **Merchandising Copilot — type the goal, not the rule** | 1 | "Push waterproof jackets to the top in Berlin this weekend, nothing pink." The agent validates its own proposal against live facet/analytics counts, shows before/after result grids; merchandiser approves with a click. | agent calling search/facets/analytics to self-validate; generation citing real counts; before/after grids as the visual state; guardrail-shaped confirmation | ≈18 h |
| **Ask the Docs — your corpus, our docs** | 3 | An assistant over Algolia's own documentation, answering with section-level citations and folding the drawn-from docs into view — the corpus-exceeds-window problem solved the honest way, transferable to any corpus. | live `/context/trim` folding of docs.algolia.com; citation-first answers; multilingual ≈ tokenization estimates; pre-spend cost meter | ≈16 h |
| **Cold-Start Oracle — questions before the first question** | 3 | The assistant reads the index (facets, passage coverage, frequency spikes) and generates opening questions on document load, graded against the 32 hand-written chips teams maintain today. | index-grounded suggestions; A/B vs hand-written chips; each chip pre-validated by a search call; renders before the user types | ≈10 h |
| **Injection Firing Range — guardrails under attack** | 4 | Guardrail battle proves which model obeys polite test messages; the Firing Range proves which one leaks when a customer review contains a planted injection. Up to 10 models, adversarial corpora, every leak shown verbatim for the audit file. | adversarial test corpus the current demo lacks; paired tests + 95% CIs; failure-first display (exact leaked output beside the broken rule); rerun workflow | ≈14 h |
| **Ten-Second Flip — the whole shelf, their app** | 5 | One link, one pasted key, every demo on the page retargets to the customer's app/index/twin agent before the coffee arrives; "what changed" cards name the endpoints exercised. | the provision toolchain driven from a UI; presets carrying app/index/agent, never keys; BYOK key-store with search-only ACL; fixture labeling | ≈12 h |

---

## Part 6 — Mergeability review (CodeMerge)

**Verdict.** Mergeable, but only as a deliberate curation project, not a folder move. The two collections are complementary: repo A is a disciplined, zero-dependency, CI-gated public site; repo B is an unpolished internal workshop — two real products (algobot-cli, context-management + its lab), several frozen prototypes, hardcoded credentials, a nested git repo, and no unified build. The honest blocker is not code but policy: credential policy, endpoint policy, and history preservation vs clean import. Expect the real cost to be dominated by trust work — making genai-demos content pass repo A's CI gates and byok-izing it — not by the mechanical move.

### Collisions (verified, with resolutions)

1. **`memoires` forked in both trees — HIGH.** `public/memoires/index.html` (1 942 lines, credentials via `window.DEMO_CONFIG.memoires`) vs `demos/memoires/comparison.html` (1 927 lines + `extraction.html` + shared.js with a "View PR" banner and two-demo nav, hardcoded key). Diffed: ~75 divergent lines over a shared ≈1 940-line body; the public copy is the *sanitized* fork. **Resolution:** repo A's copy is canonical; port `extraction.html` onto it; adopt repo A's shared.js (drop the banner — that PR is long merged); delete the demos copy on merge.
2. **Hardcoded live API keys — HIGH, hard blocker.** Two distinct 32-hex keys across six sites: app `latency` key in `style_studio/app.js`, `memoires/comparison.html` + its `README.md`; a second key defaulting in `shopping_assistant/app.js`. Verified by hash comparison. **Resolution:** strip all six occurrences before the tree moves; migrate to `window.DEMO_CONFIG` or the visitor key-store; **rotate both keys** (already public in git history); clean import — keep genai-demos' history out of the merged repo.
3. **Tooltip engine verbatim-duplicated — MEDIUM.** `tip()` at `chat-with-book/app.js:2087` and `infinite-conversation/app.js:518`. **Resolution:** extract to `public/shared/tooltip.js` (+ css) with contract tests before or as merge phase one.
4. **Conceptually-duplicated cost meter — MEDIUM.** context-management's 3 360-line app.js embeds the naive/real/saved meter that `shared/meter.js` (462 lines) later extracted and contract-tested. **Resolution:** refactor context-management onto `shared/meter.js`; keep `lab/` as a sibling `tools/` directory — it is the intellectual ancestor and still unique.
5. **Two `haystack` assets, same name, different content — HIGH.** Repo A's untracked `haystack/` (staging-EU Python proxy with credential references, `__pycache__` in-tree) vs `haystack26/` (untracked symlink into another repo's stage dir, 0600 `config.local.js` adjacent). **Resolution:** neither merges as-is; extract at most `haystack/demo/` after credential extraction; dissolve the symlink into a built-deck copy with provenance; both stay out of the first wave.
6. **Config/credential model clash — HIGH.** Repo A synthesizes gitignored `config.js` from the single `DEMO_CONFIG_JS` variable at deploy time; repo B uses per-demo `.env` files, Vite env, local config.js with real credentials, hardcoded defaults. **Resolution:** adopt the single-variable model repo-wide with per-demo blocks (memoires already has one; add shoppingAssistant, styleStudio, contextManagement); every merged demo reads `window.DEMO_CONFIG` only.
7. **Design-system clash — MEDIUM.** memoires/deepresearch/azure_foundry use Tailwind CDN, escaping tokens.css; none of repo B's content was written against the copy gate. **Resolution:** two tiers, consciously: migrated demos get the tokens.css treatment (memoires first — it is small); long-tail demos land in a clearly-marked archive lane exempt from the copy gate, or get copy passes piecemeal. Do not widen budgets.
8. **Nested git repo — MEDIUM.** `algolia-agent-cli` (own `.git`, pyproject, tests) inside `algobot-cli`. **Resolution:** algobot-cli stays a separate repo linked from the merged site's index — it is a terminal product, not a browser demo.
9. **Landing-page/README index collisions — LOW.** Both trees enumerate demos; the deploy workflow compiles `functions/` and writes config files. **Resolution:** one editorial pass on the cards (check-copy green), extend the deploy config synthesis.

### Shared components worth reusing repo-wide

`shared/tooltip.js` (to be extracted — first dedupe target, with contract tests mirroring `meter.test.js`); `shared/meter.js` as the one meter (absorb context-management's inline meter and the extraction demo's latency stats); the `DEMO_CONFIG` deploy-time pattern (replace all `.env`/Vite/hardcoded variants); `shared/key-store.mjs` for every visitor-key demo; `shared/i18n.js` 8-language chrome; `shared/md.js` replacing marked.js and deepresearch's renderer; `shared/wire-log.mjs` + the `system-one.mjs`/`generation.mjs` transports generalized; the three CI gates as the merged repo's definition of done (where most hours go); `tools/main-demo-provision.mjs` generalized into a per-demo provisioning convention.

### Plan (one engineer familiar with the stack)

| Phase | Work | Hours |
|---|---|---|
| 0 — Land the house | Commit/push the uncommitted `feat/main-demo` work (13 modified, 14 untracked: jev comparison engine, three shared transports, Settings/presets). A merge cannot start from a dirty tree; tests already cover most of it. | 2–6 |
| 1 — Policy decisions (no code) | Clean import vs history preservation (**recommend clean import** — keys are in genai-demos history); which demos survive (keep: context-management front-end + lab, shopping_assistant, style_studio, agent_chat_demo, extraction.html port; archive: product_coach, deepresearch artifacts, azure_foundry, rag-openapi snapshots, haystack/ as-is, haystack26 symlink); endpoint/credential policy; algobot-cli separate? | 4–8 |
| 2 — Credentials & config unification | Strip the six key occurrences; rotate both keys; extend `DEMO_CONFIG_JS` synthesis with per-demo blocks; migrate every merged demo to `window.DEMO_CONFIG`; keep the relay gated; the README's Cloudflare Access/WAF TODOs stay open until deliberately decided. | 8–16 |
| 3 — Dedupe the shared layer | Extract `tooltip.js` (both or neither, with tests); context-management onto `shared/meter.js`; adopt `key-store.mjs` for visitor-key demos; replace marked.js with `shared/md.js`. | 10–20 |
| 4 — Migrate & reconcile demos | Move survivors into `public/`; reconcile memoires (canonical = repo A, port extraction.html, drop banner shared.js); retarget `localhost:8000` FastAPI dependencies or rewrite to talk straight to Agent Studio; dissolve haystack26 into a `talks/` artifact; move `context-management/lab` to `tools/` with Poetry config intact. | 24–48 |
| 5 — Gates & CI for migrated content | Every migrated demo through eslint + node --test + check-copy (400-word/grade-9 rewrites are real writing work per page, not a checkbox); rewire landing cards; extend `deploy.yml`/`ci.yml`; i18n tests green. | 16–40 |
| 6 — Verification & docs | Per-demo smoke test against the right backend; README + `docs/_DESIGN.md` update; archive notes; provisioning runbooks. | 8–16 |

**Total: ≈72 h (low) – 154 h (high)** — ≈2–4 engineer-weeks. The low bound assumes the recommended scope (7 surviving demos, memoires reconciled to its sanitized fork, both haystacks excluded, algobot-cli kept separate, config pattern extended once). The high bound adds the extraction.html port, a full copy-gate rewrite pass, the meter refactor, lab integration, and buffer for the endpoint-policy migration (the largest single unknown). The verified collision work itself is modest (memoires fork = 75 divergent lines; tooltip dedupe = two sites); the estimate is dominated by curation, credentials, and gates.

### Blockers

1. **Live API keys hardcoded at six sites** (two distinct keys) — cannot merge to a public repo before stripping *and* rotating; the keys are permanently in genai-demos git history → forces the clean-import decision.
2. **Repo A's entire current feature set is uncommitted** on `feat/main-demo` (13 modified, 14 untracked files) — no merge work can safely start until the branch lands.
3. `haystack/` is untracked talk workspace with staging-EU + centralized-memory credential references (repo-root `.env`) and committed `__pycache__` — merging as-is would sweep real credentials into git.
4. `haystack26` is an untracked symlink into another repo's stage directory with a 0600-perms `config.local.js` holding real keys adjacent.
5. The relay (`functions/relay`) ships with every deploy gated only by `RELAY_ENABLED=1`; the README's pre-flight TODOs (Cloudflare Access on `/jev-attributes/*` and `/relay/*`, per-IP WAF rate limit) are unresolved — a merge that touches Pages variables must not flip that gate.
6. Several demos deliberately expose keys in the browser (main-demo, memoires admin-ish key, guardrail-battle visitor admin key, agent_chat_demo Vite env) — a coherent demos home needs a documented key-exposure policy **before** adding pages to the same origin, not after.
7. Unstable-endpoint coupling: chat-with-book and infinite-conversation sit on `/1/unstable/context/*`; memoires calls raw `/1/agents` write APIs from the page — consolidating onto one shared deploy multiplies Agent Studio API-drift blast radius.
8. `shopping_assistant`, `style_studio` (and part of memoires) depend on a parent-repo FastAPI RAG backend on `localhost:8000` that does not exist in a merged world — rewrite to Agent Studio-direct or stay local-only; that decision gates their migration.

---

## Part 7 — Conclusions & recommended next actions

1. **Rotate the two live API keys now, regardless of whether the merge ever happens** — they are hardcoded, in git history, and referenced across three demos and a README.
2. **Land `feat/main-demo` first.** Phase 0 of every credible path; the working tree currently carries three shared transports, the Jev comparison engine, and the Settings/presets work, all already test-covered.
3. **Decide the three policies before writing any merge code:** clean import (recommended — keys in history), which demos survive (recommendation in phase 1), and the key-exposure/endpoint policy for a shared origin.
4. **Sequence the merge as trust work:** credentials → shared-layer dedupe (tooltip first, meter second) → migration → gates. The hours live in the gates, not in `git mv`.
5. **For new demos, build from the vision list** — the ledger thread (Payload Autopsy, Per-Turn Receipt) is cheap (≈10–14 h each), plays to existing house strengths, and answers ICP 2's procurement question; the Returns Desk and Merchandising Copilot open the second-budget-line conversation with ICP 1; Ten-Second Flip turns the SE runbook into product. The marketing gap (zero live demos on the product page) is the hole every one of these fills.
6. **Keep algobot-cli and both haystack assets out of the merge** — a terminal CLI is not a browser demo, and neither haystack is safe to move without credential triage.

*Verification note: the census, vision, ICP and merge streams were reviewed in full; the conversational-ai scan's highest-stakes claims (key-file hits, nested repo, memoires divergence) were independently re-verified mechanically after the fact — pattern presence only, no key values read or recorded.*

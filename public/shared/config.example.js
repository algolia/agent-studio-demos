// Copy to config.js and fill in your own values. config.js is gitignored.
//
// The context endpoints and agent completions are called directly from the
// browser, so whatever key you put here is visible to anyone who loads the page.
// For a public deployment, proxy these calls through your own backend.
window.DEMO_CONFIG = {
  host: "https://agent-studio.eu.algolia.com",
  appId: "YOUR_APP_ID",
  apiKey: "YOUR_API_KEY",

  // One published agent per model: /completions takes the model from the agent
  // (per-request `configuration` overrides are rejected with 422
  // "Dynamic configuration not allowed" on most apps).
  // providerId + model are also sent to /context/compact, which runs the
  // summary on your own provider credentials.
  //
  // contextWindow is the model's REAL published window — the hard ceiling the
  // provider enforces on both /completions and the summarizer behind
  // /context/compact. The oversize guard measures against this, never against
  // the demo's working budget below.
  models: [
    {
      id: "enablers",
      label: "Enablers small",
      note: "via an openai_compatible provider",
      // Headline option: Algolia's own open-source model family, reached through an
      // openai_compatible provider. Verified: /context/compact works through it.
      badge: "Algolia open-source",
      agentId: "b3fb1cf2-81e0-4721-9142-c860518784bb",
      // The chat-with-a-book demo talks to its own agent: same model, but carrying
      // the shelf search tool and book-specific instructions. Two sets of agents
      // rather than one, because a tool schema is sent — and billed — on every
      // request, and the infinite-conversation demo argues from the numbers on its
      // own meter. Create these with `node scripts/create-book-agents.js --push`,
      // which prints the ids to paste here. Omit the field and the book page falls
      // back to `agentId`, working exactly as before but without shelf search.
      bookAgentId: "YOUR_BOOK_AGENT_ID",
      // The same agent at four wider page sizes, keyed by hits per search.
      // `hitsPerPage` is welded to the agent — the tool's value beats the number
      // the model asks for, and a request cannot move it — so the greedy
      // retrieval control swaps ids rather than sending a parameter. Measured on
      // this shelf: ~1,300 characters a passage, so 1,000 hits is ~326,000
      // tokens of tool output in one turn. The same script creates these; a
      // level with no id here is shown disabled rather than quietly serving 5.
      greedyAgentIds: {
        "50": "YOUR_GREEDY_50_AGENT_ID",
        "100": "YOUR_GREEDY_100_AGENT_ID",
        "500": "YOUR_GREEDY_500_AGENT_ID",
        "1000": "YOUR_GREEDY_1000_AGENT_ID",
      },
      providerId: "c39b45b0-ff20-401f-a9ef-2c4c2fd016f8",
      model: "small",
      // The provider publishes no window: neither GET /1/providers/{id} nor
      // GET /1/providers/{id}/models carries one (the model list is bare strings),
      // and the upstream openai_compatible /v1/models answers 401. So the ceiling
      // was measured instead, by bisecting /context/compact with high-entropy text:
      //   248,893 tokens → 200 in 47s   |   255,901 tokens → 500 in 1.5s
      // The refusal is immediate, so it is the provider rejecting on length rather
      // than the summarizer timing out. Real ceiling therefore ~256k; 200,000 is the
      // nearest standard size strictly below what was verified to pass, so the
      // oversize guard can never wave through a payload the provider would refuse.
      contextWindow: 200000,
      windowVerified: true,
      windowNote: "The provider publishes no context window, so this one was measured: " +
        "context/compact accepted 248,893 tokens and refused 255,901 (immediately, in 1.5s — a " +
        "length rejection, not a timeout), which puts the real ceiling near 256k. The demo " +
        "carries 200,000, the nearest standard size below what was verified to pass.",
    },
    {
      id: "mini",
      label: "gpt-4.1-mini",
      note: "OpenAI · small",
      agentId: "YOUR_AGENT_ID",
      providerId: "YOUR_PROVIDER_ID",
      model: "gpt-4.1-mini",
      contextWindow: 1047576,
    },
  ],

  // Working budget the meter fills against. Real windows are on the model
  // options; these smaller budgets make compaction observable in a demo.
  budgets: [
    { label: "4k", value: 4000 },
    { label: "8k", value: 8000 },
    { label: "32k", value: 32000 },
    { label: "model window", value: null },
  ],
  defaultBudget: 8000,
  compactAtRatio: 0.7,
  keepLastMessages: 6,

  // ── Oversize handling ────────────────────────────────────────────
  // Above this share of the model's real window nothing is sent: not to
  // /completions (400 "prompt is too long") and not to /context/compact in one
  // piece either — that endpoint forwards its whole payload to the summarizer,
  // which overflows the same window and answers 500. Instead the document is
  // folded bottom-up, section by section.
  oversizeAtRatio: 0.8,

  // Target size of one section handed to the summarizer. Measured against
  // /context/trim: 60k tokens compacts in ~4–6 s and leaves a wide margin under
  // a 200k window. Sections much larger still succeed but summarize thinner.
  foldChunkTokens: 60000,

  // Cap on each section summary. Uncapped, the summarizer writes thousands of
  // tokens per section and the fold takes minutes; output tokens are what the
  // latency is made of. 250 words still carries every chapter title.
  foldSectionWords: 250,

  // Only used before the first trim probe. After it, the real chars-per-token
  // ratio is derived from the endpoint's own count — the usual ~4 is badly wrong
  // for non-English text (this demo's French book runs at ~2.7).
  charsPerTokenFallback: 4,

  // Cap on the joint digest the reduce pass writes. Same lesson as
  // foldSectionWords, one level up: left open, the reduce faithfully reproduces
  // all six section summaries and the digest comes back as large as the
  // concatenation it replaced — measured at 8,182 → 8,484 tokens in 123 s, which
  // is all latency and no compression. Capped, the same six summaries join into
  // ~1,200 tokens in a fraction of the time, and the seams are still smoothed.
  foldDigestWords: 900,

  // How many section summaries run at once. Each section is an independent
  // /context/compact call, so they parallelise cleanly; the ceiling is the
  // provider's rate limit, not this page. On a 429 the section backs off once
  // and then gives up as a placeholder rather than failing the whole fold.
  //
  // `null` means ALL sections at once, and it is the default because the fold is
  // the demo's hot path: a reader watching War and Peace go in should not wait
  // out five sequential rounds of three. The map has no ordering constraint, so
  // the whole pass costs one slowest section instead of ceil(n/3) of them — on
  // the 16-section reference book that is a fold that finishes in about the time
  // one section takes. Set an integer to cap it if a provider starts answering
  // 429; the retry already handles the occasional one.
  foldConcurrency: null,

  // After the sections land, one more /context/compact call over the section
  // summaries joins them into a single digest — it dedups entities and smooths
  // the seams between sections. Set false to keep the raw concatenation.
  foldReducePass: true,

  // Sections → digest → digest-of-digests. Two passes clear a 1M-char book.
  maxFoldLevels: 3,

  // The line above which a tile asks before it spends. Ingesting a book runs
  // every word past the summarizer once, on your own provider credentials, so
  // it is a per-click cost rather than a one-off — above this estimate the tile
  // shows a confirm and sends nothing until it is accepted. Read live, so it
  // moves with the model picker: the rate changes, the estimates change, and
  // the shelf's cost-gated group rearranges. Omit it and the demo uses 0.5.
  costConfirmUsd: 0.5,

  // The same gate's second line, in tokens, and it exists because the first one
  // is a rate away from silence: 紅樓夢 is 3,020,297 tokens and 51 summarizer
  // calls, which at the default $0.10 per million comes to $0.30 — under the
  // money line, so the largest fold on the shelf would start without asking.
  // 500,000 is 2.5 default windows, above Moby-Dick's 329,443 and Ulysses'
  // 444,359 so the demo's own hero flows stay one click. Unlike the money line
  // this one holds with no rate configured at all. Omit it and the demo uses
  // 500000.
  costConfirmTokens: 500000,

  // Most sites do not send Access-Control-Allow-Origin, so a browser cannot
  // read them directly. When the direct fetch is refused, the URL is read
  // through this public reader instead — always named in the UI and wire log,
  // never silent. Set to null to disable the fallback entirely.
  readerProxy: {
    url: "https://r.jina.ai/",
    label: "r.jina.ai reader",
  },

  repoUrl: "https://github.com/algolia/agent-studio-demos",

  // Jev picks the attributes, public mode. Search runs in the browser on a
  // SECURED key: an HMAC of a search-only parent key, restricted to the
  // Factbook index names, analytics forced off. Never paste the parent here.
  // Derive and write this block with `node scripts/factbook-secured-key.mjs`.
  jevAttributes: {
    appId: "YOUR_APP_ID",
    searchKey: "YOUR_SECURED_FACTBOOK_KEY",
    indexes: ["demo_factbook", "esci_demo_factbook"],
  },

  // ── main-demo ("What is Agent Studio?") ───────────────────────────
  // Its own block, because it talks to a different backend and index than the
  // book demos. Locally, agent ids are not here: tools/main-demo-provision.mjs
  // writes them to public/main-demo/variants.json, one agent per toggle set.
  // A deploy has no variants.json (it is gitignored), so it carries the same
  // map in `variants` below.
  mainDemo: {
    // Agent Studio API. A local backend by default; the page replays a fixture
    // when nothing answers here.
    host: "http://127.0.0.1:8000",
    appId: "YOUR_APP_ID",
    // Search-only key for the InstantSearch client. Omit it and the lanes run
    // on a stub client: the Chat widget still hydrates from the agent's stream.
    searchApiKey: "YOUR_SEARCH_ONLY_API_KEY",
    // Sent on /completions. The agent's search tool searches with this key,
    // so it needs search on indexName — and nothing more.
    agentStudioApiKey: "YOUR_AGENT_STUDIO_API_KEY",
    indexName: "YOUR_PRODUCTS_INDEX",
    // Optional: record attributes the product cards read, tried before the
    // defaults (name/title, image, price, description).
    // fields: { title: "name", image: "image", price: "price.value", line: "brand" },
    // Optional: the variant map, config key → agent. When present the page uses
    // it and never fetches variants.json; leave it out locally so the script's
    // file is read. Print it from a provisioned backend, agent ids only, with
    //   MAIN_DEMO_HOST=… APP_ID=… ADMIN_KEY=… node tools/main-demo-provision.mjs --print-config
    // and paste the output here. An entry with no agentId is ignored.
    // variants: {
    //   "prefetch=0,memory=0,guardrails=0,suggestions=0": { agentId: "YOUR_BASE_AGENT_ID", name: "main-demo-base" },
    //   "prefetch=1,memory=0,guardrails=0,suggestions=0": { agentId: "YOUR_PREFETCH_AGENT_ID", name: "main-demo-prefetch" },
    // },
  },
};

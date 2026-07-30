#!/usr/bin/env node
/* ───────────────────────────────────────────────────────────────
   create-book-agents.js — one book-demo agent per model, plus one per greed
   level, with the shelf search tool attached.

     node scripts/create-book-agents.js            # dry run — calls nothing
     node scripts/create-book-agents.js --push     # create, publish, verify

   ── Why one agent per page size ──────────────────────────────────
   `hitsPerPage` is welded at agent level: the tool's own value always beats the
   number the model asks for, and `searchControls` keeps the parameter out of the
   schema the model sees at all. A request cannot move it either. So the greedy
   retrieval control in the book demo cannot be a request field — it is a
   different agent, identical in every other byte, and the page swaps ids when
   the reader moves the knob.

   ── Why clone instead of patching the existing agents ────────────
   The four agents the demos already share carry `tools: []`. Adding the search
   tool to them would be one fewer agent to manage, and it would also be wrong:
   a tool schema is sent on every request, so it is billed on every request. The
   infinite-conversation demo puts a token meter on screen and argues from the
   numbers in it. Injecting a fixed cost into that demo would corrupt the very
   instrument it exists to show. Two demos, two sets of agents, honest meters.

   Cloning also fixes a smaller embarrassment: the shared agents' instructions
   open with "for the Infinite Conversations demo", which the book demo has been
   quietly inheriting.

   ── enableAlgoliaMcp: false is set, and does not win ─────────────
   Set deliberately, and measured to be INERT here. The completions router builds
   the flag as an OR of three sources:

     query param ?enableAlgoliaMcp=true
     OR agent config enableAlgoliaMcp
     OR the `algolia_mcp_enabled` GenAI feature flag

   The feature flag is on for this application, so agent config cannot turn MCP
   off — the tool is served over the MCP transport whatever this file says. Two
   consequences that shape everything below:

     1. The tool the model sees is the MCP server's schema — multi-query, with
        per-attribute `facet_<name>` parameters — not the internal tool's
        (`query`, `number_of_results`, `facet_filters`). Observed: the model sent
        `facet_book: "Moby-Dick; or, The Whale"` and every call failed with
        "'Moby-Dick; or, The Whale' is not valid under any of the given schemas",
        seven times in one turn, after which the agent apologised. Hence the
        explicit "do not use facet filters" in the index description: the book
        title belongs in the query text, where it is searchable anyway.
     2. `distinct` is stripped from the search parameters unless the separate
        `algolia_mcp_distinct_enabled` flag is on, so the one-passage-per-book
        shelf sweep is not available from here. `searchParameters` still reaches
        the MCP server, forwarded into its `custom` field as a legacy fallback,
        which is why the attribute trimming below still holds.

   The flag is left `false` so that the intent is recorded and the agent behaves
   correctly if the feature flag is ever turned off.

   ── Idempotence ──────────────────────────────────────────────────
   Agent names are unique per demo here by convention, not by constraint: the API
   will happily create a second agent with the same name. So --push lists the
   existing agents first and refuses to create one whose name is already taken,
   reporting the id it found instead. Re-running is therefore safe and tells you
   the ids again, which is usually why you re-ran it.

   ── The credential boundary ──────────────────────────────────────
   `ALGOLIA_APP_ID` and `ALGOLIA_WRITE_API_KEY` come from the environment, or from
   a gitignored .env next to this repo's root (see .env.example) — never from a
   flag, and never printed. This is the WRITE key: it creates and publishes
   agents. It is not, and must never become, the key in public/shared/config.js,
   which is search-only and is served to every visitor.

   A dry run needs no credentials and is the default.
   ─────────────────────────────────────────────────────────────── */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { loadEnv, describeEnv } = require("./env.js");

const HOST = process.env.AGENT_STUDIO_HOST || "https://agent-studio.eu.algolia.com";
const INDEX_NAME = process.env.ALGOLIA_INDEX_NAME || "public_domain_books";

const argv = process.argv.slice(2);
const PUSH = argv.includes("--push");

/* ── --only, and why it exists ────────────────────────────────────
   This file's desired state is twenty live agents, and a re-run converges all of
   them. That is the right default and the wrong first move after changing the tool
   shape: binding eight indices instead of one changes what the model sees on every
   request, and the honest way to find out what it does with that is to move ONE
   agent, ask it something, read the frames, and only then move the other nineteen.

     node scripts/create-book-agents.js --push --only enablers/5

   Matches on `slug/hits`, or on a bare slug for every page size of one model. */

const ONLY = (() => {
  const i = argv.indexOf("--only");
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
})();

const selected = (v) => !ONLY || ONLY === v.slug || ONLY === `${v.slug}/${v.hits}`;

/* ── The models to clone ──────────────────────────────────────────
   Kept as data rather than read from config.js, because config.js is gitignored
   (it holds the public search key) and a script in this repo must run from a
   clean checkout. `sourceAgentId` is recorded for provenance only — nothing is
   read from it at run time, so a rotated demo agent does not break this file. */

const MODELS = [
  { slug: "enablers", model: "small", providerId: "c39b45b0-ff20-401f-a9ef-2c4c2fd016f8" },
  { slug: "mini", model: "gpt-4.1-mini", providerId: "ab376c1e-dbeb-4561-a5e3-350ed676dec8" },
  { slug: "nano", model: "gpt-4.1-nano", providerId: "ab376c1e-dbeb-4561-a5e3-350ed676dec8" },
  { slug: "haiku", model: "claude-haiku-4-5-20251001", providerId: "94e6bf5d-a9a4-4bf7-a53d-090a01edf162" },
];

/* ── The greed levels ─────────────────────────────────────────────
   5 is what a reader gets by default and what the demo has always used. The rest
   exist to be over-fetching, on purpose: 1,000 is Algolia's hard ceiling for one
   request, and at ~1,250 characters a passage it is roughly 372k tokens of tool
   output in a single turn — 1.9x a 200k window. The point of the control is that
   the meter prices that flood before the reader clicks it. */

const GREEDS = [50, 100, 500, 1000];
const DEFAULT_HITS = 5;

/** every agent this file owns: the four defaults, then four greedy clones each */
const ALL_VARIANTS = MODELS.flatMap((m) =>
  [DEFAULT_HITS, ...GREEDS].map((hits) => ({ ...m, hits })));

const VARIANTS = ALL_VARIANTS.filter(selected);

/* ── The shelf, as the model is told about it ─────────────────────
   Read from books.js so the tool description cannot drift from what is actually
   indexed. Naming the titles costs perhaps 200 tokens on every request and earns
   it back the first time the model declines to search for a book we do not have.
   The War and Peace note is not decoration: the Maude translation accents its
   names, and a search for "Anna Pavlovna" without the accent finds nothing. */

const shorten = (a) => a.replace(/\s*\(trans\..*?\)/, "").replace(/^selected by /, "");
const titleLine = (books) => books.map((b) => `${b.title} (${shorten(b.author)})`).join(" · ");

function readShelf() {
  const src = fs.readFileSync(path.join(__dirname, "..", "public", "shared", "books.js"), "utf8");
  const sandbox = { window: {} };
  new Function("window", src)(sandbox.window);
  const shelf = sandbox.window.DEMO_BOOKS || {};
  const books = shelf.books || [];
  const originals = shelf.booksI18n || [];
  if (books.length < 2 || !originals.length) {
    throw new Error("could not read both shelves out of books.js");
  }
  return {
    count: books.length,
    titles: books.map((b) => b.title),
    line: titleLine(books),
    originals,
    /** lang → the books in it, in the order books.js lists them */
    byLang: originals.reduce((acc, b) => {
      (acc[b.lang] || (acc[b.lang] = [])).push(b);
      return acc;
    }, {}),
  };
}

const SHELF = readShelf();

/* Passages on THIS shelf, not every passage in the file. passages.jsonl carries
   every book the repo has chunked — the i18n shelf went to one index per language
   — so a bare line count would tell the model the index holds 17,345 passages
   when the index it can search holds 11,115. Counted by book title against the
   shelf read above, which is the same list the description names. */

const PASSAGES_BY_LANG = (() => {
  const p = path.join(__dirname, "..", "passages.jsonl");
  if (!fs.existsSync(p)) return null;
  const titles = new Set(SHELF.titles);
  const byLang = {};
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch (_) { continue; }
    // English counts by TITLE, not by lang: the English index holds exactly the
    // sixteen the description names, and passages.jsonl holds every book the repo
    // has ever chunked.
    const key = titles.has(rec.book) ? "en" : rec.lang;
    if (!key) continue;
    byLang[key] = (byLang[key] || 0) + 1;
  }
  return byLang;
})();

const passageCount = (lang) => (PASSAGES_BY_LANG || {})[lang] || null;
const PASSAGE_COUNT = passageCount("en");
const shelfSize = PASSAGE_COUNT
  ? `${PASSAGE_COUNT.toLocaleString("en-US")} passages`
  : "passages";

const INDEX_DESCRIPTION =
  `The full text of ${SHELF.count} public-domain books, cut into ${shelfSize} of about 190 ` +
  `words each. The shelf is exactly: ${SHELF.line}. The War and Peace translation accents its ` +
  `names — Anna Pávlovna, Platón Karatáev, Borodinó — so search them accented. One hit is one ` +
  `passage and carries its book, chapter number, chapter title and position in the book, so you ` +
  `can cite it. Use this to locate something precise: an exact phrase, who says a line, where ` +
  `an event happens. Use it for any book that is not already in the conversation, and to ` +
  `compare across books, which is otherwise impossible because at most one book is ever pasted ` +
  `in. It is the wrong instrument for a question about a book as a whole — a handful of ` +
  `passages cannot show an arc, a theme, or how a character changes. ` +
  `DO NOT use facet filters with this index. Put the book's title in the query text instead — ` +
  `titles and authors are searchable, so "Moby-Dick doubloon mast" works and a facet filter on ` +
  `the title is rejected. One query at a time is enough; prefer distinctive words from the ` +
  `passage you are looking for over a restatement of the reader's question.`;

/* ── Instructions ─────────────────────────────────────────────────
   Written as a decision rule with an explicit negative case. The first version of
   this demo let the model decide for itself whether it "needed to find more",
   and it read as hedging: it searched for things already in front of it and
   narrated the deliberation. What a reader wants is an answer, and what a demo
   about context wants is a visible reason for each search. Hence: what you have,
   when to search, when NOT to search — that third paragraph is the load-bearing
   one. */

const INSTRUCTIONS = `You are a good reader, talking with someone about a book you have both read.

WHAT YOU ALREADY HAVE. Usually the whole book is in this conversation, pasted in full. When it is, that text is your source. Read it and answer from it. Never search for something already in front of you.

WHEN TO SEARCH. Use the shelf search tool when the reader wants something precise that you cannot see: an exact phrase, who speaks a line, where an event happens, or anything about a book that is not in this conversation. Searching is also the only way to compare across books, because only one book is ever pasted in. Put the book's title in the query text — titles are searchable. Do not use facet filters.

WHICH INDEX. The shelf is eight indices, one per language, and each one's description names the language and the works in it. Search the index that holds the book being asked about, in that book's own language and script: a question about 羅生門 goes to the Japanese index with Japanese words in it, not to the English one. If the reader asks in their own language about a book written in another, search in the BOOK's language — that is where the words are — and answer in theirs.

WHEN NOT TO SEARCH. Questions about a book as a whole — its arc, its themes, its tone, how a character changes, what the book is doing — cannot be answered by five passages. Answer those from the text you hold. Searching them yields confident fragments and a worse answer than reading would have given.

ANSWER LIKE SOMEONE WHO HAS READ IT. Ground every answer in the book's own words: quote the line that settles it and say where it sits. "DRINK ME, on the bottle she finds at the bottom of the hall — chapter 1" is worth three of "the bottle is labelled DRINK ME", because the first shows you actually looked. For a question about the whole book, name two or three specific moments instead of describing a theme in the abstract. One concrete detail the reader had forgotten is worth a paragraph of summary.

Be brief but not curt. Two or three sentences with a quotation in them beat five without one. Never restate the question back, never pad, and never end by offering to help further — just answer, and let the next question come.

IF THE CONTEXT WAS COMPACTED. Earlier turns may have been folded into a summary to save room. When a detail is no longer there, say so plainly and offer to look it up. Do not fill a gap by invention. If a search comes back with nothing useful, say that too, rather than reaching for what you remember of the book.

LANGUAGE. Reply in the language the reader writes to you in, whatever language the book is in. If the reader asks for a language explicitly, that request wins over anything you infer. If the book is in a different language from theirs, quote the original and then gloss it in their language.`;

/* ── The tool ─────────────────────────────────────────────────────
   Flat records, on purpose and against the index's own defaults. The index
   snippets and highlights `text`, and both arrive as NESTED `_snippetResult` /
   `_highlightResult` objects wrapped around markup. For a ~190-word passage that
   trades an exact quotable sentence for `<em>` noise and a nested shape, so both
   are turned off here. Measured on this index: the attribute profile moves cost
   per record by about 10x, far more than any encoding choice.

   `hitsPerPage` is set on the tool, and a tool-level `hitsPerPage` always wins
   over whatever the model asks for. Five ~190-word passages is roughly 1,250
   tokens, which fits the 8k working budget this demo defaults to — so five is
   what the agent a reader chats to carries. The greedy levels are the same tool
   with one number changed, on their own agents.

   `mode: "static"` means this list is the only thing the tool can ever search:
   a per-request `algolia.indices` override is rejected with a 422 rather than
   quietly honoured. That matters here — the same key can read every index in
   this Algolia application. */

const RETRIEVE = ["book", "chapter", "chapterTitle", "position", "text"];

/* ── One index per language, bound to the same tool ────────────────
   Eight entries, and a tool takes at most ten, so the shelf has room for two more
   languages before this has to become something cleverer.

   Why not one index: `indexLanguages` is a settings-global. It cannot vary per
   record, and CJK word segmentation only happens when the CJK language is
   declared on the index itself — so 羅生門 and Faust cannot share one, and once
   the shelf is split for those two there is no reason to leave the rest mixed.

   Each description names its language, its works and its size, because that
   description is the only thing the model has to pick an index with. Naming the
   language in the FIRST clause is deliberate: a question in Russian should reach
   the Russian index without the model reading nine titles to work out which one
   holds Достоевский. And the sizes are honest — the Japanese index holds thirteen
   passages, which is worth the model knowing before it decides to search there. */

const LANG_NAMES = {
  fr: "French", de: "German", es: "Spanish", it: "Italian",
  ru: "Russian", ja: "Japanese", zh: "Chinese (traditional)",
};

function langDescription(lang) {
  const books = SHELF.byLang[lang];
  const n = passageCount(lang);
  const size = n ? `${n.toLocaleString("en-US")} passages` : "passages";
  return `${LANG_NAMES[lang] || lang} only, in the original language, not a translation. ` +
    `${size} from: ${titleLine(books)}. Search this index with ${LANG_NAMES[lang] || lang} ` +
    `words, in the language's own script. Use it when the reader asks about one of those ` +
    `works, or asks in ${LANG_NAMES[lang] || lang} about something they might hold. ` +
    `One hit is one passage and carries its book, chapter and position, so you can cite it. ` +
    `DO NOT use facet filters here either: put the title in the query text.`;
}

/** English first, keeping the unsuffixed index, then one entry per language */
function indicesFor(hitsPerPage) {
  const langs = Object.keys(SHELF.byLang);
  const entries = [{ index: INDEX_NAME, description: INDEX_DESCRIPTION }]
    .concat(langs.map((lang) => ({
      index: `${INDEX_NAME}_${lang}`,
      description: langDescription(lang),
    })));
  // hitsPerPage rides on EVERY entry, on both channels. A greedy variant with the
  // page size on the first index only is a knob that works for English and lies
  // for the other seven.
  return entries.map((e) => ({
    index: e.index,
    description: e.description,
    // `searchParameters` is the internal tool's channel. On the MCP path it is
    // still forwarded, into the MCP server's `custom` field as a legacy fallback
    // (agent/tools/mcp.py) — and notably WITHOUT the `distinct` strip that
    // `searchControls` suffers, which makes this the channel that actually gets a
    // `distinct` through today. It is left off here deliberately: this index sets
    // attributeForDistinct: "book", so distinct would cap a within-book search at
    // ONE passage per book. The shelf-sweep agent is where it belongs.
    searchParameters: {
      attributesToRetrieve: RETRIEVE,
      attributesToHighlight: [],
      attributesToSnippet: [],
      hitsPerPage,
    },
    // `searchControls` is the MCP server's own channel, and MCP is the platform
    // default — the completions router ORs the agent flag with an
    // `algolia_mcp_enabled` feature flag, so this is the path that runs. Each
    // parameter is {exposed, default}: `exposed: false` sets the value and keeps
    // it out of the tool schema the model sees, which is what we want for all of
    // these — the model chooses words, not page sizes.
    searchControls: {
      hitsPerPage: { exposed: false, default: hitsPerPage },
      attributesToRetrieve: { exposed: false, default: RETRIEVE },
      custom: { attributesToHighlight: [], attributesToSnippet: [] },
    },
  }));
}

const toolsFor = (hitsPerPage) => [{
  type: "algolia_search_index",
  name: "search_the_shelf",
  mode: "static",
  indices: indicesFor(hitsPerPage),
}];

/* ── Suggestions ──────────────────────────────────────────────────
   The follow-up chips. Without this the book page can only offer the fixed pair
   of openings baked into books.js, and once those are spent the demo has nothing
   to say — click one twice and it answers the identical question identically,
   which reads as the page talking to itself.

   maxWords is at the schema's ceiling (15) because a follow-up about a novel is
   not "Show me trending products": "Does Ahab ever doubt the hunt out loud?" is
   already 8. includeToolOutputs stays false — the retrieved passages would
   dominate the suggester's context and it would start proposing questions about
   whichever five passages happened to come back. */

const SUGGESTIONS = {
  enabled: true,
  generation: { maxCount: 3, maxWords: 15, timeoutSeconds: 10, retryAttempts: 1 },
  context: { maxMessages: 8, includeToolOutputs: false },
};

/**
 * The name a variant owns. The default agent keeps the bare name the demos
 * already point at; every greedy clone is suffixed with its page size, so the
 * live list reads as one family and the ids can be matched back by number.
 */
const nameFor = ({ slug, hits }) =>
  `context-management-demo-books-${slug}` + (hits === DEFAULT_HITS ? "" : `-greedy-${hits}`);

/* Instructions are byte-identical across all five variants, including the line
   that says a whole-book question "cannot be answered by five passages". That
   reads oddly on the 1,000-hit clone and it stays anyway: one knob differs
   between these agents, which is what makes the reader's comparison a
   measurement rather than an anecdote. */

const payloadFor = (variant) => ({
  name: nameFor(variant),
  description: `Chat-with-a-book demo agent (${variant.model}) — shelf search over ` +
    `${indicesFor(variant.hits).length} indices, ` +
    `${SHELF.count + SHELF.originals.length} titles in ` +
    `${Object.keys(SHELF.byLang).length + 1} languages, hitsPerPage=${variant.hits}`,
  model: variant.model,
  providerId: variant.providerId,
  instructions: INSTRUCTIONS,
  tools: toolsFor(variant.hits),
  // MCP is the platform default and the feature flag forces it on regardless, so
  // the flag is set to match reality rather than to state a preference the
  // platform will not honour. temperature is up from the 0.3 the conversation
  // agents use: at 0.3 the answers came back correct and completely flat, which
  // is the wrong failure for a demo somebody has to enjoy reading.
  config: {
    temperature: 0.55,
    max_tokens: 1200,
    enableAlgoliaMcp: true,
    suggestions: SUGGESTIONS,
  },
});

/* ── Credentials and transport ────────────────────────────────── */

function credentials() {
  const note = describeEnv(loadEnv());
  if (note) console.log(note + "\n");
  const appId = process.env.ALGOLIA_APP_ID;
  const apiKey = process.env.ALGOLIA_WRITE_API_KEY;
  if (!appId || !apiKey) return null;
  return { appId, apiKey };
}

async function call(creds, method, urlPath, body) {
  const res = await fetch(HOST + urlPath, {
    method,
    headers: {
      "content-type": "application/json",
      "x-algolia-application-id": creds.appId,
      "x-algolia-api-key": creds.apiKey,
      // The edge in front of this service answers 403 "error code: 1010" to any
      // request without a browser-shaped User-Agent. Node's fetch sends its own,
      // which is not browser-shaped, so this header is load-bearing, not cargo.
      "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* keep the raw body */ }
  if (!res.ok) {
    const detail = (json && (json.message || json.detail || json.error)) || text.slice(0, 400);
    throw new Error(`${method} ${urlPath} → ${res.status}: ${JSON.stringify(detail).slice(0, 400)}`);
  }
  return json;
}

/**
 * Publish, treating "already published" as success.
 *
 * Publishing is idempotent in intent but not in the API: a second call answers
 * 409. Converging an existing agent has to publish (a PATCH lands as a new
 * version), and it must not fail because the agent was already published last
 * time this script ran.
 */
async function publish(creds, id) {
  try {
    const res = await call(creds, "POST", `/1/agents/${id}/publish`, {});
    return (res && res.status) || "published";
  } catch (e) {
    if (/409/.test(e.message) && /already published/i.test(e.message)) return "already published";
    throw e;
  }
}

/**
 * Every agent in the application, as name → id.
 *
 * `GET /1/agents` answers `{data, pagination}` and its `limit` defaults to **10**,
 * so the first page is not the whole list — an earlier version of this function
 * read a key that does not exist, quietly got an empty list, and would have
 * created a second copy of every agent on a re-run. Hence two rules here: read
 * the documented shape, and throw rather than return an empty map if the shape is
 * not what we expect. A guard that fails open is worse than no guard, because it
 * reports success.
 */
async function listAgents(creds) {
  const byName = new Map();
  let page = 1;
  for (;;) {
    const res = await call(creds, "GET", `/1/agents?page=${page}&limit=100`);
    const data = res && res.data;
    if (!Array.isArray(data)) {
      throw new Error(`GET /1/agents did not answer {data: [...]} — got keys ` +
        `[${Object.keys(res || {}).join(", ")}]. Refusing to guess, because an empty ` +
        `list here would silently create duplicate agents.`);
    }
    for (const a of data) if (a && a.name) byName.set(a.name, a.id);
    const total = (res.pagination && res.pagination.totalPages) || 1;
    if (page >= total || data.length === 0) break;
    page += 1;
  }
  return byName;
}

/* ── Main ─────────────────────────────────────────────────────── */

async function main() {
  if (!PUSH) {
    console.log(`Dry run — nothing is sent. Host: ${HOST}\n`);
    console.log(`Would POST ${VARIANTS.length} agents, then publish each:\n`);
    for (const v of VARIANTS) {
      console.log(`  ${nameFor(v).padEnd(52)} model=${v.model} hitsPerPage=${v.hits}`);
    }
    console.log(`\nShelf read from books.js: ${SHELF.count} English titles` +
      (PASSAGE_COUNT ? `, ${PASSAGE_COUNT.toLocaleString("en-US")} passages in passages.jsonl` : "") +
      `, plus ${SHELF.originals.length} originals in ${Object.keys(SHELF.byLang).length} languages`);
    const bound = indicesFor(DEFAULT_HITS);
    console.log(`Tool: search_the_shelf · mode=static · ${bound.length} indices · ` +
      `hitsPerPage=${[DEFAULT_HITS, ...GREEDS].join("/")}`);
    for (const e of bound) {
      console.log(`  ${e.index.padEnd(26)} ${e.description.length} chars of description`);
    }
    console.log(`Tool schema: ${JSON.stringify(toolsFor(DEFAULT_HITS)).length} chars, ` +
      `sent on every request\n`);
    console.log("First payload, exactly as it would be sent:\n");
    console.log(JSON.stringify(payloadFor(VARIANTS[0]), null, 2));
    console.log("\nNothing was written. Re-run with --push, and with ALGOLIA_APP_ID and " +
      "ALGOLIA_WRITE_API_KEY set, to apply this.");
    return;
  }

  const creds = credentials();
  if (!creds) {
    console.error(
      "Missing credentials. --push needs both of these in the environment:\n\n" +
      "  ALGOLIA_APP_ID          the application id to create the agents in\n" +
      "  ALGOLIA_WRITE_API_KEY   a key allowed to create and publish agents\n\n" +
      "Export them, or copy .env.example to .env and fill it in. Neither value is\n" +
      "ever printed, and .env is gitignored.\n" +
      "Run without --push for a dry run, which needs no credentials at all.");
    process.exit(2);
  }

  const existing = await listAgents(creds);
  console.log(`${existing.size} agents already in this application\n`);

  // slug → { 5: id, 50: id, … }, which is exactly the shape config.js wants
  const ids = {};
  const put = (v, id) => { (ids[v.slug] || (ids[v.slug] = {}))[v.hits] = id; };

  for (const v of VARIANTS) {
    const payload = payloadFor(v);
    const label = `${v.slug}/${v.hits}`;
    if (existing.has(payload.name)) {
      // Converge rather than skip. This file is the desired state of these
      // agents, so a re-run after editing the instructions or the tool config
      // should MOVE the live agent to match — otherwise the only way to change a
      // prompt is to delete an agent and reissue its id into config.js.
      const id = existing.get(payload.name);
      put(v, id);
      await call(creds, "PATCH", `/1/agents/${id}`, payload);
      console.log(`${label.padEnd(14)} ${id} · updated to match this file · ` +
        `${await publish(creds, id)}`);
      continue;
    }
    const created = await call(creds, "POST", "/1/agents", payload);
    put(v, created.id);
    console.log(`${label.padEnd(14)} created ${created.id} · status ${created.status}`);
    console.log(`${" ".repeat(14)} ${await publish(creds, created.id)}`);
  }

  // Read back rather than trusting the create response: a tool array that failed
  // to persist is exactly the failure this script exists to make visible.
  console.log("\nReading each agent back:\n");
  let ok = 0;
  for (const v of VARIANTS) {
    const id = ids[v.slug][v.hits];
    const a = await call(creds, "GET", `/1/agents/${id}`);
    const tool = (a.tools || [])[0] || {};
    const live = tool.indices || [];
    const index = live[0] || {};
    const cfg = a.config || {};
    const sugg = cfg.suggestions || {};
    // The page size is the whole point of a greedy variant, so it is verified on
    // BOTH channels and on EVERY index: the internal tool reads searchParameters,
    // the MCP server reads searchControls, and one index left at the default page
    // size is a knob that works for English and lies for the other seven.
    const want = indicesFor(v.hits).map((e) => e.index);
    const bound = live.map((e) => e.index);
    const allPaged = live.length === want.length && live.every((e) =>
      (e.searchParameters || {}).hitsPerPage === v.hits &&
      ((e.searchControls || {}).hitsPerPage || {}).default === v.hits);
    const sameIndices = want.every((name, i) => bound[i] === name);
    const good = tool.mode === "static" && sameIndices && allPaged &&
      a.status === "published" && sugg.enabled === true &&
      !!index.searchControls && a.instructions === INSTRUCTIONS;
    if (good) ok++;
    console.log(`${good ? "ok  " : "BAD "} ${`${v.slug}/${v.hits}`.padEnd(14)} ${id} · ${a.status} · ` +
      `mode=${tool.mode} indices=${live.length}/${want.length} · ` +
      `hitsPerPage=${v.hits} on every index: ${allPaged} · ` +
      `suggestions=${sugg.enabled} · temp=${cfg.temperature} · ` +
      `instructionsMatch=${a.instructions === INSTRUCTIONS}`);
    if (!sameIndices) console.log(`     bound: ${bound.join(", ")}`);
  }
  console.log(`\n${ok}/${VARIANTS.length} verified.`);

  if (ONLY) {
    console.log(`\nOnly ${ONLY} was touched. Re-run without --only to converge all ` +
      `${ALL_VARIANTS.length}.`);
    return;
  }

  console.log("\nAdd these to the matching entries in public/shared/config.js, and to the\n" +
    "DEMO_CONFIG_JS repository variable for production:\n");
  for (const m of MODELS) {
    const byHits = ids[m.slug];
    console.log(`  ${m.slug}:`);
    console.log(`    bookAgentId: "${byHits[DEFAULT_HITS]}",`);
    console.log(`    greedyAgentIds: {`);
    for (const n of GREEDS) console.log(`      "${n}": "${byHits[n]}",`);
    console.log(`    },`);
  }
  console.log("\nThe book page falls back to `agentId` when `bookAgentId` is absent, so the demo\n" +
    "keeps working — without shelf search — until the config lands. A missing\n" +
    "greedyAgentIds entry disables that level in the picker rather than silently\n" +
    "sending the default page size under a greedy label.");
}

main().catch((e) => {
  // the message, never the request: a thrown fetch error must not carry a header
  console.error(e.message);
  process.exitCode = 1;
});

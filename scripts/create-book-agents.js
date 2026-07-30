#!/usr/bin/env node
/* ───────────────────────────────────────────────────────────────
   create-book-agents.js — one book-demo agent per model, with the shelf
   search tool attached.

     node scripts/create-book-agents.js            # dry run — calls nothing
     node scripts/create-book-agents.js --push     # create, publish, verify

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

/* ── The shelf, as the model is told about it ─────────────────────
   Read from books.js so the tool description cannot drift from what is actually
   indexed. Naming the titles costs perhaps 200 tokens on every request and earns
   it back the first time the model declines to search for a book we do not have.
   The War and Peace note is not decoration: the Maude translation accents its
   names, and a search for "Anna Pavlovna" without the accent finds nothing. */

function shelfLine() {
  const src = fs.readFileSync(path.join(__dirname, "..", "public", "shared", "books.js"), "utf8");
  const sandbox = { window: {} };
  // eslint-disable-next-line no-new-func
  new Function("window", src)(sandbox.window);
  const books = (sandbox.window.DEMO_BOOKS || {}).books || [];
  if (books.length < 2) throw new Error("could not read the shelf out of books.js");
  const shorten = (a) => a.replace(/\s*\(trans\..*?\)/, "").replace(/^selected by /, "");
  return {
    count: books.length,
    line: books.map((b) => `${b.title} (${shorten(b.author)})`).join(" · "),
  };
}

const SHELF = shelfLine();

const PASSAGE_COUNT = (() => {
  const p = path.join(__dirname, "..", "passages.jsonl");
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).length;
})();

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

WHEN NOT TO SEARCH. Questions about a book as a whole — its arc, its themes, its tone, how a character changes, what the book is doing — cannot be answered by five passages. Answer those from the text you hold. Searching them yields confident fragments and a worse answer than reading would have given.

ANSWER LIKE SOMEONE WHO HAS READ IT. Ground every answer in the book's own words: quote the line that settles it and say where it sits. "DRINK ME, on the bottle she finds at the bottom of the hall — chapter 1" is worth three of "the bottle is labelled DRINK ME", because the first shows you actually looked. For a question about the whole book, name two or three specific moments instead of describing a theme in the abstract. One concrete detail the reader had forgotten is worth a paragraph of summary.

Be brief but not curt. Two or three sentences with a quotation in them beat five without one. Never restate the question back, never pad, and never end by offering to help further — just answer, and let the next question come.

IF THE CONTEXT WAS COMPACTED. Earlier turns may have been folded into a summary to save room. When a detail is no longer there, say so plainly and offer to look it up. Do not fill a gap by invention. If a search comes back with nothing useful, say that too, rather than reaching for what you remember of the book.

LANGUAGE. Reply in the language the reader writes to you in, whatever language the book is in. If the book is in a different language from theirs, quote the original and then gloss it in their language.`;

/* ── The tool ─────────────────────────────────────────────────────
   Flat records, on purpose and against the index's own defaults. The index
   snippets and highlights `text`, and both arrive as NESTED `_snippetResult` /
   `_highlightResult` objects wrapped around markup. For a ~190-word passage that
   trades an exact quotable sentence for `<em>` noise and a nested shape, so both
   are turned off here. Measured on this index: the attribute profile moves cost
   per record by about 10x, far more than any encoding choice.

   `hitsPerPage: 5` is set on the tool, and a tool-level `hitsPerPage` always wins
   over whatever the model asks for. Five ~190-word passages is roughly 1,250
   tokens, which fits the 8k working budget this demo defaults to. The greedy
   1,000-hit case gets its own agent when the over-fetch demo lands; it does not
   belong on the agent a reader chats to.

   `mode: "static"` means this list is the only thing the tool can ever search:
   a per-request `algolia.indices` override is rejected with a 422 rather than
   quietly honoured. That matters here — the same key can read every index in
   this Algolia application. */

const RETRIEVE = ["book", "chapter", "chapterTitle", "position", "text"];

const TOOLS = [{
  type: "algolia_search_index",
  name: "search_the_shelf",
  mode: "static",
  indices: [{
    index: INDEX_NAME,
    description: INDEX_DESCRIPTION,
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
      hitsPerPage: 5,
    },
    // `searchControls` is the MCP server's own channel, and MCP is the platform
    // default — the completions router ORs the agent flag with an
    // `algolia_mcp_enabled` feature flag, so this is the path that runs. Each
    // parameter is {exposed, default}: `exposed: false` sets the value and keeps
    // it out of the tool schema the model sees, which is what we want for all of
    // these — the model chooses words, not page sizes.
    searchControls: {
      hitsPerPage: { exposed: false, default: 5 },
      attributesToRetrieve: { exposed: false, default: RETRIEVE },
      custom: { attributesToHighlight: [], attributesToSnippet: [] },
    },
  }],
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

const payloadFor = ({ slug, model, providerId }) => ({
  name: `context-management-demo-books-${slug}`,
  description: `Chat-with-a-book demo agent (${model}) — shelf search over ${INDEX_NAME}, ` +
    `${SHELF.count} titles`,
  model,
  providerId,
  instructions: INSTRUCTIONS,
  tools: TOOLS,
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
    console.log(`Would POST ${MODELS.length} agents, then publish each:\n`);
    for (const m of MODELS) {
      console.log(`  context-management-demo-books-${m.slug}  model=${m.model}`);
    }
    console.log(`\nShelf read from books.js: ${SHELF.count} titles` +
      (PASSAGE_COUNT ? `, ${PASSAGE_COUNT.toLocaleString("en-US")} passages in passages.jsonl` : ""));
    console.log(`Tool: search_the_shelf · mode=static · index=${INDEX_NAME} · hitsPerPage=5`);
    console.log(`Tool description: ${INDEX_DESCRIPTION.length} chars\n`);
    console.log("First payload, exactly as it would be sent:\n");
    console.log(JSON.stringify(payloadFor(MODELS[0]), null, 2));
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

  const ids = {};
  for (const m of MODELS) {
    const payload = payloadFor(m);
    if (existing.has(payload.name)) {
      // Converge rather than skip. This file is the desired state of these
      // agents, so a re-run after editing the instructions or the tool config
      // should MOVE the live agent to match — otherwise the only way to change a
      // prompt is to delete an agent and reissue its id into config.js.
      const id = existing.get(payload.name);
      ids[m.slug] = id;
      await call(creds, "PATCH", `/1/agents/${id}`, payload);
      console.log(`${m.slug.padEnd(9)} ${id} · updated to match this file · ` +
        `${await publish(creds, id)}`);
      continue;
    }
    const created = await call(creds, "POST", "/1/agents", payload);
    ids[m.slug] = created.id;
    console.log(`${m.slug.padEnd(9)} created ${created.id} · status ${created.status}`);
    console.log(`${" ".repeat(9)} ${await publish(creds, created.id)}`);
  }

  // Read back rather than trusting the create response: a tool array that failed
  // to persist is exactly the failure this script exists to make visible.
  console.log("\nReading each agent back:\n");
  let ok = 0;
  for (const m of MODELS) {
    const a = await call(creds, "GET", `/1/agents/${ids[m.slug]}`);
    const tool = (a.tools || [])[0] || {};
    const index = (tool.indices || [])[0] || {};
    const cfg = a.config || {};
    const sugg = cfg.suggestions || {};
    const good = tool.mode === "static" && index.index === INDEX_NAME &&
      a.status === "published" && sugg.enabled === true &&
      !!index.searchControls && a.instructions === INSTRUCTIONS;
    if (good) ok++;
    console.log(`${good ? "ok  " : "BAD "} ${m.slug.padEnd(9)} ${ids[m.slug]} · ${a.status} · ` +
      `mode=${tool.mode} index=${index.index} · ` +
      `hitsPerPage=${(index.searchParameters || {}).hitsPerPage} · ` +
      `searchControls=${!!index.searchControls} · suggestions=${sugg.enabled} · ` +
      `temp=${cfg.temperature} · instructionsMatch=${a.instructions === INSTRUCTIONS}`);
  }
  console.log(`\n${ok}/${MODELS.length} verified.`);

  console.log("\nAdd these to the matching entries in public/shared/config.js, and to the\n" +
    "DEMO_CONFIG_JS repository variable for production:\n");
  for (const m of MODELS) {
    console.log(`  ${m.slug.padEnd(9)} bookAgentId: "${ids[m.slug]}",`);
  }
  console.log("\nThe book page falls back to `agentId` when `bookAgentId` is absent, so the demo\n" +
    "keeps working — without shelf search — until the config lands.");
}

main().catch((e) => {
  // the message, never the request: a thrown fetch error must not carry a header
  console.error(e.message);
  process.exitCode = 1;
});

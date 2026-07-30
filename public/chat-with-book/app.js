/* ───────────────────────────────────────────────────────────────
   Infinite Conversations — Agent Studio context APIs demo

   Three endpoints, no build step:
     POST /1/unstable/context/trim        token probe + deterministic trim
     POST /1/unstable/context/compact     LLM summary of older turns
     POST /1/agents/{id}/completions      streaming chat (ai-sdk-5 SSE)

   Messages are AI SDK v5 shaped: { role, parts: [{ type:"text", text }] }.
   ─────────────────────────────────────────────────────────────── */

"use strict";

const CFG = window.DEMO_CONFIG;

/**
 * The meter — its cost model, its two modes and its rendering — lives in the
 * shared demo kit (`shared/meter.js`), so the next demo inherits the whole thing
 * instead of a copy of it. What stays in this file is only what is specific to
 * this page: which model is selected, and which of its calls belong on which
 * side of the ledger. The bookshelf manifest arrives the same way.
 */
const M = window.DemoMeter;
const BOOKS = window.DEMO_BOOKS;

const state = {
  messages: [],        // v5 messages, the live history
  weights: [],         // per-message token estimate, parallel to messages
  kinds: [],           // "user" | "assistant" | "summary" | "doc"
  tokens: 0,
  folds: 0,
  reclaimed: 0,
  model: null,
  budget: CFG && CFG.defaultBudget,
  busy: false,
  calls: 0,
  // chars per token, learned from the trim endpoint rather than assumed
  charsPerToken: null,
  // { phase: "map" | "reduce", done, total } while a hierarchical fold runs
  foldProgress: null,
  /**
   * The fold, still openable. Set by foldOversize and kept for the life of the
   * conversation: every section's ORIGINAL text stays in memory beside the
   * summary that replaced it, which is what makes the three "dig deeper" moves
   * possible at all. Nothing here is in the history — the history holds the
   * digest (and, when the window can afford it, the section summaries).
   *   { msg, sections: [{ text, summary, chars, tokensIn, tokensOut,
   *                       focus, refocused }],
   *     digest, digestStale, carriesSections, card }
   */
  fold: null,
  // set by an in-flight agent-driven unfold, so the event card can be told how
  // long the second completion took once it lands
  unfoldSettle: null,
  // the two prices for this conversation — see shared/meter.js
  cost: M.freshCost(),
  // the book taken off the shelf, if any: carries this book's suggestion chips
  book: null,
  // Questions already sent from a chip. A chip is an opening, not a button to
  // press twice: re-sending one produced the same answer again, which read as the
  // demo holding a conversation with itself.
  askedChips: new Set(),
  // Follow-ups the agent wrote, from the most recent `data-suggestions` frame.
  // Replaced wholesale each turn — they describe the conversation as it is now.
  suggestions: [],
};

/**
 * Knobs for the dig-deeper suite. Defaults live here rather than in config.js so
 * an existing config keeps working untouched; set any of these in config.js to
 * override.
 */
const TUNE = {
  // Loop guard on agent-driven unfolds. Two is enough for "which chapter, then
  // what does it say"; a third firing is answered from what is already on hand.
  unfoldMaxPerTurn: CFG.unfoldMaxPerTurn ?? 2,
  // Target size of the ephemeral focused extract the agent gets back.
  unfoldFocusWords: CFG.unfoldFocusWords ?? 800,
  // Target size of a user-requested refold. Smaller than a first-pass summary:
  // a refold is asked for when the reader wants one thing kept well.
  refocusWords: CFG.refocusWords ?? 400,
  // Hold this many characters back before painting a bubble, so a sentinel line
  // is never flashed on screen and then retracted.
  sentinelBufferChars: CFG.sentinelBufferChars ?? 80,
  // Keep every section summary in the history — not just the joint digest — while
  // they fit inside this share of the model's real window. More detail retained
  // for free; the digest alone is the fallback when they do not fit.
  keepSectionsAtRatio: CFG.keepSectionsAtRatio ?? 0.25,
};

const $ = (id) => document.getElementById(id);
const el = {
  doc: $("doc"), file: $("file"), ingest: $("ingest-btn"), ingestStatus: $("ingest-status"),
  url: $("url"), urlBtn: $("url-btn"), urlStatus: $("url-status"),
  shelf: $("shelf"), shelfStatus: $("shelf-status"), byo: $("byo"),
  chips: $("chips"), chipsNeedle: $("chips-needle"), chipsArc: $("chips-arc"),
  chipsNext: $("chips-next"),
  sample: $("sample-btn"), model: $("model"), modelHint: $("model-hint"),
  budget: $("budget"), budgetHint: $("budget-hint"),
  meter: $("meter"), fill: $("meter-fill"), threshold: $("meter-threshold"),
  read: $("meter-read"), meterState: $("meter-state"),
  axisMax: $("axis-max"), axisThreshold: $("axis-threshold"),
  compact: $("compact-btn"), reset: $("reset-btn"), ledger: $("ledger"),
  thread: $("thread"), composer: $("composer"), prompt: $("prompt"), send: $("send-btn"),
  wireList: $("wire-list"), wireCount: $("wire-count"),
  heroTokens: $("hero-tokens"), heroFolds: $("hero-folds"), heroSaved: $("hero-saved"),
  tooltip: $("tooltip"),
  themeToggle: $("theme-toggle"), themeGlyph: $("theme-glyph"), themeLabel: $("theme-label"),
  costbar: $("costbar"), costToggle: $("cost-toggle"), meterInfo: $("meter-info"),
  tileNaive: $("tile-naive"), tileReal: $("tile-real"), tileSaved: $("tile-saved"),
  naiveUsd: $("naive-usd"), realUsd: $("real-usd"), savedUsd: $("saved-usd"),
  naiveTok: $("naive-tok"), realTok: $("real-tok"), savedTok: $("saved-tok"),
  naiveBadge: $("naive-badge"), realEst: $("real-est"),
  savedLabel: $("saved-label"), savedSub: $("saved-sub"),
  savedPct: $("saved-pct"), savedFill: $("saved-fill"), savedTrack: $("saved-track"),
  opMinus: $("op-minus"), opEquals: $("op-equals"),
  unlockedValue: $("unlocked-value"), unlockedSub: $("unlocked-sub"),
  unlockedInfo: $("unlocked-info"),
};

/* number and money formatting come from the kit, so the strip at the top of the
   page and the wire log below it can never disagree about a figure */
const { usd, fmt } = M;

/* ── API ──────────────────────────────────────────────────────── */

function headers() {
  return {
    "content-type": "application/json",
    "X-Algolia-Application-Id": CFG.appId,
    "X-Algolia-API-Key": CFG.apiKey,
  };
}

/**
 * Errors carry `status` and `detail` so the caller can turn them into a human
 * sentence. The raw payload goes to the wire log and nowhere else — a chat
 * bubble is not a place to print JSON at somebody.
 */
async function api(path, body, { stream = false } = {}) {
  const url = CFG.host + path;
  const res = await fetch(url, { method: "POST", headers: headers(), body: JSON.stringify(body) });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const j = await res.json();
      detail = j.message || j.detail || detail;
      if (typeof detail === "object") detail = JSON.stringify(detail);
    } catch (_) { /* keep statusText */ }
    logCall(path, null, `${res.status} ${detail}`);
    const err = new Error(`${res.status}\u00a0— ${detail}`);
    err.status = res.status;
    err.detail = String(detail);
    throw err;
  }
  if (stream) return res;
  return res.json();
}

/* ── Compact response normalizer ───────────────────────────────────
   WORKAROUND for a backend bug currently in flight: /context/compact sometimes
   returns its summary as a Python repr of content blocks embedded in the text —

     Summary of the conversation so far:

     [{'type': 'text', 'text': 'the actual summary…'}]

   — instead of the summary itself. Left alone that repr is displayed to the
   reader, stored in the history, and re-sent on every subsequent turn, so it
   costs tokens as well as legibility. This pulls the inner text values out and
   joins them; anything that does not match the shape passes through untouched.
   Remove once PR #1496 deploys. ─────────────────────────────────────── */

/** Python string escapes, one pass, so a literal backslash survives */
function unescapePyString(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== "\\") { out += c; continue; }
    const n = s[++i];
    if (n === undefined) break;
    if (n === "n") out += "\n";
    else if (n === "r") out += "\r";
    else if (n === "t") out += "\t";
    else if (n === "u") { out += String.fromCharCode(parseInt(s.slice(i + 1, i + 5), 16) || 0); i += 4; }
    else if (n === "x") { out += String.fromCharCode(parseInt(s.slice(i + 1, i + 3), 16) || 0); i += 2; }
    else out += n;
  }
  return out;
}

/** → { text, normalized }; `normalized` is false when nothing was unwrapped */
function unwrapContentBlocks(raw) {
  const text = String(raw == null ? "" : raw);
  const open = text.indexOf("[{");
  if (open < 0) return { text, normalized: false };
  const tail = text.slice(open);
  if (!/^\[\s*\{\s*(['"])type\1\s*:/.test(tail)) return { text, normalized: false };

  // 'text': '<value>' — 'type': 'text' cannot match, it is followed by a comma
  const parts = [];
  const key = /(['"])text\1\s*:\s*(['"])/g;
  let m;
  while ((m = key.exec(tail))) {
    const quote = m[2];
    let i = key.lastIndex, buf = "";
    while (i < tail.length) {
      if (tail[i] === "\\") { buf += tail[i] + (tail[i + 1] || ""); i += 2; continue; }
      if (tail[i] === quote) break;
      buf += tail[i]; i += 1;
    }
    key.lastIndex = Math.min(i + 1, tail.length);
    const value = unescapePyString(buf).trim();
    if (value) parts.push(value);
  }
  if (!parts.length) return { text, normalized: false };

  const prefix = text.slice(0, open).replace(/\s+$/, "");
  return { text: (prefix ? `${prefix}\n\n` : "") + parts.join("\n\n"), normalized: true };
}

/** rewrite every text part of a compact response in place, before it is stored */
function normalizeCompactResponse(out) {
  let fired = false;
  for (const m of (out && out.messages) || []) {
    for (const p of m.parts || []) {
      if (p.type !== "text" || typeof p.text !== "string") continue;
      const r = unwrapContentBlocks(p.text);
      if (r.normalized) { p.text = r.text; fired = true; }
    }
  }
  if (out) out.normalized = fired;
  return fired;
}

/** trim with no constraints = a pure token-count probe */
async function probe(messages) {
  const body = { messages };
  const out = await api("/1/unstable/context/trim", body);
  // no LLM behind it, so it is free on both sides — annotated rather than assumed
  logCall("/1/unstable/context/trim", out.stats, null, "probe · no constraints", "POST", false, 0);
  return out;
}

/**
 * keepLastMessages is capped at messages.length - 1: asking to keep more
 * messages than exist leaves nothing to summarize, and the endpoint politely
 * returns the history unchanged.
 */
function effectiveKeep(messages) {
  return Math.max(1, Math.min(CFG.keepLastMessages, messages.length - 1));
}

async function compact(messages) {
  const keep = effectiveKeep(messages);
  const body = {
    providerID: state.model.providerId,
    model: state.model.model,
    messages,
    keepLastMessages: keep,
  };
  const out = await api("/1/unstable/context/compact", body);
  out.keep = keep;
  normalizeCompactResponse(out);
  // keepLastMessages > 0 means tokensAfterEstimate is summary PLUS the kept turns,
  // which would overstate what the summarizer wrote — so the output is taken from
  // the summary message itself instead
  const wrote = estTokens(textOf((out.messages || [])[0] || {}).length);
  const spent = chargeSummarizer({ stats: out.stats, outTok: wrote });
  logCall("/1/unstable/context/compact", out.stats, null,
    `keepLastMessages: ${keep} · via ${state.model.model}`, "POST", out.normalized, spent);
  return out;
}

/* ── API reference links ──────────────────────────────────────────
   The service publishes its own OpenAPI schema behind a Swagger UI at
   {host}/docs, whose anchors are #/{tag}/{operationId} — so every path this page
   calls can point at the operation that documents it, rather than at prose about
   it. Anything not in this map (a fetched page URL) simply gets no link. ── */

const DOCS = {
  "/1/unstable/context/trim": { tag: "Context", op: "trimContext" },
  "/1/unstable/context/compact": { tag: "Context", op: "compactContext" },
  "/1/agents/{agent_id}/completions": {
    tag: "Completions",
    op: "create_completion_1_agents__agent_id__completions_post",
  },
};

/** an agent id in the path is an argument, not a different endpoint */
function canonicalPath(path) {
  return String(path)
    .split("?")[0]
    .replace(/\/1\/agents\/[^/]+\/completions/, "/1/agents/{agent_id}/completions");
}

function docsUrl(path) {
  const d = DOCS[canonicalPath(path)];
  return d ? `${CFG.host}/docs#/${d.tag}/${d.op}` : null;
}

/** "docs ↗" affordance, tooltip included, for anywhere an endpoint is named */
function docsLink(path, label = "docs ↗") {
  const url = docsUrl(path);
  if (!url) return null;
  const a = document.createElement("a");
  a.className = "doc-link";
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = label;
  tip(a, `The endpoint's entry in the live OpenAPI reference\u00a0— the schema the API ` +
    `generates, not a copy of it. Request and response shapes, every field.`, url);
  return a;
}

/* ── Wire log (transparent by design) ─────────────────────────── */

function logCall(path, stats, error, note, verb = "POST", normalized = false, cost = null) {
  state.calls += 1;
  el.wireCount.textContent = `${state.calls}\u00a0call${state.calls === 1 ? "" : "s"}`;
  const li = document.createElement("li");
  const bits = [`<span class="wire-path"><span class="verb">${escapeHtml(verb)}</span> ${escapeHtml(path)}</span>`];
  if (note) bits.push(`<span class="stat">${note}</span>`);
  if (stats) {
    bits.push(`<span class="stat">msgs ${stats.messagesBefore}→${stats.messagesAfter} · tokens ${fmt(stats.tokensBeforeEstimate)}→${fmt(stats.tokensAfterEstimate)}</span>`);
  }
  if (error) bits.push(`<span class="err">${escapeHtml(error)}</span>`);
  li.innerHTML = bits.join("<br>");
  const link = docsLink(path);
  if (link) li.querySelector(".wire-path").after(link);
  if (normalized) {
    const chip = document.createElement("span");
    chip.className = "wire-fix";
    chip.textContent = "normalized ✂";
    tip(chip, "The summary arrived wrapped in a Python repr of content blocks\u00a0— a backend " +
      "bug, fix in flight. The page unwrapped it before storing it, so the repr never rides " +
      "a later request. The stats are the API's own.");
    li.appendChild(chip);
  }
  // what this one call added to the strip at the top, on the same rates
  if (cost !== null && Number.isFinite(cost)) {
    const chip = document.createElement("span");
    chip.className = `wire-cost${cost === 0 ? " is-free" : ""}`;
    chip.textContent = cost === 0 ? "$0 · no LLM" : `~${usd(cost)}`;
    tip(chip, cost === 0
      ? "context/trim counts without calling a model, so it is free on both sides of the " +
        "meter\u00a0— and it is why the meter can be honest without shipping a tokenizer."
      : () => `Charged to the real side at ${priceLine()} Estimated\u00a0— the API does not ` +
        `expose summarizer usage yet, so the call's before/after token counts stand in.`);
    li.appendChild(chip);
  }
  el.wireList.appendChild(li);
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = String(s);
  return d.innerHTML;
}

/* ── The meter: what this cost, and what the fold bought ───────────
   The cost model, the two modes and the strip's rendering are all in
   shared/meter.js — read the comment at the top of that file for how naive and
   real are defined and why the subtraction stops once the naive run no longer
   fits the model's window.

   What lives here is the part that cannot be shared: which model is selected,
   and which of this page's calls belong on which side of the ledger.

   Token counts come from the trim probe and the compact stats wherever the API
   reports them; the increments it never saw (a fresh question, a loaned extract,
   an answer) are converted at the chars-per-token ratio the probe measured on
   this very conversation, not at the chars/4 folklore.
   ─────────────────────────────────────────────────────────────── */

function currentPrice() {
  return M.priceOf(state.model && state.model.model);
}

/** every call site in this file means "the model selected right now" */
function priceLine() {
  return M.priceLine(currentPrice());
}

function charge(side, inTok, outTok, price) {
  return M.charge(state.cost, side, inTok, outTok, price || currentPrice());
}

/** one real /completions call — an unfolding turn makes two, and both are billed */
function chargeChat(inTok, outTok) {
  state.cost.chatCalls += 1;
  const value = charge("real", inTok, outTok);
  renderCost();
  return value;
}

/**
 * The counterfactual for one turn: one call, carrying the whole unfolded history,
 * answering at the size the real answer answered at. Charged once per turn no
 * matter how many calls the real side needed — that is the comparison.
 */
function chargeNaiveTurn(inTok, outTok) {
  const c = state.cost;
  c.turns += 1;
  c.naivePeak = Math.max(c.naivePeak, inTok);
  const value = charge("naive", inTok, outTok);
  renderCost();
  return value;
}

/**
 * The extra model step a tool call costs.
 *
 * One /completions request that searches is billed as two passes over the
 * conversation: the first ends in a tool call, the second answers with the hits
 * appended. `chargeChat` already accounts for the answering pass, so this adds the
 * deciding one — and deliberately does NOT touch `chatCalls`, which counts HTTP
 * calls and would be a lie at two.
 *
 * This is why the agent is told not to search for something already in front of
 * it: the cheapest search is the one that does not happen, and the expensive part
 * is not the passages, it is sending the whole conversation a second time.
 */
function chargeToolStep(inTok, outTok) {
  const value = charge("real", inTok, outTok);
  renderCost();
  return value;
}

/**
 * Every /context/compact call, whoever asked for it. The endpoint reports the
 * payload it counted but NOT the summarizer's own usage, so input is taken as
 * stats.tokensBeforeEstimate and output as stats.tokensAfterEstimate — for the
 * keepLastMessages: 0 calls the fold uses, "after" is exactly the summary that
 * came back. It is still an estimate, and the strip says so.
 */
function chargeSummarizer({ stats, inTok, outTok }) {
  // an explicit figure wins: the ordinary compact keeps messages verbatim, so its
  // tokensAfterEstimate is not what the summarizer wrote
  const i = Number.isFinite(inTok) ? inTok : tokensIn(stats, 0);
  const o = Number.isFinite(outTok) ? outTok : tokensOut(stats, 0);
  const c = state.cost;
  const value = charge("real", i, o);
  c.summUsd += value; c.summTokens += i + o; c.summCalls += 1;
  renderCost();
  return value;
}

/**
 * Tokens this turn's real payload carries. The probe's own count of the stored
 * history is the anchor; only what the probe has not seen yet — the new question,
 * the sentinel notes, anything loaned for this turn — is estimated on top of it.
 * Call it after the user message has been pushed.
 */
function realInputTokens(newChars, extras) {
  const notes = state.fold && state.fold.sections.length > 1
    ? textOf(sentinelPreamble(state.fold)).length : 0;
  const loaned = (extras || []).reduce((n, m) => n + textOf(m).length, 0);
  return Math.round(state.tokens + estTokens(newChars + notes + loaned));
}

/* ── Rendering the strip ──────────────────────────────────────────
   The odometer, the tile states and every word of the tooltips are in
   shared/meter.js. This page's job is to say what the model context is —
   window, label, price — and to hand the kit a view. ─────────────── */

const strip = M.createStrip(el);

/**
 * The model's REAL window, never the demo's working budget: the mode switch is a
 * statement about what the provider would accept, and the budget is a device
 * this page invented to make the fold visible.
 */
function meterView() {
  return M.meterView(state.cost, {
    modelWindow: state.model ? modelWindow() : Infinity,
    modelLabel: state.model ? state.model.label : "this model",
    price: currentPrice(),
  });
}

function renderCost() {
  strip.render(meterView());
}

function resetCost() {
  state.cost = M.freshCost();
  strip.reset();
  renderCost();
}

/** phone: the saving is the headline, its two operands are one tap away */
function initCostbar() {
  el.costToggle.addEventListener("click", () => {
    const open = el.costbar.dataset.open !== "1";
    el.costbar.dataset.open = open ? "1" : "0";
    el.costToggle.setAttribute("aria-expanded", String(open));
    el.costToggle.textContent = open ? "Hide" : "Breakdown";
  });

  // bound once, read live: every one of these asks the kit for the wording that
  // matches the mode the meter is in at the moment it is opened
  tip(el.meterInfo, () => M.tileCopy.eyebrow, null, { heading: "Two prices" });
  // the badge shrinks to a bare ✗ on a phone, so it carries its own explanation
  tip(el.naiveBadge, () => M.tileCopy.badge(meterView()), null, { heading: "Refused, not billed" });
  tip(el.tileNaive, () => M.tileCopy.naive(meterView()), M.tileCopy.naiveFormula,
    { heading: "The naive run" });
  tip(el.tileReal, () => M.tileCopy.real(meterView()), M.tileCopy.realFormula,
    { heading: "Actually spent" });
  tip(el.tileSaved, () => M.tileCopy.saved(meterView()),
    () => M.tileCopy.savedFormula(meterView()), { heading: "The difference" });
  tip(el.unlockedInfo, () => M.tileCopy.unlocked(meterView()), null, { heading: "Unlocked" });

  renderCost();
}

/* ── Message helpers ──────────────────────────────────────────── */

const userMsg = (text) => ({ role: "user", parts: [{ type: "text", text }] });
const textOf = (m) => (m.parts || []).filter((p) => p.type === "text").map((p) => p.text).join("");

/** cheap local split of a total token count across messages, by character share */
function distribute(total, messages) {
  const lens = messages.map((m) => Math.max(textOf(m).length, 1));
  const sum = lens.reduce((a, b) => a + b, 0);
  return lens.map((l) => (total * l) / sum);
}

/* ── URL ingest ───────────────────────────────────────────────────
   Fetch in the browser, strip to text in the browser. Nothing about the page
   is sent anywhere until you press Ingest. ─────────────────────── */

/** elements that carry no prose: dropped whole, children and all */
const HTML_NOISE = "script,style,noscript,template,iframe,svg,canvas,form,button," +
  "select,nav,aside,header,footer";

/** elements whose end is a line break in the text version */
const HTML_BLOCKS = "p,div,br,hr,li,tr,section,article,blockquote,pre," +
  "h1,h2,h3,h4,h5,h6,dt,dd,figcaption,td,th";

function collapse(text) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\u00a0\u2000-\u200a\u202f\u205f\u3000]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll(HTML_NOISE).forEach((n) => n.remove());
  // a newline per block, or "…mers</p><p>Chapitre" welds into "mersChapitre"
  doc.querySelectorAll(HTML_BLOCKS).forEach((n) => {
    try { n.after(doc.createTextNode("\n")); } catch (_) { /* detached node */ }
  });
  const root = doc.body || doc.documentElement;
  const title = collapse(doc.title || "");
  const body = collapse(root ? root.textContent || "" : "");
  return title && !body.startsWith(title) ? `${title}\n\n${body}` : body;
}

/**
 * The reader proxy answers in its own envelope — a couple of provenance lines,
 * then the page as markdown. Keep the title, drop the machinery, and unwrap the
 * link syntax: on the reference book, image refs and link URLs are 4.5% of the
 * payload and none of the meaning, and they turn the on-screen preview into soup.
 */
function readerToText(text) {
  return text
    .replace(/^URL Source:.*$/im, "")
    .replace(/^Published Time:.*$/im, "")
    .replace(/^Warning:.*$/im, "")
    .replace(/^Markdown Content:\s*$/im, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")            // image refs: no text at all
    .replace(/(?<!!)\[([^\]]*)\]\([^)]*\)/g, "$1")   // links: keep the label
    .replace(/^\n+/, "");
}

/**
 * Direct first — a host that sends Access-Control-Allow-Origin needs no help,
 * and no third party sees the URL. Most hosts send nothing, the browser refuses
 * to hand over the response, and the fetch rejects; only then does the request
 * go through the reader named in config, and the substitution is reported.
 */
async function fetchUrlText(url) {
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`the site answered ${res.status} ${res.statusText}`);
    const type = res.headers.get("content-type") || "";
    const body = await res.text();
    logCall(url, null, null, `direct · ${fmt(body.length)}\u00a0chars · ${type.split(";")[0] || "unknown type"}`, "GET");
    return {
      text: /html|xml/i.test(type) || /^\s*<(!doctype|html)/i.test(body) ? htmlToText(body) : collapse(body),
      via: "direct browser fetch",
      direct: true,
      chars: body.length,
    };
  } catch (first) {
    const reader = CFG.readerProxy;
    if (!reader || !reader.url) throw first;
    logCall(url, null, null,
      `direct fetch refused (${first.message}) · retrying via ${reader.label}`, "GET");
    let res;
    try {
      res = await fetch(reader.url + url);
    } catch (second) {
      const err = new Error(`neither the site nor ${reader.label} could be reached`);
      err.detail = `direct: ${first.message} · via ${reader.label}: ${second.message}`;
      throw err;
    }
    if (!res.ok) {
      const err = new Error(`${reader.label} answered ${res.status}`);
      err.detail = `direct: ${first.message} · via ${reader.label}: ${res.status} ${res.statusText}`;
      throw err;
    }
    const body = await res.text();
    logCall(reader.url + "…", null, null, `via ${reader.label} · ${fmt(body.length)}\u00a0chars`, "GET");
    return {
      text: collapse(readerToText(body)),
      via: reader.label,
      direct: false,
      chars: body.length,
    };
  }
}

/* ── Render ───────────────────────────────────────────────────── */

function currentWindow() {
  return state.budget || state.model.contextWindow;
}

/**
 * Ordinary compaction needs something to summarize and something to keep, so it
 * wants three messages. An oversized single document is the exception: there the
 * fold is the only way forward, so the button stays live.
 */
function canCompact() {
  return state.messages.length >= 3 ||
    (state.messages.length > 0 && state.tokens > oversizeLimit());
}

function renderMeter() {
  const max = currentWindow();
  const ratio = Math.min(state.tokens / max, 1);
  const thresholdRatio = CFG.compactAtRatio;

  el.fill.style.width = `${ratio * 100}%`;
  el.fill.classList.toggle("is-warn", state.tokens >= max * thresholdRatio && state.tokens < max);
  el.fill.classList.toggle("is-over", state.tokens >= max);
  el.threshold.style.left = `${thresholdRatio * 100}%`;

  const over = state.tokens > max;
  el.fill.classList.toggle("is-clamped", over);
  el.read.textContent = over
    ? `${fmt(state.tokens)}\u00a0tokens · ${Math.round((state.tokens / max) * 100)}% of ${fmt(max)}`
    : `${fmt(state.tokens)} / ${fmt(max)}\u00a0tokens`;
  el.axisMax.textContent = over ? `${fmt(max)} ▸` : fmt(max);
  el.axisThreshold.textContent = `${Math.round(thresholdRatio * 100)}% · ${fmt(max * thresholdRatio)}`;
  el.meter.setAttribute("aria-valuenow", Math.round(Math.min(state.tokens, max)));
  el.meter.setAttribute("aria-valuemax", Math.round(max));
  el.meter.setAttribute("aria-valuetext",
    `${fmt(state.tokens)}\u00a0tokens of a ${fmt(max)}\u00a0token budget${over ? ", over budget" : ""}`);

  renderMeterState();

  el.heroTokens.textContent = fmt(state.tokens);
  el.heroFolds.textContent = fmt(state.folds);
  el.heroSaved.textContent = fmt(state.reclaimed);
  el.compact.disabled = state.busy || !canCompact();
  // the strip's badge and its prices both depend on the selected model, and the
  // model can change under a conversation that has already been charged
  renderCost();
}

/**
 * The state line answers "what now?", so it has to know whether the remedy is
 * already running. Standing at "over budget — fold to continue" while the fold
 * is folding reads as an ignored warning; the fold's own progress belongs here.
 */
function renderMeterState() {
  const max = currentWindow();
  const over = state.tokens > max;
  const p = state.foldProgress;

  let dot = "state-ok", label = "Room to spare";
  if (p) {
    dot = "state-working";
    label = p.phase === "reduce"
      ? `${over ? "Over budget" : "Folding"}\u00a0— joining ${p.total} summaries into one digest…`
      : `${over ? "Over budget" : "Folding"}\u00a0— folding now (section ${Math.min(p.done + 1, p.total)}/${p.total})…`;
  } else if (over) {
    dot = "state-over";
    label = `Over budget by ${fmt(state.tokens - max)}\u00a0tokens\u00a0— fold to continue`;
  } else if (state.tokens >= max) { dot = "state-over"; label = "At the budget\u00a0— fold to continue"; }
  else if (state.tokens >= max * CFG.compactAtRatio) { dot = "state-warn"; label = "Approaching the fold"; }
  el.meterState.innerHTML = `<span class="dot ${dot}" aria-hidden="true"></span> ${escapeHtml(label)}`;
}

/** null when no fold is running; { phase, done, total } while one is */
function setFoldProgress(p) {
  const was = state.foldProgress;
  state.foldProgress = p;
  const key = (x) => (x ? `${x.phase}:${x.done}:${x.total}` : "");
  if (key(was) !== key(p)) renderMeterState();
}

function renderLedger() {
  el.ledger.innerHTML = "";
  const max = Math.max(...state.weights, 1);
  state.messages.forEach((m, i) => {
    const w = state.weights[i] || 0;
    const kind = state.kinds[i] || m.role;
    const band = document.createElement("div");
    band.className = `band ${kind}`;
    // 18px floor: below that the band label collides with its neighbour
    band.style.height = `${18 + Math.round((w / max) * 44)}px`;
    const head = textOf(m).replace(/\s+/g, " ").slice(0, 70);
    band.textContent = `${fmt(w)}\u00a0tok · ${head}`;
    tip(band, `${kind === "summary" ? "Folded summary" : kind === "doc" ? "Ingested document" : m.role} · ~${fmt(w)}\u00a0tokens (estimated share of the trim probe's total)`);
    el.ledger.appendChild(band);
  });
}

function addBubble(role, text, { doc = false } = {}) {
  el.thread.querySelector(".empty")?.remove();
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = role;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;
  wrap.append(who, bubble);
  el.thread.appendChild(wrap);
  el.thread.scrollTop = el.thread.scrollHeight;
  return bubble;
}

/**
 * Ingested documents can be book-length, so the thread never holds the whole
 * string: it shows a fixed-length excerpt, says exactly how much of the source
 * that is, and offers a scrollable full view on demand.
 */
const PREVIEW_CHARS = 520;

function addDocBubble(text, tokens) {
  el.thread.querySelector(".empty")?.remove();
  const total = text.length;
  const excerpt = text.slice(0, PREVIEW_CHARS);
  const truncated = total > PREVIEW_CHARS;

  const wrap = document.createElement("div");
  wrap.className = "msg user doc";
  // built without stray whitespace: .bubble is pre-wrap, so template
  // indentation would render as blank space inside the card
  wrap.innerHTML = '<span class="who">you · ingested document</span>' +
    '<div class="bubble"><div class="doc-text" data-mode="excerpt"></div>' +
    '<div class="doc-meta"><span class="doc-count"></span>' +
    '<button class="doc-toggle" type="button"></button></div></div>';

  const body = wrap.querySelector(".doc-text");
  const count = wrap.querySelector(".doc-count");
  const toggle = wrap.querySelector(".doc-toggle");

  const paint = (mode) => {
    const showing = mode === "full" ? total : Math.min(PREVIEW_CHARS, total);
    body.dataset.mode = mode;
    body.textContent = mode === "full" ? text : excerpt + (truncated ? " …" : "");
    count.textContent =
      `Showing ${fmt(showing)} of ${fmt(total)}\u00a0characters` +
      (tokens ? ` · ~${fmt(tokens)}\u00a0tokens sent to the model` : "");
    toggle.textContent = mode === "full" ? "Show excerpt" : `Show all ${fmt(total)}\u00a0characters`;
    toggle.setAttribute("aria-expanded", String(mode === "full"));
  };

  paint("excerpt");
  if (!truncated) toggle.hidden = true;
  toggle.addEventListener("click", () => {
    paint(body.dataset.mode === "full" ? "excerpt" : "full");
    el.thread.scrollTop = el.thread.scrollHeight;
  });
  tip(count, "The whole document goes to the API; only the on-screen excerpt is trimmed, to keep the page responsive with book-length input.");

  el.thread.appendChild(wrap);
  el.thread.scrollTop = el.thread.scrollHeight;
  return { setTokens(t) { tokens = t; paint(body.dataset.mode); } };
}

function addEventCard(stats, foldNo, keep) {
  el.thread.querySelector(".empty")?.remove();
  const before = stats.tokensBeforeEstimate, after = stats.tokensAfterEstimate;
  const freed = Math.max(before - after, 0);
  const pct = before ? Math.round((freed / before) * 100) : 0;
  const card = document.createElement("div");
  card.className = "msg event";
  card.innerHTML = `
    <h3 class="event-h">Fold ${foldNo}\u00a0— history compacted, conversation intact</h3>
    <div class="event-figures">
      <div><span class="k">tokens</span><span>${fmt(before)} → ${fmt(after)}</span></div>
      <div><span class="k">freed</span><span>${fmt(freed)} (${pct}%)</span></div>
      <div><span class="k">messages</span><span>${stats.messagesBefore} → ${stats.messagesAfter}</span></div>
      <div><span class="k">kept verbatim</span><span>last ${keep}</span></div>
    </div>
    <div class="ba">
      <div class="ba-row"><span>before</span><span class="ba-bar"><span style="width:100%"></span></span><span class="ba-val">${fmt(before)}</span></div>
      <div class="ba-row after"><span>after</span><span class="ba-bar"><span style="width:${before ? (after / before) * 100 : 0}%"></span></span><span class="ba-val">${fmt(after)}</span></div>
    </div>
    <p class="event-note">Everything older than the last ${keep}\u00a0message${keep === 1 ? "" : "s"} is now one summary,
    written by <code>${escapeHtml(state.model.model)}</code> on your credentials. Ask for a detail it
    dropped\u00a0— the assistant will say so.</p>`;
  // anchor the tooltip to the heading, not the whole card: a card-wide
  // trigger pops the panel over its own figures
  tip(card.querySelector(".event-h"), `POST /1/unstable/context/compact\u00a0— bars share one 0→${fmt(before)}\u00a0token scale`,
    `{ providerID, model: "${state.model.model}", keepLastMessages: ${keep}, messages }`);
  el.thread.appendChild(card);
  el.thread.scrollTop = el.thread.scrollHeight;
}

/**
 * First ~100 chars of a generated summary, for the row's inline peek. The
 * summaries are Markdown, and one line of hashes and asterisks reads as noise —
 * the syntax comes off here and the popover renders it properly.
 */
function peekOf(text, n = 100) {
  const flat = String(text || "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*|__|~~|`/g, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > n ? `${flat.slice(0, n).trimEnd()}…` : flat;
}

/**
 * Live card for a hierarchical fold. Built empty, then filled pass by pass and
 * section by section as the calls land — the sequence is the point, so it is
 * shown happening rather than reported afterwards. Sections run concurrently, so
 * rows change state independently and the live line counts them rather than
 * naming one.
 */
function addFoldCard({ before, sectionTokens }) {
  el.thread.querySelector(".empty")?.remove();
  const card = document.createElement("div");
  card.className = "msg event fold";
  card.innerHTML =
    '<h3 class="event-h">Folding an oversized document</h3>' +
    '<p class="event-note fold-why"></p>' +
    '<div class="fold-levels"></div>' +
    '<p class="fold-live" role="status" aria-live="polite"></p>';

  const why = card.querySelector(".fold-why");
  const levels = card.querySelector(".fold-levels");
  const live = card.querySelector(".fold-live");
  why.innerHTML =
    `<strong>${fmt(before)} tokens</strong> — past ${escapeHtml(state.model.label)}'s ` +
    `${fmt(modelWindow())}-token window. Nothing that size can be sent, and one ` +
    `<code>context/compact</code> call would fail the same way. So: sections of ` +
    `~${fmt(sectionTokens)} tokens, ${foldLanesLabel()}.`;
  tip(card.querySelector(".event-h"), () =>
    `Each section gets its own compact call, ${foldLanesLabel()} — **the map**. ` +
    `One final call joins the summaries into a single digest — **the reduce**.`,
    `{ providerID, model: "${state.model.model}", keepLastMessages: 0, messages: [section] }`,
    { heading: "Map, then reduce" });

  el.thread.appendChild(card);
  el.thread.scrollTop = el.thread.scrollHeight;

  let rows = [];
  // the first pass's rows outlive the pass: they are the ones with real source
  // text behind them, so they are the ones that can be reopened
  let firstPassRows = null;
  let running = 0, finished = 0, total = 0;
  let phase = "map";
  let reduceRow = null;
  let staleHint = null;
  let t0 = performance.now();
  let ticker = null;

  const elapsed = () => (performance.now() - t0) / 1000;

  function paintLive() {
    if (phase === "idle") { live.textContent = ""; return; }
    const secs = `${elapsed().toFixed(1)}s elapsed`;
    if (phase === "reduce") {
      live.textContent = `joining ${total} summaries into one digest… · ${secs}`;
    } else {
      live.textContent =
        `folding ${total} section${total === 1 ? "" : "s"} · ` +
        `${running} in flight · ${finished} of ${total} done · ${secs}`;
    }
    setFoldProgress(phase === "reduce"
      ? { phase: "reduce", total }
      : { phase: "map", done: finished, total });
  }

  function startTicker() {
    if (ticker) return;
    ticker = setInterval(paintLive, 200);
  }
  function stopTicker() {
    clearInterval(ticker);
    ticker = null;
  }

  /** attach the "read the summary" affordance to a finished row */
  function attachSummary(li, text, heading) {
    if (!text) return;
    const peek = li.querySelector(".sum-peek") || document.createElement("button");
    peek.type = "button";
    peek.className = "sum-peek";
    peek.textContent = peekOf(text);
    peek.setAttribute("aria-label", `${heading} — read the full text`);
    // rebound rather than re-added, so a refolded row peeks at its new summary
    if (peek.dataset.bound !== "1") {
      tip(peek, () => peek.dataset.text || "", null, { rich: true, markdown: true, heading });
      peek.dataset.bound = "1";
      li.appendChild(peek);
    }
    peek.dataset.text = text;
  }

  /* ── Dig deeper ──────────────────────────────────────────────────
     Every finished section row grows two affordances once the fold is done, and
     both are the same shape: a small button that reveals one inline field.
     "Dive in" loans the section's original text to the model for one answer;
     "refold with focus" spends one summarizer call to keep something the first
     pass dropped. The digest row gets dive-in too, plus the rebuild. ─── */

  /**
   * A small inline form under a row: one field, one button, escape closes it. The
   * rebuild has nothing to type, so `noInput` drops the field and leaves the
   * confirmation — a button that needs a value it cannot be given is a dead end.
   */
  function inlineForm(li, { placeholder, submitLabel, onSubmit, hint, noInput }) {
    const form = document.createElement("form");
    form.className = `dig-form${noInput ? " is-bare" : ""}`;
    form.innerHTML =
      (noInput ? "" : '<input type="text" autocomplete="off">') +
      `<button class="btn dig-go" type="submit">${escapeHtml(submitLabel)}</button>`;
    const input = form.querySelector("input");
    if (input) input.placeholder = placeholder;
    if (hint) {
      const p = document.createElement("p");
      p.className = "dig-hint";
      p.textContent = hint;
      form.appendChild(p);
    }
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const v = input ? input.value.trim() : "";
      if ((!v && !noInput) || state.busy) return;
      if (input) input.value = "";
      form.remove();
      onSubmit(v);
    });
    (input || form).addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); form.remove(); }
    });
    // appended before focused: focus() on a detached node does nothing
    li.appendChild(form);
    (input || form.querySelector(".dig-go")).focus();
    el.thread.scrollTop = el.thread.scrollHeight;
    return form;
  }

  function digButton(li, label, title, build) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "dig-btn";
    b.textContent = label;
    tip(b, title);
    b.addEventListener("click", () => {
      const open = li.querySelector(".dig-form");
      if (open) {
        const mine = open.dataset.kind === label;
        open.remove();
        if (mine) return;
      }
      build(li).dataset.kind = label;
    });
    let tools = li.querySelector(".dig-tools");
    if (!tools) {
      tools = document.createElement("div");
      tools.className = "dig-tools";
      li.appendChild(tools);
    }
    tools.appendChild(b);
    return b;
  }

  return {
    /** open a pass and lay out one pending row per section */
    pass(n, count) {
      const group = document.createElement("div");
      group.className = "fold-level";
      group.innerHTML = `<span class="fold-level-h">Pass ${n} · map · ${count} section${count === 1 ? "" : "s"}, ` +
        `${foldLanes(count) >= count ? "all at once" : `${foldLanes(count)} at a time`}</span>` +
        '<ol class="fold-steps"></ol>';
      const list = group.querySelector(".fold-steps");
      rows = [];
      for (let i = 0; i < count; i++) {
        const li = document.createElement("li");
        li.dataset.state = "pending";
        li.innerHTML = '<span class="mark" aria-hidden="true"></span>' +
          `<span class="lbl">section ${i + 1} of ${count}</span>` +
          '<span class="val">queued</span>';
        list.appendChild(li);
        rows.push(li);
      }
      levels.appendChild(group);
      if (n === 1) firstPassRows = rows.slice();
      running = 0; finished = 0; total = count; phase = "map";
      t0 = performance.now();
      startTicker();
      paintLive();
      el.thread.scrollTop = el.thread.scrollHeight;
    },
    begin(i, inTokens) {
      const li = rows[i];
      if (!li) return;
      li.dataset.state = "working";
      li.querySelector(".val").textContent = `folding ~${fmt(inTokens)} tok…`;
      running += 1;
      paintLive();
      el.thread.scrollTop = el.thread.scrollHeight;
    },
    done(i, inTokens, outTokens, ms, summary) {
      const li = rows[i];
      if (!li) return;
      li.dataset.state = "done";
      li.querySelector(".val").textContent =
        `${fmt(inTokens)} → ${fmt(outTokens)} tok · ${(ms / 1000).toFixed(1)}s`;
      attachSummary(li, summary, `Section ${i + 1} summary · ${fmt(outTokens)} tokens`);
      running = Math.max(0, running - 1);
      finished += 1;
      paintLive();
    },
    failed(i, message) {
      const li = rows[i];
      if (!li) return;
      li.dataset.state = "failed";
      li.querySelector(".val").textContent = message;
      running = Math.max(0, running - 1);
      finished += 1;
      paintLive();
    },
    /** the reduce is its own row: one call, N summaries in, one digest out */
    reduce(count, inTokens) {
      const group = document.createElement("div");
      group.className = "fold-level";
      group.innerHTML = '<span class="fold-level-h">Reduce · one joint pass</span>' +
        '<ol class="fold-steps"></ol>';
      reduceRow = document.createElement("li");
      reduceRow.dataset.state = "working";
      reduceRow.className = "is-reduce";
      reduceRow.innerHTML = '<span class="mark" aria-hidden="true"></span>' +
        `<span class="lbl">joining ${count} summaries → digest</span>` +
        `<span class="val">~${fmt(inTokens)} tok in…</span>`;
      group.querySelector(".fold-steps").appendChild(reduceRow);
      levels.appendChild(group);
      phase = "reduce";
      paintLive();
      el.thread.scrollTop = el.thread.scrollHeight;
    },
    reduceDone(count, inTokens, outTokens, ms, digest) {
      if (!reduceRow) return;
      reduceRow.dataset.state = "done";
      reduceRow.querySelector(".lbl").textContent = `joined ${count} summaries → digest`;
      reduceRow.querySelector(".val").textContent =
        `${fmt(inTokens)} → ${fmt(outTokens)} tok · ${(ms / 1000).toFixed(1)}s`;
      attachSummary(reduceRow, digest, `Joint digest · ${fmt(outTokens)} tokens`);
    },
    reduceFailed(message) {
      if (!reduceRow) return;
      reduceRow.dataset.state = "failed";
      reduceRow.querySelector(".val").textContent = message;
    },
    /** replace the live line with the arithmetic of the whole fold */
    finish({ after, sections, passes, ms, serialMs, calls, carriesSections }) {
      phase = "idle";
      stopTicker();
      setFoldProgress(null);
      live.textContent = "";
      const freed = Math.max(before - after, 0);
      const pct = before ? Math.round((freed / before) * 100) : 0;
      const speedup = ms > 0 ? serialMs / ms : 0;
      const speedLabel = speedup >= 10 ? `${Math.round(speedup)}×` : `${speedup.toFixed(1)}×`;
      const figures = document.createElement("div");
      figures.className = "event-figures";
      figures.style.marginTop = "12px";
      figures.innerHTML =
        `<div><span class="k">tokens</span><span>${fmt(before)} → ${fmt(after)}</span></div>` +
        `<div><span class="k">freed</span><span>${fmt(freed)} (${pct}%)</span></div>` +
        `<div><span class="k">sections folded</span><span>${sections} in ${passes} pass${passes === 1 ? "" : "es"}</span></div>` +
        `<div><span class="k">wall time</span><span>${(ms / 1000).toFixed(1)}s</span></div>` +
        `<div><span class="k">summarizer time</span><span>${(serialMs / 1000).toFixed(1)}s in ${calls} call${calls === 1 ? "" : "s"}</span></div>` +
        `<div><span class="k">parallel speedup</span><span>${speedLabel}</span></div>`;
      const ba = document.createElement("div");
      ba.className = "ba";
      ba.innerHTML =
        `<div class="ba-row"><span>before</span><span class="ba-bar"><span style="width:100%"></span></span><span class="ba-val">${fmt(before)}</span></div>` +
        `<div class="ba-row after"><span>after</span><span class="ba-bar"><span style="width:${before ? Math.max((after / before) * 100, 0.4) : 0}%"></span></span><span class="ba-val">${fmt(after)}</span></div>`;
      const timing = document.createElement("p");
      timing.className = "fold-timing";
      timing.textContent =
        `${(ms / 1000).toFixed(1)}s wall, ${(serialMs / 1000).toFixed(1)}s of summarizer work ` +
        `across ${calls} call${calls === 1 ? "" : "s"} — ${speedLabel} parallel speedup.`;
      tip(timing, () =>
        `**Wall time**: the whole fold, on one clock. **Summarizer time**: every call added ` +
        `up — the cost of folding one section at a time. The gap between them is the ` +
        `parallelism (${foldLanesLabel()}).`,
        "speedup = summarizer time ÷ wall time", { heading: "Two clocks" });

      const note = document.createElement("p");
      note.className = "event-note";
      note.innerHTML =
        (carriesSections
          ? `<strong>Every section summary travels with the digest</strong> — the window has ` +
            `room, so the detail was free to keep. `
          : `Only the digest travels — the section summaries together would not fit this ` +
            `window. `) +
        `The sections themselves are still here: hover a row to read its summary, ` +
        `<strong>dive in</strong> to question its full original text, or ` +
        `<strong>refold</strong> it around what you care about.`;
      card.append(figures, timing, ba, note);
      card.querySelector(".event-h").textContent =
        `Fold ${state.folds} — oversized document folded in ${passes} pass${passes === 1 ? "" : "es"}`;
      el.thread.scrollTop = el.thread.scrollHeight;
    },
    abandon(message) {
      phase = "idle";
      stopTicker();
      setFoldProgress(null);
      live.textContent = "";
      const p = document.createElement("p");
      p.className = "event-note";
      p.textContent = message;
      card.appendChild(p);
    },

    /**
     * Turn the finished rows into openable ones. Only the first pass gets the
     * dive-in and refold controls: those rows have original text behind them. A
     * second pass folded summaries, and reopening a summary would just hand back
     * the same summary.
     */
    openDeepDive(fold) {
      const rowsFor = firstPassRows || [];
      fold.sections.forEach((section, i) => {
        const li = rowsFor[i];
        if (!li || li.dataset.state !== "done") return;
        li.dataset.dig = "1";

        digButton(li, "dive in ↓",
          `Ask about part ${i + 1} in full — all ${fmt(section.chars)} characters of original ` +
          `text, not its summary. Loaned to the model for one answer, then folded away again; ` +
          `it never joins the history.`,
          (row) => inlineForm(row, {
            placeholder: `ask about part ${i + 1}…`,
            submitLabel: "Ask",
            hint: `~${fmt(estTokens(section.chars))} tokens of original text go to the model for ` +
              `this answer, and then leave again.`,
            onSubmit: (q) => askSection(fold, i, q),
          }));

        digButton(li, "refold with focus ✎",
          `Summarize part ${i + 1} again with an instruction — “keep every quote”, say. One ` +
          `compact call, and the new summary replaces this one for good. Diving in borrows; ` +
          `refolding rewrites.`,
          (row) => inlineForm(row, {
            placeholder: "keep every quote and character name…",
            submitLabel: "Refold",
            hint: "One summarizer call. The digest is not rebuilt automatically — it will be " +
              "marked stale instead.",
            onSubmit: (focus) => refocusSection(fold, i, focus),
          }));
      });

      if (reduceRow && fold.digest) {
        reduceRow.dataset.dig = "1";
        digButton(reduceRow, "dive in ↓",
          "Ask about the whole document, answered from every part summary at once — the " +
          "digest's raw material. Loaned for one answer, like a part is.",
          (row) => inlineForm(row, {
            placeholder: "ask about the document as a whole…",
            submitLabel: "Ask",
            hint: "All part summaries go to the model for this answer, and then leave again.",
            onSubmit: (q) => askSection(fold, -1, q),
          }));
        digButton(reduceRow, "rebuild digest ↻",
          "Run the reduce again over the current summaries, refolds included. Not automatic — " +
          "a rebuild is one more paid call, and spending it is your decision.",
          (row) => inlineForm(row, {
            noInput: true,
            submitLabel: "Rebuild the digest",
            hint: "One /context/compact call over the current part summaries.",
            onSubmit: () => rebuildDigest(fold),
          }));
      }
    },

    /** stamp a row whose summary was replaced, and re-point its peek */
    markRefocused(i, focus, summary, inTokens, outTokens, ms) {
      const li = (firstPassRows || [])[i];
      if (!li) return;
      li.dataset.state = "done";
      li.querySelector(".val").textContent =
        `${fmt(inTokens)} → ${fmt(outTokens)} tok · ${(ms / 1000).toFixed(1)}s`;
      attachSummary(li, summary, `Part ${i + 1} summary, refocused · ${fmt(outTokens)} tokens`);
      let chip = li.querySelector(".refocused");
      if (!chip) {
        chip = document.createElement("span");
        chip.className = "refocused";
        li.querySelector(".lbl").after(chip);
      }
      chip.textContent = "refocused ✎";
      tip(chip, () => `Folded again, keeping: “${focus}”. The history now carries the new ` +
        `summary; the old one is gone. The digest was written from the old one — stale ` +
        `until you rebuild it.`);
    },

    /** the subtle stale hint on the digest row, and its removal */
    setStale(on) {
      if (!reduceRow) return;
      if (!on) { staleHint?.remove(); staleHint = null; return; }
      if (staleHint) return;
      staleHint = document.createElement("span");
      staleHint.className = "stale-hint";
      staleHint.textContent = "digest is stale";
      tip(staleHint, "A part was refolded after this digest was written. Nothing is broken — " +
        "the part summaries are current; this line is not. “Rebuild digest” spends one call " +
        "to catch it up.");
      reduceRow.querySelector(".lbl").after(staleHint);
    },

    /** the digest row, after a rebuild */
    markRebuilt(count, inTokens, outTokens, ms, digest) {
      if (!reduceRow) return;
      reduceRow.dataset.state = "done";
      reduceRow.querySelector(".lbl").textContent = `rejoined ${count} summaries → digest`;
      reduceRow.querySelector(".val").textContent =
        `${fmt(inTokens)} → ${fmt(outTokens)} tok · ${(ms / 1000).toFixed(1)}s`;
      attachSummary(reduceRow, digest, `Joint digest, rebuilt · ${fmt(outTokens)} tokens`);
    },

    rowWorking(i, label) {
      const li = i < 0 ? reduceRow : (firstPassRows || [])[i];
      if (!li) return;
      li.dataset.state = "working";
      li.querySelector(".val").textContent = label;
    },
    rowFailed(i, label) {
      const li = i < 0 ? reduceRow : (firstPassRows || [])[i];
      if (!li) return;
      li.dataset.state = "failed";
      li.querySelector(".val").textContent = label;
    },
  };
}

/**
 * Failures get a sentence, not a payload. The status line and response body go
 * to the wire log, which is where somebody debugging will look anyway.
 */
function addErrorCard(title, body, hint) {
  el.thread.querySelector(".empty")?.remove();
  const card = document.createElement("div");
  card.className = "msg error";
  card.setAttribute("role", "alert");
  card.innerHTML =
    `<h3 class="error-h"><span class="mark" aria-hidden="true"></span>${escapeHtml(title)}</h3>` +
    `<p class="error-body">${escapeHtml(body)}</p>` +
    '<p class="error-hint">The exact request and response are in the wire log below.';
  if (hint) {
    const extra = document.createElement("p");
    extra.className = "error-body";
    extra.textContent = hint;
    card.querySelector(".error-hint").before(extra);
  }
  el.thread.appendChild(card);
  el.thread.scrollTop = el.thread.scrollHeight;
  return card;
}

/** map the API's own wording onto something a person can act on */
function humanize(err) {
  const raw = String((err && (err.detail || err.message)) || err);
  const tooLong = raw.match(/too long:\s*([\d]+)\s*tokens?\s*>\s*([\d]+)/i);
  if (tooLong) {
    return `The model refused the request: the conversation is ${fmt(+tooLong[1])} tokens and ` +
      `this one accepts ${fmt(+tooLong[2])}. Fold it before sending — press “Compact now”, ` +
      `or start over and re-ingest, which lets the oversize guard fold it in sections first.`;
  }
  if (/could not compact/i.test(raw)) {
    return `The summarizer could not fold this in one piece: ${fmt(state.tokens)} tokens goes to ` +
      `it whole, and it has the same ${fmt(modelWindow())}-token window as the chat model. ` +
      `It has to be folded in sections instead.`;
  }
  if (/failed to fetch|networkerror|load failed/i.test(raw)) {
    return "The browser could not reach the API. Check the host in config.js, your network, " +
      "and whether an extension is blocking the request.";
  }
  if (err && err.status === 401 || err && err.status === 403) {
    return "The API rejected the credentials in config.js — check the application id and key, " +
      "and that the key is allowed to call the unstable context endpoints.";
  }
  if (err && err.status === 422) {
    return "The API would not accept the request shape. This usually means the agent forbids " +
      "per-request configuration, or a message is missing its text part.";
  }
  if (err && err.status >= 500) {
    return `The API had a problem on its side (HTTP ${err.status}). Retrying usually helps; if ` +
      `it does not, the payload is probably too large for the model behind the endpoint.`;
  }
  if (err && err.status) return `The API rejected the request with HTTP ${err.status}.`;
  return "Something went wrong before the request completed.";
}

/* ── Oversize: hierarchical folding ───────────────────────────────
   The failure this solves: a document larger than the model window cannot be
   sent (400 "prompt is too long") and cannot be compacted either, because
   /context/compact hands its entire payload to the summarizer, which overflows
   the same window (500 "Could not compact conversation"). So the fold runs
   bottom-up — summarize each section on its own, then fold the summaries,
   repeating until the digest fits. ────────────────────────────── */

/** the model's real published window — never the demo's working budget */
function modelWindow() {
  return state.model.contextWindow;
}

function oversizeLimit() {
  return Math.round(modelWindow() * CFG.oversizeAtRatio);
}

/**
 * Learned from the trim endpoint on the last probe. The habitual chars/4 is off
 * by a third on this demo's French source (2.7 chars per token), and guessing
 * low is the dangerous direction: it sizes sections too big for the summarizer.
 */
function charsPerToken() {
  return state.charsPerToken || CFG.charsPerTokenFallback;
}

const estTokens = (chars) => Math.round(chars / charsPerToken());
const sectionChars = () => Math.max(4000, Math.round(CFG.foldChunkTokens * charsPerToken()));

/**
 * Pack paragraphs up to maxChars. Paragraph boundaries keep each section
 * readable on its own, which is what the summarizer is being asked to do; a
 * paragraph longer than a whole section is cut on characters as a last resort.
 */
function chunkText(text, maxChars) {
  const chunks = [];
  let cur = "";
  const flush = () => { if (cur.trim()) chunks.push(cur.trim()); cur = ""; };
  for (const para of text.split(/\n{2,}/)) {
    if (para.length >= maxChars) {
      flush();
      for (let i = 0; i < para.length; i += maxChars) chunks.push(para.slice(i, i + maxChars));
      continue;
    }
    if (cur.length + para.length + 2 > maxChars) flush();
    cur += (cur ? "\n\n" : "") + para;
  }
  flush();
  return chunks;
}

/** the message the fold targets: the heaviest one, which is the ingested document */
function heaviestIndex() {
  let best = -1, bestLen = -1;
  state.messages.forEach((m, i) => {
    const len = textOf(m).length;
    if (len > bestLen) { bestLen = len; best = i; }
  });
  return best;
}

/** the endpoint prefixes its output; the digest supplies its own framing */
function summaryTextOf(out) {
  return textOf((out.messages || [])[0] || {})
    .replace(/^\s*Summary of the conversation so far:\s*/i, "")
    .trim();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── The folded document, as the model sees it ─────────────────────
   Two jobs, and they pull the same way.

   One: the framing. Told it is holding a summary, a model dutifully says so —
   "based on the summary provided, …" — on every single answer, which is both a
   tic and a lie about what the reader asked for. It was handed a record of a
   document; the useful posture is that of somebody who read the document. So the
   framing says exactly that, and says not to narrate the machinery unless asked.

   Two: how much of the fold to carry. The digest is what makes an oversized
   document fit, but fitting is not the goal — answering is. When the section
   summaries also fit comfortably inside the model's window, carrying all of them
   costs nothing anybody was going to spend and keeps far more detail than the
   digest alone. ────────────────────────────────────────────────── */

const READ_IT_FRAMING =
  "Here is the document we are working from. You have read it: speak from it as " +
  "your own knowledge of the document. Do not open an answer with \"based on the " +
  "summary\", and do not mention summaries, digests, extracts, condensing or " +
  "context windows — unless I ask you how this page works, in which case explain it " +
  "plainly.";

/**
 * The endpoint opens its summary with "Summary of the conversation so far:", and a
 * model handed that phrase says it back — "based on the summary provided, …" — on
 * every answer afterwards. The words come off and the posture goes on. The summary
 * itself is untouched; only its first line changes, and the role it came back with
 * (user) is kept.
 */
function reframeSummaryMessage(msg) {
  if (!msg || !Array.isArray(msg.parts)) return msg;
  const body = textOf(msg).replace(/^\s*Summary of the conversation so far:\s*/i, "").trim();
  if (!body) return msg;
  return {
    role: msg.role || "user",
    parts: [{
      type: "text",
      text: `${READ_IT_FRAMING}\n\nWhere we had got to, and what the document says:\n\n${body}`,
    }],
  };
}

/** the text of the one history message that stands in for the whole document */
function foldedDocText(fold) {
  const withSections = fold.carriesSections && fold.sections.length > 1 &&
    fold.sections.some((s) => s.summary);
  const head = `${READ_IT_FRAMING}\n\n`;
  const digest = fold.digest
    ? `── The document, end to end ──\n${fold.digest}\n\n`
    : "";
  if (!withSections) {
    return head + (digest || sectionsBlock(fold));
  }
  return head + digest + sectionsBlock(fold);
}

function sectionsBlock(fold) {
  const n = fold.sections.length;
  return fold.sections
    .map((s, i) => `── Part ${i + 1} of ${n}${s.refocused ? " (re-read for: " + s.focus + ")" : ""} ──\n` +
      `${s.summary || "(this part could not be read)"}`)
    .join("\n\n");
}

/**
 * True when every section summary fits alongside the digest with room to spare.
 *
 * Two ceilings, and the lower one governs. The model's real window is the one that
 * decides whether the detail is affordable at all. The working budget is what
 * actually triggers the next compaction, and a fold that lands just under that
 * threshold gets compacted away on the very next turn — which spends a call to
 * throw away the detail this function was trying to keep. Measured: a 6-section
 * Moby-Dick fold carrying its summaries came to 7,648 tokens against an 8,000
 * budget whose auto-compaction fires at 5,600, so the summaries survived exactly
 * one turn. Staying under the threshold keeps them for the whole conversation.
 */
function sectionsAffordable(fold) {
  const chars = fold.sections.reduce((n, s) => n + (s.summary || "").length, 0) +
    (fold.digest || "").length;
  const ceiling = Math.min(
    modelWindow() * TUNE.keepSectionsAtRatio,
    currentWindow() * CFG.compactAtRatio * 0.85);
  return estTokens(chars) <= ceiling;
}

/**
 * One line per section, for the numbered list the sentinel instruction carries.
 *
 * The chapter range is prepended when the summary names chapters, and it is the
 * difference between the protocol working and the protocol misfiring. Measured on
 * a 6-part Moby-Dick fold: asked for "the key quotes from chapter 3", models given
 * only a prose gist reached for part *3* about as often as for the part that
 * actually holds chapter 3 — they anchor on the numeral in the question. Told that
 * part 1 covers chapters 1–31, they stop guessing. The section summaries already
 * list chapter titles (that is what foldSectionWords asks them for), so the range
 * is free to extract and costs a handful of tokens to carry.
 */
function gistOf(section, i) {
  const summary = section.summary || "";
  const flat = peekOf(summary, 140);
  const nums = [];
  const re = /\bchap(?:ter|\.)\s*(\d{1,3})\b/gi;
  let m;
  while ((m = re.exec(summary))) nums.push(Number(m[1]));
  let range = "";
  if (nums.length) {
    const lo = Math.min(...nums), hi = Math.max(...nums);
    range = lo === hi ? `chapter ${lo}: ` : `chapters ${lo}–${hi}: `;
  }
  return (range + flat).trim() || `part ${i + 1} of the document`;
}

/** where the folded document currently sits in the history, or -1 */
function foldIndex() {
  return state.fold ? state.messages.indexOf(state.fold.msg) : -1;
}

/**
 * Rewrite the folded document message in place after a refold or a rebuilt
 * digest. Returns false when the message is no longer in the history at all —
 * an ordinary compact can have swallowed it — in which case the sections stay
 * openable but the history is left alone.
 */
async function syncFoldedDoc() {
  const i = foldIndex();
  if (i < 0) return false;
  state.fold.carriesSections = sectionsAffordable(state.fold);
  const next = userMsg(foldedDocText(state.fold));
  state.messages[i] = next;
  state.fold.msg = next;
  state.kinds[i] = "summary";
  await refreshContext();
  return true;
}

/* ── Sentinel protocol (agent-driven unfold) ───────────────────────
   The instruction the model is given alongside the folded document: here is what
   each part holds, and here is the one line to say if you need one of them back.
   It rides as a user message, not a system message — /completions accepts only
   `user` and `assistant` roles (a `system` role is refused with 422), and a user
   message labelled "SYSTEM:" reads as an injection attempt and gets declined on
   its face. Framed as the operator's own working notes, it is followed.

   The few-shot example is kept because it costs ~40 tokens and makes the focus
   strings noticeably more specific, not because emission depends on it: measured
   at 5/5 with and 5/5 without on both claude-haiku-4.5 and Enablers small.
   ─────────────────────────────────────────────────────────────── */

const SENTINEL_RE = /<<\s*UNFOLD\s+section\s*=\s*(\d+)(?:\s+focus\s*=\s*"([^"]*)")?\s*>>/i;
/** cheap "could this still become a sentinel?" test on a partial stream */
const SENTINEL_HEAD = "<<unfold";

function sentinelPreamble(fold) {
  const n = fold.sections.length;
  const list = fold.sections.map((s, i) => `  ${i + 1}. ${gistOf(s, i)}`).join("\n");
  return userMsg(
    `Working notes for this conversation, from me — the person you are talking to.\n\n` +
    `The full text of the document is stored here in ${n} parts. What each one holds:\n${list}\n\n` +
    `If I ask for a detail that is likely inside one of those parts and is not in the ` +
    `record you hold, do not guess and do not apologise. Reply with exactly one line and ` +
    `nothing else:\n\n<<UNFOLD section=N focus="what to look for">>\n\n` +
    `For example, if I asked what a character actually says when they refuse, and that ` +
    `scene is in part 2, you would reply with exactly:\n` +
    `<<UNFOLD section=2 focus="that character's dialogue when they refuse, verbatim">>\n\n` +
    `I will fetch that part and hand it back to you, and then you answer normally — ` +
    `without mentioning that any of this happened.`);
}

/**
 * The messages one chat request carries: the sentinel notes, the history, and any
 * extracts loaned to the model for this turn only. `extras` are never stored —
 * that is the whole point of a loan.
 */
function requestMessages(extras) {
  const pre = state.fold && state.fold.sections.length > 1 ? [sentinelPreamble(state.fold)] : [];
  return pre.concat(state.messages, extras || []);
}

/* The endpoint counts the payload it was actually given, so its stats beat the
   local chars-per-token estimate whenever they are present. */
const tokensIn = (stats, fallback) =>
  (stats && Number.isFinite(stats.tokensBeforeEstimate)) ? stats.tokensBeforeEstimate : fallback;
const tokensOut = (stats, fallback) =>
  (stats && Number.isFinite(stats.tokensAfterEstimate)) ? stats.tokensAfterEstimate : fallback;

/**
 * How many section summaries may be in flight.
 *
 * `null` (the default) means all of them. The map has no ordering constraint —
 * each section is an independent /context/compact call — so the whole pass costs
 * one slowest section rather than ceil(n / lanes) rounds of waiting. On the
 * 16-section reference book that is the difference between a fold a reader
 * watches happen and a fold a reader waits out. An integer caps it, for a
 * provider that starts answering 429 more often than the single retry absorbs.
 */
function foldLanes(total) {
  const c = CFG.foldConcurrency;
  if (c === null || c === undefined || c === 0 || c === "all") return total;
  return Math.max(1, Math.min(c, total));
}

/** How the copy says it, so the page never claims a cap it is not applying */
function foldLanesLabel() {
  const c = CFG.foldConcurrency;
  return (c === null || c === undefined || c === 0 || c === "all")
    ? "all of them at once"
    : `up to ${c} at a time`;
}

/**
 * Run `worker` over items with at most `limit` in flight. Workers are expected
 * not to reject — a failed section becomes a placeholder, because losing one
 * section of a book is recoverable and losing the whole fold is not.
 */
async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(lanes);
  return out;
}

/**
 * One /context/compact call, with one retry. Two things are worth retrying and
 * nothing else: a 429, which concurrency is what makes likely in the first place,
 * and a bare network failure — a fold is a minutes-long run of calls, and a
 * laptop that changes network in the middle of one should not lose the section.
 * A 4xx or 5xx from the API itself is a real answer and is not retried.
 */
function worthRetrying(e) {
  return e.status === 429 || !e.status;
}

async function compactOnce(body, note) {
  for (let attempt = 0; ; attempt++) {
    try {
      const out = await api("/1/unstable/context/compact", body);
      normalizeCompactResponse(out);
      // every call here runs keepLastMessages: 0, so tokensAfterEstimate IS the
      // summary the summarizer wrote — the stats can be used as they stand
      const spent = chargeSummarizer({ stats: out.stats });
      logCall("/1/unstable/context/compact", out.stats, null, note, "POST", out.normalized, spent);
      return out;
    } catch (e) {
      if (attempt >= 1 || !worthRetrying(e)) throw e;
      const delay = CFG.foldRetryDelayMs || 2500;
      logCall("/1/unstable/context/compact", null, null,
        `${note} · ${e.status === 429 ? "rate limited" : "network failure"}, backing off ` +
        `${delay}ms and retrying once`);
      await sleep(delay);
    }
  }
}

/**
 * One section → one summary (the map step). keepLastMessages: 0 is accepted and
 * means "keep nothing verbatim", which turns compact into the pure summarizer
 * this needs.
 */
async function summarizeSection(text, i, count, pass) {
  // The word cap is not cosmetic. Left open, the summarizer writes several
  // thousand tokens per section: on the reference book that is 31 s a section
  // instead of 7 s, because output tokens dominate the latency. Capped, the same
  // 62k-token section comes back in 6.5 s and still carries every chapter title.
  // Stating the cap late matters too: with it only up front, 60k tokens away from
  // where the answer starts, sections that are mostly verse numbers come back
  // quoted rather than outlined — measured at 3,050 tokens against a 250-word
  // instruction, which then makes the reduce four times slower.
  // Hence the shape: compact summarizes every message it is given, so the steering
  // cannot sit where content sits. The section goes in bracketed, alone; the
  // instruction follows as its own short message, in the imperative, so the only
  // natural completion is the outline and not an acknowledgement of the request.
  /* check-copy: off */
  const bracketed = `── Section ${i + 1} of ${count} ──\n${text}\n── End of section ${i + 1} of ${count} ──`;
  const ask =
    `Condense the text above into an outline of at most ${CFG.foldSectionWords} words. ` +
    `List the chapter or section titles in order, one short clause each. ` +
    `Keep names and places. Do not quote. Output only the outline.`;
  /* check-copy: on */
  const out = await compactOnce({
    providerID: state.model.providerId,
    model: state.model.model,
    messages: [userMsg(bracketed), userMsg(ask)],
    keepLastMessages: 0,
  }, `pass ${pass} · map · section ${i + 1}/${count} · keepLastMessages: 0 · via ${state.model.model}`);
  return { text: summaryTextOf(out), stats: out.stats };
}

/**
 * The reduce step: the N section summaries go in as N messages and one digest
 * comes back. Concatenating them would already fit, but it reads as N documents
 * stapled together — the same names reintroduced section by section, the same
 * framing repeated. One joint pass is what makes it a single record.
 */
async function reduceSummaries(summaries, pass) {
  // The word cap matters here for the same reason it does per section, one level
  // up. Uncapped, the reduce dutifully reproduces all six summaries and the digest
  // comes back the same size as the concatenation it replaced — 8,182 → 8,484
  // tokens in 123 s, measured: pure latency, no compression. Capped, the join
  // still dedups and smooths, and it does it in a fraction of the time.
  /* check-copy: off */
  const ask =
    `Merge the sections above into one continuous record of at most ` +
    `${CFG.foldDigestWords} words. Preserve their order and their chapter or section titles. ` +
    `Name each person and place once, not once per section. Output only the record.`;
  const messages = summaries
    .map((s, i) => userMsg(`── Section ${i + 1} of ${summaries.length} ──\n${s}`))
    .concat(userMsg(ask));
  /* check-copy: on */
  const out = await compactOnce({
    providerID: state.model.providerId,
    model: state.model.model,
    messages,
    keepLastMessages: 0,
  }, `pass ${pass} · reduce · ${summaries.length} summaries → 1 digest · keepLastMessages: 0 · via ${state.model.model}`);
  return { text: summaryTextOf(out), stats: out.stats };
}

/**
 * One section, folded again with a stated focus (the map step, aimed).
 *
 * The focus rides in a message of its own after the section, because
 * /context/compact has no `instructions` field yet — the endpoint takes providerID,
 * model, messages and the trim knobs, and nothing that says what to keep. When that
 * parameter ships, this becomes `{ …, instructions: focus }` and the second message
 * comes out; a trailing message is a workaround, not a design.
 *
 * `words` separates the two callers: a refold the reader asked for is kept small
 * and stored, an extract the model asked for is bigger and thrown away.
 */
async function focusSection(text, i, focus, { words, note, label }) {
  const what = label || `part ${i + 1} of a long document`;
  /* check-copy: off */
  const bracketed = `── Begin: ${what} ──\n${text}\n── End ──`;
  const ask =
    `Condense ${what}, above, into at most ${words} words, keeping this above everything ` +
    `else: ${focus}. Quote exact wording where the focus asks for it, and attribute it. ` +
    `List every name where it asks for names. One clause for everything else. ` +
    `Output only the result.`;
  /* check-copy: on */
  const out = await compactOnce({
    providerID: state.model.providerId,
    model: state.model.model,
    messages: [userMsg(bracketed), userMsg(ask)],
    keepLastMessages: 0,
  }, note);
  return { text: summaryTextOf(out), stats: out.stats };
}

/**
 * Returns true when the history now fits. Leaves the card on screen either way:
 * a fold that ran out of passes is more informative visible than erased.
 */
async function foldOversize() {
  const idx = heaviestIndex();
  if (idx < 0) return false;

  const before = state.tokens;
  const perSection = sectionChars();
  const card = addFoldCard({ before, sectionTokens: CFG.foldChunkTokens });
  const t0 = performance.now();

  let text = textOf(state.messages[idx]);
  let sections = 0;
  let pass = 0;
  // sum of every call's own latency: what a strictly sequential fold would cost
  let serialMs = 0;
  let calls = 0;
  // The first pass is the one whose sections hold real source text, so it is the
  // one worth keeping: a second pass folds summaries, and there is no original
  // behind those to reopen. A previous fold's sections are dropped here.
  let fold = null;
  state.fold = null;

  try {
    while (pass < CFG.maxFoldLevels) {
      const chunks = chunkText(text, perSection);
      if (!chunks.length) break;
      pass += 1;
      card.pass(pass, chunks.length);

      /* ── map: sections in parallel — all of them, unless capped ── */
      const summaries = await mapLimit(chunks, foldLanes(chunks.length), async (chunk, i) => {
        const inTokens = estTokens(chunk.length);
        card.begin(i, inTokens);
        const tSec = performance.now();
        try {
          const { text: summary, stats } = await summarizeSection(chunk, i, chunks.length, pass);
          const ms = performance.now() - tSec;
          serialMs += ms; calls += 1;
          // the endpoint counted the same payload: prefer its numbers to the local
          // estimate, so the card and the wire log never disagree
          card.done(i, tokensIn(stats, inTokens), tokensOut(stats, estTokens(summary.length)),
            ms, summary);
          return summary;
        } catch (e) {
          serialMs += performance.now() - tSec; calls += 1;
          const rate = e.status === 429;
          card.failed(i, rate ? "rate limited — skipped" : `failed — ${e.status || "network"}`);
          logCall("/1/unstable/context/compact", null, e.detail || e.message,
            `pass ${pass} · map · section ${i + 1}/${chunks.length} · placeholdered`);
          // a hole in the digest, honestly labelled, beats no digest at all
          return `(section ${i + 1} of ${chunks.length} could not be summarized: ` +
            `${rate ? "the provider rate-limited the request twice" : "the call failed"}. ` +
            `Its content is not represented below.)`;
        }
      });
      sections += chunks.length;
      if (pass === 1) {
        fold = {
          sections: chunks.map((chunk, i) => ({
            text: chunk,
            summary: summaries[i],
            chars: chunk.length,
            focus: null,
            refocused: false,
          })),
          digest: null,
          digestStale: false,
          carriesSections: false,
          card,
          msg: null,
        };
      }

      /* ── reduce: one joint pass over the summaries ── */
      let joined = null;
      if (CFG.foldReducePass && summaries.length > 1) {
        const inTokens = estTokens(summaries.reduce((n, s) => n + s.length, 0));
        card.reduce(summaries.length, inTokens);
        const tRed = performance.now();
        try {
          const red = await reduceSummaries(summaries, pass);
          joined = red.text;
          const ms = performance.now() - tRed;
          serialMs += ms; calls += 1;
          card.reduceDone(summaries.length, tokensIn(red.stats, inTokens),
            tokensOut(red.stats, estTokens(joined.length)), ms, joined);
        } catch (e) {
          serialMs += performance.now() - tRed; calls += 1;
          joined = null;
          card.reduceFailed(`failed — ${e.status || "network"}, keeping the sections`);
          logCall("/1/unstable/context/compact", null, e.detail || e.message,
            `pass ${pass} · reduce · fell back to concatenation`);
        }
      }

      // The digest is what the history will carry, so it is stored as the digest
      // and framed once, at the end — the "condensed record of…" wording that used
      // to sit here is what taught the model to answer "based on the summary".
      const digest = joined ||
        summaries.map((s, i) => `── Part ${i + 1} of ${chunks.length} ──\n${s}`).join("\n\n");
      if (fold) fold.digest = digest;
      text = digest;

      // one section means there was nothing left to fold together
      if (chunks.length === 1 || estTokens(text.length) <= oversizeLimit()) break;
    }
  } catch (e) {
    card.abandon(`The fold stopped part way: ${humanize(e)} The document was left as it was.`);
    addErrorCard("Could not fold the document", humanize(e));
    return false;
  }

  const foldMs = performance.now() - t0;
  if (fold) {
    state.fold = fold;
    // decided once here and re-decided after every refold: the summaries ride along
    // with the digest whenever the window can afford them
    fold.carriesSections = sectionsAffordable(fold);
    fold.msg = userMsg(foldedDocText(fold));
    state.messages[idx] = fold.msg;
  } else {
    state.messages[idx] = userMsg(`${READ_IT_FRAMING}\n\n${text}`);
  }
  state.kinds[idx] = "summary";
  state.folds += 1;
  // The fold has already happened by here; only the probe that confirms it can
  // still fail. When it does, fall back to the local estimate and finish the card
  // anyway — a card left mid-flight forever, with its timer still counting, is a
  // worse lie than an estimated number labelled as one.
  try {
    await refreshContext();
  } catch (e) {
    state.tokens = estTokens(text.length);
    state.weights = distribute(state.tokens, state.messages);
    renderMeter();
    renderLedger();
    addErrorCard("The fold finished, but the count could not be confirmed", humanize(e),
      `The figures below use this page's own estimate of ~${fmt(state.tokens)} tokens ` +
      `instead of the trim endpoint's count. Ask a question and the next probe will correct it.`);
  }
  const after = state.tokens;
  state.reclaimed += Math.max(before - after, 0);
  card.finish({ after, sections, passes: pass, ms: foldMs, serialMs, calls,
    carriesSections: !!(fold && fold.carriesSections) });
  if (fold) card.openDeepDive(fold);
  markDocFolded();
  renderMeter();
  renderLedger();

  if (after > oversizeLimit()) {
    card.abandon(`Still ${fmt(after)} tokens after ${pass} pass${pass === 1 ? "" : "es"} — ` +
      `the configured limit of ${CFG.maxFoldLevels} passes was reached.`);
    addErrorCard("The digest is still too large",
      `After ${pass} folding pass${pass === 1 ? "" : "es"} the context is ${fmt(after)} tokens, ` +
      `still above the ${fmt(oversizeLimit())} the guard allows for ${state.model.label}. ` +
      `Raise maxFoldLevels or lower foldChunkTokens in config.js, or start over with less text.`);
    return false;
  }
  return true;
}

/** stamp the ingested-document card so the thread does not imply it is still carried */
function markDocFolded() {
  const meta = [...el.thread.querySelectorAll(".msg.doc .doc-meta")].pop();
  if (!meta || meta.querySelector(".doc-folded")) return;
  const chip = document.createElement("span");
  chip.className = "doc-folded";
  chip.textContent = "folded";
  tip(chip, "The model no longer carries this text — it carries a digest of it. The card " +
    "stays as a record of what was ingested.");
  meta.insertBefore(chip, meta.querySelector(".doc-toggle"));
}

/* ── Tooltips (show the machinery) ──────────────────────────────────
   One panel, reused. Two flavours: the short explanatory tip, which never takes
   the pointer, and the "rich" flavour used to read a whole generated summary —
   that one is scrollable, so it has to accept the pointer, which means the hide
   is delayed long enough to travel from the trigger into the panel. ─────── */

const TIP_PAD = 8;
let tipHideTimer = null;
let tipPinned = null;

function tip(node, text, code, opts) {
  const show = () => showTip(node, text, code, opts);
  node.addEventListener("pointerenter", show);
  node.addEventListener("pointerleave", () => hideTip(opts));
  node.addEventListener("focus", show);
  node.addEventListener("blur", () => hideTip(opts));
  if (opts && opts.rich) {
    // touch has no hover: a tap pins the panel open, a second tap closes it
    node.addEventListener("click", (e) => {
      e.preventDefault();
      if (tipPinned === node) { tipPinned = null; hideTip(); return; }
      tipPinned = node;
      show();
    });
  }
}

/** text and code may be functions, for tooltips whose numbers move */
function showTip(node, text, code, opts) {
  clearTimeout(tipHideTimer);
  const rich = !!(opts && opts.rich);
  const body = typeof text === "function" ? text() : text;
  const snippet = typeof code === "function" ? code() : code;
  const heading = opts && opts.heading;
  // summaries come back as Markdown; render them the same way an answer is
  // rendered — escaped first, then structured — rather than showing the syntax
  const asMd = !!(opts && opts.markdown) && !!window.renderMarkdown;
  el.tooltip.classList.toggle("is-rich", rich);
  // plain tips allow exactly one marker, **bold**, applied after escaping: the
  // lead figure or term should stand out of the panel without a Markdown pass
  const plain = escapeHtml(body).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  el.tooltip.innerHTML =
    (heading ? `<span class="tip-h">${escapeHtml(heading)}</span>` : "") +
    `<span class="tip-body${asMd ? " md" : ""}">${asMd ? window.renderMarkdown(body) : plain}</span>` +
    (snippet ? `<code>${escapeHtml(snippet)}</code>` : "");
  el.tooltip.classList.add("on");
  el.tooltip.setAttribute("aria-hidden", "false");
  placeTip(node.getBoundingClientRect(), rich);
}

/**
 * Flip above/below on whichever side has room, clamp to the viewport on both
 * axes, and when neither side can hold the panel, cap its height to the taller
 * gap and let it scroll. Nothing here may leave the window: the panel is
 * position: fixed, so a clipped edge is unreachable rather than merely ugly.
 */
function placeTip(r, rich) {
  const vw = window.innerWidth, vh = window.innerHeight;
  // The rich panel gets an explicit width, not shrink-to-fit. Shrink-to-fit was
  // measured at 348px, positioned against that, and then settled at 356px once
  // the scrollbar re-wrapped its text — which put its right edge exactly on a
  // 420px viewport's edge. A fixed width makes the clamp arithmetic exact.
  const w = Math.min(rich ? 420 : 320, vw - 2 * TIP_PAD);
  el.tooltip.style.maxWidth = `${w}px`;
  el.tooltip.style.width = rich ? `${w}px` : "";
  el.tooltip.style.maxHeight = "none";

  const above = r.top - TIP_PAD * 2;
  const below = vh - r.bottom - TIP_PAD * 2;
  const cap = rich ? Math.min(vh * 0.42, Math.max(above, below)) : Infinity;
  if (cap !== Infinity) el.tooltip.style.maxHeight = `${Math.round(cap)}px`;

  let h = el.tooltip.getBoundingClientRect().height;
  let top;
  if (h <= above) top = r.top - h - TIP_PAD;
  else if (h <= below) top = r.bottom + TIP_PAD;
  else {
    // neither gap fits: take the larger one and scroll inside it
    const room = Math.max(above, below);
    el.tooltip.style.maxHeight = `${Math.round(room)}px`;
    h = el.tooltip.getBoundingClientRect().height;
    top = below >= above ? r.bottom + TIP_PAD : Math.max(TIP_PAD, r.top - h - TIP_PAD);
  }
  // height can still settle when the text re-wraps, so clamp it against a fresh
  // measurement; the width is now fixed, so its clamp is arithmetic
  const box = el.tooltip.getBoundingClientRect();
  el.tooltip.style.top =
    `${Math.round(Math.max(TIP_PAD, Math.min(top, vh - box.height - TIP_PAD)))}px`;
  el.tooltip.style.left =
    `${Math.round(Math.max(TIP_PAD, Math.min(r.left, vw - box.width - TIP_PAD)))}px`;
}

function hideTip(opts) {
  if (opts && opts.rich) {
    // give the pointer time to reach a scrollable panel before it vanishes
    clearTimeout(tipHideTimer);
    tipHideTimer = setTimeout(() => { if (!tipPinned) closeTip(); }, 220);
    return;
  }
  closeTip();
}

function closeTip() {
  el.tooltip.classList.remove("on", "is-rich");
  el.tooltip.setAttribute("aria-hidden", "true");
  el.tooltip.style.maxHeight = "none";
  el.tooltip.style.width = "";
}

/* ── The bookshelf ────────────────────────────────────────────────
   Sixteen whole books, on this origin, as plain text. A tile is one fetch and
   one ingest: no upload, no paste, no third party — and the wire log records the
   fetch alongside the API calls so it is clear which is which.

   Nothing on a tile is stored. The token figure, the regime, the number of
   summarizer calls and the dollar estimate are all derived at render time from
   the book's character count and the config as it stands right now — see
   `estimate()` in shared/books.js. That is deliberate: the shelf is grouped by
   what will happen when you click, and what will happen depends on the model you
   picked, the budget you set and the chars-per-token ratio this conversation has
   measured so far. A label written down once would be a label that lies after
   the first probe. Change the model or the budget and the groups rearrange in
   front of you, which is the honest behaviour even though it moves.

   The price is the same story one step further. It comes from the selected
   model's entry in the kit's price list, so the figure tracks the picker rather
   than a constant — and when that rate is a placeholder rather than a published
   one, the tile says so in those words. A confident number about somebody else's
   money is the one thing worse than no number.
   ────────────────────────────────────────────────────────────────── */

/** the threshold above which a tile asks before it spends; overridable in config */
function costConfirmUsd() {
  return CFG.costConfirmUsd ?? 0.5;
}

/**
 * The live config the shelf prices itself against. Read fresh on every render,
 * never captured: the model picker moves the window and the rate, the budget
 * picker moves the compaction threshold, and the trim probe replaces the shelf's
 * own chars-per-token measurement with this conversation's.
 */
function shelfOpts() {
  const opts = {
    oversizeAtRatio: CFG.oversizeAtRatio,
    compactAtRatio: CFG.compactAtRatio,
    foldSectionTokens: CFG.foldChunkTokens,
    workingBudget: state.model ? currentWindow() : CFG.defaultBudget,
    costConfirmUsd: costConfirmUsd(),
    // the kit's own money formatter, so a tile and the cost strip cannot disagree
    formatUsd: usd,
  };
  if (state.model) {
    opts.contextWindow = modelWindow();
    opts.price = currentPrice();
  }
  // the probe's ratio beats the shelf's default: it was measured on this
  // conversation, through this model's tokenizer
  if (state.charsPerToken) opts.charsPerToken = state.charsPerToken;
  return opts;
}

const estimateFor = (book) => BOOKS.estimate(book, shelfOpts());

function bookSizeLine(book, est) {
  return `${fmt(book.words)} words · ≈${fmt(est.tokens)} tokens`;
}

/** where the token figure came from — a guess, or something measured */
function ratioNote() {
  return state.charsPerToken
    ? `converted at the ${charsPerToken().toFixed(1)} characters per token this conversation ` +
      `measured through the trim endpoint`
    : `converted at ${BOOKS.SHELF_DEFAULTS.charsPerToken} characters per token, measured on ` +
      `Alice against the same endpoint — the first probe of this conversation replaces it with ` +
      `its own ratio`;
}

function bookTile(book, est) {
  const tile = document.createElement("button");
  tile.type = "button";
  tile.className = "shelf-book";
  tile.dataset.slug = book.slug;
  tile.dataset.regime = est.regime;
  tile.disabled = state.busy;
  tile.setAttribute("aria-pressed", "false");

  const title = document.createElement("span");
  title.className = "sb-title";
  title.textContent = book.title;
  const by = document.createElement("span");
  by.className = "sb-by";
  by.textContent = `${book.author} · ${book.year}`;
  const size = document.createElement("span");
  size.className = "sb-size";
  size.textContent = bookSizeLine(book, est);

  /* The whole point of the rework: before you spend anything, the tile tells you
     what the click will do and what it will cost. Two lines rather than one, so
     the mechanism and the bill can be read separately. */
  const plan = document.createElement("span");
  plan.className = "sb-plan";
  const what = document.createElement("span");
  what.className = "sb-what";
  what.textContent = est.what;
  const price = document.createElement("span");
  price.className = "sb-price";
  price.textContent = est.price;
  plan.append(what, price);

  const hook = document.createElement("span");
  hook.className = "sb-hook";
  hook.textContent = book.hook;

  tile.append(title, by, size, plan);
  if (est.costGated) {
    const flag = document.createElement("span");
    flag.className = "sb-gate-flag";
    flag.textContent = `asks first · over ${usd(est.costConfirmUsd)}`;
    tile.appendChild(flag);
  }
  tile.appendChild(hook);

  // the accessible name carries the figures, because a screen reader reading
  // "The Awakening" alone would not have been told what pressing it costs
  tile.setAttribute("aria-label",
    `${book.title}, ${book.author}, ${book.year}. ${fmt(book.words)} words, about ` +
    `${fmt(est.tokens)} tokens. ${est.line}.` +
    (est.costGated ? " Asks for confirmation before ingesting." : ""));

  tip(tile, () => {
    const live = estimateFor(book);
    const bill = live.usd === null
      ? `No rate is configured for this model, so no bill is quoted — the call count is still real.`
      : `**~${usd(live.usd)}**: ${fmt(live.tokens)} tokens read once by the summarizer at ` +
        `${M.priceLine(live.rate)} An estimate, not an invoice.`;
    return `Gutenberg ebook #${book.gutenbergId}, licence header removed, nothing else ` +
      `edited. Clicking makes it the first user message. ` +
      `${live.what[0].toUpperCase()}${live.what.slice(1)}. ${bill} Token figure ${ratioNote()}.`;
  }, null, { heading: `${book.title} · ${fmt(book.chars)} characters` });
  tile.addEventListener("click", () => pickBook(book));
  return tile;
}

/**
 * Grouped by regime, cheapest group first, and each group says in a sentence why
 * its books behave the way they do. A flat grid of sixteen tiles would hide the
 * one fact a visitor most needs before clicking: that the bottom half of this
 * shelf cannot be sent to the model at all.
 */
function renderShelf() {
  closeCostGate();
  el.shelf.textContent = "";
  BOOKS.groupByRegime(shelfOpts()).forEach((group) => {
    const section = document.createElement("section");
    section.className = "shelf-group";
    section.dataset.regime = group.regime;

    const head = document.createElement("h3");
    head.className = "shelf-group-h";
    head.append(document.createTextNode(group.copy.heading));
    const count = document.createElement("span");
    count.className = "shelf-group-n";
    count.textContent = group.entries.length === 1 ? "1 book" : `${group.entries.length} books`;
    const info = document.createElement("button");
    info.type = "button";
    info.className = "info";
    info.textContent = "?";
    tip(info, group.copy.note);
    head.append(count, info);

    const grid = document.createElement("div");
    grid.className = "shelf-grid";
    group.entries.forEach(({ book, est }) => grid.appendChild(bookTile(book, est)));

    section.append(head, grid);
    el.shelf.appendChild(section);
  });
  if (state.book) markShelf(state.book.slug);
}

function markShelf(slug) {
  el.shelf.querySelectorAll(".shelf-book").forEach((tile) => {
    const on = tile.dataset.slug === slug;
    tile.classList.toggle("is-picked", on);
    tile.setAttribute("aria-pressed", String(on));
  });
}

function shelfStatus(text, kind) {
  el.shelfStatus.textContent = text;
  el.shelfStatus.className = `hint${kind ? ` is-${kind}` : ""}`;
}

/* ── The confirm, for a book that costs real money ─────────────────
   Everything else on this page reports what a call cost after the fact. This is
   the one place where the number arrives first, because it is the one place a
   single click can spend a dollar of somebody else's budget. Whether a tile
   reaches this depends on the model selected: at the default rate nothing here
   does, and switching to a model ten times dearer makes the largest books start
   asking, with no per-book copy anywhere. ───────────────────────── */

function closeCostGate() {
  el.shelf.querySelectorAll(".shelf-gate").forEach((n) => n.remove());
}

function showCostGate(book, est) {
  const tile = el.shelf.querySelector(`.shelf-book[data-slug="${book.slug}"]`);
  closeCostGate();
  if (!tile) return;

  const panel = document.createElement("div");
  panel.className = "shelf-gate";
  panel.setAttribute("role", "group");
  panel.setAttribute("aria-label", `Confirm ingesting ${book.title}`);
  panel.dataset.slug = book.slug;

  const h = document.createElement("p");
  h.className = "gate-h";
  h.textContent = `${book.title} costs about ${usd(est.usd)} to ingest`;

  const body = document.createElement("p");
  body.className = "gate-body";
  body.textContent =
    `${est.what[0].toUpperCase()}${est.what.slice(1)} — about ${est.compactCalls} summarizer ` +
    `${est.compactCalls === 1 ? "call" : "calls"} over ${fmt(est.tokens)} tokens, on your own ` +
    `credentials. An estimate, not a quote. Nothing has been sent yet.`;

  const why = document.createElement("button");
  why.type = "button";
  why.className = "info";
  why.textContent = "?";
  tip(why, () => `The line is ${usd(costConfirmUsd())}, compared against the estimate at the ` +
    `model you picked — no fixed list of books. ${M.priceLine(est.rate)} Move it with ` +
    `costConfirmUsd in config.js.`);
  h.appendChild(why);

  const row = document.createElement("div");
  row.className = "gate-row";
  const go = document.createElement("button");
  go.type = "button";
  go.className = "btn primary gate-go";
  go.textContent = `Ingest anyway · ~${usd(est.usd)}`;
  go.addEventListener("click", () => {
    closeCostGate();
    pickBook(book, { confirmed: true });
  });
  const no = document.createElement("button");
  no.type = "button";
  no.className = "btn ghost gate-no";
  no.textContent = "Not now";
  no.addEventListener("click", () => {
    closeCostGate();
    shelfStatus(`${book.title} not ingested — nothing was sent.`, null);
    tile.focus();
  });
  row.append(go, no);

  panel.append(h, body, row);
  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); no.click(); }
  });
  tile.after(panel);
  go.focus();
  shelfStatus(`${book.title} is waiting on your confirmation — no call has been made.`, "working");
}

/**
 * One tile, one whole book. A second pick starts over rather than stacking two
 * books in one history — two documents in one conversation is a different demo,
 * and silently concatenating them would make every number on the page harder to
 * account for.
 *
 * A book whose estimated bill is over the threshold stops here the first time and
 * asks. Nothing is fetched and nothing is sent until it is confirmed: the gate
 * sits ahead of the static-file fetch too, not just ahead of the API calls.
 */
async function pickBook(book, { confirmed = false } = {}) {
  if (state.busy) return;
  const est = estimateFor(book);
  if (est.costGated && !confirmed) {
    showCostGate(book, est);
    return;
  }
  closeCostGate();
  if (state.messages.length) resetAll();
  markShelf(book.slug);
  state.book = book;
  renderChips(book);

  const url = BOOKS.bookUrl(book);
  let text;
  busy(true);
  try {
    shelfStatus(`Fetching ${book.title}…`, "working");
    const t0 = performance.now();
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    text = await res.text();
    logCall(url, null, null,
      `${fmt(text.length)} chars in ${Math.round(performance.now() - t0)}ms · a static file on ` +
      `this origin — no API, no key, no third party`, "GET");
    shelfStatus(`${book.title} · ${fmt(text.length)} chars — ${est.what}`, "working");
  } catch (e) {
    shelfStatus(`Could not load ${book.title} from this site.`, "err");
    logCall(url, null, e.message, "failed", "GET");
    busy(false);
    return;
  }
  busy(false);

  const ok = await ingest(text);
  if (ok) {
    shelfStatus(`${book.title} is in the conversation — ask it something.`, "ok");
  } else {
    shelfStatus("", null);
  }
}

/* ── Suggestion chips ─────────────────────────────────────────────
   Two families, and the labels are not decoration. A needle question has its
   answer in one place, which is what a search index is for; an arc question is
   about the whole book, which is what carrying it in context is for. Both go
   down the same path today — the point of showing them side by side is that one
   of them has no retrievable answer at all. ────────────────────── */

function renderChips(book) {
  const rows = { needle: el.chipsNeedle, arc: el.chipsArc };
  rows.needle.textContent = "";
  rows.arc.textContent = "";
  if (!book) {
    // No book, but the agent may still have written follow-ups — a reader can ask
    // about the shelf without taking anything off it, and the search tool answers
    // from the index. So the rail survives an empty shelf.
    renderSuggestionChips();
    return;
  }
  book.chips.forEach((chip) => {
    const row = rows[chip.kind];
    if (!row) return;
    const spent = state.askedChips.has(chip.text);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `chip chip-${chip.kind}${spent ? " is-spent" : ""}`;
    // A spent chip stays visible but unclickable. Clicking one twice used to send
    // the identical question again and get the identical answer back, which reads
    // as the demo talking to itself — the one thing a conversation demo must not do.
    btn.disabled = state.busy || spent;
    // the pill wears a handle; the question itself is the accessible name and the
    // tooltip, because a truncated question is a question nobody can check
    btn.textContent = chip.short;
    btn.setAttribute("aria-label", spent ? `${chip.text} (already asked)` : chip.text);
    tip(btn, spent
      ? `Already asked — the answer is in the thread above. Asking again would spend the ` +
        `same tokens for the same answer.`
      : `Sends: “${chip.text}”` + (chip.kind === "needle"
        ? " — one answer, in one place. A search index would find this."
        : " — a property of the whole book. There is no single passage to retrieve."));
    btn.addEventListener("click", () => {
      if (state.busy || state.askedChips.has(chip.text)) return;
      state.askedChips.add(chip.text);
      el.prompt.value = "";
      renderChips(book);
      send(chip.text);
    });
    row.appendChild(btn);
  });
  renderSuggestionChips();
}

/**
 * Follow-up chips the model wrote, from the `data-suggestions` frame.
 *
 * The per-book chips are a fixed pair of openings — one needle, one arc — and they
 * are meant to be spent. What comes after them has to come from the conversation,
 * so it comes from the agent's own suggestions node rather than from a list this
 * page could never keep interesting. Absent suggestions, this row simply is not
 * there: an empty "what next" rail is worse than none.
 */
function renderSuggestionChips() {
  const row = el.chipsNext;
  if (!row) return;
  row.textContent = "";
  const fresh = (state.suggestions || []).filter((s) => !state.askedChips.has(s));
  const bookChips = el.chipsNeedle.childElementCount + el.chipsArc.childElementCount;
  // The whole rail is hidden only when there is nothing at all in it — a book's
  // openings, or the agent's follow-ups, or both.
  el.chips.hidden = bookChips === 0 && fresh.length === 0;

  // Cold start is a real state, not a bug, and it gets said out loud rather than
  // hidden. Suggestions are generated by a node that runs as part of a
  // completion, so before the first answer there is no conversation to suggest
  // from — the two rows above ARE the opening move. An empty rail that silently
  // appears later reads as a page that was broken and then fixed itself.
  row.parentElement.hidden = fresh.length === 0 && bookChips === 0;
  if (fresh.length === 0) {
    if (bookChips === 0) return;
    const note = document.createElement("span");
    note.className = "chip-note";
    note.textContent = "after your first question";
    tip(note, "Written by the agent, from the conversation — and there is no conversation " +
      "yet. Ask one of the openings above and this row starts moving with the answers.");
    row.appendChild(note);
    return;
  }
  fresh.forEach((text) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip chip-next";
    btn.disabled = state.busy;
    btn.textContent = text;
    btn.setAttribute("aria-label", text);
    tip(btn, `Sends: “${text}” — written by the agent from this conversation, not from a ` +
      `list in this page. Agent Studio's suggestions node runs after the answer and ` +
      `streams these back as a data-suggestions frame.`);
    btn.addEventListener("click", () => {
      if (state.busy) return;
      state.askedChips.add(text);
      el.prompt.value = "";
      send(text);
    });
    row.appendChild(btn);
  });
}

/* ── Core flows ───────────────────────────────────────────────── */

async function refreshContext() {
  if (!state.messages.length) {
    state.tokens = 0; state.weights = [];
    renderMeter(); renderLedger();
    return;
  }
  const out = await probe(state.messages);
  state.tokens = out.stats.tokensBeforeEstimate;
  state.weights = distribute(state.tokens, state.messages);
  // calibrate the local estimator against the endpoint's own count, so section
  // sizing stops depending on the chars/4 folklore
  const chars = state.messages.reduce((n, m) => n + textOf(m).length, 0);
  if (state.tokens > 0 && chars > 0) state.charsPerToken = chars / state.tokens;
  renderMeter();
  renderLedger();
  // The shelf quotes token figures, regimes and dollars, all derived from a
  // chars-per-token ratio that was a prior measurement until this probe made it
  // this conversation's own. Re-render rather than patch one line: the ratio can
  // move a book across a group boundary, and a tile in the wrong group is a
  // wronger claim than a stale number.
  renderShelf();
}

/**
 * `source` is passed in rather than read from the textarea, because a book off
 * the shelf is over a million characters and routing that through a form control
 * buys nothing but a paint stall.
 */
async function ingest(source) {
  const fromBox = source === undefined;
  const text = String(fromBox ? el.doc.value : source).trim();
  if (!text) { el.doc.focus(); return false; }
  busy(true);
  try {
    state.messages.push(userMsg(
      "Here is a document to keep in mind for the rest of our conversation:\n\n" + text
    ));
    state.kinds.push("doc");
    const docBubble = addDocBubble(text, null);
    await refreshContext();
    const share = Math.round(state.weights[state.weights.length - 1]);
    docBubble.setTokens(share);
    // The naive side's baseline, captured here because here is the only moment it
    // exists: this is the document at full size, before any fold touches it. From
    // now on the naive history carries it on every single turn.
    state.cost.naiveHistory += share;
    // the badge is a fact about the document, not about a turn: the moment this
    // much text is on the naive side we already know a naive run of it would be
    // refused, so say so before the first question rather than after it
    state.cost.naivePeak = Math.max(state.cost.naivePeak, state.cost.naiveHistory);
    renderCost();
    el.ingestStatus.textContent = `✓ ~${fmt(share)} tokens ingested`;
    tip(el.ingestStatus,
      `Counted by the trim endpoint with no constraints — nothing was dropped, it just reported the estimate.`,
      `POST /1/unstable/context/trim\n{ messages }`);
    if (fromBox) el.doc.value = "";
    // the probe just told us this cannot be sent at all: fold it now rather than
    // letting the first question collect a 400
    if (state.tokens > oversizeLimit()) {
      el.ingestStatus.textContent = `✓ ~${fmt(share)} tokens — too large to send, folding`;
      await foldOversize();
      el.ingestStatus.textContent = `✓ folded to ~${fmt(state.tokens)} tokens`;
    }
    return true;
  } catch (e) {
    el.ingestStatus.textContent = "";
    addErrorCard("Could not ingest that document", humanize(e));
    return false;
  } finally {
    busy(false);
  }
}

/* ── URL ingest flow ─────────────────────────────────────────────── */

function urlStatus(text, kind) {
  el.urlStatus.textContent = text;
  el.urlStatus.className = `hint${kind ? ` is-${kind}` : ""}`;
}

async function fetchUrl() {
  const raw = el.url.value.trim();
  if (!raw) { el.url.focus(); return; }
  const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  busy(true);
  urlStatus("Fetching…", "working");
  try {
    const t0 = performance.now();
    const { text, via, direct, chars } = await fetchUrlText(url);
    const ms = Math.round(performance.now() - t0);
    if (!text) {
      urlStatus("That page had no readable text once markup was stripped.", "err");
      return;
    }
    el.doc.value = text;
    // the local guess is worth showing but not worth trusting: before the first
    // probe it is chars/4, which reads a third low on this book
    const guess = state.charsPerToken
      ? `≈${fmt(estTokens(text.length))} tokens at the measured ${charsPerToken().toFixed(1)} chars/token`
      : `≈${fmt(estTokens(text.length))} tokens by the rough chars/${CFG.charsPerTokenFallback} rule — Ingest asks the trim endpoint for the real count`;
    // Fetch fills the box; Ingest is what sends it. Saying so removes the one
    // dead end a first-time visitor can walk into here.
    urlStatus(
      `Fetched via ${via} in ${(ms / 1000).toFixed(1)}s · ${fmt(chars)} chars → ` +
      `${fmt(text.length)} chars of text · ${guess} — now press Ingest`,
      "ok");
    tip(el.urlStatus, direct
      ? "This host sends Access-Control-Allow-Origin, so your browser read it directly and no third party was involved. Markup was stripped here, in the page."
      : `This host sends no CORS header, so the browser could not read it directly. The URL was read through ${via}, which returned already-extracted text. That service saw the URL you asked for.`);
  } catch (e) {
    urlStatus("Could not fetch that URL.", "err");
    logCall(url, null, e.detail || e.message, "failed", "GET");
    addErrorCard("Could not fetch that page",
      `${e.message}. Some sites refuse automated requests outright; others are only reachable ` +
      `over their own domain. Pasting the text into the box above always works.`);
  } finally {
    busy(false);
  }
}

async function runCompact({ auto = false, keepBusy = false } = {}) {
  if (!canCompact()) return;
  busy(true);
  try {
    // a single compact call on an oversized history is the 500 the operator hit:
    // route it through the sectioned fold instead of reproducing the failure
    if (state.tokens > oversizeLimit()) {
      await foldOversize();
      return;
    }
    const out = await compact(state.messages);
    state.folds += 1;
    const freed = Math.max(out.stats.tokensBeforeEstimate - out.stats.tokensAfterEstimate, 0);
    state.reclaimed += freed;
    state.messages = out.messages;
    // The first message is now the summary; the rest kept their roles. It is also
    // reframed before it is stored, so the fold does not hand the model the phrase
    // that makes it narrate its own summary on every turn afterwards.
    state.messages[0] = reframeSummaryMessage(state.messages[0]);
    state.kinds = state.messages.map((m, i) => (i === 0 ? "summary" : m.role));
    // the folded document was just swallowed by this summary; the sections stay
    // reopenable, but there is no longer a message of ours to keep in sync
    if (state.fold && foldIndex() < 0) state.fold.msg = null;
    addEventCard(out.stats, state.folds, out.keep);
    state.tokens = out.stats.tokensAfterEstimate;
    state.weights = distribute(state.tokens, state.messages);
    renderMeter();
    renderLedger();
    if (auto) el.ingestStatus.textContent = "";
  } catch (e) {
    addErrorCard("Could not compact the conversation", humanize(e));
  } finally {
    if (!keepBusy) busy(false);
  }
}

/* ── One streamed answer ──────────────────────────────────────────
   Split out of send() because three flows now need it: an ordinary question, a
   question aimed at one section's original text, and the second half of an
   agent-driven unfold. All three paint the same bubble the same way. ─── */

/**
 * The assistant bubble, with the Markdown renderer and the blinking cursor
 * already wired. `chip` labels a turn that is not an ordinary one.
 */
function addAnswerBubble(chip) {
  el.thread.querySelector(".empty")?.remove();
  const wrap = document.createElement("div");
  wrap.className = "msg assistant";
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = "assistant";
  tip(who, "The model answers in Markdown. This page escapes its output, then renders the " +
    "Markdown on top of the escaped text — locally, in md.js, with no third-party script " +
    "and no HTML from the model ever inserted as HTML.");
  wrap.appendChild(who);
  if (chip) wrap.appendChild(turnChip(chip));

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  const md = document.createElement("div");
  md.className = "md";
  bubble.appendChild(md);
  const cursor = document.createElement("span");
  cursor.className = "cursor";
  cursor.textContent = " ";
  bubble.appendChild(cursor);
  wrap.appendChild(bubble);
  el.thread.appendChild(wrap);
  el.thread.scrollTop = el.thread.scrollHeight;

  // one repaint per frame at most: a fast stream would otherwise re-parse the
  // whole answer on every delta
  let frame = null;
  let text = "";
  const paint = () => {
    frame = null;
    md.innerHTML = window.renderMarkdown ? window.renderMarkdown(text) : escapeHtml(text);
    el.thread.scrollTop = el.thread.scrollHeight;
  };
  return {
    wrap,
    md,
    set(next) { text = next; if (frame === null) frame = requestAnimationFrame(paint); },
    flush() { if (frame !== null) { cancelAnimationFrame(frame); frame = null; } paint(); },
    end() { cursor.remove(); if (frame !== null) { cancelAnimationFrame(frame); frame = null; } paint(); },
    remove() { if (frame !== null) cancelAnimationFrame(frame); wrap.remove(); },
  };
}

/** the small "↳ part 3" label that keeps a loaned-context turn readable */
function turnChip({ label, tip: title }) {
  const chip = document.createElement("span");
  chip.className = "turn-chip";
  chip.textContent = label;
  if (title) tip(chip, title);
  return chip;
}

/** could this partial answer still turn out to be a sentinel line? */
function maybeSentinel(partial) {
  const t = partial.trimStart().toLowerCase();
  if (!t) return true;
  return t.length < SENTINEL_HEAD.length
    ? SENTINEL_HEAD.startsWith(t)
    : t.startsWith(SENTINEL_HEAD);
}

/**
 * Stream one completion into `into`.
 *
 * With `watchSentinel`, the first characters are held back rather than painted:
 * a sentinel line is an instruction to this page, not an answer, and flashing it
 * on screen and then retracting it is exactly the kind of seam a demo about
 * transparency should not have. The hold ends the moment the text cannot be a
 * sentinel any more, which for ordinary prose is the first delta — so nothing
 * perceptible is delayed.
 */
async function streamAnswer(messages, { note, watchSentinel, into }) {
  // The book demo has its own agents — same models, but carrying the shelf search
  // tool and book-specific instructions. `agentId` stays as the fallback so the
  // page keeps working against a config written before those agents existed; it
  // simply has no shelf search, which the header says out loud.
  const agentId = state.model.bookAgentId || state.model.agentId;
  const path = `/1/agents/${agentId}/completions?compatibilityMode=ai-sdk-5&stream=true`;
  const res = await api(path, { messages }, { stream: true });
  logCall(path.split("?")[0], null, null, note);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  // A full sentinel with a descriptive focus runs well past 80 characters, so the
  // hard cap has to clear one comfortably or a genuine sentinel gets painted just
  // before it would have been recognised.
  const holdCap = Math.max(400, TUNE.sentinelBufferChars * 3);
  let buf = "", answer = "", held = "", open = !watchSentinel, sentinel = null;
  const streamErrors = [];
  // Searches the model made during this stream. Shown as they happen and charged
  // afterwards: a tool call is one HTTP call but two model steps, and the demo
  // would be lying if the second one were free.
  const searches = [];
  let toolChars = 0;

  outer:
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let evt;
      try { evt = JSON.parse(payload); } catch (_) { continue; }
      if (evt.type === "text-delta" && evt.delta) {
        if (open) { answer += evt.delta; into.set(answer); continue; }
        held += evt.delta;
        const m = held.match(SENTINEL_RE);
        if (m) {
          sentinel = { section: Number(m[1]), focus: (m[2] || "").trim() };
          break outer;
        }
        if (!maybeSentinel(held) || held.length >= holdCap) {
          open = true;
          answer = held;
          into.set(answer);
        }
      } else if (evt.type === "tool-input-available") {
        // the model has decided to search, and the arguments are settled
        const search = { id: evt.toolCallId, name: evt.toolName, input: evt.input || {} };
        search.card = addSearchCard({ search, before: into.wrap });
        searches.push(search);
      } else if (evt.type === "tool-output-available") {
        const search = searches.find((s) => s.id === evt.toolCallId);
        // what the model is about to read, measured as it arrives rather than
        // guessed from the hit count: record size is what costs, not hits
        const chars = JSON.stringify(evt.output === undefined ? "" : evt.output).length;
        toolChars += chars;
        if (search) { search.chars = chars; search.output = evt.output; }
        if (search && search.card) search.card.done(evt.output, chars);
      } else if (evt.type === "data-suggestions") {
        // Follow-ups the agent's suggestions node wrote from this conversation.
        // The frame has carried the list under `data` and under `suggestions`
        // across versions, so accept either and ignore anything that is not a
        // list of strings rather than rendering `[object Object]` at a reader.
        const raw = evt.data && evt.data.suggestions ? evt.data.suggestions
          : (evt.suggestions || evt.data);
        if (Array.isArray(raw)) {
          state.suggestions = raw.filter((s) => typeof s === "string" && s.trim())
            .map((s) => s.trim());
          // not gated on a book: the shelf is searchable with nothing loaded
          renderChips(state.book);
        }
      } else if (evt.type === "tool-output-error" || evt.type === "tool-input-error") {
        // A rejected call never emits tool-input-available — the server emits
        // tool-input-error INSTEAD of it — so there may be no card yet. Open one
        // here rather than swallowing the failure: seven silent rejections in one
        // turn is exactly how this demo shipped an agent that apologised for not
        // finding a passage that was sitting in the index.
        const why = evt.errorText || evt.error || "the search failed";
        let search = searches.find((s) => s.id === evt.toolCallId);
        if (!search) {
          search = { id: evt.toolCallId, name: evt.toolName, input: evt.input || {} };
          search.card = addSearchCard({ search, before: into.wrap });
          searches.push(search);
        }
        if (search.card) search.card.fail(why);
        streamErrors.push(`${evt.type}: ${why}`);
      } else if (evt.type === "error") {
        // an SSE error frame is still a raw provider string: hold it back for
        // the wire log and the error card, out of the bubble
        streamErrors.push(evt.errorText || evt.error || "unspecified stream error");
      }
    }
  }

  // Belt and braces: the gate only inspects the head of the answer, so a model
  // that says "let me check" *before* the sentinel would slip past it. Measured
  // emission is bare (20/20 across two models), but a stray preamble is cheap to
  // catch here rather than showing a raw protocol line to a reader.
  if (!sentinel && watchSentinel && answer) {
    const m = answer.match(SENTINEL_RE);
    if (m && answer.replace(SENTINEL_RE, "").trim().length < 200) {
      sentinel = { section: Number(m[1]), focus: (m[2] || "").trim() };
    }
  }

  if (sentinel) {
    // nothing more from this stream is wanted: the page is about to ask a
    // different question on the model's behalf
    try { await reader.cancel(); } catch (_) { /* already closed */ }
    logCall("/1/agents/{id}/completions", null, null,
      `sentinel · the model asked for part ${sentinel.section} back` +
      (sentinel.focus ? ` · focus: “${sentinel.focus}”` : ""));
    // a sentinel is still generated output and still billed: `chars` is what the
    // model actually wrote, not what was shown
    return { answer: "", sentinel, streamErrors, chars: held.length, searches, toolChars };
  }
  if (!open && held) answer = held;
  into.end();
  return { answer, sentinel: null, streamErrors, chars: answer.length, searches, toolChars };
}

/* ── The shelf-search event card ──────────────────────────────────
   The other half of the argument this demo makes. The unfold card shows the model
   asking for context back; this one shows it reaching for the index instead. Both
   get a card rather than a spinner, because in a demo about where tokens go, a
   retrieval that happens invisibly is a retrieval the reader cannot reason about.
   ────────────────────────────────────────────────────────────── */

/**
 * Pull the hits out of a tool result without assuming its envelope. The result
 * arrives as whatever the tool serialized — a bare search response, a `results`
 * array, or a JSON string of either — so every shape is tried and `null` means
 * "say nothing about the hits" rather than "there were none".
 */
function hitsOf(output) {
  let o = output;
  if (typeof o === "string") {
    try { o = JSON.parse(o); } catch (_) { return null; }
  }
  if (!o || typeof o !== "object") return null;

  // A passage is recognisable by its own fields, so look for those rather than
  // for a particular envelope. The server hands the tool's value through
  // untouched, and the tool is free to wrap it in `hits`, in `results[0].hits`,
  // in an object keyed by index name, or not at all — so walk until something
  // looks like our records. Breadth-first, and capped, because this runs on a
  // payload the page did not author.
  const looksLikeHits = (v) => Array.isArray(v) && v.length > 0 &&
    v.every((h) => h && typeof h === "object" &&
      ("text" in h || "book" in h || "objectID" in h));

  const queue = [o];
  for (let seen = 0; queue.length && seen < 200; seen++) {
    const node = queue.shift();
    if (looksLikeHits(node)) return node;
    if (!node || typeof node !== "object") continue;
    for (const v of Object.values(node)) {
      if (v && typeof v === "object") queue.push(v);
    }
  }
  return null;
}

function addSearchCard({ search, before }) {
  el.thread.querySelector(".empty")?.remove();
  const card = document.createElement("div");
  card.className = "msg event search";
  card.innerHTML =
    '<h3 class="event-h">🔎 <span class="se-title"></span></h3>' +
    '<p class="event-note se-why"></p>' +
    '<ol class="fold-steps se-steps"></ol>' +
    '<p class="fold-live se-live" role="status" aria-live="polite"></p>';

  // The tool's own argument names are the model's words, not ours, and they vary
  // by provider. Show the query if one is recognisable, and the raw arguments in
  // the tooltip either way.
  // Two shapes, because two transports. The internal tool takes a single `query`;
  // the Algolia MCP server takes `queries: [{query, ...}]` and adds `userIntent`.
  // MCP is the platform default, so the nested form is the common case.
  const input = search.input || {};
  const nested = Array.isArray(input.queries)
    ? input.queries.map((q) => q && q.query).filter(Boolean)
    : [];
  const query = nested.length ? nested.join("” + “")
    : (input.query || input.q || input.search_query || "");
  card.querySelector(".se-title").textContent = query
    ? `assistant searched the shelf · “${query}”`
    : "assistant searched the shelf";
  card.querySelector(".se-why").innerHTML =
    `The model judged that this needed something it could not see, so it called ` +
    `<code>search_the_shelf</code> instead of answering from memory. The passages that come ` +
    `back are added to this turn and go up to the model with your question — which is why ` +
    `the meter moves. A tool call is one HTTP request but <em>two</em> model steps: one to ` +
    `decide to search, one to answer with the hits in hand.`;
  tip(card.querySelector(".event-h"),
    "A real Agent Studio tool call, not a mock: the tool is configured on the agent with " +
    "mode=static, so it can only ever search this one index — a per-request index override " +
    "is refused with a 422. Five passages come back, flat, with no snippet or highlight " +
    "metadata, because a nested match object costs tokens and cannot be quoted.",
    `${search.name || "search_the_shelf"}(${JSON.stringify(input)})\n` +
    "  → POST /1/indexes/public_domain_books/query");

  const steps = card.querySelector(".se-steps");
  const live = card.querySelector(".se-live");
  const row = document.createElement("li");
  row.dataset.state = "working";
  row.innerHTML = '<span class="mark" aria-hidden="true"></span>' +
    '<span class="lbl">searching 16 books, 11,115 passages</span>' +
    '<span class="val">…</span>';
  steps.appendChild(row);
  // above the answer bubble, because it happened before the answer did
  if (before && before.parentNode === el.thread) el.thread.insertBefore(card, before);
  else el.thread.appendChild(card);
  el.thread.scrollTop = el.thread.scrollHeight;

  const t0 = performance.now();
  const ticker = setInterval(() => {
    live.textContent = `${((performance.now() - t0) / 1000).toFixed(1)}s elapsed`;
  }, 200);

  return {
    done(output, chars) {
      clearInterval(ticker);
      const ms = performance.now() - t0;
      const hits = hitsOf(output);
      row.dataset.state = "done";
      // An index answering in 40ms should not read as "0.0s", which looks like a
      // broken timer rather than the fastest thing on the page.
      const took = ms < 950 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
      row.querySelector(".val").textContent =
        (hits ? `${hits.length} passage${hits.length === 1 ? "" : "s"} · ` : "") +
        `≈${fmt(estTokens(chars))} tok · ${took}`;

      if (hits && hits.length) {
        // one line per hit, so a reader can see WHICH passages grounded the answer
        // and go check them — provenance, not a hit count
        const cited = hits.map((h) => {
          const where = h.chapterTitle
            ? `${h.chapterTitle}`
            : (h.chapter === null || h.chapter === undefined ? "no chapter" : `chapter ${h.chapter}`);
          return `**${h.book || "unknown book"}** · ${where}${h.position ? ` · passage ${h.position}` : ""}\n\n` +
            `${(h.text || "").slice(0, 700)}${(h.text || "").length > 700 ? "…" : ""}`;
        }).join("\n\n---\n\n");
        const peek = document.createElement("button");
        peek.type = "button";
        peek.className = "sum-peek";
        const books = [...new Set(hits.map((h) => h.book).filter(Boolean))];
        peek.textContent = books.length === 1
          ? `${hits.length} from ${books[0]}`
          : `${hits.length} across ${books.length} books`;
        tip(peek, cited, null,
          { rich: true, markdown: true, heading: `What came back · ${fmt(estTokens(chars))} tokens` });
        row.appendChild(peek);
      }
      live.textContent = hits && hits.length === 0
        ? "nothing matched — the model was told so, rather than left to invent"
        : `${fmt(estTokens(chars))} tokens of passages went up with your question.`;
    },
    fail(why) {
      clearInterval(ticker);
      row.dataset.state = "failed";
      row.querySelector(".val").textContent = "failed";
      card.classList.add("is-capped");
      live.textContent = `The search failed, so the answer is coming from what was already ` +
        `in context: ${why}`;
    },
  };
}

/* ── The unfold event card ────────────────────────────────────────
   The tool loop, shown happening. A sentinel is the one moment in this demo
   where the model changes what the page does, so it gets a card of its own
   rather than a spinner. ────────────────────────────────────────── */

function addUnfoldCard({ section, focus, attempt, chars }) {
  el.thread.querySelector(".empty")?.remove();
  const card = document.createElement("div");
  card.className = "msg event unfold";
  card.innerHTML =
    '<h3 class="event-h">🔍 <span class="uf-title"></span></h3>' +
    '<p class="event-note uf-why"></p>' +
    '<ol class="fold-steps uf-steps"></ol>' +
    '<p class="fold-live uf-live" role="status" aria-live="polite"></p>';
  card.querySelector(".uf-title").textContent =
    `assistant reopened part ${section} · refolding with focus “${focus}”`;
  card.querySelector(".uf-why").innerHTML =
    `The answer to that needs something the record no longer holds, so instead of guessing, ` +
    `the model asked for a part back — in one line this page recognises. Part ${section} ` +
    `(${fmt(chars)} characters of original text) is being folded again around ` +
    `<em>${escapeHtml(focus)}</em>, and the extract goes back to the model with your question. ` +
    `Unfold ${attempt} of ${TUNE.unfoldMaxPerTurn} allowed this turn.`;
  tip(card.querySelector(".event-h"),
    "A prototype of agent-driven context paging — the model asks for its own memories back. " +
    "The sentinel line is a client-side convention, parsed by this page: the production " +
    "version would be a server-side tool the agent calls, with the same shape and none of the " +
    "string matching. What you are watching is the loop, not a mock of it.",
    `<<UNFOLD section=${section} focus="${focus}">>  →  POST /1/unstable/context/compact`);

  const steps = card.querySelector(".uf-steps");
  const live = card.querySelector(".uf-live");
  const row = document.createElement("li");
  row.dataset.state = "working";
  row.innerHTML = '<span class="mark" aria-hidden="true"></span>' +
    `<span class="lbl">folding part ${section} around the focus</span>` +
    '<span class="val">…</span>';
  steps.appendChild(row);
  el.thread.appendChild(card);
  el.thread.scrollTop = el.thread.scrollHeight;

  const t0 = performance.now();
  const ticker = setInterval(() => {
    live.textContent = `${((performance.now() - t0) / 1000).toFixed(1)}s elapsed`;
  }, 200);

  return {
    done(inTokens, outTokens, ms, extract) {
      clearInterval(ticker);
      row.dataset.state = "done";
      row.querySelector(".val").textContent =
        `${fmt(inTokens)} → ${fmt(outTokens)} tok · ${(ms / 1000).toFixed(1)}s`;
      const peek = document.createElement("button");
      peek.type = "button";
      peek.className = "sum-peek";
      peek.textContent = peekOf(extract);
      tip(peek, extract, null,
        { rich: true, markdown: true, heading: `Focused extract · ${fmt(outTokens)} tokens` });
      row.appendChild(peek);
      const second = document.createElement("li");
      second.dataset.state = "working";
      second.innerHTML = '<span class="mark" aria-hidden="true"></span>' +
        '<span class="lbl">answering again, with the extract in hand</span>' +
        '<span class="val">…</span>';
      steps.appendChild(second);
      return {
        settle(ms2) {
          second.dataset.state = "done";
          second.querySelector(".val").textContent = `${(ms2 / 1000).toFixed(1)}s`;
          live.textContent =
            `${((performance.now() - t0) / 1000).toFixed(1)}s for the whole loop · ` +
            `the extract was not kept: the history is back to the folded record.`;
        },
      };
    },
    failed(message) {
      clearInterval(ticker);
      row.dataset.state = "failed";
      row.querySelector(".val").textContent = message;
      live.textContent = "answering from what was already on hand instead.";
    },
  };
}

/** the loop guard, made visible: the model asked once too often */
function addCapCard(sentinel, used) {
  el.thread.querySelector(".empty")?.remove();
  const card = document.createElement("div");
  card.className = "msg event unfold is-capped";
  card.innerHTML =
    '<h3 class="event-h">⛔ <span class="uf-title"></span></h3>' +
    '<p class="event-note uf-why"></p>';
  card.querySelector(".uf-title").textContent =
    `unfold cap reached — part ${sentinel.section} was not reopened`;
  card.querySelector(".uf-why").textContent =
    `${used} part${used === 1 ? "" : "s"} ${used === 1 ? "has" : "have"} already been reopened for ` +
    `this one question, which is the configured ceiling. Rather than page through the document a ` +
    `line at a time, the model was asked to answer from what it holds and to name the detail it ` +
    `could not retrieve.`;
  tip(card.querySelector(".event-h"), () =>
    `A tool loop without a ceiling is a tool loop that can run until the credits do. ` +
    `unfoldMaxPerTurn is ${TUNE.unfoldMaxPerTurn} here; raise it in config.js if a document ` +
    `genuinely needs deeper paging. Either way the guard is shown rather than hidden, because a ` +
    `truncated answer with no explanation reads as a broken demo.`);
  el.thread.appendChild(card);
  el.thread.scrollTop = el.thread.scrollHeight;
}

/* ── Turn flows ──────────────────────────────────────────────────── */

/* ── Oversized answers ────────────────────────────────────────────
   An answer joins the history verbatim, and the history is what every later turn
   carries. Normally that is fine — an answer is a few hundred tokens. But a model
   handed a loaned section can decide the best answer is the section, and quote
   thousands of tokens of it straight back. That reply is then a *recent* message,
   and /context/compact keeps the last N messages verbatim by count, not by size,
   so the next auto-compact cannot touch it: measured once at 17.8k tokens sitting
   in the protected tail, which left a compaction freeing 2% of the history.

   The prompt now tells the model not to do that (see runUnfold and askSection).
   This is the other half: when it happens anyway, the answer is still recorded in
   full — nothing is truncated behind the reader's back — and the page says out
   loud what it will cost, because a demo about showing the machinery does not get
   to hide the one place the machinery bites. ────────────────────── */

/** past this, an "answer" is really a paste-back. 4× the loan budget, floor 3k. */
const LARGE_ANSWER_TOKENS = Math.max(3000, TUNE.unfoldFocusWords * 4);

function addLargeAnswerCard(tokens) {
  el.thread.querySelector(".empty")?.remove();
  const card = document.createElement("div");
  card.className = "msg event large-answer";
  card.innerHTML =
    '<h3 class="event-h">⚠ <span class="la-title"></span></h3>' +
    '<div class="event-figures"></div>' +
    '<p class="event-note la-why"></p>';
  card.querySelector(".la-title").textContent =
    "unusually large answer recorded — it will linger in the history";
  card.querySelector(".event-figures").innerHTML =
    `<div><span class="k">this answer</span><span>~${fmt(tokens)} tok</span></div>` +
    `<div><span class="k">usual ceiling</span><span>~${fmt(LARGE_ANSWER_TOKENS)} tok</span></div>` +
    `<div><span class="k">protected tail</span><span>last ${CFG.keepLastMessages} messages</span></div>`;
  card.querySelector(".la-why").textContent =
    "The model answered by reproducing a large stretch of text rather than writing about it. " +
    "It is recorded in full — nothing here is truncated without saying so — but compaction " +
    "keeps the last messages verbatim by count rather than by size, so this one sits inside the " +
    "protected tail and the next fold cannot reclaim it. Expect the meter to climb and the next " +
    "compaction to free less than usual. Ask the question again and it will usually answer " +
    "shorter; “Start over” clears it outright.";
  tip(card.querySelector(".event-h"), () =>
    `POST /1/unstable/context/compact takes keepLastMessages (${CFG.keepLastMessages} here) — a ` +
    `count, not a token budget. The newest ${CFG.keepLastMessages} messages are kept word for ` +
    `word whatever they weigh, which is what makes the immediate exchange read naturally and ` +
    `also what makes one oversized message expensive: it has to fall out of the tail on its own ` +
    `before a fold can reach it. A maxTokensEstimate on the trailing window would cap this; the ` +
    `endpoint has no such knob yet.`,
    `{ keepLastMessages: ${CFG.keepLastMessages} }  →  the last ${CFG.keepLastMessages} messages survive verbatim`);
  el.thread.appendChild(card);
  el.thread.scrollTop = el.thread.scrollHeight;
}

/** the assistant answer, recorded in the history and rendered as such */
function recordAnswer(answer) {
  state.messages.push({ role: "assistant", parts: [{ type: "text", text: answer }] });
  state.kinds.push("assistant");
  const tokens = estTokens(String(answer || "").length);
  if (tokens > LARGE_ANSWER_TOKENS) addLargeAnswerCard(tokens);
}

/**
 * An ordinary question, with the sentinel loop wrapped around it.
 *
 * `extras` are messages loaned to the model for this turn and this turn only:
 * a focused extract, plus a restatement of the question so the extract has
 * something to be an answer to. They are never pushed into state.messages, which
 * is what makes the loop free — the turn after this one costs what the turn
 * before it did.
 */
async function send(text) {
  busy(true);

  // Pre-flight against the model's real window, not the demo budget. Past this
  // the provider rejects the request outright, so the fold happens first and the
  // 400 never has to be explained to anybody.
  if (state.messages.length && state.tokens + estTokens(text.length) > oversizeLimit()) {
    const ok = await foldOversize();
    if (!ok) {
      busy(false);
      return;
    }
  }

  state.messages.push(userMsg(text));
  state.kinds.push("user");
  const userBubble = addBubble("user", text);

  // the naive history grows by the question whether or not the fold exists
  const naiveQuestion = estTokens(text.length);
  state.cost.naiveHistory += naiveQuestion;
  const naiveIn = state.cost.naiveHistory;

  let into = addAnswerBubble(null);
  const rollback = () => {
    into.remove();
    userBubble.parentElement.remove();
    state.messages.pop();
    state.kinds.pop();
    // the question never landed, so the counterfactual never carried it either.
    // Anything already charged to the real side stays — that money was spent.
    state.cost.naiveHistory -= naiveQuestion;
    renderCost();
    if (!el.prompt.value) el.prompt.value = text;
  };

  const extras = [];
  let unfolds = 0;
  let cappedOnce = false;
  // what the model wrote on the last attempt: the naive side is charged one
  // answer per turn, at whatever size the answer turned out to be
  let outChars = 0;

  try {
    for (;;) {
      const canUnfold = !!state.fold && state.fold.sections.length > 1 &&
        unfolds < TUNE.unfoldMaxPerTurn;
      const t0 = performance.now();
      const realIn = realInputTokens(text.length, extras);
      const out = await streamAnswer(requestMessages(extras), {
        note: `stream=true · ${state.model.model}` +
          (extras.length ? ` · +${extras.length} loaned message${extras.length === 1 ? "" : "s"}` : "") +
          (state.fold && state.fold.sections.length > 1 ? " · sentinel notes attached" : ""),
        watchSentinel: !!state.fold && state.fold.sections.length > 1,
        into,
      });
      // A search means the model was run twice over this conversation. Charge the
      // deciding pass separately, then let the ordinary charge below cover the
      // answering pass with the passages added to its input.
      const searched = (out.searches || []).length > 0;
      if (searched) chargeToolStep(realIn, estTokens(JSON.stringify(out.searches.map((s) => s.input)).length));
      // every attempt is a real call the provider will invoice, sentinel included
      chargeChat(realIn + estTokens(out.toolChars || 0), estTokens(out.chars));
      outChars = out.chars;

      if (out.sentinel) {
        // the empty bubble goes first, so the event card is not preceded by a
        // blinking cursor that will never write anything
        into.remove();

        if (canUnfold) {
          const ok = await runUnfold(out.sentinel, text, extras, unfolds + 1);
          unfolds += 1;
          into = addAnswerBubble(ok
            ? {
              label: `↳ part ${out.sentinel.section}, reopened`,
              tip: "This answer was written with a focused extract of that part in hand. The " +
                "extract was loaned for this turn and is already gone — the history holds the " +
                "folded record, exactly as it did before you asked.",
            }
            : {
              label: "↳ the reopening failed",
              tip: "The focused fold of that part did not come back, so the model was asked to " +
                "answer from the record it already held.",
            });
          continue;
        }

        if (!cappedOnce) {
          // The cap is reached. Ask for an answer from what is on hand rather
          // than paging forever — and show the guard, because a guard nobody can
          // see is indistinguishable from a bug.
          cappedOnce = true;
          addCapCard(out.sentinel, unfolds);
          extras.push(userMsg(
            `No more parts can be fetched for this question — you have used the ` +
            `${TUNE.unfoldMaxPerTurn} allowed. Answer now from what you already hold, and name ` +
            `plainly the one detail you could not retrieve. Do not use the <<UNFOLD …>> line again.`));
          into = addAnswerBubble({
            label: "↳ answered without a further unfold",
            tip: `The model asked to reopen a part once more than the loop guard allows ` +
              `(${TUNE.unfoldMaxPerTurn} per turn). Past that a model can page indefinitely, so it ` +
              `was asked to answer from what it had and to say what it could not find.`,
          });
          continue;
        }

        // asked again after being told not to: stop honouring it and say so
        into = addAnswerBubble(null);
        into.end();
        into.md.textContent =
          "(the model kept asking to reopen a part instead of answering, so the page stopped " +
          "honouring the request)";
        recordAnswer("I could not answer that from the record I hold.");
        break;
      }

      const ms = performance.now() - t0;
      if (out.streamErrors.length) {
        const detail = out.streamErrors.join(" · ");
        logCall("/1/agents/{id}/completions", null, detail, "stream error frame");
        if (!out.answer) {
          rollback();
          addErrorCard("The model stopped before answering", humanize({ detail }),
            "Your question is back in the box — nothing was left half-recorded in the history.");
          busy(false);
          return;
        }
        addErrorCard("The answer was cut short", humanize({ detail }),
          "What did arrive is kept above and stays in the conversation.");
      }
      if (!out.answer) into.md.textContent = "(empty response)";
      recordAnswer(out.answer);
      if (state.unfoldSettle) { state.unfoldSettle(ms); state.unfoldSettle = null; }
      break;
    }
    // One turn, one naive call — however many calls the real side needed to get
    // here. That asymmetry is the comparison, not a thumb on the scale: the naive
    // run would have answered in one call because it never lost the detail.
    const naiveAnswer = estTokens(outChars);
    chargeNaiveTurn(naiveIn, naiveAnswer);
    state.cost.naiveHistory += naiveAnswer;
  } catch (e) {
    rollback();
    state.unfoldSettle = null;
    addErrorCard("The model did not answer", humanize(e),
      "Your question is back in the box — nothing was left half-recorded in the history.");
    busy(false);
    return;
  }

  // stay busy through the post-turn probe and any fold: re-enabling the
  // composer early lets a second message race the history swap
  try {
    await refreshContext();
    if (state.tokens >= currentWindow() * CFG.compactAtRatio) {
      await runCompact({ auto: true, keepBusy: true });
    }
  } finally {
    busy(false);
  }
}

/**
 * Half of the tool loop: fold the requested part around the model's own stated
 * focus and push the extract into this turn's loaned messages. Returns false when
 * the fold failed, in which case the model is told to manage without it.
 */
async function runUnfold(sentinel, question, extras, attempt) {
  const n = state.fold.sections.length;
  // a model can name a part that does not exist; clamp rather than fail
  const i = Math.min(Math.max(sentinel.section - 1, 0), n - 1);
  const section = state.fold.sections[i];
  const focus = sentinel.focus || `whatever answers: ${question}`;
  const card = addUnfoldCard({ section: i + 1, focus, attempt, chars: section.chars });
  const t0 = performance.now();
  try {
    const { text: extract, stats } = await focusSection(section.text, i, focus, {
      words: TUNE.unfoldFocusWords,
      note: `unfold ${attempt}/${TUNE.unfoldMaxPerTurn} · part ${i + 1}/${n} · ephemeral extract · ` +
        `keepLastMessages: 0 · via ${state.model.model}`,
    });
    const ms = performance.now() - t0;
    const stage = card.done(tokensIn(stats, estTokens(section.chars)),
      tokensOut(stats, estTokens(extract.length)), ms, extract);
    state.unfoldSettle = stage.settle;
    extras.push(userMsg(
      `Here is that part of the document, in full on the point you asked about.\n\n` +
      `${extract}\n\n` +
      `Now answer my question, from this and from what you already know of the document: ` +
      `${question}\n\n` +
      `Answer it directly, in your own words, and at the length the question deserves. ` +
      `Quote briefly — a phrase or a line — where a quotation is the answer, and attribute it. ` +
      `Do NOT reproduce this text wholesale or paste long stretches of it back to me: the ` +
      `passage above is on loan for this answer only, and copying it into your reply is what ` +
      `keeps it in the conversation afterwards. ` +
      `Do not mention this exchange, extracts, parts, or summaries.`));
    return true;
  } catch (e) {
    card.failed(`failed — ${e.status || "network"}`);
    logCall("/1/unstable/context/compact", null, e.detail || e.message,
      `unfold ${attempt} · part ${i + 1}/${n} · the model was asked to manage without it`);
    extras.push(userMsg(
      `That part could not be fetched. Answer from what you already hold, and say plainly ` +
      `which detail you could not retrieve. Do not use the <<UNFOLD …>> line again.`));
    return false;
  }
}

/**
 * Feature 1 — the reader's own unfold. The context for this one answer is the
 * FULL original text of one part plus the question, and nothing else: no folded
 * history, no other parts. A 60k-token part fits any window this demo offers, so
 * the loan is affordable; when it is not (a small window, or a part that grew past
 * one), the part is folded around the question first and the card says so.
 *
 * The question and the answer join the history. The part does not.
 */
async function askSection(fold, i, question) {
  // the card that owns these controls may belong to a superseded fold: a second
  // ingest builds a new one, and the old card is still on screen in the thread
  if (state.fold !== fold || state.busy) return;
  const whole = i < 0;
  const n = fold.sections.length;
  const label = whole ? "the part summaries" : `part ${i + 1} of ${n}`;
  const source = whole
    ? fold.sections.map((s, k) => `── Part ${k + 1} of ${n} ──\n${s.summary || ""}`).join("\n\n")
    : fold.sections[i].text;

  busy(true);
  state.messages.push(userMsg(question));
  state.kinds.push("user");
  const userBubble = addBubble("user", question);
  userBubble.parentElement.insertBefore(
    turnChip({
      label: whole ? "↳ all parts" : `↳ part ${i + 1}`,
      tip: `Asked against ${label}. The model gets that text and this question — not the ` +
        `conversation, not the other parts.`,
    }),
    userBubble);

  let into = addAnswerBubble({
    label: whole ? "↳ all parts" : `↳ part ${i + 1}`,
    tip: `The part was loaned to the model for this answer, then folded away again: it is not ` +
      `in the history, so it is not re-sent on the next turn and the meter does not move. ` +
      `Only your question and this answer stay.`,
  });

  // A dive-in has no naive counterpart of its own: in a world with no fold the
  // document was never put away, so this is simply an ordinary question asked
  // against the whole of it. That is exactly what the naive side charges.
  const naiveQuestion = estTokens(question.length);
  state.cost.naiveHistory += naiveQuestion;
  const naiveIn = state.cost.naiveHistory;

  const rollback = () => {
    into.remove();
    userBubble.parentElement.remove();
    state.messages.pop();
    state.kinds.pop();
    state.cost.naiveHistory -= naiveQuestion;
    renderCost();
  };

  try {
    let context = source;
    let loaned = estTokens(source.length);
    // The margin is the answer's own room: a part that fills the window leaves
    // nowhere to write. Past it, the part is folded around the question first.
    const room = Math.round(modelWindow() * CFG.oversizeAtRatio) - estTokens(question.length) - 2000;
    if (loaned > room) {
      const { text: focused, stats } = await focusSection(source, whole ? 0 : i, question, {
        words: TUNE.unfoldFocusWords,
        label: whole ? "every part summary of a long document" : `part ${i + 1} of a long document`,
        note: `dive in · ${label} · too large to loan whole (${fmt(loaned)} tok > ${fmt(room)}) · ` +
          `folded around the question first · via ${state.model.model}`,
      });
      context = focused;
      const was = loaned;
      loaned = tokensOut(stats, estTokens(focused.length));
      addEventNote(into.wrap,
        `That part is ${fmt(was)} tokens, past the ${fmt(room)} this model can be loaned ` +
        `alongside an answer, so it was folded around your question first — ${fmt(loaned)} tokens ` +
        `of it went to the model, aimed at what you asked.`);
    }

    const framed =
      `${READ_IT_FRAMING}\n\n` +
      `This is ${label} of the document, in full.\n\n${context}\n\n` +
      `My question about it: ${question}\n\n` +
      `Answer from this text, in your own words. Quote briefly — a phrase or a line, attributed — ` +
      `where a quotation is what answers the question, but do not reproduce the passage wholesale: ` +
      `it is on loan for this answer, and copying it into your reply is what keeps it in the ` +
      `conversation afterwards. If the answer is genuinely not in it, say so in one line.`;

    const out = await streamAnswer([userMsg(framed)], {
      note: `stream=true · ${state.model.model} · dive in · ${label} only · ~${fmt(loaned)} tok loaned`,
      watchSentinel: false,
      into,
    });
    // this payload IS the whole request — no stored history rides along with it
    chargeChat(estTokens(framed.length), estTokens(out.chars));

    if (out.streamErrors.length) {
      const detail = out.streamErrors.join(" · ");
      logCall("/1/agents/{id}/completions", null, detail, "stream error frame");
      if (!out.answer) {
        rollback();
        addErrorCard("The model stopped before answering", humanize({ detail }));
        return;
      }
      addErrorCard("The answer was cut short", humanize({ detail }),
        "What did arrive is kept above and stays in the conversation.");
    }
    if (!out.answer) into.md.textContent = "(empty response)";
    recordAnswer(out.answer);
    const naiveAnswer = estTokens(out.chars);
    chargeNaiveTurn(naiveIn, naiveAnswer);
    state.cost.naiveHistory += naiveAnswer;
    await refreshContext();
  } catch (e) {
    rollback();
    addErrorCard("Could not answer against that part", humanize(e));
  } finally {
    busy(false);
  }
}

/** a small explanatory line attached under a bubble, in the card idiom */
function addEventNote(wrap, text) {
  const p = document.createElement("p");
  p.className = "turn-note";
  p.textContent = text;
  wrap.appendChild(p);
}

/**
 * Feature 2 — refold one part with a stated focus. One /context/compact call.
 * The new summary replaces the old one in the history; the digest is left alone
 * and marked stale, because rebuilding it is a second call and spending it is the
 * reader's decision, not this function's.
 */
async function refocusSection(fold, i, focus) {
  if (state.fold !== fold || state.busy) return;
  const section = fold.sections[i];
  const n = fold.sections.length;
  const card = fold.card;
  busy(true);
  card.rowWorking(i, `refolding around the focus…`);
  const t0 = performance.now();
  try {
    const { text: summary, stats } = await focusSection(section.text, i, focus, {
      words: TUNE.refocusWords,
      note: `refold · part ${i + 1}/${n} · focus: “${focus}” · keepLastMessages: 0 · ` +
        `via ${state.model.model}`,
    });
    const ms = performance.now() - t0;
    section.summary = summary;
    section.focus = focus;
    section.refocused = true;
    fold.digestStale = true;
    card.markRefocused(i, focus, summary,
      tokensIn(stats, estTokens(section.chars)),
      tokensOut(stats, estTokens(summary.length)), ms);
    card.setStale(true);
    const synced = await syncFoldedDoc();
    renderMeter();
    renderLedger();
    addFoldNote(`Part ${i + 1} was folded again, keeping “${focus}”. ` +
      (synced
        ? fold.carriesSections
          ? "The new summary is what the conversation carries now."
          : "The history carries the digest, which still reflects the older summary — rebuild it to catch up."
        : "The folded record has since been compacted away, so the history was left alone.") +
      " The digest was not rebuilt: that is one more call, and it is your call.");
  } catch (e) {
    card.rowFailed(i, `refold failed — ${e.status || "network"}`);
    addErrorCard("Could not refold that part", humanize(e));
  } finally {
    busy(false);
  }
}

/** Feature 2, second half — the reduce pass again, on demand */
async function rebuildDigest(fold) {
  if (state.fold !== fold || state.busy) return;
  const summaries = fold.sections.map((s) => s.summary || "");
  if (summaries.length < 2) return;
  busy(true);
  fold.card.rowWorking(-1, "rejoining the current summaries…");
  const inTokens = estTokens(summaries.reduce((n, s) => n + s.length, 0));
  const t0 = performance.now();
  try {
    const red = await reduceSummaries(summaries, "rebuild");
    const ms = performance.now() - t0;
    fold.digest = red.text;
    fold.digestStale = false;
    // resolved once and used in both places: the endpoint counted this payload, so
    // the row and the note must not quote two different numbers for it
    const inTok = tokensIn(red.stats, inTokens);
    const outTok = tokensOut(red.stats, estTokens(red.text.length));
    fold.card.markRebuilt(summaries.length, inTok, outTok, ms, red.text);
    fold.card.setStale(false);
    await syncFoldedDoc();
    renderMeter();
    renderLedger();
    addFoldNote(`The digest was rewritten from the current part summaries, refolded ones ` +
      `included — ${fmt(inTok)} tokens in, ${fmt(outTok)} out, ${(ms / 1000).toFixed(1)}s.`);
  } catch (e) {
    fold.card.rowFailed(-1, `rebuild failed — ${e.status || "network"}`);
    addErrorCard("Could not rebuild the digest", humanize(e));
  } finally {
    busy(false);
  }
}

/** a one-line record in the thread, so a fold-card change is not silent */
function addFoldNote(text) {
  el.thread.querySelector(".empty")?.remove();
  const p = document.createElement("div");
  p.className = "msg fold-note";
  p.textContent = text;
  el.thread.appendChild(p);
  el.thread.scrollTop = el.thread.scrollHeight;
}

function busy(on) {
  state.busy = on;
  el.send.disabled = on;
  el.ingest.disabled = on;
  el.urlBtn.disabled = on;
  el.reset.disabled = on;
  el.compact.disabled = on || !canCompact();
  el.send.textContent = on ? "…" : "Send";
  // a second book or a second question mid-fold would race the history swap
  document.querySelectorAll(".shelf-book, .chip").forEach((b) => {
    // A spent chip is disabled for a reason that outlives the busy state, so
    // releasing the page must not hand it back: `on || spent`, never a bare `on`.
    b.disabled = on || b.classList.contains("is-spent");
  });
}

/**
 * Back to an empty conversation, with the model and budget choices left alone.
 * Also what a second book pick runs first — one document per conversation keeps
 * every figure on the page accountable to one source.
 */
function resetAll() {
  state.messages = []; state.weights = []; state.kinds = [];
  state.tokens = 0; state.folds = 0; state.reclaimed = 0;
  state.charsPerToken = null;
  state.foldProgress = null;
  state.fold = null;
  state.unfoldSettle = null;
  // a cleared thread has asked nothing, and last turn's follow-ups describe a
  // conversation that no longer exists
  state.askedChips = new Set();
  state.suggestions = [];
  resetCost();
  // the chips go with the document they belong to: a Moby-Dick question sent
  // against an empty history reads as the demo failing to answer
  renderChips(null);
  markShelf(null);
  tipPinned = null; closeTip();
  el.thread.innerHTML = '<div class="empty"><p><strong>Cleared.</strong></p>' +
    '<p>Take a book off the shelf, or ingest a document of your own.</p></div>';
  el.ingestStatus.textContent = "";
  urlStatus("");
  renderMeter(); renderLedger();
}

/* ── Wiring ───────────────────────────────────────────────────── */

const SAMPLE = `Agent Studio release notes — context management (unstable)

Why this exists
Every agent conversation carries its full history to the model on each turn.
History grows monotonically; the model window does not. Past a point you either
truncate blindly, lose the thread, or pay for tokens nobody reads.

context/trim
Deterministic, no LLM call, no cost. Give it a message array and it reports
messagesBefore/After and tokensBefore/AfterEstimate. With keepLastMessages it
drops older turns; with maxTokensEstimate it drops oldest-first until the budget
fits; with dropToolParts it strips tool invocations and results from survivors.
Called with none of those, it is a pure token-count probe — which is how this
demo keeps its meter honest without guessing at tokenizers in the browser.

context/compact
Summarization instead of deletion. It keeps the last N messages verbatim and
replaces everything older with a single summary message, written by the model you
name via providerID + model. The summary runs on your provider credentials, so
the cost lands on your account and the choice of model is yours: a small, fast
model is usually enough to summarize a conversation faithfully.

Guidance
Probe on every turn, compact on a threshold rather than on overflow — a fold at
70% of the budget keeps a comfortable margin for the next answer. Keep enough
trailing turns verbatim that the immediate exchange still reads naturally; six is
a reasonable default for chat, more for agentic tool loops.

Caveats
Token counts are heuristic estimates over serialized messages, not authoritative
provider counts. These endpoints live under /1/unstable and can change.`;

function initModels() {
  CFG.models.forEach((m, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    const win = m.contextWindow >= 1000000
      ? `${Math.round(m.contextWindow / 1000000)}M`
      : `${Math.round(m.contextWindow / 1000)}k`;
    // an option holds text only, so an unverified window is marked with an
    // asterisk here and explained in full in the hint below the select
    opt.textContent = `${m.label} · ${win}${m.windowVerified === false ? "*" : ""}` +
      (m.badge ? ` · ${m.badge}` : "");
    el.model.appendChild(opt);
  });
  el.model.addEventListener("change", () => {
    state.model = CFG.models[Number(el.model.value)];
    setModelHint();
    renderMeter();
    // the meter's mode is a statement about THIS model's window: a history that
    // cannot be sent naively to a 200k model fits a 1M one, so switching the
    // picker can make an impossible run possible again. Re-render or the tile
    // keeps asserting the old answer until the next charge lands.
    renderCost();
    // and the shelf's groups are a claim about THIS model: its window decides
    // what folds, its rate decides what asks first. A dearer model can move a
    // book into the confirm group without anything else on the page changing.
    renderShelf();
  });
  state.model = CFG.models[0];
  setModelHint();
}

/**
 * The hint carries two things a dropdown cannot: the badge on the headline
 * option, and — when the provider publishes no window — where the number beside
 * it came from instead. An unpublished window is either still a guess
 * (windowVerified: false, marked in warn colour) or one this demo measured
 * against the live endpoint (windowVerified: true plus a windowNote), and the
 * two read differently: a guess is a caveat, a measurement is a citation.
 */
function setModelHint() {
  const m = state.model;
  el.modelHint.textContent = "";

  if (m.badge) {
    const badge = document.createElement("span");
    badge.className = "model-badge";
    badge.textContent = m.badge;
    tip(badge, "Algolia's own open-source model family, reached through an " +
      "openai_compatible provider — the same two context endpoints work through it unchanged: " +
      "context/compact was measured folding this conversation in 1.1s.");
    el.modelHint.append(badge, " ");
  }

  el.modelHint.append(document.createTextNode(
    `${m.note} · ${fmt(m.contextWindow)}-token window` +
    `${m.windowVerified === false ? "*" : ""} · anything past ` +
    `${fmt(oversizeLimit())} is folded in sections before it is sent`));

  if (m.windowVerified === false) {
    const star = document.createElement("span");
    star.className = "unverified";
    star.textContent = " window unverified";
    tip(star, m.windowNote ||
      "The provider does not publish a context window; the number beside it is a conservative " +
      "floor chosen by this demo, not a specification.");
    el.modelHint.appendChild(star);
  } else if (m.windowVerified === true && m.windowNote) {
    const measured = document.createElement("span");
    measured.className = "measured";
    measured.textContent = " window measured";
    tip(measured, m.windowNote);
    el.modelHint.appendChild(measured);
  }
}

function initBudgets() {
  CFG.budgets.forEach((b, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = b.value ? `${b.label} tokens` : b.label;
    if (b.value === CFG.defaultBudget) opt.selected = true;
    el.budget.appendChild(opt);
  });
  el.budget.addEventListener("change", () => {
    state.budget = CFG.budgets[Number(el.budget.value)].value;
    setBudgetHint();
    renderMeter();
    // the compaction threshold moved, so "compacts on your first question" may no
    // longer be true of the smaller books
    renderShelf();
  });
  setBudgetHint();
}

function setBudgetHint() {
  el.budgetHint.textContent = state.budget
    ? `Auto-compaction fires at ${fmt(state.budget * CFG.compactAtRatio)} tokens`
    : `Full model window — a demo will not reach it`;
}

/* ── Theme ────────────────────────────────────────────────────────
   The head script has already resolved the theme before first paint; this only
   labels the button and handles the click. The palette is one set of
   light-dark() declarations, so switching is a single attribute. ────── */

function currentTheme() {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem("ic-theme", theme); } catch (_) { /* private mode */ }
  const dark = theme === "dark";
  // the button names what it will do, not what is on screen
  el.themeGlyph.textContent = dark ? "☀" : "☾";
  el.themeLabel.textContent = dark ? "Light" : "Dark";
  el.themeToggle.setAttribute("aria-pressed", String(dark));
  el.themeToggle.setAttribute("aria-label",
    dark ? "Switch to the light theme" : "Switch to the dark theme");
}

function initTheme() {
  applyTheme(currentTheme());
  el.themeToggle.addEventListener("click", () => {
    applyTheme(currentTheme() === "dark" ? "light" : "dark");
  });
  tip(el.themeToggle, () =>
    `Currently ${currentTheme()}. This overrides your system preference and remembers the ` +
    `choice in this browser only. Both themes come from one set of light-dark() custom ` +
    `properties, so there is no second palette to fall out of sync.`);
}

function init() {
  if (!CFG || !CFG.appId || CFG.appId === "YOUR_APP_ID") {
    document.body.innerHTML =
      '<p style="font-family:system-ui;padding:40px;max-width:60ch">' +
      "Copy <code>shared/config.example.js</code> to <code>shared/config.js</code> and fill in your " +
      "app id, API key, and agent ids before loading this page.</p>";
    return;
  }
  initTheme();
  initModels();
  initBudgets();
  initCostbar();
  renderShelf();
  renderMeter();

  // the panel takes the pointer when it is scrollable, so travelling into it
  // must not read as leaving the trigger
  el.tooltip.addEventListener("pointerenter", () => clearTimeout(tipHideTimer));
  el.tooltip.addEventListener("pointerleave", () => { if (!tipPinned) closeTip(); });
  document.addEventListener("pointerdown", (e) => {
    if (tipPinned && !el.tooltip.contains(e.target) && !tipPinned.contains(e.target)) {
      tipPinned = null;
      closeTip();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { tipPinned = null; closeTip(); }
  });

  document.querySelectorAll("#footer-endpoints li[data-endpoint]").forEach((li) => {
    const link = docsLink(li.dataset.endpoint, "reference ↗");
    if (link) li.append(" ", link);
  });

  // The markup already carries the canonical repo URL, so the links work with no
  // config at all; a config may still redirect them at a fork.
  if (CFG.repoUrl) {
    $("repo-cta").href = CFG.repoUrl;
    $("repo-link").href = CFG.repoUrl;
  }

  el.ingest.addEventListener("click", () => ingest());
  el.urlBtn.addEventListener("click", fetchUrl);
  el.url.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); if (!state.busy) fetchUrl(); }
  });
  el.sample.addEventListener("click", () => { el.doc.value = SAMPLE; el.doc.focus(); });
  el.file.addEventListener("change", async () => {
    const f = el.file.files[0];
    if (!f) return;
    el.doc.value = await f.text();
    el.ingestStatus.textContent = `${f.name} loaded — press Ingest`;
  });
  el.compact.addEventListener("click", () => runCompact());
  el.reset.addEventListener("click", () => {
    resetAll();
    // the shelf keeps its selection: the chips are the reason to come back to it
    if (state.book) shelfStatus(`${state.book.title} cleared — pick it again, or another.`, null);
  });
  el.composer.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = el.prompt.value.trim();
    if (!text || state.busy) return;
    el.prompt.value = "";
    send(text);
  });

  document.querySelectorAll("[data-tip]").forEach((n) =>
    tip(n, n.dataset.tip, null, n.dataset.tipH ? { heading: n.dataset.tipH } : undefined));
  // two ceilings, two different remedies — the meter shows one and enforces both
  tip(el.meter, () =>
    `Filled 0→max, never a truncated axis; the number is the trim probe's, not a guess. ` +
    `**Budget** — ${fmt(currentWindow())} tokens, your pick above — fires a plain compact at ` +
    `${Math.round(CFG.compactAtRatio * 100)}%. **Real window** — ${state.model.label}'s ` +
    `${fmt(modelWindow())} — forces the sectioned fold past ${fmt(oversizeLimit())}: one ` +
    `compact call would overflow the summarizer too.`,
    "POST /1/unstable/context/trim\n{ messages }  →  stats.tokensBeforeEstimate",
    { heading: "Two ceilings" });
  tip(el.ledger,
    "Each band is one message; its height is that message's share of the probe's token total. A creased band is folded history.");
  // bound once, read live: the numbers change with the model selection
  tip(el.modelHint, () =>
    `The provider enforces it on the chat call and the summarizer alike — the budget beside ` +
    `it is a demo device, this number is not. Past ${fmt(oversizeLimit())} tokens the page ` +
    `folds in sections: one compact call would fail too.`,
    null, { heading: "The model's real window" });
}

init();

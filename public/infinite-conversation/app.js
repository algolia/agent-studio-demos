/* ───────────────────────────────────────────────────────────────
   Infinite conversation — Agent Studio context APIs demo

   The premise: you arrive in the middle of a thread that already has hundreds
   of turns and more tokens than the working budget can hold, and you can keep
   going forever by clicking suggested replies.

   Three endpoints, no build step:
     POST /1/unstable/context/trim        token count, deterministic, free
     POST /1/unstable/context/compact     LLM summary of older turns
     POST /1/agents/{id}/completions      streaming chat (ai-sdk-5 SSE)

   What this file does NOT contain is the compaction loop. That lives in
   shared/compactor.js, which owns none of the state below and calls back into
   it — the seam CONTRIBUTING describes. This page supplies the history, the
   thresholds and the drawing; the driver decides when and how much to fold.

   Messages are AI SDK v5 shaped: { role, parts: [{ type:"text", text }] }.
   ─────────────────────────────────────────────────────────────── */

"use strict";

const CFG = window.DEMO_CONFIG;
const M = window.DemoMeter;
const C = window.DemoCompactor;

/**
 * Knobs with defaults here rather than in config.js, so an older config keeps
 * working. Set any of them in config.js to override.
 */
const TUNE = {
  // Messages painted as bubbles when you arrive. The rest of the seeded thread
  // is in the live history and in the ledger, but printing four hundred bubbles
  // would be a wall rather than a conversation.
  visibleMessages: CFG.visibleMessages ?? 12,

  // Messages the fold never touches. Higher than chat-with-book's six on
  // purpose: the seeded turns here are long, and keeping only six would leave
  // the visitor reading less than the fold left behind.
  keepLast: CFG.icKeepLastMessages ?? 10,

  // One /context/compact call's share of the model's REAL window. The endpoint
  // forwards its whole payload to the summarizer, which has to fit the same
  // window — so a pass is sized against the provider's ceiling, not the demo's
  // working budget.
  maxPayloadRatio: CFG.maxPayloadRatio ?? 0.35,

  // How many turns "Keep going" rides for before handing control back.
  rideTurns: CFG.rideTurns ?? 5,

  // Only used before the first trim probe. After it, the real ratio comes from
  // the endpoint's own count.
  charsPerTokenFallback: CFG.charsPerTokenFallback ?? 4,
};

const state = {
  // the manifest entry and the loaded record for the thread being read
  saga: null,
  // v5 messages, the live history — the seeded thread plus everything since
  messages: [],
  weights: [],          // per-message token estimate, parallel to messages
  kinds: [],            // "user" | "assistant" | "summary"
  tokens: 0,
  folds: 0,
  reclaimed: 0,
  // what arrived with the thread, counted from the file and then from the probe
  arrival: null,
  // turns taken since you got here, which is not the same as turns in the thread
  turns: 0,
  model: null,
  budget: CFG && CFG.defaultBudget,
  busy: false,
  calls: 0,
  charsPerToken: null,
  cost: M.freshCost(),
  suggestions: [],
  suggestionSource: null,   // "shipped" | "stream" | "generated"
  ride: null,               // { left } while "Keep going" is running
  // message object → its bubble, so a fold can retire exactly the bubbles whose
  // messages left the history
  nodes: new Map(),
  foldRecord: null,         // the card at the top of the thread
};

const $ = (id) => document.getElementById(id);
const el = {
  sagas: $("sagas"), sagaStatus: $("saga-status"), provenance: $("provenance-body"),
  model: $("model"), modelHint: $("model-hint"),
  budget: $("budget"), budgetHint: $("budget-hint"),
  meter: $("meter"), fill: $("meter-fill"), threshold: $("meter-threshold"),
  read: $("meter-read"), meterState: $("meter-state"),
  axisMax: $("axis-max"), axisThreshold: $("axis-threshold"),
  compact: $("compact-btn"), compactHint: $("compact-hint"), reset: $("reset-btn"),
  ledger: $("ledger"),
  thread: $("thread"), composer: $("composer"), prompt: $("prompt"), send: $("send-btn"),
  chips: $("chips"), chipRow: $("chip-row"), chipsSource: $("chips-source"),
  chipsInfo: $("chips-info"),
  ride: $("ride-btn"), rideStop: $("ride-stop"), rideCount: $("ride-count"),
  turnline: $("turnline"),
  wireList: $("wire-list"), wireCount: $("wire-count"),
  heroBehind: $("hero-behind"), heroTokens: $("hero-tokens"), heroFolds: $("hero-folds"),
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

/* formatting comes from the kit, so the strip, the ledger and the wire log
   cannot disagree about a figure */
const { usd, fmt } = M;

/* ── Message helpers ──────────────────────────────────────────── */

const userMsg = (text) => ({ role: "user", parts: [{ type: "text", text }] });
const textOf = (m) => (m.parts || []).filter((p) => p.type === "text").map((p) => p.text).join("");

function charsPerToken() {
  return state.charsPerToken || TUNE.charsPerTokenFallback;
}
const estTokens = (chars) => Math.round(chars / charsPerToken());

/** cheap local split of a probed total across messages, by character share */
function distribute(total, messages) {
  const lens = messages.map((m) => Math.max(textOf(m).length, 1));
  const sum = lens.reduce((a, b) => a + b, 0);
  return lens.map((n) => (total * n) / sum);
}

/* ── API ──────────────────────────────────────────────────────── */

function headers() {
  return {
    "content-type": "application/json",
    "X-Algolia-Application-Id": CFG.appId,
    "X-Algolia-API-Key": CFG.apiKey,
  };
}

/**
 * Errors carry `status` and `detail` so a caller can turn them into a human
 * sentence. The raw payload goes to the wire log and nowhere else.
 */
async function api(path, body, { stream = false } = {}) {
  const res = await fetch(CFG.host + path, {
    method: "POST", headers: headers(), body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const j = await res.json();
      detail = j.message || j.detail || detail;
      if (typeof detail === "object") detail = JSON.stringify(detail);
    } catch (_) { /* keep statusText */ }
    logCall(path, null, `${res.status} ${detail}`);
    const err = new Error(`${res.status} — ${detail}`);
    err.status = res.status;
    err.detail = String(detail);
    throw err;
  }
  if (stream) return res;
  return res.json();
}

/** trim with no constraints is a pure token count */
async function probe(messages) {
  const out = await api("/1/unstable/context/trim", { messages });
  // deterministic, no model behind it, so it is free on both sides — annotated
  // rather than assumed
  logCall("/1/unstable/context/trim", out.stats, null, "count · no constraints", "POST", 0);
  return out;
}

async function compact(messages, opts) {
  const keep = (opts && opts.keepLastMessages) || 0;
  const out = await api("/1/unstable/context/compact", {
    providerID: state.model.providerId,
    model: state.model.model,
    messages,
    keepLastMessages: keep,
  });
  const summary = (out.messages || [])[0];
  // With keepLastMessages: 0 the response is the summary alone, so its own
  // length is what the summarizer wrote — a fairer output figure than
  // tokensAfterEstimate, which would also count anything kept verbatim.
  const wrote = estTokens(textOf(summary || {}).length);
  const spent = chargeSummarizer({ stats: out.stats, outTok: wrote });
  logCall("/1/unstable/context/compact", out.stats, null,
    `keepLastMessages: ${keep} · via ${state.model.model}`, "POST", spent);
  return out;
}

/* ── API reference links ──────────────────────────────────────────
   The service publishes its own OpenAPI schema behind a Swagger UI at
   {host}/docs, whose anchors are #/{tag}/{operationId} — so every path this
   page calls can point at the operation that documents it. ── */

const DOCS = {
  "/1/unstable/context/trim": { tag: "Context", op: "trimContext" },
  "/1/unstable/context/compact": { tag: "Context", op: "compactContext" },
  "/1/agents/{agent_id}/completions": {
    tag: "Completions",
    op: "create_completion_1_agents__agent_id__completions_post",
  },
};

function canonicalPath(path) {
  return String(path)
    .split("?")[0]
    .replace(/\/1\/agents\/[^/]+\/completions/, "/1/agents/{agent_id}/completions");
}

function docsUrl(path) {
  const d = DOCS[canonicalPath(path)];
  return d ? `${CFG.host}/docs#/${d.tag}/${d.op}` : null;
}

function docsLink(path, label = "docs ↗") {
  const url = docsUrl(path);
  if (!url) return null;
  const a = document.createElement("a");
  a.className = "doc-link";
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = label;
  tip(a, "Opens this endpoint's entry in the service's own OpenAPI reference — the schema the " +
    "API generates, not a copy of it.", url);
  return a;
}

/* ── Wire log (transparent by design) ─────────────────────────── */

function logCall(path, stats, error, note, verb = "POST", cost = null) {
  state.calls += 1;
  el.wireCount.textContent = `${state.calls} call${state.calls === 1 ? "" : "s"}`;
  const li = document.createElement("li");
  const bits = [`<span class="wire-path"><span class="verb">${escapeHtml(verb)}</span> ${escapeHtml(path)}</span>`];
  if (note) bits.push(`<span class="stat">${escapeHtml(note)}</span>`);
  if (stats) {
    bits.push(`<span class="stat">msgs ${stats.messagesBefore}→${stats.messagesAfter} · ` +
      `tokens ${fmt(stats.tokensBeforeEstimate)}→${fmt(stats.tokensAfterEstimate)}</span>`);
  }
  if (error) bits.push(`<span class="err">${escapeHtml(error)}</span>`);
  li.innerHTML = bits.join("<br>");
  const link = docsLink(path);
  if (link) li.querySelector(".wire-path").after(link);
  if (cost !== null && Number.isFinite(cost)) {
    const chip = document.createElement("span");
    chip.className = `wire-cost${cost === 0 ? " is-free" : ""}`;
    chip.textContent = cost === 0 ? "$0 · no LLM" : `~${usd(cost)}`;
    tip(chip, cost === 0
      ? "context/trim counts without calling a model, so it is free on both sides of the " +
        "meter — and it is why the meter can be honest without shipping a tokenizer."
      : () => `Charged to the real side at ${priceLine()} Estimated — the API does not ` +
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

/* ── The meter ────────────────────────────────────────────────────
   The cost model, the two modes and the strip's rendering are all in
   shared/meter.js. What lives here is which model is selected and which of
   this page's calls belong on which side of the ledger. ────────── */

function modelWindow() {
  return (state.model && state.model.contextWindow) || Infinity;
}

/** the working budget the meter fills against; null in config means the window */
function currentWindow() {
  return state.budget || modelWindow();
}

function currentPrice() {
  return M.priceOf(state.model && state.model.model);
}

function priceLine() {
  return M.priceLine(currentPrice());
}

function charge(side, inTok, outTok) {
  return M.charge(state.cost, side, inTok, outTok, currentPrice());
}

/** one real /completions call — a suggestion refresh is one too, and it is billed */
function chargeChat(inTok, outTok) {
  state.cost.chatCalls += 1;
  const value = charge("real", inTok, outTok);
  renderCost();
  return value;
}

/**
 * The counterfactual for one turn: one call carrying the whole unfolded
 * history, answering at the size the real answer answered at.
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
 * Every /context/compact call, whoever asked for it. The endpoint reports the
 * payload it counted but not the summarizer's own usage, so input is taken as
 * stats.tokensBeforeEstimate. Charging the summarizer to ourselves is the whole
 * point: a fold whose own bill is hidden saves money it never saved.
 */
function chargeSummarizer({ stats, outTok }) {
  const i = (stats && Number.isFinite(stats.tokensBeforeEstimate)) ? stats.tokensBeforeEstimate : 0;
  const o = Number.isFinite(outTok) ? outTok : 0;
  const c = state.cost;
  const value = charge("real", i, o);
  c.summUsd += value; c.summTokens += i + o; c.summCalls += 1;
  renderCost();
  return value;
}

const strip = M.createStrip(el);

/**
 * The model's REAL window, never the working budget: the mode switch is a
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

/** phone: the saving is the headline, its two operands are one tap away */
function initCostbar() {
  el.costToggle.addEventListener("click", () => {
    const open = el.costbar.dataset.open !== "1";
    el.costbar.dataset.open = open ? "1" : "0";
    el.costToggle.setAttribute("aria-expanded", String(open));
    el.costToggle.textContent = open ? "Hide" : "Breakdown";
  });

  // bound once, read live: each asks the kit for the wording that matches the
  // mode the meter is in at the moment it is opened
  tip(el.meterInfo, () => M.tileCopy.eyebrow, null, { heading: "Two prices" });
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

/* ── The token meter and the ledger ─────────────────────────────── */

function renderMeter() {
  const max = currentWindow();
  const pct = Math.min(100, (state.tokens / max) * 100);
  el.fill.style.width = `${pct}%`;
  el.fill.classList.toggle("is-over", state.tokens > max);
  const ratio = CFG.compactAtRatio;
  el.threshold.style.left = `${ratio * 100}%`;
  el.read.textContent = `${fmt(state.tokens)} / ${fmt(max)} tokens`;
  el.axisMax.textContent = fmt(max);
  el.axisThreshold.textContent = `${Math.round(ratio * 100)}% · ${fmt(max * ratio)}`;
  el.meter.setAttribute("aria-valuenow", String(Math.round(state.tokens)));
  el.meter.setAttribute("aria-valuemax", String(Math.round(max)));

  el.heroTokens.textContent = fmt(state.tokens);
  el.heroFolds.textContent = fmt(state.folds);
  renderMeterState();
  renderCompactHint();
}

function renderMeterState() {
  const max = currentWindow();
  let dot = "state-ok";
  let label = "Room to spare";
  if (!state.messages.length) label = "Nothing carried yet";
  else if (state.tokens > max) { dot = "state-over"; label = "Over the working budget"; }
  else if (state.tokens >= max * CFG.compactAtRatio) {
    dot = "state-warn";
    label = "At the threshold — the next answer folds it";
  }
  el.meterState.innerHTML = `<span class="dot ${dot}" aria-hidden="true"></span> ${escapeHtml(label)}`;
}

function renderCompactHint() {
  if (!state.saga) { el.compactHint.textContent = ""; return; }
  const plan = compactor.plan();
  if (!plan) {
    el.compactHint.textContent = "Nothing left to fold: what remains is the tail the fold keeps.";
    return;
  }
  const passes = Math.max(1, Math.ceil(state.tokens / Math.max(1, plan.tokens)));
  el.compactHint.textContent = state.folds === 0
    ? `${fmt(plan.cut)} of ${fmt(state.messages.length)} messages fit in one call — about ` +
      `${passes} pass${passes === 1 ? "" : "es"} to get under the threshold.`
    : `Auto-compaction is on. It fires by itself at ${fmt(currentWindow() * CFG.compactAtRatio)} ` +
      `tokens; this button only makes it happen sooner.`;
}

function renderLedger() {
  el.ledger.textContent = "";
  const total = state.weights.reduce((a, b) => a + b, 0) || 1;
  state.messages.forEach((m, i) => {
    const band = document.createElement("div");
    const kind = state.kinds[i] || m.role;
    band.className = `band band-${kind}`;
    band.style.flexGrow = String(Math.max(state.weights[i] / total, 0.0008));
    const head = textOf(m).replace(/\s+/g, " ").slice(0, 70);
    tip(band, `${kind} · ~${fmt(state.weights[i])} tokens\n\n${head}…`);
    el.ledger.appendChild(band);
  });
}

async function refreshContext() {
  if (!state.messages.length) {
    state.tokens = 0; state.weights = [];
    renderMeter(); renderLedger();
    return;
  }
  const out = await probe(state.messages);
  state.tokens = out.stats.tokensBeforeEstimate;
  state.weights = distribute(state.tokens, state.messages);
  // calibrate the local estimator against the endpoint's own count, so the
  // increments it never sees stop depending on the chars/4 folklore
  const chars = state.messages.reduce((n, m) => n + textOf(m).length, 0);
  if (state.tokens > 0 && chars > 0) state.charsPerToken = chars / state.tokens;
  renderMeter();
  renderLedger();
}

/* ── The compaction driver ────────────────────────────────────────
   Everything about WHEN and HOW MUCH to fold is in shared/compactor.js. What
   is wired here is only what the driver cannot know: where the history lives,
   what the thresholds are, and what to redraw afterwards. ─────── */

let narrator = null;   // the card listening to the fold that is running

const compactor = C.createCompactor({
  history: () => ({ messages: state.messages, weights: state.weights, tokens: state.tokens }),
  probe: async (messages) => ({ tokens: (await probe(messages)).stats.tokensBeforeEstimate }),
  compact: (messages, opts) => compact(messages, opts),
  budget: () => currentWindow(),
  ratio: () => CFG.compactAtRatio,
  keepLast: () => TUNE.keepLast,
  maxPayload: () => Math.round(modelWindow() * TUNE.maxPayloadRatio),
  onPass: (meta) => { if (narrator) narrator.pass(meta); },
  onCharge: () => { /* compact() already billed it, so the wire log and the strip agree */ },
  onHistory: (messages, stats, meta) => applyFold(messages, stats, meta),
});

/**
 * The driver has a new history; this is the page catching up to it. Bubbles
 * whose messages are no longer carried are retired, and the record at the top
 * of the thread becomes the summary that replaced them.
 */
function applyFold(messages, stats, meta) {
  state.messages = messages;
  state.kinds = messages.map((m, i) => (i === 0 ? "summary" : m.role));
  state.tokens = meta.tokensAfter;
  state.weights = distribute(state.tokens, state.messages);
  state.folds += 1;
  state.reclaimed += meta.reclaimed;

  const live = new Set(messages);
  state.nodes.forEach((node, msg) => {
    if (live.has(msg)) return;
    node.remove();
    state.nodes.delete(msg);
  });

  setFoldRecord(messages[0], meta);
  if (narrator) narrator.settle(meta);
  renderMeter();
  renderLedger();
  renderTurnline();
}

/* ── Tooltips (show the machinery) ────────────────────────────────
   One panel, reused. Two flavours: the short explanatory tip, which never
   takes the pointer, and the "rich" flavour used to read a whole generated
   summary — that one is scrollable, so it has to accept the pointer, which
   means the hide is delayed long enough to travel into the panel. ──── */

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
    const room = Math.max(above, below);
    el.tooltip.style.maxHeight = `${Math.round(room)}px`;
    h = el.tooltip.getBoundingClientRect().height;
    top = below >= above ? r.bottom + TIP_PAD : Math.max(TIP_PAD, r.top - h - TIP_PAD);
  }
  const box = el.tooltip.getBoundingClientRect();
  el.tooltip.style.top =
    `${Math.round(Math.max(TIP_PAD, Math.min(top, vh - box.height - TIP_PAD)))}px`;
  el.tooltip.style.left =
    `${Math.round(Math.max(TIP_PAD, Math.min(r.left, vw - box.width - TIP_PAD)))}px`;
}

function hideTip(opts) {
  if (opts && opts.rich) {
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

/* ── Bubbles and cards ──────────────────────────────────────────── */

const peekOf = (text) => {
  const s = String(text).replace(/\s+/g, " ").trim();
  return s.length > 76 ? `${s.slice(0, 74)}…` : s;
};

function clearEmpty() {
  const e = el.thread.querySelector(".empty");
  if (e) e.remove();
}

/** one message, painted. `msg` ties the node to the history entry it shows. */
function addBubble(role, text, msg, { seeded = false } = {}) {
  clearEmpty();
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}${seeded ? " is-seeded" : ""}`;
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = role === "user" ? "you" : "assistant";
  wrap.appendChild(who);
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  const md = document.createElement("div");
  md.className = "md";
  md.innerHTML = window.renderMarkdown ? window.renderMarkdown(text) : escapeHtml(text);
  bubble.appendChild(md);
  wrap.appendChild(bubble);
  el.thread.appendChild(wrap);
  if (msg) state.nodes.set(msg, wrap);
  return wrap;
}

/** the assistant bubble, with the Markdown renderer and the cursor wired */
function addAnswerBubble(msg) {
  clearEmpty();
  const wrap = document.createElement("div");
  wrap.className = "msg assistant";
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = "assistant";
  tip(who, "Answers arrive as Markdown. The page escapes the text first, then renders " +
    "structure on top — locally, in md.js. Model HTML is never inserted as HTML.");
  wrap.appendChild(who);
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
  if (msg) state.nodes.set(msg, wrap);

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
    wrap, md,
    attach(m) { state.nodes.set(m, wrap); },
    set(next) { text = next; if (frame === null) frame = requestAnimationFrame(paint); },
    end() { cursor.remove(); if (frame !== null) { cancelAnimationFrame(frame); frame = null; } paint(); },
    remove() { if (frame !== null) cancelAnimationFrame(frame); wrap.remove(); },
  };
}

/**
 * The card at the top of the thread: before the first fold it states what
 * arrived and that all of it is still being carried; afterwards it is the
 * summary that replaced it. One card, not a stack — each pass absorbs the
 * previous summary, so a stack would misrepresent the history.
 */
function setBacklogCard() {
  const a = state.arrival;
  const hidden = a.messageCount - TUNE.visibleMessages;
  const card = document.createElement("div");
  card.className = "msg event backlog";
  card.innerHTML =
    '<h3 class="event-h">↥ <span class="bk-title"></span></h3>' +
    '<p class="event-note bk-note"></p>';
  card.querySelector(".bk-title").textContent =
    `${fmt(hidden)} earlier messages, still carried in full`;
  card.querySelector(".bk-note").innerHTML =
    `${fmt(a.messageCount)} messages — ${fmt(a.exchanges)} exchanges — all still in the ` +
    `history sent to the model. You can read the last ${TUNE.visibleMessages}; the ledger ` +
    `holds the rest. <strong>${fmt(a.tokens)} tokens</strong>, counted by ` +
    `<code>context/trim</code>. That is ${a.tokens > currentWindow()
      ? `past the ${fmt(currentWindow())}-token budget — nothing can go out yet`
      : `already over the fold threshold`}.`;
  tip(card.querySelector(".event-h"),
    `The committed file quotes ${fmt(a.claimed)} tokens — a deliberate floor. The figure ` +
    `above is ${fmt(a.tokens)}: what context/trim answered for the exact array being ` +
    `carried. Where they differ, the measurement wins.`,
    "POST /1/unstable/context/trim\n{ messages }  →  stats.tokensBeforeEstimate",
    { heading: "Counted, not claimed" });
  el.thread.prepend(card);
  state.foldRecord = card;
}

/** the same slot, once a fold has happened: the summary that stands in for it */
function setFoldRecord(summary, meta) {
  const a = state.arrival;
  const text = textOf(summary);
  const card = document.createElement("div");
  card.className = "msg event record";
  card.innerHTML =
    '<h3 class="event-h">◤ <span class="rc-title"></span></h3>' +
    '<p class="event-note rc-note"></p>';
  card.querySelector(".rc-title").textContent =
    `the thread so far, folded ${state.folds} time${state.folds === 1 ? "" : "s"}`;
  card.querySelector(".rc-note").innerHTML =
    `Everything above the last ${TUNE.keepLast} messages is now this one summary — ` +
    `<strong>${fmt(estTokens(text.length))} tokens standing in for ${fmt(a.tokens)}</strong>. ` +
    `A real message in the history: every turn from here carries it, and nothing else of ` +
    `what came before.`;
  const peek = document.createElement("button");
  peek.type = "button";
  peek.className = "sum-peek";
  peek.textContent = peekOf(text);
  tip(peek, text, null,
    { rich: true, markdown: true, heading: `The summary · ${fmt(estTokens(text.length))} tokens` });
  card.appendChild(peek);
  tip(card.querySelector(".event-h"),
    `Written by ${state.model.label} through context/compact, on your own credentials. The ` +
    `originals simply are not carried any more — that is the entire saving. ` +
    `${meta ? `The last pass reclaimed ${fmt(meta.reclaimed)} tokens.` : ""}`,
    "POST /1/unstable/context/compact\n{ messages, keepLastMessages: 0 }");

  if (state.foldRecord) state.foldRecord.replaceWith(card);
  else el.thread.prepend(card);
  state.foldRecord = card;
}

/**
 * The fold, shown happening. One row per pass, because a fold that takes four
 * calls and reports one number is hiding three of them.
 */
function addFoldCard({ auto }) {
  clearEmpty();
  const card = document.createElement("div");
  card.className = `msg event fold${auto ? " is-auto" : ""}`;
  card.innerHTML =
    '<h3 class="event-h">◤ <span class="fd-title"></span></h3>' +
    '<p class="event-note fd-why"></p>' +
    '<ol class="fold-steps fd-steps"></ol>' +
    '<p class="fold-live fd-live" role="status" aria-live="polite"></p>';
  const plan = compactor.plan();
  const passes = plan ? Math.max(1, Math.ceil(state.tokens / Math.max(1, plan.tokens))) : 1;
  card.querySelector(".fd-title").textContent = auto
    ? "the budget filled, so it folded — nobody asked"
    : "folding the backlog";
  card.querySelector(".fd-why").innerHTML = auto
    ? `The last answer took the history past ${fmt(currentWindow() * CFG.compactAtRatio)} tokens, ` +
      `which is ${Math.round(CFG.compactAtRatio * 100)}% of the working budget. From here this ` +
      `happens on its own, every time, for as long as you keep going.`
    : `${fmt(state.tokens)} tokens is more than one <code>context/compact</code> call can ` +
      `carry — the payload must fit the summarizer's window too. So the oldest end goes ` +
      `first: ~${passes} pass${passes === 1 ? "" : "es"} of at most ` +
      `${fmt(Math.round(modelWindow() * TUNE.maxPayloadRatio))} tokens, each folding the ` +
      `previous summary in with the next stretch.`;
  tip(card.querySelector(".event-h"),
    "The fold decision lives in shared/compactor.js — a driver that owns none of this " +
    "page's history and calls back into it. Each row below is one API call.",
    "createCompactor({ probe, compact, budget, ratio, onHistory, onCharge })");

  const steps = card.querySelector(".fd-steps");
  const live = card.querySelector(".fd-live");
  el.thread.appendChild(card);
  el.thread.scrollTop = el.thread.scrollHeight;

  const t0 = performance.now();
  const ticker = setInterval(() => {
    live.textContent = `${((performance.now() - t0) / 1000).toFixed(1)}s elapsed`;
  }, 200);
  let row = null;

  return {
    pass(meta) {
      row = document.createElement("li");
      row.dataset.state = "working";
      row.innerHTML = '<span class="mark" aria-hidden="true"></span>' +
        `<span class="lbl">pass ${meta.pass} · folding ${fmt(meta.folding)} ` +
        `message${meta.folding === 1 ? "" : "s"} (~${fmt(meta.payloadTokens)} tok)</span>` +
        '<span class="val">…</span>';
      steps.appendChild(row);
      el.thread.scrollTop = el.thread.scrollHeight;
      if (meta.oversize) {
        const warn = document.createElement("span");
        warn.className = "wire-fix";
        warn.textContent = "single oversize message";
        tip(warn, "This one message is bigger than a pass should be. Sent anyway: refusing " +
          "it would leave the conversation stuck, and the endpoint is the authority on what " +
          "it accepts.");
        row.appendChild(warn);
      }
    },
    settle(meta) {
      if (!row) return;
      row.dataset.state = "done";
      row.querySelector(".val").textContent =
        `${fmt(meta.tokensBefore)} → ${fmt(meta.tokensAfter)} tok`;
      row = null;
    },
    done(run) {
      clearInterval(ticker);
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      const head = `${secs}s · ${run.passes} call${run.passes === 1 ? "" : "s"} · ` +
        `${fmt(run.reclaimed)} tokens reclaimed`;
      // A fold that stops still over the line is not a failure, and the copy
      // should not read like one: the protected tail can simply weigh more than
      // the threshold, which is what the automatic loop then works through as
      // those long arriving turns age out of it.
      live.textContent = run.stalled || run.stillOver
        ? `${head} · still ${fmt(state.tokens)} tokens: the protected last ${TUNE.keepLast} ` +
          `messages weigh that much on their own. Another pass would buy no room, so it ` +
          `stopped — auto-compaction keeps working it down as those long turns age out.`
        : `${head} · back under the threshold, with the last ${TUNE.keepLast} messages untouched.`;
    },
    failed(message) {
      clearInterval(ticker);
      if (row) { row.dataset.state = "failed"; row.querySelector(".val").textContent = message; }
      live.textContent = "the history is unchanged — nothing was folded.";
    },
  };
}

function addErrorCard(title, detail, reassurance) {
  clearEmpty();
  const card = document.createElement("div");
  card.className = "msg event is-error";
  card.innerHTML =
    '<h3 class="event-h">△ <span class="er-title"></span></h3>' +
    '<p class="event-note er-detail"></p>' +
    '<p class="event-note er-calm"></p>';
  card.querySelector(".er-title").textContent = title;
  card.querySelector(".er-detail").textContent = detail;
  if (reassurance) card.querySelector(".er-calm").textContent = reassurance;
  el.thread.appendChild(card);
  el.thread.scrollTop = el.thread.scrollHeight;
}

function humanize(e) {
  const status = e && e.status;
  const detail = (e && (e.detail || e.message)) || "no detail";
  if (status === 401 || status === 403) {
    return `The API refused the credentials in config.js (${status}). ${detail}`;
  }
  if (status === 429) return `The provider is rate-limiting this key. ${detail}`;
  if (status >= 500) return `The service answered ${status}. ${detail}`;
  return String(detail);
}

/* ── One streamed answer ──────────────────────────────────────────
   The stream is watched for `data-suggestions` as well as text. When the agent
   emits them the chips are the model's own and cost nothing extra; when it does
   not, they are generated by one more call and the label says so. Both paths
   ship, because which one you get is a property of the agent, not of this
   page. ────────────────────────────────────────────────────────── */

/** the payload of a data-suggestions frame, in any of the shapes it may take */
function readSuggestions(evt) {
  const raw = evt && (evt.data !== undefined ? evt.data : evt.suggestions);
  const list = Array.isArray(raw) ? raw
    : (raw && Array.isArray(raw.suggestions)) ? raw.suggestions
      : (raw && Array.isArray(raw.items)) ? raw.items
        : null;
  if (!list) return [];
  return list
    .map((s) => (typeof s === "string" ? s : (s && (s.text || s.label || s.title || s.suggestion))))
    .filter((s) => typeof s === "string" && s.trim())
    .map((s) => s.trim());
}

async function streamAnswer(messages, { note, into }) {
  const path = `/1/agents/${state.model.agentId}/completions?compatibilityMode=ai-sdk-5&stream=true`;
  const res = await api(path, { messages }, { stream: true });
  logCall(path.split("?")[0], null, null, note);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", answer = "";
  let suggestions = [];
  const streamErrors = [];

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
        answer += evt.delta;
        into.set(answer);
      } else if (evt.type === "data-suggestions") {
        const found = readSuggestions(evt);
        if (found.length) suggestions = found;
      } else if (evt.type === "error") {
        // an SSE error frame is still a raw provider string: hold it back for
        // the wire log and the error card, out of the bubble
        streamErrors.push(evt.errorText || evt.error || "unspecified stream error");
      }
    }
  }
  into.end();
  return { answer, chars: answer.length, suggestions, streamErrors };
}

/**
 * The fallback path. No agent configured for this demo emits data-suggestions
 * today, so this is what usually runs: one extra completion, charged to the
 * real side of the meter like every other call, carrying only the last answer
 * rather than the history — the chips are not worth a second full payload.
 */
async function generateSuggestions(answer) {
  // this text goes to the model, not the reader — the copy gate exempts it
  /* check-copy: off */
  const ask = userMsg(
    `Here is the last thing you said to me:\n\n"""\n${String(answer).slice(0, 1500)}\n"""\n\n` +
    `Write exactly three replies I might plausibly send next, in my voice, as the person you ` +
    `are talking to. One per line, each under 70 characters, each a real question or a real ` +
    `answer to what you just said. No numbering, no bullets, no quotation marks, no commentary ` +
    `— three lines and nothing else.`);
  /* check-copy: on */
  const path = `/1/agents/${state.model.agentId}/completions?compatibilityMode=ai-sdk-5&stream=true`;
  const res = await api(path, { messages: [ask] }, { stream: true });

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", text = "";
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
      if (evt.type === "text-delta" && evt.delta) text += evt.delta;
    }
  }
  const spent = chargeChat(estTokens(textOf(ask).length), estTokens(text.length));
  logCall(path.split("?")[0], null, null,
    "suggestions · one extra call · last answer only, not the history", "POST", spent);

  return text.split("\n")
    .map((s) => s.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").replace(/^["“']|["”']$/g, "").trim())
    .filter((s) => s.length > 2 && s.length < 160)
    .slice(0, 3);
}

/* ── The chips, and riding them forever ─────────────────────────── */

const SOURCE_LABEL = {
  shipped: "suggested replies · shipped with the thread",
  stream: "suggested replies · from the stream",
  generated: "suggested replies · generated, one extra call",
};

const SOURCE_TIP = {
  shipped: "These three came with the conversation file, so the very first click costs nothing " +
    "extra. From the next answer onwards they are the agent's own, or generated from it.",
  stream: "The agent emitted these itself, as data-suggestions frames inside the same SSE " +
    "stream that carried the answer. No extra call, no extra tokens — the chips are free when " +
    "the agent is configured to offer them.",
  generated: "No agent in this demo emits data-suggestions, so these cost one extra " +
    "completion — carrying only the last answer, charged to the real side like everything " +
    "else. Native frames are used whenever they arrive; the wire log says which happened.",
};

function renderChips() {
  el.chipRow.textContent = "";
  el.chipsSource.textContent = SOURCE_LABEL[state.suggestionSource] || "suggested replies";
  if (!state.suggestions.length) { el.chips.hidden = true; return; }
  el.chips.hidden = false;
  state.suggestions.forEach((text) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.textContent = text;
    b.disabled = state.busy;
    b.addEventListener("click", () => { if (!state.busy) send(text); });
    el.chipRow.appendChild(b);
  });
}

async function refreshSuggestions(out) {
  if (out && out.suggestions && out.suggestions.length) {
    state.suggestions = out.suggestions.slice(0, 3);
    state.suggestionSource = "stream";
    logCall("/1/agents/{id}/completions", null, null,
      `data-suggestions · ${state.suggestions.length} from the stream · no extra call`, "POST", 0);
    renderChips();
    return;
  }
  if (!out || !out.answer) return;
  try {
    const list = await generateSuggestions(out.answer);
    if (list.length) {
      state.suggestions = list;
      state.suggestionSource = "generated";
      renderChips();
    }
  } catch (e) {
    // chips are a convenience: losing them is not worth an error card, and the
    // composer is still there
    logCall("/1/agents/{id}/completions", null, e.detail || e.message,
      "suggestions could not be generated — type instead");
  }
}

function renderRide() {
  const riding = !!state.ride;
  el.ride.hidden = riding;
  el.rideStop.hidden = !riding;
  el.rideCount.textContent = riding
    ? `${state.ride.left} to go`
    : (state.turns ? `${state.turns} turn${state.turns === 1 ? "" : "s"} since you arrived` : "");
  el.ride.textContent = `Keep going ×${TUNE.rideTurns}`;
}

/**
 * The infinity, made concrete: take the first suggestion, send it, take the
 * next one, repeat. Nothing here is special-cased — it presses the same chip a
 * visitor would.
 */
async function ride(n) {
  if (state.ride || state.busy || !state.suggestions.length) return;
  state.ride = { left: n };
  renderRide();
  try {
    while (state.ride && state.ride.left > 0) {
      const next = state.suggestions[0];
      if (!next) break;
      state.ride.left -= 1;
      renderRide();
      await send(next);
      if (!state.ride) break;
    }
  } finally {
    state.ride = null;
    renderRide();
  }
}

/* ── The turn ───────────────────────────────────────────────────── */

function renderTurnline() {
  const a = state.arrival;
  if (!a) { el.turnline.textContent = ""; return; }
  const total = a.exchanges + state.turns;
  el.turnline.textContent =
    `${fmt(a.exchanges)} exchanges were here before you, and ${fmt(state.turns)} since — ` +
    `${fmt(total)} in this thread, carried in ${fmt(state.messages.length)} messages after ` +
    `${fmt(state.folds)} fold${state.folds === 1 ? "" : "s"}` +
    `${state.reclaimed ? ` that reclaimed ${fmt(state.reclaimed)} tokens` : ""}.`;
  el.heroBehind.textContent = fmt(a.exchanges);
  renderRide();
}

function busy(on) {
  state.busy = on;
  el.send.disabled = on;
  el.prompt.disabled = on;
  el.compact.disabled = on || !state.saga;
  el.reset.disabled = on;
  el.ride.disabled = on && !state.ride;
  el.sagas.querySelectorAll("button").forEach((b) => { b.disabled = on; });
  el.chipRow.querySelectorAll(".chip").forEach((b) => { b.disabled = on; });
}

function recordAnswer(text, into) {
  const msg = { role: "assistant", parts: [{ type: "text", text }] };
  state.messages.push(msg);
  state.kinds.push("assistant");
  if (into) into.attach(msg);
  return msg;
}

async function send(text) {
  if (state.busy || !state.saga) return;
  busy(true);

  const msg = userMsg(text);
  state.messages.push(msg);
  state.kinds.push("user");
  addBubble("user", text, msg);
  el.thread.scrollTop = el.thread.scrollHeight;

  // the naive history grows by the question whether or not anything folded
  const naiveQuestion = estTokens(text.length);
  state.cost.naiveHistory += naiveQuestion;
  const naiveIn = state.cost.naiveHistory;

  const into = addAnswerBubble();
  const rollback = () => {
    into.remove();
    const node = state.nodes.get(msg);
    if (node) { node.remove(); state.nodes.delete(msg); }
    state.messages.pop();
    state.kinds.pop();
    // the question never landed, so the counterfactual never carried it either.
    // Anything already charged to the real side stays — that money was spent.
    state.cost.naiveHistory -= naiveQuestion;
    renderCost();
    if (!el.prompt.value) el.prompt.value = text;
  };

  let out;
  try {
    const realIn = Math.round(state.tokens + naiveQuestion);
    out = await streamAnswer(state.messages, {
      note: `stream=true · ${state.model.model} · ${fmt(state.messages.length)} messages`,
      into,
    });
    chargeChat(realIn, estTokens(out.chars));

    if (out.streamErrors.length) {
      const detail = out.streamErrors.join(" · ");
      logCall("/1/agents/{id}/completions", null, detail, "stream error frame");
      if (!out.answer) {
        rollback();
        addErrorCard("The model stopped before answering", humanize({ detail }),
          "Your message is back in the box — nothing was left half-recorded in the history.");
        busy(false);
        return;
      }
      addErrorCard("The answer was cut short", humanize({ detail }),
        "What did arrive is kept above and stays in the conversation.");
    }
    if (!out.answer) into.md.textContent = "(empty response)";
    recordAnswer(out.answer, into);

    // One turn, one naive call: the same question against the whole unfolded
    // history, answering at the size the real answer answered at.
    const naiveAnswer = estTokens(out.chars);
    chargeNaiveTurn(naiveIn, naiveAnswer);
    state.cost.naiveHistory += naiveAnswer;
    state.turns += 1;
  } catch (e) {
    rollback();
    addErrorCard("The model did not answer", humanize(e),
      "Your message is back in the box — nothing was left half-recorded in the history.");
    busy(false);
    return;
  }

  // stay busy through the post-turn count and any fold: re-enabling the
  // composer early lets a second message race the history swap
  try {
    await refreshContext();
    renderTurnline();
    await autoFold();
    await refreshSuggestions(out);
  } catch (e) {
    addErrorCard("Could not finish the turn", humanize(e),
      "The answer above is in the history; the count beside it may be a turn stale.");
  } finally {
    busy(false);
    renderChips();
  }
}

/** the loop, firing on its own. Nobody presses anything for this one. */
async function autoFold() {
  if (!compactor.needed()) return;
  const card = addFoldCard({ auto: true });
  narrator = card;
  try {
    const run = await compactor.afterTurn();
    card.done(run);
  } catch (e) {
    card.failed(`failed — ${e.status || "network"}`);
    addErrorCard("Auto-compaction failed", humanize(e),
      "The history is unchanged, so the next turn will try again.");
  } finally {
    narrator = null;
  }
}

/**
 * The opening act, and the one fold in this demo that waits to be asked for.
 * Everything after it happens by itself — which is the whole sequence the demo
 * is trying to show: first see it, then stop having to.
 */
async function foldBacklog() {
  if (state.busy || !state.saga) return;
  busy(true);
  const card = addFoldCard({ auto: false });
  narrator = card;
  try {
    const run = await compactor.now();
    card.done(run);
    el.compact.textContent = "Compact now";
    if (!state.suggestions.length) renderChips();
  } catch (e) {
    card.failed(`failed — ${e.status || "network"}`);
    addErrorCard("Could not fold the backlog", humanize(e),
      "Nothing was changed. The whole thread is still in the history, exactly as it arrived.");
  } finally {
    narrator = null;
    busy(false);
  }
}

/* ── Picking up a thread ────────────────────────────────────────── */

let manifest = null;

/**
 * Threads this page has actually counted, slug → the trim endpoint's number.
 * The figure in the manifest is a deliberate floor; once a thread has been
 * loaded the page knows better, and a card that kept quoting the floor after
 * that would be underselling its own data.
 */
const measured = {};

function sagaCard(entry) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "saga";
  b.dataset.slug = entry.slug;
  const known = measured[entry.slug];
  const tokens = known || entry.tokens;
  const oversize = tokens > modelWindow();
  b.innerHTML =
    '<span class="saga-title"></span>' +
    '<span class="saga-register"></span>' +
    '<span class="saga-blurb"></span>' +
    '<span class="saga-meta"></span>';
  b.querySelector(".saga-title").textContent = entry.title;
  b.querySelector(".saga-register").textContent = entry.register;
  b.querySelector(".saga-blurb").textContent = entry.blurb;
  b.querySelector(".saga-meta").innerHTML =
    `<span>${fmt(entry.exchanges)} exchanges</span>` +
    `<span>${fmt(entry.messageCount)} messages</span>` +
    `<span>${known ? "" : "≥"}${fmt(tokens)} tok${known ? " counted" : ""}</span>` +
    (oversize ? '<span class="saga-flag">past the window</span>' : "");
  tip(b, () =>
    `Every figure is counted from the committed file. ` +
    (known
      ? `Tokens: ${fmt(known)}, measured by context/trim on this exact thread — the file ` +
        `itself claims only ${fmt(entry.tokens)}, deliberately low.`
      : `Tokens: a floor, not a measurement — text like this usually tokenizes higher. ` +
        `context/trim measures it the moment you load the thread.`) +
    (oversize
      ? ` Past ${state.model.label}'s ${fmt(modelWindow())}-token window: a naive run would ` +
        `be refused, not billed.`
      : ""), null, { heading: "Counted, not claimed" });
  b.addEventListener("click", () => { if (!state.busy) loadSaga(entry.slug); });
  return b;
}

function renderSagas() {
  el.sagas.textContent = "";
  if (!manifest) return;
  manifest.scenarios.forEach((entry) => {
    const card = sagaCard(entry);
    if (state.saga && state.saga.slug === entry.slug) card.classList.add("is-on");
    el.sagas.appendChild(card);
  });
}

function renderProvenance() {
  if (!manifest) return;
  const methods = [...new Set(manifest.scenarios.map((s) => s.method).filter(Boolean))];
  el.provenance.innerHTML =
    `<p>Not transcripts of anything real, and not padding either. Each was built by ` +
    `<code>tools/generate-conversations.js</code>, in the repository: an authored arc, cut ` +
    `into chapters, with the prose written from it.</p>` +
    `<p class="prov-method">${escapeHtml(methods.join(" · ") || "see the scenario files")}</p>` +
    `<p>The generator prefers self-play against this same API — two personas talking for a ` +
    `few hundred turns. These files came from its offline path instead (the demo credential ` +
    `had expired), and each file records which path produced it. Every figure on a card is ` +
    `counted from the file, not claimed.</p>`;
}

async function loadSaga(slug) {
  const entry = manifest.scenarios.find((s) => s.slug === slug);
  if (!entry) return;
  busy(true);
  resetThread();
  el.sagaStatus.textContent = `Loading ${entry.title}…`;
  try {
    const res = await fetch(`../assets/convs/${entry.file}`);
    if (!res.ok) throw new Error(`${res.status} loading ${entry.file}`);
    const record = await res.json();
    logCall(`/assets/convs/${entry.file}`, null, null,
      `${fmt(record.messageCount)} messages · ${fmt(record.chars)} chars · from this origin`,
      "GET", 0);

    state.saga = entry;
    // the whole thread is the live history: that is what makes it oversized,
    // and pretending otherwise would be the one dishonest thing this page could do
    state.messages = record.messages.map((m) => ({ role: m.role, parts: m.parts }));
    state.kinds = state.messages.map((m) => m.role);
    state.suggestions = (record.starters || []).slice(0, 3);
    state.suggestionSource = "shipped";
    state.arrival = {
      messageCount: record.messageCount,
      exchanges: record.exchanges,
      chars: record.chars,
      tokens: record.tokens,          // replaced by the probe's own count below
      claimed: record.tokens,
      opener: record.opener,
      method: record.generated && record.generated.method,
    };

    // the last N messages as bubbles, oldest first
    const visible = state.messages.slice(-TUNE.visibleMessages);
    visible.forEach((m) => addBubble(m.role, textOf(m), m, { seeded: true }));

    // the honest count, from the endpoint that counts
    await refreshContext();
    state.arrival.tokens = state.tokens;
    measured[entry.slug] = state.tokens;

    // The naive side's baseline, captured here because here is the only moment
    // it exists: the thread at full size, before any fold touches it. The peak
    // is set now rather than after the first turn, so the strip can say what it
    // knows — this much history would be refused, not merely billed.
    state.cost.naiveHistory = state.tokens;
    state.cost.naivePeak = Math.max(state.cost.naivePeak, state.tokens);
    renderCost();

    setBacklogCard();
    renderSagas();
    renderTurnline();
    renderChips();
    el.compact.textContent = "Fold the backlog";
    el.sagaStatus.innerHTML =
      `${escapeHtml(record.opener)} <strong>${fmt(state.tokens)} tokens</strong> counted, ` +
      `against a ${fmt(currentWindow())}-token working budget.`;
    el.thread.scrollTop = el.thread.scrollHeight;
  } catch (e) {
    el.sagaStatus.textContent = "";
    addErrorCard("Could not open that thread", humanize(e));
  } finally {
    busy(false);
  }
}

function resetThread() {
  state.messages = []; state.weights = []; state.kinds = [];
  state.tokens = 0; state.folds = 0; state.reclaimed = 0; state.turns = 0;
  state.arrival = null; state.saga = null;
  state.suggestions = []; state.suggestionSource = null;
  state.nodes = new Map();
  state.foldRecord = null;
  state.cost = M.freshCost();
  strip.reset();
  renderCost();
  el.thread.textContent = "";
  const empty = document.createElement("div");
  empty.className = "empty";
  empty.innerHTML = "<p><strong>Nothing loaded yet.</strong></p>" +
    "<p>Pick one of the threads on the left and you will arrive in the middle of it.</p>";
  el.thread.appendChild(empty);
  el.chips.hidden = true;
  el.compact.textContent = "Compact now";
  el.sagaStatus.textContent = "";
  el.heroBehind.textContent = "0";
  // nothing is loaded, so nothing can be folded: re-run the enable/disable pass
  // rather than leaving a primary button that looks live and does nothing
  busy(false);
  renderMeter();
  renderLedger();
  renderTurnline();
}

/* ── Model and budget ───────────────────────────────────────────── */

function initModels() {
  CFG.models.forEach((m, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = m.badge ? `${m.label} — ${m.badge}` : m.label;
    el.model.appendChild(opt);
  });
  state.model = CFG.models[0];
  el.model.addEventListener("change", () => {
    state.model = CFG.models[Number(el.model.value)];
    setModelHint();
    renderCost();
    renderMeter();
    renderSagas();
  });
  setModelHint();
}

function setModelHint() {
  const m = state.model;
  el.modelHint.textContent =
    `${m.note ? `${m.note} · ` : ""}${fmt(m.contextWindow)}-token window`;
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
  });
  setBudgetHint();
}

function setBudgetHint() {
  el.budgetHint.textContent = state.budget
    ? `Auto-compaction fires at ${fmt(state.budget * CFG.compactAtRatio)} tokens`
    : "Full model window — a turn-by-turn demo will not reach it";
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
  el.themeGlyph.textContent = dark ? "◑" : "◐";
  el.themeLabel.textContent = dark ? "Light" : "Dark";
  el.themeToggle.setAttribute("aria-pressed", String(dark));
  el.themeToggle.setAttribute("aria-label",
    dark ? "Switch to the light theme" : "Switch to the dark theme");
}

function initTheme() {
  applyTheme(currentTheme());
  el.themeToggle.addEventListener("click", () => {
    applyTheme(currentTheme() === "dark" ? "light" : "dark");
    // the panel is still open under the pointer and its text was written before
    // the flip, so leaving it up would show the theme that is no longer on
    closeTip();
  });
  tip(el.themeToggle, () =>
    `Currently ${currentTheme()}. Overrides your system preference; remembered in this ` +
    `browser only. One set of light-dark() properties drives both themes.`);
}

/* ── Boot ───────────────────────────────────────────────────────── */

async function init() {
  if (!CFG || !CFG.appId || CFG.appId === "YOUR_APP_ID") {
    document.body.innerHTML =
      '<p style="font-family:system-ui;padding:40px;max-width:60ch">' +
      "Copy <code>shared/config.example.js</code> to <code>shared/config.js</code> and fill in " +
      "your app id, API key, and agent ids before loading this page.</p>";
    return;
  }
  initTheme();
  initModels();
  initBudgets();
  initCostbar();
  renderMeter();
  renderTurnline();

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

  // The markup already carries the canonical repo URL, so the links work with
  // no config at all; a config may still redirect them at a fork.
  if (CFG.repoUrl) {
    $("repo-cta").href = CFG.repoUrl;
    $("repo-link").href = CFG.repoUrl;
  }

  el.compact.addEventListener("click", () => foldBacklog());
  el.reset.addEventListener("click", () => { resetThread(); renderSagas(); });
  el.ride.addEventListener("click", () => ride(TUNE.rideTurns));
  el.rideStop.addEventListener("click", () => { state.ride = null; renderRide(); });
  el.composer.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = el.prompt.value.trim();
    if (!text || state.busy) return;
    el.prompt.value = "";
    send(text);
  });

  document.querySelectorAll("[data-tip]").forEach((n) =>
    tip(n, n.dataset.tip, null, n.dataset.tipH ? { heading: n.dataset.tipH } : undefined));
  tip(el.chipsInfo, () => SOURCE_TIP[state.suggestionSource] || SOURCE_TIP.generated);
  tip(el.meter, () =>
    `Filled 0→max, never a truncated axis; the number is context/trim's, not a guess. ` +
    `**Budget** — ${fmt(currentWindow())} tokens, a demo device — is what auto-compaction ` +
    `watches (fires at ${Math.round(CFG.compactAtRatio * 100)}%). **Real window** — ` +
    `${state.model.label}'s ${fmt(modelWindow())} — is what the provider enforces, and ` +
    `decides expensive versus impossible.`,
    "POST /1/unstable/context/trim\n{ messages }  →  stats.tokensBeforeEstimate",
    { heading: "Two ceilings" });
  tip(el.ledger, () =>
    `One band per message in the live history — ${fmt(state.messages.length)} of them right now. ` +
    `Height is that message's share of the probe's token total. The creased band at the top is ` +
    `the fold: one summary standing in for everything it replaced.`);
  tip(el.modelHint, () =>
    `The provider enforces it on the chat call and the summarizer alike. A fold pass is ` +
    `sized at ${Math.round(TUNE.maxPayloadRatio * 100)}% of it — ` +
    `${fmt(Math.round(modelWindow() * TUNE.maxPayloadRatio))} tokens — because the payload ` +
    `must fit the summarizer too.`,
    null, { heading: "The model's real window" });

  // the manifest, then the thread: every figure on a card comes from it
  try {
    const res = await fetch("../assets/convs/index.json");
    if (!res.ok) throw new Error(`${res.status} loading the conversation manifest`);
    manifest = await res.json();
    renderSagas();
    renderProvenance();
    const first = manifest.scenarios[0];
    if (first) await loadSaga(first.slug);
  } catch (e) {
    el.sagaStatus.textContent = "";
    addErrorCard("Could not load the conversation manifest", humanize(e),
      "The seeded threads live in public/assets/convs/ — serve the site over http rather than " +
      "opening the file directly.");
  }
}

init();

/* ───────────────────────────────────────────────────────────────
   tune.js: "Tune it", two prefetch agents on one two-turn conversation.

   Each lane picks a window and a hit count; each pick is its own agent,
   named in the config block's tune map (tune.mjs). Before a run, the lane
   shows the query prefetch will search, built as the backend builds it.
   After, it shows what the stream says: the query searched, the decision,
   the hits with their covers, how many fit the conversation, the tokens
   read, and the answer. Every number is read off the lane's own stream.
   ─────────────────────────────────────────────────────────────── */

import { demoHost, completionQuery } from "../main-demo/configs.mjs";
import { createSseParser, createTurn, decisionLabel, ms } from "../main-demo/stream.mjs";

import { fieldsFrom, imageCandidates, pick, bylineText } from "../main-demo/fields.mjs";
import { pageConfig } from "./compare.mjs";
import { demoOf } from "./demos.mjs";
import { HITS, PAIRS, TUNE_DEFAULTS, WINDOWS, messagesFor, onTopic, pairOf, tuneAgent, windowQuery } from "./tune.mjs";

/* the prefetch budget of the six Act 3 agents (their `timeoutMs`) */
const TUNE_BUDGET_MS = 1000;

const DEMO = demoOf(document.documentElement.dataset.demo);
const { block } = pageConfig(window.DEMO_CONFIG, DEMO.blocks);
const HOST = demoHost(block);
const FIELDS = fieldsFrom({ fields: DEMO.fields });

const $ = (id) => document.getElementById(id);
const el = { form: $("tune-form"), pairs: $("tune-pairs"), t1: $("turn-1"), t2: $("turn-2"), run: $("tune-run"), check: $("tune-check") };
const LANES = [
  { key: "a", label: "Prefetch A", node: $("tune-a") },
  { key: "b", label: "Prefetch B", node: $("tune-b") },
];
const state = {
  running: false,
  lanes: { a: { combo: { ...TUNE_DEFAULTS.a }, turns: [], full: false }, b: { combo: { ...TUNE_DEFAULTS.b }, turns: [], full: false } },
};
const ready = Boolean(block && block.appId && block.agentStudioApiKey);

function cell(tag, text, cls) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.append(text);
  return n;
}

const tokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
const turnsNow = () => [el.t1.value, el.t2.value].map((s) => s.replace(/\s+/g, " ").trim());

/* ── One lane ──────────────────────────────────────────────────── */

/** a segmented control: one button per value, the picked one pressed */
function knob(name, values, picked, onPick, enabled) {
  const box = cell("div", undefined, "pf-knob");
  box.setAttribute("role", "group");
  box.setAttribute("aria-label", name);
  box.append(cell("span", name, "pf-knob-h"));
  for (const v of values) {
    const b = cell("button", String(v), "pf-knob-b");
    b.type = "button";
    b.setAttribute("aria-pressed", String(v === picked));
    b.disabled = state.running || !enabled(v);
    b.addEventListener("click", () => onPick(v));
    box.append(b);
  }
  return box;
}

/** the query as two parts: what earlier turns add, then the latest turn */
function queryLine(query, turns, window) {
  const p = cell("p", undefined, "pf-q");
  const last = windowQuery(turns.slice(-1), 1);
  const ctx = window > 1 ? windowQuery(turns.slice(0, -1), window - 1) : "";
  if (query && ctx && query === `${ctx} ${last}`) {
    p.append(cell("mark", ctx, "is-ctx"), " ", cell("span", last));
  } else {
    p.append(cell("span", query || last || "…"));
  }
  return p;
}

function cover(hit, fit) {
  const fig = cell("figure", undefined, "pf-cover" + (fit === false ? " is-off" : ""));
  const src = imageCandidates(hit, FIELDS.image)[0];
  const title = String(pick(hit, FIELDS.title) || "");
  const by = bylineText(hit, FIELDS.byline);
  // a record with no cover, or one that fails to load, keeps its square
  const slot = () => cell("span", undefined, "pf-cover-slot");
  if (src) {
    const img = cell("img");
    img.src = String(src);
    img.alt = "";
    img.loading = "lazy";
    img.addEventListener("error", () => img.replaceWith(slot()), { once: true });
    fig.append(img);
  } else {
    fig.append(slot());
  }
  fig.title = by ? `${title}, ${by}` : title;
  fig.append(cell("figcaption", title));
  return fig;
}

/** one hit fits the conversation when it passes the pair's topic tests */
const fits = (hit, topic) => (topic ? onTopic([hit], topic) === 1 : null);

function turnCard(lane, i, turns) {
  const t = lane.turns[i];
  const v = t && t.view;
  const card = cell("div", undefined, "pf-tcard" + (i === turns.length - 1 ? " is-last" : " is-first"));
  const part = v && v.prefetchPart;
  // the stream's own query when it came; until then, the one the backend will build
  const query = (v && v.prefetchQuery) || windowQuery(turns.slice(0, i + 1), lane.combo.window);
  const head = cell("p", undefined, "pf-tcard-h");
  head.append(cell("b", `Turn ${i + 1}`), " ", cell("span", v && v.prefetchQuery ? "prefetch searched" : "prefetch searches"));
  card.append(head, queryLine(query, turns.slice(0, i + 1), lane.combo.window));
  if (!v) {
    if (i === turns.length - 1) {
      const row = cell("div", undefined, "pf-covers is-empty");
      for (let k = 0; k < lane.combo.hits; k++) row.append(cell("span", undefined, "pf-cover-slot"));
      card.append(row);
    }
    return card;
  }
  if (part) {
    const bits = [decisionLabel(part.decision, part.latencyMs, TUNE_BUDGET_MS), Number.isFinite(part.nbHits) && part.toolCallId ? `${v.prefetchHits.length}\u00a0hits` : null,
      Number.isFinite(part.latencyMs) ? ms(part.latencyMs) : null].filter(Boolean);
    card.append(cell("p", bits.join(" · "), "pf-dec" + (part.toolCallId ? " is-in" : " is-skip")));
  } else if (v.status === "done") {
    card.append(cell("p", "no prefetch part streamed", "pf-dec is-skip"));
  }
  const pair = pairOf(turns.slice(0, 2));
  const topic = pair && i === 1 ? pair.topic : null;
  if (v.prefetchHits.length) {
    const row = cell("div", undefined, "pf-covers");
    for (const h of v.prefetchHits) row.append(cover(h, topic ? fits(h, topic) : null));
    card.append(row);
    if (topic) {
      const n = onTopic(v.prefetchHits, topic);
      const p = cell("p", undefined, "pf-fit");
      p.append(cell("b", String(n)), ` of ${v.prefetchHits.length} fit both turns`);
      card.append(p);
    }
  }
  if (i === turns.length - 1) {
    const nums = cell("dl", undefined, "pf-nums");
    const add = (label, value) => {
      const d = cell("div");
      d.append(cell("dt", label), cell("dd", value));
      nums.append(d);
    };
    const settled = v.status === "done" || v.status === "error";
    add("Tokens read", v.usage && Number.isFinite(v.usage.inputTokens) ? tokens(v.usage.inputTokens) : settled ? "–" : "…");
    add("First words", Number.isFinite(v.ttft) ? ms(v.ttft) : settled ? "–" : "…");
    add("Full answer", v.status === "done" ? ms(v.total) : settled ? "no answer" : "…");
    card.append(nums);
    if (v.answer) {
      const ans = cell("div", undefined, "pf-answer" + (lane.full ? " is-full" : ""));
      ans.innerHTML = typeof window.renderMarkdown === "function" ? window.renderMarkdown(v.answer) : "";
      if (!ans.innerHTML) ans.textContent = v.answer;
      card.append(ans);
      if (!lane.full && settled) {
        const more = cell("button", "Show the whole answer", "pf-more-t");
        more.type = "button";
        more.addEventListener("click", () => { lane.full = true; render(); });
        card.append(more);
      }
    }
    if (v.errors && v.errors.length) card.append(cell("p", `No answer: ${String(v.errors[0]).slice(0, 80)}`, "pf-err"));
  }
  return card;
}

function renderLane(l) {
  const lane = state.lanes[l.key];
  const has = (combo) => Boolean(tuneAgent(block, combo));
  const head = cell("header", undefined, "pf-tlane-h");
  head.append(cell("p", l.label, "pf-tlane-name"));
  const knobs = cell("div", undefined, "pf-knobs");
  knobs.append(
    knob("Window", WINDOWS, lane.combo.window, (w) => pickCombo(l.key, { ...lane.combo, window: w }), (w) => has({ ...lane.combo, window: w })),
    knob("Hits", HITS, lane.combo.hits, (h) => pickCombo(l.key, { ...lane.combo, hits: h }), (h) => has({ ...lane.combo, hits: h })),
  );
  head.append(knobs);
  const turns = turnsNow();
  const shown = lane.turns.length ? lane.turns.map((t) => t.text) : turns;
  const body = cell("div", undefined, "pf-tlane-body");
  if (shown.every(Boolean)) shown.forEach((_, i) => body.append(turnCard(lane, i, shown)));
  else body.append(cell("p", "Pick a conversation above.", "pf-tlane-empty"));
  l.node.replaceChildren(head, body);
}

let frame = 0;
function render() {
  frame = 0;
  for (const l of LANES) renderLane(l);
  el.run.disabled = state.running || !ready || !turnsNow().every(Boolean);
  el.run.textContent = state.running ? "Running…" : "Run";
  for (const b of el.pairs.querySelectorAll("button")) b.disabled = state.running;
}
const redraw = () => { if (!frame) frame = requestAnimationFrame(render); };

function pickCombo(key, combo) {
  if (state.running || !tuneAgent(block, combo)) return;
  state.lanes[key].combo = combo;
  state.lanes[key].turns = [];
  state.lanes[key].full = false;
  render();
}

/* ── Running: turn 1, then turn 2 with turn 1's answer ─────────── */

async function stream(agentId, turns, answers, onView) {
  const q = new URLSearchParams({ ...completionQuery(), ...(block.query || {}) }).toString();
  const t0 = performance.now();
  const now = () => performance.now() - t0;
  const tr = createTurn({ text: turns[turns.length - 1] });
  onView(tr.view());
  try {
    const res = await fetch(`${HOST}/1/agents/${agentId}/completions?${q}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-algolia-application-id": block.appId, "x-algolia-api-key": block.agentStudioApiKey },
      body: JSON.stringify({ messages: messagesFor(turns, answers) }),
    });
    tr.headers(now(), { status: res.status, get: (h) => res.headers.get(h) });
    if (!res.ok || !res.body) {
      tr.finish(now(), { error: `HTTP ${res.status}` });
    } else {
      const parser = createSseParser((evt) => { if (evt.type !== "[DONE]") { tr.observe(now(), evt); onView(tr.view()); } });
      const reader = res.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        parser.push(value);
      }
      parser.end();
      tr.finish(now());
    }
  } catch (e) {
    tr.finish(now(), { error: e.message || "network error" });
  }
  const v = tr.view();
  onView(v);
  return v;
}

async function runLane(key, turns) {
  const lane = state.lanes[key];
  const agent = tuneAgent(block, lane.combo);
  lane.turns = turns.map((text) => ({ text, view: null }));
  lane.full = false;
  const answers = [];
  for (let i = 0; i < turns.length; i++) {
    const v = await stream(agent.agentId, turns.slice(0, i + 1), answers, (view) => { lane.turns[i].view = view; redraw(); });
    if (v.status !== "done") break;
    answers.push(v.answer);
  }
}

async function run() {
  const turns = turnsNow();
  if (state.running || !ready || !turns.every(Boolean)) return;
  state.running = true;
  el.check.textContent = "";
  render();
  await Promise.all(LANES.map((l) => runLane(l.key, turns)));
  state.running = false;
  render();
}

function main() {
  if (!el.form) return;
  el.pairs.replaceChildren(...PAIRS.map((p) => {
    const b = cell("button", undefined, "chip pf-pair");
    b.type = "button";
    b.append(cell("span", p.turns[0]), cell("i", " then ", "pf-then"), cell("span", p.turns[1]));
    b.addEventListener("click", () => {
      el.t1.value = p.turns[0];
      el.t2.value = p.turns[1];
      for (const l of LANES) state.lanes[l.key].turns = [];
      render();
    });
    return b;
  }));
  el.t1.value = PAIRS[0].turns[0];
  el.t2.value = PAIRS[0].turns[1];
  for (const input of [el.t1, el.t2]) {
    input.addEventListener("input", () => {
      for (const l of LANES) state.lanes[l.key].turns = [];
      redraw();
    });
  }
  el.form.addEventListener("submit", (e) => { e.preventDefault(); run(); });
  if (!ready) {
    el.check.textContent = "Live unavailable: this build has no agents for this part.";
    el.check.dataset.phase = "unavailable";
  }
  render();
}

main();

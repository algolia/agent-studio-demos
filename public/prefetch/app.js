/* ───────────────────────────────────────────────────────────────
   app.js: search prefetch, before and after, on one question.

   Two main-demo lanes, locked to the race's two arms, and the numbers
   their stream readers measure. Live only, on the agents named in the
   prefetchDemo config block, or main-demo's mainDemo. Run stays off until both
   agents pass a one-message preflight, and nothing runs until Run is
   pressed: every run makes real model calls.
   ─────────────────────────────────────────────────────────────── */

import { liteClient } from "algoliasearch/lite";
import { mountLane } from "../main-demo/lane.js";
import { configKey, demoHost } from "../main-demo/configs.mjs";
import { LANES, STARTERS, liveReadiness, pageConfig, questionOf, rows } from "./compare.mjs";
import { afterRun, cacheKey, laneFailure, preflightState, probeAgent } from "./preflight.mjs";

// prefetchDemo when the deploy gives this page its own agent pair, else mainDemo
const { block: mainDemo, name: blockName } = pageConfig(window.DEMO_CONFIG);
const CFG = { indexName: "products", ...(mainDemo || {}) };
CFG.host = demoHost(mainDemo);

const $ = (id) => document.getElementById(id);
const el = {
  run: $("run"), check: $("check"), lanes: $("lanes"),
  form: $("ask-form"), ask: $("ask"), chips: $("chips"), score: $("score"),
  lane: { a: $("lane-a"), b: $("lane-b") }, err: { a: $("err-a"), b: $("err-b") },
};

const state = { running: false, at: null, question: "", ready: null, check: null, runs: 0 };
const lanes = { a: null, b: null };
const seen = { a: null, b: null };
let frame = 0;

const pause = (t) => new Promise((r) => setTimeout(r, t));
const terminal = (r) => Boolean(r && r.view) && (r.view.status === "done" || r.view.status === "error");

async function until(pred, timeout) {
  const t0 = performance.now();
  while (!pred()) {
    if (performance.now() - t0 > timeout) return false;
    await pause(100);
  }
  return true;
}

/** main-demo's local run keeps its map in variants.json; a deploy carries it in config.js */
async function localVariants() {
  try {
    const res = await fetch("../main-demo/variants.json", { cache: "no-store" });
    if (!res.ok) return null;
    const j = await res.json();
    return (j && j.variants) || null;
  } catch (_) {
    return null;
  }
}

/* ── Preflight: one short message to each agent, once a session ── */

function cached(key) {
  try { return sessionStorage.getItem(key) === "ok"; } catch (_) { return false; }
}

function remember(key) {
  try { sessionStorage.setItem(key, "ok"); } catch (_) { /* private mode: probe again next load */ }
}

async function preflight(variants) {
  const results = {};
  const show = () => { state.check = preflightState(results, LANES); renderCheck(); };
  show();
  await Promise.all(LANES.map(async (l) => {
    const agentId = variants[configKey(l.toggles)].agentId;
    const key = cacheKey(CFG.host, agentId);
    results[l.key] = cached(key) ? { ok: true }
      : await probeAgent(window.fetch.bind(window), { host: CFG.host, appId: CFG.appId, apiKey: CFG.agentStudioApiKey }, agentId);
    if (results[l.key].ok) remember(key);
    show();
  }));
}

/* ── The table ─────────────────────────────────────────────────── */

function cell(tag, text, cls) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.append(text);
  return n;
}

/** a value with its bar: the bar starts at zero, on the row's shared scale */
function valueCell(r, k) {
  const td = cell("td", undefined, "pf-v" + (r.known[k] ? "" : " is-blank"));
  td.append(cell("span", r[k], "pf-num"));
  const w = r.bars && r.bars[k];
  if (w !== null && w !== undefined) {
    const bar = cell("span", undefined, "pf-bar");
    bar.setAttribute("aria-hidden", "true");
    const fill = cell("i");
    fill.style.width = `${w}%`;
    bar.append(fill);
    td.append(bar);
  }
  return td;
}

/** what the numbers are: the question, and that this is one run of many possible */
function caption() {
  const c = cell("caption");
  if (!state.at) {
    c.append("Pick a question. Both agents get it at the same moment.");
    return c;
  }
  const when = state.at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  c.append(cell("q", state.question), cell("span", `One live run, ${when}. The next one will differ.`, "pf-n"));
  return c;
}

function renderScore() {
  frame = 0;
  const table = cell("table");
  table.append(caption());
  const cols = cell("colgroup");
  for (const c of ["pf-c-m", "pf-c-v", "pf-c-v", "pf-c-d"]) cols.append(cell("col", undefined, c));
  table.append(cols);
  const head = cell("tr");
  head.append(cell("td", "", "pf-m"));
  for (const l of LANES) {
    const th = cell("th", l.label, "pf-col" + (l.key === "b" ? " is-on" : ""));
    th.scope = "col";
    head.append(th);
  }
  const d = cell("th", "Change", "pf-d");
  d.scope = "col";
  d.title = "With prefetch minus without, in this one run";
  head.append(d);
  const thead = cell("thead");
  thead.append(head);
  table.append(thead);
  const body = cell("tbody");
  for (const r of rows(seen)) {
    const tr = cell("tr", undefined, r.lead ? "is-lead" : "");
    const th = cell("th", r.label, "pf-m");
    th.scope = "row";
    tr.append(th, valueCell(r, "a"), valueCell(r, "b"), cell("td", r.diff, "pf-d"));
    body.append(tr);
  }
  table.append(body);
  el.score.replaceChildren(table);
  renderErrors();
}

function scheduleScore() {
  if (!frame) frame = requestAnimationFrame(renderScore);
}

/** a lane with no answer says so above its chat, in place of the widget's generic error */
function renderErrors() {
  for (const l of LANES) {
    const why = laneFailure(seen[l.key] && seen[l.key].view);
    el.err[l.key].textContent = why ? `${l.label}: no answer, ${why}.` : "";
    el.err[l.key].hidden = !why;
    el.lane[l.key].classList.toggle("is-failed", Boolean(why));
  }
}

/* ── The bar: what the numbers are, and whether Run can run ────── */

function renderCheck() {
  const c = state.check || { phase: "unavailable", text: "" };
  el.check.textContent = c.text;
  el.check.dataset.phase = c.phase;
  renderButton();
}

function canRun() {
  return !state.running && Boolean(state.check && (state.check.phase === "ready" || state.check.phase === "retry"));
}

function renderButton() {
  el.run.disabled = !canRun();
  el.run.textContent = state.running ? "Running…" : "Run";
  for (const b of el.chips.querySelectorAll("button")) b.disabled = !canRun();
}

/** one chip per starter, in two groups: where prefetch fits, and where it won't help */
function renderChips() {
  for (const fit of ["good", "poor"]) {
    const box = el.chips.querySelector(`[data-fit="${fit}"] .chips`);
    box.replaceChildren(...STARTERS.filter((s) => s.fit === fit).map((s) => {
      const b = cell("button", s.text, "chip");
      b.type = "button";
      b.addEventListener("click", () => { el.ask.value = s.text; run(s.text); });
      return b;
    }));
  }
}

/* ── The lanes ─────────────────────────────────────────────────── */

function mount(variants) {
  const searchClient = CFG.appId && CFG.searchApiKey ? liteClient(CFG.appId, CFG.searchApiKey) : null;
  for (const l of LANES) {
    lanes[l.key] = mountLane(el.lane[l.key], {
      label: l.label, cfg: CFG, variants, searchClient, initialToggles: l.toggles, fixture: false, locked: true,
      onView: (report) => { seen[l.key] = report; scheduleScore(); },
    });
  }
}

/** a fresh conversation in both lanes, then the question to both at the same moment */
async function run(text) {
  const q = questionOf(text);
  if (!q || !canRun()) return;
  state.running = true;
  renderButton();
  for (const l of LANES) lanes[l.key].clear();
  const fresh = await until(() => LANES.every((l) => lanes[l.key].ready() && !(seen[l.key] && seen[l.key].view)), 15000);
  if (!fresh) {
    state.check = { phase: "unavailable", text: "A lane did not load. Reload the page to try again." };
  } else {
    const before = { a: seen.a ? seen.a.seq : 0, b: seen.b ? seen.b.seq : 0 };
    state.at = new Date();
    state.runs += 1;
    state.question = q;
    for (const l of LANES) lanes[l.key].send(q);
    await until(() => LANES.every((l) => seen[l.key] && seen[l.key].seq > before[l.key] && terminal(seen[l.key])), 180000);
    state.check = afterRun(seen, LANES);
  }
  state.running = false;
  renderCheck();
  scheduleScore();
}

async function main() {
  renderChips();
  el.form.addEventListener("submit", (e) => { e.preventDefault(); run(el.ask.value); });
  scheduleScore();
  // variants.json is main-demo's local map: it only stands in for mainDemo
  const local = blockName === "mainDemo" && !mainDemo.variants ? await localVariants() : null;
  state.ready = liveReadiness(mainDemo, local);
  if (!state.ready.ok) {
    state.check = { phase: "unavailable", text: state.ready.why };
    renderCheck();
    el.lanes.hidden = true;
    return;
  }
  mount(state.ready.variants);
  await preflight(state.ready.variants);
}

main();

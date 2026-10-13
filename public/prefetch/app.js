/* ───────────────────────────────────────────────────────────────
   app.js: search prefetch, before and after, on one question.

   Two main-demo lanes, locked to the race's two arms, and the numbers
   their stream readers measure. Live only, on the agents named in the
   page's demo blocks (demos.mjs): prefetchDemo or main-demo's mainDemo for
   the catalog, one block each for the other use cases. Run stays off until both
   agents pass a one-message preflight, and nothing runs until Run is
   pressed: every run makes real model calls.
   ─────────────────────────────────────────────────────────────── */

import { liteClient } from "algoliasearch/lite";
import { mountLane } from "../main-demo/lane.js";
import { configKey, demoHost } from "../main-demo/configs.mjs";
import { LANES, PHASES, axis, laneEnd, liveReadiness, pageConfig, phases, questionOf, rows, tickText } from "./compare.mjs";
import { ms } from "../main-demo/stream.mjs";
import { afterRun, cacheKey, laneFailure, preflightState, probeAgent } from "./preflight.mjs";
import { demoConfig, demoOf } from "./demos.mjs";

// the page names its use case; the demo says which config blocks hold its agents
const DEMO = demoOf(document.documentElement.dataset.demo);
const { block: mainDemo, name: blockName } = pageConfig(window.DEMO_CONFIG, DEMO.blocks);
const CFG = demoConfig(DEMO, mainDemo);
CFG.host = demoHost(mainDemo);

const $ = (id) => document.getElementById(id);
const el = {
  run: $("run"), check: $("check"), lanes: $("lanes"),
  form: $("ask-form"), ask: $("ask"), chips: $("chips"), score: $("score"), race: $("race"),
  lane: { a: $("lane-a"), b: $("lane-b") }, err: { a: $("err-a"), b: $("err-b") },
};

const state = { running: false, ready: null, check: null };
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

function valueCell(r, k) {
  const td = cell("td", undefined, "pf-v" + (r.known[k] ? "" : " is-blank"));
  td.append(cell("span", r[k], "pf-num"));
  return td;
}

function renderScore() {
  frame = 0;
  const table = cell("table");
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
  renderRace();
  renderErrors();
}

/* ── The timeline: both lanes on one time axis ─────────────────── */

const PHASE = Object.fromEntries(PHASES.map((p) => [p.id, p]));

/** one lane's row: its name, its phases end to end, and when its answer was complete */
function raceRow(l, scale) {
  const r = seen[l.key];
  const v = r && r.view;
  const parts = phases(v);
  const row = cell("div", undefined, "pf-tl-row" + (l.key === "b" ? " is-on" : ""));
  const track = cell("div", undefined, "pf-tl-track");
  track.setAttribute("role", "img");
  track.setAttribute("aria-label", parts.length
    ? `${l.label}: ` + parts.map((p) => `${PHASE[p.kind].short} ${ms(p.end - p.start)}`).join(", ")
    : `${l.label}: no run yet`);
  for (const p of parts) {
    const seg = cell("span", undefined, "pf-seg is-" + p.kind);
    seg.style.left = `${(p.start / scale) * 100}%`;
    seg.style.width = `${((p.end - p.start) / scale) * 100}%`;
    const d = ms(p.end - p.start);
    seg.title = `${PHASE[p.kind].label}${p.name ? ` (${p.name})` : ""}: ${d}`;
    seg.append(cell("b", PHASE[p.kind].short), cell("i", d));
    track.append(seg);
  }
  const live = v && (v.status === "sending" || v.status === "streaming");
  const failed = laneFailure(v);
  const end = failed ? "no answer" : !v ? "" : live ? "…" : ms(v.total);
  row.append(cell("span", l.label, "pf-tl-name"), track, cell("span", end, "pf-tl-end"));
  return row;
}

function renderRace() {
  const { max, ticks } = axis(...LANES.map((l) => laneEnd(seen[l.key])));
  const scale = max || 1;
  const box = cell("div", undefined, "pf-tl");
  for (const l of LANES) box.append(raceRow(l, scale));
  const scaleRow = cell("div", undefined, "pf-tl-row is-axis");
  const ax = cell("div", undefined, "pf-tl-axis");
  ax.setAttribute("aria-hidden", "true");
  for (const t of ticks) {
    const tick = cell("span", tickText(t), "pf-tick");
    tick.style.left = `${(t / scale) * 100}%`;
    ax.append(tick);
  }
  scaleRow.append(cell("span", "", "pf-tl-name"), ax, cell("span", "", "pf-tl-end"));
  if (ticks.length) box.append(scaleRow);
  else box.append(cell("p", "Both agents get the question at the same moment. Their time shows here, on one scale.", "pf-tl-empty"));
  const key = cell("ul", undefined, "pf-tl-key");
  for (const p of PHASES) key.append(cell("li", p.label, "is-" + p.id));
  el.race.replaceChildren(box, key);
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
    box.replaceChildren(...DEMO.starters.filter((s) => s.fit === fit).map((s) => {
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
    for (const l of LANES) lanes[l.key].send(q);
    await until(() => LANES.every((l) => seen[l.key] && seen[l.key].seq > before[l.key] && terminal(seen[l.key])), 180000);
    state.check = afterRun(seen, LANES);
  }
  state.running = false;
  renderCheck();
  scheduleScore();
}

async function main() {
  el.ask.placeholder = DEMO.placeholder;
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

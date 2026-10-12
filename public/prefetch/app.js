/* ───────────────────────────────────────────────────────────────
   app.js: search prefetch, before and after, on one question.

   Two main-demo lanes, locked to the race's two arms, and the numbers
   their stream readers measure. Live only, on the agents named in the
   same mainDemo config block main-demo reads. Run stays off until both
   agents pass a one-message preflight, and nothing runs until Run is
   pressed: every run makes real model calls.
   ─────────────────────────────────────────────────────────────── */

import { liteClient } from "algoliasearch/lite";
import { mountLane } from "../main-demo/lane.js";
import { configKey, demoHost } from "../main-demo/configs.mjs";
import { LANES, QUESTION, liveReadiness, rows } from "./compare.mjs";
import { afterRun, cacheKey, laneFailure, preflightState, probeAgent } from "./preflight.mjs";

const root = window.DEMO_CONFIG || {};
const mainDemo = root.mainDemo || null;
const CFG = { indexName: "products", ...(mainDemo || {}) };
CFG.host = demoHost(mainDemo);

const $ = (id) => document.getElementById(id);
const el = {
  run: $("run"), check: $("check"), source: $("source"), lanes: $("lanes"),
  question: $("question"), score: $("score"),
  lane: { a: $("lane-a"), b: $("lane-b") }, err: { a: $("err-a"), b: $("err-b") },
};

const state = { running: false, at: null, ready: null, check: null, runs: 0 };
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

function renderScore() {
  frame = 0;
  const table = cell("table");
  const head = cell("tr");
  head.append(cell("th", "", "pf-m"));
  for (const l of LANES) {
    const th = cell("th", l.label, "pf-col" + (l.key === "b" ? " is-on" : ""));
    th.scope = "col";
    head.append(th);
  }
  const d = cell("th", "B − A", "pf-d");
  d.scope = "col";
  d.title = "With prefetch minus without, from this one run";
  head.append(d);
  table.append(cell("thead"));
  table.firstChild.append(head);
  const body = cell("tbody");
  for (const r of rows(seen)) {
    const tr = cell("tr");
    const th = cell("th", r.label, "pf-m");
    th.scope = "row";
    const val = (k) => cell("td", r[k], "pf-v" + (r.known[k] ? "" : " is-blank"));
    tr.append(th, val("a"), val("b"), cell("td", r.diff, "pf-d"));
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

function renderSource() {
  el.source.textContent = "";
  if (!state.at) {
    el.source.append(cell("b", "Live"), ": each run makes real model calls, so nothing runs until you press Run.");
    return;
  }
  const when = state.at.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  el.source.append(cell("b", "Live run"), `, ${when}, one conversation. A second run will differ.`);
}

function renderCheck() {
  const c = state.check || { phase: "unavailable", text: "" };
  el.check.textContent = c.text;
  el.check.dataset.phase = c.phase;
  renderButton();
}

function renderButton() {
  const ready = Boolean(state.check && (state.check.phase === "ready" || state.check.phase === "retry"));
  el.run.disabled = state.running || !ready;
  el.run.textContent = state.running ? "Running…" : state.runs ? "Run again" : "Run";
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
async function run() {
  if (state.running || !state.check || !["ready", "retry"].includes(state.check.phase)) return;
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
    renderSource();
    for (const l of LANES) lanes[l.key].send(QUESTION);
    await until(() => LANES.every((l) => seen[l.key] && seen[l.key].seq > before[l.key] && terminal(seen[l.key])), 180000);
    state.check = afterRun(seen, LANES);
  }
  state.running = false;
  renderCheck();
  scheduleScore();
}

async function main() {
  el.question.textContent = QUESTION;
  el.run.addEventListener("click", run);
  renderSource();
  scheduleScore();
  state.ready = liveReadiness(mainDemo, mainDemo && !mainDemo.variants ? await localVariants() : null);
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

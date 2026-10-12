/* ───────────────────────────────────────────────────────────────
   app.js: search prefetch, before and after, on one question.

   Two main-demo lanes, locked to the race's two arms, and the numbers
   their stream readers measure. Replay by default (fixture.mjs, labeled as
   what it is); "Run live" calls the same agents main-demo does, from the
   same mainDemo config block.
   ─────────────────────────────────────────────────────────────── */

import { liteClient } from "algoliasearch/lite";
import { mountLane } from "../main-demo/lane.js";
import { MANIFEST, configKey, demoHost } from "../main-demo/configs.mjs";
import { LANES, LIVE_QUESTION, REPLAY, REPLAY_QUESTION, liveReadiness, rows } from "./compare.mjs";

const root = window.DEMO_CONFIG || {};
const mainDemo = root.mainDemo || null;
const CFG = { indexName: "products", ...(mainDemo || {}) };
CFG.host = demoHost(mainDemo);

const $ = (id) => document.getElementById(id);
const el = {
  replay: $("replay"), live: $("live"), status: $("status"), source: $("source"),
  question: $("question"), score: $("score"), lane: { a: $("lane-a"), b: $("lane-b") },
};

const state = { mode: "replay", running: false, at: null, ready: null };
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

function say(text) {
  el.status.textContent = text || "";
  el.status.hidden = !text;
}

/** every manifest variant, served by the fixture */
function fixtureVariants() {
  const out = {};
  for (const m of MANIFEST) out[configKey(m.toggles)] = { agentId: "fixture", name: m.name, model: "fixture" };
  return out;
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

async function backendUp() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 2500);
  try {
    return (await fetch(`${CFG.host}/status`, { signal: ctl.signal })).ok;
  } catch (_) {
    return false;
  } finally {
    clearTimeout(timer);
  }
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
  for (const r of rows(seen, { replay: state.mode === "replay" })) {
    const tr = cell("tr");
    const th = cell("th", r.label, "pf-m");
    th.scope = "row";
    const val = (k) => cell("td", r[k], "pf-v" + (r.known[k] ? "" : " is-blank"));
    tr.append(th, val("a"), val("b"), cell("td", r.diff, "pf-d"));
    body.append(tr);
  }
  table.append(body);
  el.score.replaceChildren(table);
}

function scheduleScore() {
  if (!frame) frame = requestAnimationFrame(renderScore);
}

/* ── The source line: what these numbers are ──────────────────── */

function renderSource() {
  el.source.textContent = "";
  if (state.mode === "replay") {
    el.source.append(cell("b", REPLAY.label), ": scripted events with made-up timings, not a measurement.");
  } else {
    const when = state.at ? state.at.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";
    el.source.append(cell("b", "Live run"), `, ${when}, one conversation. A second run will differ.`);
  }
  el.question.textContent = state.mode === "replay" ? REPLAY_QUESTION : LIVE_QUESTION;
}

function renderButtons() {
  el.replay.disabled = state.running;
  el.live.disabled = state.running;
  el.live.setAttribute("aria-disabled", String(!(state.ready && state.ready.ok)));
}

/* ── The lanes ─────────────────────────────────────────────────── */

function mount({ fixture, variants, searchClient }) {
  for (const l of LANES) {
    if (lanes[l.key]) lanes[l.key].unmount();
    seen[l.key] = null;
    lanes[l.key] = mountLane(el.lane[l.key], {
      label: l.label, cfg: CFG, variants, searchClient, initialToggles: l.toggles, fixture, locked: true,
      onView: (report) => { seen[l.key] = report; scheduleScore(); },
    });
  }
  scheduleScore();
}

/** the question to both lanes at the same moment; resolves when both settle */
async function run(question) {
  state.running = true;
  renderButtons();
  const ready = await until(() => LANES.every((l) => lanes[l.key].ready()), 15000);
  if (!ready) {
    say("A lane did not load. Reload the page to try again.");
  } else {
    const before = { a: seen.a ? seen.a.seq : 0, b: seen.b ? seen.b.seq : 0 };
    const refused = LANES.filter((l) => !lanes[l.key].send(question));
    if (refused.length) say(`No agent for ${refused.map((l) => l.label.toLowerCase()).join(" and ")}.`);
    else await until(() => LANES.every((l) => seen[l.key] && seen[l.key].seq > before[l.key] && terminal(seen[l.key])), 180000);
  }
  state.running = false;
  renderButtons();
  scheduleScore();
}

async function replay() {
  if (state.running) return;
  state.mode = "replay";
  say("");
  renderSource();
  mount({ fixture: true, variants: fixtureVariants(), searchClient: null });
  await run(REPLAY_QUESTION);
}

async function live() {
  if (state.running) return;
  if (!state.ready.ok) { say(state.ready.why); return; }
  say("Checking the Agent Studio backend…");
  if (!(await backendUp())) { say("The Agent Studio backend did not answer. The replay still works."); return; }
  say("");
  state.mode = "live";
  state.at = new Date();
  renderSource();
  const searchClient = CFG.appId && CFG.searchApiKey ? liteClient(CFG.appId, CFG.searchApiKey) : null;
  mount({ fixture: false, variants: state.ready.variants, searchClient });
  await run(LIVE_QUESTION);
}

async function main() {
  state.ready = liveReadiness(mainDemo, mainDemo && !mainDemo.variants ? await localVariants() : null);
  el.replay.addEventListener("click", replay);
  el.live.addEventListener("click", live);
  if (!state.ready.ok) el.live.title = state.ready.why;
  renderButtons();
  await replay();
}

main();

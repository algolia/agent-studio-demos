/* ───────────────────────────────────────────────────────────────
   app.js — the page: two modes, one or two lanes, one shared input.

   Lanes are self-contained (lane.js). This file only decides how many are
   on screen, where the question comes from, and whether they talk to a
   live backend or replay the fixture.
   ─────────────────────────────────────────────────────────────── */

import { liteClient } from "algoliasearch/lite";
import { mountLane } from "./lane.js";
import { MANIFEST, BASE_TOGGLES, configKey, provisionCommand } from "./configs.mjs";
import { METRICS, compare, deltaText, summarize } from "./race.mjs";

const root = window.DEMO_CONFIG || {};
const CFG = { host: "http://127.0.0.1:8000", indexName: "products", ...(root.mainDemo || {}) };
CFG.host = String(CFG.host).replace(/\/+$/, "");

const $ = (id) => document.getElementById(id);
const el = {
  lanes: $("lanes"), laneA: $("lane-a"), laneB: $("lane-b"),
  form: $("race-form"), text: $("race-text"), chips: $("chips"), status: $("status"), score: $("score"),
  go: $("race-go"), rerun: $("race-rerun"), clear: $("race-clear"), raceState: $("race-state"),
  times: [...document.querySelectorAll("[data-times]")],
  tabs: [...document.querySelectorAll(".seg [data-mode]")],
};
const params = new URLSearchParams(location.search);

/* check-copy: off */
const STARTERS = [
  "Compare three wireless headphones under $100",
  "I need a gift for a coffee lover, budget $50",
  "Waterproof jacket for a rainy commute",
];
/* check-copy: on */

function say(node, parts) {
  node.textContent = "";
  for (const p of parts) node.append(typeof p === "string" ? document.createTextNode(p) : p);
  node.hidden = false;
}
const code = (s) => { const c = document.createElement("code"); c.textContent = s; return c; };

async function backendUp() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 2500);
  try {
    const res = await fetch(`${CFG.host}/status`, { signal: ctl.signal });
    return res.ok;
  } catch (_) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function loadVariants() {
  try {
    const res = await fetch("variants.json", { cache: "no-store" });
    if (!res.ok) return {};
    const j = await res.json();
    return (j && j.variants) || {};
  } catch (_) {
    return {};
  }
}

/** every manifest variant, served by the fixture */
function fixtureVariants() {
  const out = {};
  for (const m of MANIFEST) out[configKey(m.toggles)] = { agentId: "fixture", name: m.name, model: "fixture" };
  return out;
}

const lanes = { a: null, b: null };
let ctx = null;

/* ── Races: one question to both lanes, repeated, tallied ────── */

const seen = { a: null, b: null };
let scoreFrame = 0;
// runs: [{ a: summary, b: summary }], one per finished race on `question`
const race = { question: "", runs: [], running: false, stop: false, times: 1, at: 0, target: 0 };

const terminal = (v) => Boolean(v) && (v.status === "done" || v.status === "error");
const pause = (t) => new Promise((r) => setTimeout(r, t));

async function until(pred, timeout) {
  const t0 = performance.now();
  while (!pred()) {
    if (performance.now() - t0 > timeout) return false;
    await pause(100);
  }
  return true;
}

/**
 * One run: both chats cleared (a fresh conversation, so run 3 is not a
 * follow-up of run 2), then the question to both lanes at the same moment.
 */
async function oneRun(q) {
  lanes.a.clear();
  lanes.b.clear();
  const mounted = await until(() => lanes.a.ready() && lanes.b.ready() && !(seen.a && seen.a.view) && !(seen.b && seen.b.view), 8000);
  if (!mounted) return { error: "A lane did not reset." };
  const before = { a: seen.a ? seen.a.seq : 0, b: seen.b ? seen.b.seq : 0 };
  const refused = [["A", lanes.a], ["B", lanes.b]].filter(([, lane]) => !lane.send(q)).map(([n]) => n);
  if (refused.length) return { error: `Lane ${refused.join(" and ")} has no agent for its setup.` };
  await until(() => ["a", "b"].every((k) => seen[k] && seen[k].seq > before[k] && terminal(seen[k].view)), 180000);
  return { a: summarize(seen.a && seen.a.view), b: summarize(seen.b && seen.b.view) };
}

async function runRace(q, times, { append = false } = {}) {
  if (race.running || !q) return;
  if (!append || q !== race.question) { race.question = q; race.runs = []; }
  race.running = true;
  race.stop = false;
  race.target = times;
  for (let i = 1; i <= times && !race.stop; i++) {
    race.at = i;
    renderBar();
    const run = await oneRun(q);
    if (run.error) { say(el.status, [run.error]); break; }
    race.runs.push(run);
    scheduleScore();
  }
  race.running = false;
  race.at = 0;
  renderBar();
  scheduleScore();
}

function clearRace() {
  race.stop = true;
  race.question = "";
  race.runs = [];
  for (const lane of [lanes.a, lanes.b]) if (lane) lane.clear();
  renderBar();
  scheduleScore();
}

function renderBar() {
  for (const b of el.times) b.setAttribute("aria-pressed", String(Number(b.dataset.times) === race.times));
  el.go.textContent = race.running ? "Stop" : "Race";
  el.rerun.disabled = race.running || !race.question;
  el.rerun.textContent = `Rerun ×${race.times}`;
  el.raceState.textContent = race.running
    ? `Run ${race.at} of ${race.target}`
    : race.question ? `${race.runs.length} ${race.runs.length === 1 ? "run" : "runs"} of this question` : "";
}

/* ── The scoreboard: the two lanes' numbers, side by side ─────── */

function cell(tag, text, cls) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.append(text);
  return n;
}

/* check-copy: off */
const BENCH = [
  "Bench, 100 paired questions (Enablers medium, local stack):",
  "median model calls 3 with no prefetch, 2 with it, fewer on 76 of 100, more on 9;",
  "first text 7.47\u00a0s against 4.16\u00a0s; full paint 11.10\u00a0s against 8.68\u00a0s;",
  "paired full-paint saving 2.66\u00a0s, 95% CI 1.82 to 3.88\u00a0s.",
];
/* check-copy: on */

function laneHead(k, report) {
  const on = Boolean(report && report.prefetchOn);
  const th = cell("th", `Lane ${k}`);
  th.scope = "col";
  th.append(" ", cell("span", on ? "prefetch" : "no prefetch", "score-pf" + (on ? " is-on" : "")));
  return th;
}

function strip(metric, c) {
  const s = cell("span", undefined, "score-strip");
  c.runs.forEach((p, i) => {
    const d = cell("span", undefined, "run is-" + (p.win || "none"));
    const size = p.d === null ? "" : metric.kind === "time" ? `${Math.round(p.d)} ms` : String(p.d);
    d.title = `run ${i + 1}: ${p.win === "even" ? "even" : p.win ? `${p.win.toUpperCase()} better` : "no pair"}${size ? `, B − A = ${size}` : ""}`;
    s.append(d);
  });
  return s;
}

function renderScore() {
  scoreFrame = 0;
  const on = el.lanes.dataset.mode === "race";
  el.score.hidden = !on;
  if (!on) return;
  // finished runs; before the first one finishes, the live turn stands in
  const live = { a: summarize(seen.a && seen.a.view), b: summarize(seen.b && seen.b.view) };
  const runs = race.runs.length ? race.runs : live.a || live.b ? [live] : [];
  const n = race.runs.length;
  const table = cell("table");
  const head = cell("tr");
  head.append(cell("th", "", "score-m"), laneHead("A", seen.a), laneHead("B", seen.b), cell("th", "B vs A", "score-d"));
  if (n > 1) head.append(cell("th", "wins A · B · even", "score-w"));
  table.append(cell("thead"));
  table.firstChild.append(head);
  const body = cell("tbody");
  const hasUsage = runs.some((r) => ["a", "b"].some((k) => r[k] && Number.isFinite(r[k].inputTokens)));
  for (const m of METRICS) {
    if (m.usage && !hasUsage) continue;
    const c = compare(m, runs);
    const tr = cell("tr");
    const th = cell("th", m.label, "score-m");
    th.scope = "row";
    if (m.tip) th.title = m.tip;
    const lead = c.delta === null || deltaText(m, c) === "even" ? null : c.delta < 0 ? "b" : "a";
    const val = (x, k) => {
      const shown = x === null ? (runs.length ? "…" : "—") : m.fmt(Math.round(x * 10) / 10);
      const td = cell("td", shown, "score-v");
      if (lead === k) td.classList.add("is-win");
      return td;
    };
    tr.append(th, val(c.a, "a"), val(c.b, "b"), cell("td", deltaText(m, c), "score-d" + (lead ? " is-win" : "")));
    if (n > 1) {
      const w = cell("td", `${c.tally.a} · ${c.tally.b} · ${c.tally.even}`, "score-w");
      w.append(" ", strip(m, c));
      tr.append(w);
    }
    body.append(tr);
  }
  if (!hasUsage) {
    const tr = cell("tr", undefined, "is-placeholder");
    const th = cell("th", "Tokens", "score-m");
    th.scope = "row";
    const td = cell("td", "not streamed: set ", "score-note-cell");
    td.colSpan = n > 1 ? 4 : 3;
    td.append(cell("code", "sendUsage: true"), " in both agents' config");
    tr.append(th, td);
    body.append(tr);
  }
  table.append(body);
  const note = cell("p", undefined, "score-note");
  note.append(!runs.length ? "Race both lanes on a question to compare them."
    : n ? `${n} ${n === 1 ? "run" : "runs"}, medians. Each run sends the question to both lanes at the same moment, in a fresh conversation.`
      : "First run in progress.");
  const bench = cell("details", undefined, "score-bench");
  bench.append(cell("summary", "What 100 runs showed"), cell("p", BENCH.join(" ")));
  el.score.replaceChildren(table, note, bench);
}

function scheduleScore() {
  if (!scoreFrame) scoreFrame = requestAnimationFrame(renderScore);
}

function noteView(which, report) {
  seen[which] = report;
  scheduleScore();
}

function ensureLane(which) {
  if (lanes[which]) return lanes[which];
  const node = which === "a" ? el.laneA : el.laneB;
  const toggles = which === "a" ? BASE_TOGGLES : { ...BASE_TOGGLES, prefetch: "tool_pair" };
  lanes[which] = mountLane(node, {
    label: which === "a" ? "Lane A" : "Lane B",
    cfg: CFG, variants: ctx.variants, searchClient: ctx.searchClient,
    initialToggles: toggles, fixture: ctx.fixture,
    onView: (report) => noteView(which, report),
  });
  return lanes[which];
}

function setMode(mode) {
  const race = mode === "race";
  el.lanes.dataset.mode = race ? "race" : "chat";
  el.laneB.hidden = !race;
  el.form.hidden = !race;
  for (const t of el.tabs) t.setAttribute("aria-selected", String(t.dataset.mode === mode));
  if (race) ensureLane("b");
  renderScore();
  renderBar();
  try { history.replaceState(null, "", race ? "#race" : "#chat"); } catch (_) { /* sandboxed */ }
}

function ask(text) {
  const q = String(text || "").trim();
  if (!q) return;
  if (el.lanes.dataset.mode === "race") { runRace(q, race.times); return; }
  if (!lanes.a || !lanes.a.send(q)) say(el.status, ["Lane A has no agent for its setup."]);
}

function renderChips() {
  el.chips.textContent = "";
  for (const s of STARTERS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.textContent = s;
    b.addEventListener("click", () => ask(s));
    el.chips.append(b);
  }
}

async function main() {
  const forced = params.get("fixture") === "1";
  const up = forced ? false : await backendUp();
  const fixture = forced || !up;
  const variants = fixture ? fixtureVariants() : await loadVariants();
  const searchClient = !fixture && CFG.appId && CFG.searchApiKey ? liteClient(CFG.appId, CFG.searchApiKey) : null;
  ctx = { fixture, variants, searchClient };

  if (fixture) {
    say(el.status, forced
      ? ["Replaying a fixture stream. Timings are not measurements."]
      : ["No backend at ", code(CFG.host), ", so lanes replay a fixture. Timings are not measurements."]);
  } else if (!Object.keys(variants).length) {
    say(el.status, ["No variants.json yet. Run ", code(provisionCommand([]))]);
  } else if (!CFG.agentStudioApiKey) {
    say(el.status, ["Set ", code("mainDemo.agentStudioApiKey"), " in ", code("shared/config.js"), "."]);
  }

  ensureLane("a");
  setMode(location.hash === "#race" ? "race" : "chat");
  for (const t of el.tabs) t.addEventListener("click", () => setMode(t.dataset.mode));
  el.form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (race.running) { race.stop = true; el.go.textContent = "Stopping…"; return; }
    ask(el.text.value);
    el.text.value = "";
  });
  for (const b of el.times) {
    b.addEventListener("click", () => { race.times = Number(b.dataset.times); renderBar(); });
  }
  el.rerun.addEventListener("click", () => runRace(race.question, race.times, { append: true }));
  el.clear.addEventListener("click", clearRace);
  renderChips();
}

main();

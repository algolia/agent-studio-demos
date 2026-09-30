/* ───────────────────────────────────────────────────────────────
   app.js — the page: two modes, one or two lanes, one shared input.

   Lanes are self-contained (lane.js). This file only decides how many are
   on screen, where the question comes from, and whether they talk to a
   live backend or replay the fixture.
   ─────────────────────────────────────────────────────────────── */

import { liteClient } from "algoliasearch/lite";
import { mountLane } from "./lane.js";
import { MANIFEST, BASE_TOGGLES, configKey, provisionCommand } from "./configs.mjs";
import { ms } from "./stream.mjs";

const root = window.DEMO_CONFIG || {};
const CFG = { host: "http://127.0.0.1:8000", indexName: "products", ...(root.mainDemo || {}) };
CFG.host = String(CFG.host).replace(/\/+$/, "");

const $ = (id) => document.getElementById(id);
const el = {
  lanes: $("lanes"), laneA: $("lane-a"), laneB: $("lane-b"),
  form: $("race-form"), text: $("race-text"), chips: $("chips"), status: $("status"), score: $("score"),
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

/* ── The scoreboard: the two lanes' numbers, side by side ─────── */

const seen = { a: null, b: null };
let scoreFrame = 0;

const METRICS = [
  { id: "ttft", label: "First token", pick: (v) => v.ttft, fmt: ms, ready: (v) => v.ttft !== null },
  { id: "total", label: "Full paint", pick: (v) => v.total, fmt: ms, ready: (v) => v.status === "done",
    tip: "Stream end: the answer and its carousels are on screen." },
  { id: "searches", label: "Search calls", pick: (v) => v.searches, fmt: String, ready: (v) => v.status === "done",
    tip: "The model's own search calls. Zero on a prefetch lane means it used the prefetched hits." },
];

function cell(tag, text, cls) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.append(text);
  return n;
}

/** "B 1.28 s sooner", "even", or nothing until both lanes have the number */
function delta(m, a, b) {
  if (!a || !b || !m.ready(a) || !m.ready(b)) return { text: "", win: null };
  const d = m.pick(b) - m.pick(a);
  if (m.id === "searches") {
    if (d === 0) return { text: "same", win: null };
    return { text: `B ${d < 0 ? "saved" : "added"} ${Math.abs(d)}`, win: d < 0 ? "b" : "a" };
  }
  const slack = Math.max(50, 0.05 * Math.max(m.pick(a), m.pick(b)));
  if (Math.abs(d) < slack) return { text: "even", win: null };
  return { text: `${d < 0 ? "B" : "A"} ${ms(Math.abs(d))} sooner`, win: d < 0 ? "b" : "a" };
}

function renderScore() {
  scoreFrame = 0;
  const race = el.lanes.dataset.mode === "race";
  el.score.hidden = !race;
  if (!race) return;
  const a = seen.a && seen.a.view;
  const b = seen.b && seen.b.view;
  const table = cell("table");
  const head = cell("tr");
  head.append(cell("th", "", "score-m"));
  for (const [k, s] of [["A", seen.a], ["B", seen.b]]) {
    const th = cell("th", `Lane ${k}`);
    th.scope = "col";
    th.append(" ", cell("span", s && s.prefetchOn ? "prefetch" : "no prefetch", "score-pf" + (s && s.prefetchOn ? " is-on" : "")));
    head.append(th);
  }
  head.append(cell("th", "", "score-d"));
  table.append(cell("thead"));
  table.firstChild.append(head);
  const body = cell("tbody");
  for (const m of METRICS) {
    const tr = cell("tr");
    const th = cell("th", m.label, "score-m");
    th.scope = "row";
    if (m.tip) th.title = m.tip;
    const d = delta(m, a, b);
    const val = (v, k) => {
      const c = cell("td", v && m.ready(v) ? m.fmt(m.pick(v)) : v ? "…" : "—", "score-v");
      if (d.win === k) c.classList.add("is-win");
      return c;
    };
    tr.append(th, val(a, "a"), val(b, "b"), cell("td", d.text, "score-d" + (d.win ? " is-win" : "")));
    body.append(tr);
  }
  table.append(body);
  const note = cell("p", a || b ? "One question, one sample per lane." : "Ask both lanes a question to compare them.", "score-note");
  el.score.replaceChildren(table, note);
}

function noteView(which, report) {
  seen[which] = report;
  if (!scoreFrame) scoreFrame = requestAnimationFrame(renderScore);
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
  try { history.replaceState(null, "", race ? "#race" : "#chat"); } catch (_) { /* sandboxed */ }
}

function ask(text) {
  const q = String(text || "").trim();
  if (!q) return;
  const race = el.lanes.dataset.mode === "race";
  const targets = race ? [["A", lanes.a], ["B", lanes.b]] : [["A", lanes.a]];
  const refused = targets.filter(([, lane]) => !lane || !lane.send(q)).map(([n]) => n);
  if (refused.length) say(el.status, [`Lane ${refused.join(" and ")} has no agent for its setup.`]);
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
    ask(el.text.value);
    el.text.value = "";
  });
  renderChips();
}

main();

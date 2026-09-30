/* ───────────────────────────────────────────────────────────────
   app.js — the page: two modes, one or two lanes, one shared input.

   Lanes are self-contained (lane.js). This file only decides how many are
   on screen, where the question comes from, and whether they talk to a
   live backend or replay the fixture.
   ─────────────────────────────────────────────────────────────── */

import { liteClient } from "algoliasearch/lite";
import { mountLane } from "./lane.js";
import { MANIFEST, BASE_TOGGLES, configKey, provisionCommand } from "./configs.mjs";

const root = window.DEMO_CONFIG || {};
const CFG = { host: "http://127.0.0.1:8000", indexName: "products", ...(root.mainDemo || {}) };
CFG.host = String(CFG.host).replace(/\/+$/, "");

const $ = (id) => document.getElementById(id);
const el = {
  lanes: $("lanes"), laneA: $("lane-a"), laneB: $("lane-b"),
  form: $("race-form"), text: $("race-text"), chips: $("chips"), status: $("status"),
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

function ensureLane(which) {
  if (lanes[which]) return lanes[which];
  const node = which === "a" ? el.laneA : el.laneB;
  const toggles = which === "a" ? BASE_TOGGLES : { ...BASE_TOGGLES, prefetch: "tool_pair" };
  lanes[which] = mountLane(node, {
    label: which === "a" ? "Lane A" : "Lane B",
    cfg: CFG, variants: ctx.variants, searchClient: ctx.searchClient,
    initialToggles: toggles, fixture: ctx.fixture,
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

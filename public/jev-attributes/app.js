/* ───────────────────────────────────────────────────────────────
   jev-attributes — one question, a full lane and one lane per engine.

   run.mjs does the work and reports events; this file keeps the state they
   build and draws it. Two modes, found at startup:

     LOCAL    the proxy answers /api/status: it holds every key and adds
              them to the relay calls, and searches for the page
     PUBLIC   no proxy: the visitor pastes their own keys (held in this
              browser, see byok.mjs), the relay forwards them, and search
              runs here on the secured key in shared/config.js

   Every token count is the answering LLM's own `usage`; the page computes
   only the saving between lanes.
   ─────────────────────────────────────────────────────────────── */

import { ms, grouped } from "../shared/format.mjs";
import { SECTIONS, savingPct, overlap, splitKey } from "./attrs.mjs";
import { ENGINES, engine, looksNonEnglish, sectionDocs } from "./engines.mjs";
import { relayTransport } from "./client.mjs";
import { createBrowserSearch } from "./search.mjs";
import { createKeyStore, jwtExpiry } from "./byok.mjs";
import { createEmbedder, EMBED } from "./embed.mjs";
import { run, missingKey } from "./run.mjs";

const $ = (id) => document.getElementById(id);
const el = {
  mode: $("mode"), vendor: $("vendor"), form: $("ask"), q: $("q"), go: $("go"), engines: $("engines"), model: $("model"),
  chips: $("chips"), flow: $("flow"), board: $("board"), matrix: $("matrix"), lanes: $("lanes"),
};

/** a DOM node: h("p.cls", { title }, child, "text") */
function h(spec, attrs, ...kids) {
  const [tag, ...cls] = spec.split(".");
  const n = document.createElement(tag || "div");
  if (cls.length) n.className = cls.join(" ");
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "style") Object.assign(n.style, v);
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : String(v));
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) n.append(typeof k === "object" && k.nodeType ? k : String(k));
  return n;
}

const fromUrl = new URLSearchParams(location.search);
const safe = (fn, fallback = null) => { try { return fn(); } catch (_) { return fallback; } };

const SCENARIOS = [
  "Peru's GDP growth",
  "Which countries border Austria?",
  "Compare Japan and Germany military spending",
  "What languages are spoken in Switzerland?",
  "Population over 65 in Italy",
  "How many airports does Kenya have?",
];

/* soft hyphens, so the three long names break where a reader expects */
const WIDE = {
  "Communications": "Communi\u00adcations", "Transportation": "Transpor\u00adtation", "Transnational Issues": "Transna\u00adtional Issues",
};
const SHORT = {
  "Introduction": "Intro", "Geography": "Geo", "People and Society": "People", "Environment": "Env",
  "Government": "Gov", "Economy": "Econ", "Energy": "Energy", "Communications": "Comms", "Transportation": "Transp",
  "Military and Security": "Military", "Space": "Space", "Terrorism": "Terror", "Transnational Issues": "Transn",
};
const RELAY_SRC = "https://github.com/algolia/agent-studio-demos/blob/main/functions/relay/%5B%5Bpath%5D%5D.js";
const WHERE = { vendor: "outside vendor", enablers: "Enablers", browser: "this browser" };

/* ── mode, keys, engines ──────────────────────────────────────── */

const app = {
  mode: null, // "local" | "public"
  search: null,
  post: relayTransport("/relay"),
  keys: createKeyStore(),
  engines: new Set(safe(() => JSON.parse(localStorage.getItem("jev-attributes.engines")), null) || ENGINES.map((e) => e.id)),
  depth: "sections",
  embedder: null,
  embedState: null,
};

function saveEngines() { safe(() => localStorage.setItem("jev-attributes.engines", JSON.stringify([...app.engines]))); }

async function detectMode() {
  const local = await fetch("/api/status", { signal: AbortSignal.timeout(1500) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (local && local.mode === "local") {
    app.mode = "local";
    app.search = async (q) => {
      const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      if (!r.ok) throw new Error(`search HTTP ${r.status}`);
      return r.json();
    };
    return;
  }
  app.mode = "public";
  await new Promise((ok) => {
    const s = document.createElement("script");
    s.src = "../shared/config.js";
    s.onload = ok;
    s.onerror = ok;
    document.head.append(s);
  });
  const cfg = window.DEMO_CONFIG && window.DEMO_CONFIG.jevAttributes;
  app.search = cfg && cfg.appId && cfg.searchKey
    ? createBrowserSearch(cfg)
    : async () => { throw new Error("This site has no Factbook search key yet."); };
}

function embedder() {
  if (!app.embedder) app.embedder = createEmbedder((st) => { app.embedState = st; renderModel(); }, { device: fromUrl.get("device"), prime: sectionDocs() });
  return app.embedder;
}

/** is the model already in this browser's cache? then load it now, at no network cost */
async function warmIfCached() {
  if (!app.engines.has("embed")) return;
  const hit = await safe(async () => {
    const c = await caches.open("transformers-cache");
    return Boolean(await c.match(`https://huggingface.co/${EMBED.model}/resolve/main/${EMBED.file}`));
  }, false);
  if (hit) embedder().load();
}

/* ── the run ──────────────────────────────────────────────────── */

let state = null;
let ctl = null;
let tick = null;

const freshLane = (id) => ({ id, keys: null, chars: null, start: null, text: "", done: null, error: null, skip: null,
  engine: { loadAt: null, startAt: null, sections: null, fields: null, sectionsMs: null, fieldsMs: null, confidence: null,
    keep: null, ms: null, end: null, tokens: null, model: null } });

async function ask(question) {
  if (ctl) ctl.abort();
  ctl = new AbortController();
  const ids = ENGINES.map((e) => e.id).filter((id) => app.engines.has(id));
  const s = (state = {
    question, depth: app.depth, ids, status: "running", sentAt: performance.now(), search: null, error: null, end: null,
    lanes: Object.fromEntries(["full", ...ids].map((id) => [id, freshLane(id)])),
  });
  renderVendor();
  render();
  startTick();
  try {
    await run({
      question, depth: app.depth, engines: ids, post: app.post, keys: app.keys.all(), local: app.mode === "local",
      search: app.search, embedder: ids.includes("embed") ? embedder() : null, signal: ctl.signal,
      emit: (e) => { if (state === s) { apply(s, e); scheduleRender(); } },
    });
  } catch (err) {
    if (!ctl.signal.aborted) s.error = err.message;
  }
  if (state === s) {
    s.status = s.error ? "error" : "done";
    stopTick();
    render();
    window.__jevLast = summary(s);
  }
}

function apply(s, e) {
  const L = e.lane ? s.lanes[e.lane] : null;
  switch (e.type) {
    case "search": s.search = e; break;
    case "lane": Object.assign(L, { start: e.t, keys: e.keys, chars: e.chars }); break;
    case "load": L.engine.loadAt = e.t; break;
    case "engine": L.engine.startAt = e.t; break;
    case "pick":
      if (e.stage === "sections") Object.assign(L.engine, { sections: e.rows, sectionsMs: e.ms, confidence: e.confidence ?? null, model: e.model || null });
      else Object.assign(L.engine, { fields: e.rows, fieldsMs: e.ms });
      break;
    case "picked": Object.assign(L.engine, { keep: e.keep, ms: e.ms, end: e.t, tokens: e.engineTokens }); break;
    case "delta": L.text += e.text; break;
    case "done": L.done = e; L.end = e.t; break;
    case "skip": L.skip = e.need; break;
    case "error": if (L) L.error = e.message; else s.error = e.message; break;
    case "end": s.end = e.t; break;
    default: break;
  }
}

let raf = 0;
function scheduleRender() {
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; render(); });
}

function startTick() { stopTick(); tick = setInterval(renderLanes, 100); }
function stopTick() { if (tick) clearInterval(tick); tick = null; }

/** the numbers the README table is built from, read by the screenshot script */
function summary(s) {
  const f = s.lanes.full;
  const fullIn = f.done && f.done.usage && f.done.usage.inputTokens;
  return {
    question: s.question, depth: s.depth, hits: s.search ? s.search.hits.map((x) => x.name) : [],
    lanes: Object.values(s.lanes).map((L) => {
      const inTok = L.done && L.done.usage ? L.done.usage.inputTokens : null;
      const o = L.id !== "full" && f.done && L.done ? overlap(f.text, L.text) : null;
      return {
        id: L.id, kept: keptLabel(L), keep: L.engine.keep, inputTokens: inTok, saving: L.id === "full" ? null : savingPct(fullIn, inTok),
        engineMs: L.engine.ms, ttft: L.done ? L.done.ttft : null, doneAt: L.end || null, agree: o ? [o.shared, o.total] : null,
        confidence: L.engine.confidence, engineTokens: L.engine.tokens, error: L.error, skip: L.skip, answer: L.text,
      };
    }),
  };
}

/* ── rendering ────────────────────────────────────────────────── */

function render() {
  renderFlow();
  renderBoard();
  renderMatrix();
  renderLanes();
  el.go.textContent = state && state.status === "running" ? "Asking…" : "Ask";
}

function renderMode() {
  el.mode.textContent = "";
  if (app.mode === "local") {
    el.mode.append(h("p.mode-pill", { title: "The proxy on this machine adds the maintainer's keys to every call." }, h("b", null, "Local"), " · keys stay on this machine"));
    return;
  }
  const row = (name, label, help) => {
    const v = app.keys.get(name);
    const exp = name === "enablers" ? jwtExpiry(v) : null;
    const st = !v ? "missing" : exp && exp < Date.now() ? "expired" : "set";
    const input = h("input", {
      type: "password", id: `key-${name}`, autocomplete: "off", spellcheck: "false", placeholder: "paste here",
      oninput: (e) => { app.keys.set(name, e.target.value); renderKeyStatus(); renderEngines(); },
    });
    input.value = v; // the property, never the attribute: a key does not belong in the markup
    return h("div.key", null,
      h("label", { for: `key-${name}` }, label),
      input,
      h(`span.key-st.is-${st}`, { id: `key-${name}-st` }, st === "set" && exp ? `set · ${days(exp)}` : st),
      h("p.key-help", null, help));
  };
  const keep = h("select", { id: "keep", onchange: (e) => app.keys.setKeep(e.target.value) },
    ["memory", "tab", "device"].map((k) => h("option", { value: k, selected: app.keys.keep() === k },
      { memory: "Forget on reload", tab: "Keep for this tab", device: "Keep on this device" }[k])));
  el.mode.append(
    h("p.mode-h", null, h("b", null, "Your keys"), " stay in this browser. The vendors refuse browser calls, so ",
      h("a", { href: RELAY_SRC, target: "_blank", rel: "noopener" }, "this site's relay"), " forwards them. It logs and stores nothing."),
    h("div.keys", null,
      row("jev", "Jev key", "From TypeSafe."),
      row("enablers", "Enablers token", h("code", null, "vault read -field=token identity/oidc/token/enablers"))),
    h("div.keep", null, h("label", { for: "keep" }, "Keys"), keep,
      h("button.linkish", { type: "button", onclick: () => { app.keys.forget(); renderMode(); renderEngines(); } }, "Forget keys")));
}

const days = (exp) => {
  const d = Math.round((exp - Date.now()) / 86400000);
  return d >= 1 ? `${d}\u00a0days left` : `${Math.max(1, Math.round((exp - Date.now()) / 60000))}\u00a0min left`;
};

function renderKeyStatus() {
  for (const name of ["jev", "enablers"]) {
    const n = $(`key-${name}-st`);
    if (!n) continue;
    const v = app.keys.get(name);
    const exp = name === "enablers" ? jwtExpiry(v) : null;
    const st = !v ? "missing" : exp && exp < Date.now() ? "expired" : "set";
    n.className = `key-st is-${st}`;
    n.textContent = st === "set" && exp ? `set · ${days(exp)}` : st;
  }
}

function renderVendor() {
  const q = state ? state.question : el.q.value;
  const parts = [];
  if (app.engines.has("jev")) parts.push(h("span", null, h("b", null, "Jev"), " is an outside vendor: your question goes to it. Ask about public data only."));
  else parts.push(h("span", null, "Your question stays inside Algolia and this browser."));
  if (looksNonEnglish(q)) parts.push(h("span.is-lang", null, " Jev reads English best; Laya also routes other languages."));
  el.vendor.textContent = "";
  el.vendor.append(...parts);
}

function renderEngines() {
  el.engines.textContent = "";
  el.engines.append(h("span.engines-l", null, "Engines"));
  for (const e of ENGINES) {
    const on = app.engines.has(e.id);
    const need = app.mode === "public" ? missingKey(e.id, { local: false, keys: app.keys.all() }) : null;
    el.engines.append(h("button.eng", {
      type: "button", "aria-pressed": String(on), "data-engine": e.id,
      title: need ? `Needs your ${need === "jev" ? "Jev key" : "Enablers token"}.` : null,
      onclick: () => {
        if (app.engines.has(e.id)) app.engines.delete(e.id); else app.engines.add(e.id);
        saveEngines();
        renderEngines();
        renderVendor();
        renderModel();
      },
    }, h("b", null, e.label), h("span", null, WHERE[e.where]), need && h("i.eng-need", { "aria-label": "needs a key" }, "key")));
  }
}

function renderModel() {
  el.model.textContent = "";
  if (!app.engines.has("embed")) return;
  const st = app.embedState || { status: "idle" };
  const mb = (b) => `${(b / 1e6).toFixed(1)}\u00a0MB`;
  const total = st.total || EMBED.approxBytes;
  const pct = st.status === "ready" ? 100 : Math.min(100, Math.round(((st.loaded || 0) / total) * 100));
  const label = st.status === "ready" ? `ready · ${st.device === "webgpu" ? "WebGPU" : "WASM"} · ${mb(total)}${st.cached ? " from cache" : " cached"}`
    : st.status === "loading" ? `${mb(st.loaded || 0)} of ${mb(total)}`
      : st.status === "error" ? `failed: ${st.error}` : `${mb(total)}, downloaded once, then cached`;
  el.model.append(
    h("span.model-n", null, h("b", null, "MiniLM-L6"), " embeddings"),
    h("span.model-bar", { role: "progressbar", "aria-valuenow": pct, "aria-valuemin": 0, "aria-valuemax": 100, "aria-label": "Model download" },
      h("i", { style: { width: `${pct}%` } })),
    h("span.model-st", { class: st.status === "error" ? "model-st is-error" : "model-st" }, label),
    ...(st.status === "idle" ? [h("button.linkish", { type: "button", onclick: () => embedder().load() }, "Load now")] : []));
}

function renderFlow() {
  const s = state;
  el.flow.textContent = "";
  if (!s) return;
  const hits = s.search ? s.search.hits : null;
  el.flow.append(h(`li.${hits ? "is-done" : "is-active"}`, null, h("span.flow-n", null, "1"), h("b", null, "Search"),
    h("span", null, hits ? `${hits.length ? hits.map((x) => x.name).join(", ") : "no country found"} · ${ms(s.search.ms)}` : "…")));
  el.flow.append(h(`li.${s.end ? "is-done" : hits && hits.length ? "is-active" : "is-wait"}`, null, h("span.flow-n", null, "2"),
    h("b", null, "Engines, then one LLM"), h("span", null, `${s.ids.length} engines · ${s.depth}`)));
  if (s.search && s.search.backend === "local") el.flow.append(h("li.is-note", null, "Searched factbook.jsonl locally: no index answered."));
  if (s.error) el.flow.append(h("li.is-error", null, s.error));
}

const fullIn = (s) => { const d = s.lanes.full.done; return d && d.usage ? d.usage.inputTokens : null; };
const laneIn = (L) => (L.done && L.done.usage ? L.done.usage.inputTokens : null);

function keptLabel(L) {
  if (L.id === "full") return `${SECTIONS.length} of ${SECTIONS.length}`;
  const e = L.engine;
  if (!e.sections) return null;
  const secs = e.sections.filter((r) => r.picked).length;
  if (e.fields) return `${e.fields.filter((r) => r.picked).length} of ${e.fields.length} fields`;
  return `${secs} of ${SECTIONS.length}`;
}

function renderBoard() {
  const s = state;
  el.board.textContent = "";
  if (!s) { el.board.append(h("p.board-empty", null, "Pick a question. The engines line up here.")); return; }
  if (s.search && !s.search.hits.length) { el.board.append(h("p.board-empty", null, "No country in that question. Name one, or pick a chip.")); return; }
  const a = fullIn(s);
  const t = h("table.board-t");
  t.append(h("thead", null, h("tr", null,
    h("th", { scope: "col" }, "Lane"), h("th", { scope: "col" }, "Kept"), h("th", { scope: "col" }, "Input tokens"),
    h("th", { scope: "col" }, "Saved"), h("th", { scope: "col", title: "Time the engine took to decide, from the browser." }, "Engine"),
    h("th", { scope: "col", title: "From the question to the last token of this lane's answer." }, "Answer done"),
    h("th", { scope: "col", title: "Figures and names of the full answer this answer also states. A text match, not a fact check." }, "Agrees"))));
  const body = h("tbody");
  for (const id of ["full", ...s.ids]) {
    const L = s.lanes[id];
    const n = laneIn(L);
    const pct = id === "full" ? null : savingPct(a, n);
    const o = id !== "full" && s.lanes.full.done && L.done ? overlap(s.lanes.full.text, L.text) : null;
    const w = Number.isFinite(a) && Number.isFinite(n) && a > 0 ? `${Math.min(100, (n / a) * 100)}%` : "0%";
    const pend = L.skip ? "—" : L.error ? "error" : "…";
    body.append(h(`tr.is-${id}`, null,
      h("th", { scope: "row" }, id === "full" ? "Full record" : engine(id).label),
      h("td.c-kept", { "data-l": "Kept" }, keptLabel(L) || pend),
      h("td.c-in", { "data-l": "Input tokens" }, h("span.cin", null,
        h("span.mini", null, h("i", { style: { width: id === "full" && Number.isFinite(a) ? "100%" : w } })),
        h("b", null, Number.isFinite(n) ? grouped(n) : L.skip ? `needs ${L.skip === "jev" ? "Jev key" : "token"}` : pend))),
      h("td.c-save", { "data-l": "Saved", class: pct !== null && pct > 0 ? "c-save is-worse" : "c-save" },
        pct === null ? (id === "full" ? "" : pend) : `${pct <= 0 ? "−" : "+"}${Math.abs(Math.round(pct))}%`),
      h("td.c-eng", { "data-l": "Engine" }, id === "full" ? "" : L.engine.ms !== null ? ms(L.engine.ms) : pend),
      h("td.c-done", { "data-l": "Answer done" }, L.end ? ms(L.end) : pend),
      h("td.c-agree", { "data-l": "Agrees" }, id === "full" ? "" : o ? `${o.shared} of ${o.total}` : pend)));
  }
  t.append(body);
  el.board.append(t);
}

function renderMatrix() {
  const s = state;
  el.matrix.textContent = "";
  if (!s || !s.ids.length || (s.search && !s.search.hits.length)) { el.matrix.hidden = true; return; }
  el.matrix.hidden = false;
  const grid = h("div.mx", { role: "table", "aria-label": "Sections each engine kept" });
  grid.append(h("div.mx-row.mx-head", { role: "row" }, h("span.mx-l", { role: "columnheader" }, ""),
    SECTIONS.map((sec) => h("span.mx-h", { role: "columnheader", title: sec.name }, h("span.full", null, WIDE[sec.name] || sec.name), h("span.short", null, SHORT[sec.name])))));
  for (const id of s.ids) {
    const e = s.lanes[id].engine;
    const rows = e.sections;
    const max = rows ? Math.max(1e-9, ...rows.map((r) => (Number.isFinite(r.score) ? r.score : 0))) : 1;
    const scale = engine(id).scale;
    grid.append(h("div.mx-row", { role: "row" },
      h("span.mx-l", { role: "rowheader" }, engine(id).label,
        e.confidence !== null && h("small", { title: "Confidence of the one section it would keep first. Below 0.79 it was often wrong in earlier studies." }, ` ${e.confidence.toFixed(2)}`)),
      SECTIONS.map((sec, i) => {
        const r = rows && rows[i];
        if (!r) return h("span.mx-c.is-wait", { role: "cell" });
        const v = Number.isFinite(r.score) ? (scale === "P(yes)" || scale === "kept" ? r.score : r.score / max) : 0;
        return h(`span.mx-c${r.picked ? ".is-kept" : ""}${r.fallback ? ".is-fb" : ""}${r.byMain ? ".is-main" : ""}`, {
          role: "cell", style: { "--v": Math.max(0, Math.min(1, v)).toFixed(2) },
          title: `${sec.name}: ${scale} ${Number.isFinite(r.score) ? r.score.toFixed(2) : "—"}${r.picked ? ", kept" : ""}${r.byMain ? " as its first pick" : ""}${r.fallback ? " (no clear pick)" : ""}`,
          "aria-label": `${sec.name} ${r.picked ? "kept" : "dropped"}`,
        });
      })));
  }
  el.matrix.append(grid);
}

function renderLanes() {
  const s = state;
  const now = s ? (s.status === "running" ? performance.now() - s.sentAt : Math.max(s.end || 0, 1)) : 1;
  const ids = s ? ["full", ...s.ids] : ["full"];
  const span = Math.max(now, ...ids.map((k) => (s ? s.lanes[k].end || 0 : 0)), 1);
  if (el.lanes.children.length !== ids.length || [...el.lanes.children].some((n, i) => n.dataset.lane !== ids[i])) {
    el.lanes.textContent = "";
    for (const id of ids) el.lanes.append(h(`section.lane.is-${id}`, { "data-lane": id, "aria-label": id === "full" ? "Full record" : engine(id).label }));
  }
  for (const node of el.lanes.children) laneView(node, node.dataset.lane, s, span, now);
}

function laneView(node, id, s, span, now) {
  node.textContent = "";
  const L = s ? s.lanes[id] : freshLane(id);
  const idle = !s || (s.search && !s.search.hits.length);
  const u = (L.done && L.done.usage) || {};
  const label = id === "full" ? "FULL RECORD" : engine(id).label.toUpperCase();
  node.append(h("header.lane-h", null,
    h("p.lane-tag", null, label),
    h("p.lane-w", null, id === "full" ? "13\u00a0sections, no engine" : WHERE[engine(id).where])));
  if (id !== "full") node.append(keptView(L));
  const a = s ? fullIn(s) : null;
  const pct = id === "full" ? null : savingPct(a, u.inputTokens);
  node.append(h("div.nums", null,
    h("div.num.is-in", null, h("b", null, Number.isFinite(u.inputTokens) ? grouped(u.inputTokens) : idle || L.skip ? "—" : "…"), h("span", null, "input tokens")),
    pct !== null && h("div.num.is-save", null, h("b", { class: pct > 0 ? "is-worse" : "" }, `${pct <= 0 ? "−" : "+"}${Math.abs(Math.round(pct))}%`), h("span", null, "vs full")),
    h("div.num", null, h("b", null, Number.isFinite(u.outputTokens) ? grouped(u.outputTokens) : idle || L.skip ? "—" : "…"), h("span", null, "output"))));
  node.append(track(L, idle ? null : s, span, now));
  const wait = idle || L.skip ? "—" : "…";
  const times = [];
  if (id !== "full") times.push(h("li.is-engine", null, h("b", null, L.engine.ms !== null ? ms(L.engine.ms) : wait), " engine"));
  times.push(h("li", null, h("b", null, L.done ? ms(L.done.ttft) : wait), " first token"));
  times.push(h("li", null, h("b", null, L.end ? ms(L.end) : wait), " done"));
  if (Number.isFinite(L.engine.tokens)) times.push(h("li.is-cache", { title: "Input tokens the engine's own call used." }, `${grouped(L.engine.tokens)} engine tokens`));
  node.append(h("ul.times", null, times));
  const ans = h("div.answer");
  if (L.error) ans.append(h("p.is-error", null, L.error));
  else if (L.skip) ans.append(h("p.answer-empty", null, `Add your ${L.skip === "jev" ? "Jev key" : "Enablers token"} above.`));
  else if (L.text) ans.innerHTML = window.renderMarkdown ? window.renderMarkdown(L.text) : "";
  else ans.append(h("p.answer-empty", null, idle ? "The answer appears here." : "…"));
  node.append(ans);
  if (id !== "full" && s && s.lanes.full.done && L.done) node.append(agreeView(s.lanes.full.text, L.text));
}

function keptView(L) {
  const e = L.engine;
  if (!e.sections) return h("p.kept.is-wait", null, e.loadAt !== null && e.startAt === null ? "loading the model…" : L.skip && !e.startAt ? "" : "deciding…");
  const secs = e.sections.filter((r) => r.picked);
  const p = h("p.kept");
  if (secs.length && secs.every((r) => r.fallback)) p.append(h("span.kept-fb", null, "no clear pick: kept all"));
  else p.append(...secs.map((r) => h(`span.kept-s${r.byMain ? ".is-main" : ""}`, { title: r.byMain ? "Under the line, kept as the section it would read first." : null }, r.name)));
  if (e.fields) {
    const f = e.fields.filter((r) => r.picked);
    const show = f.slice(0, 6);
    p.append(h("span.kept-n", null, `${f.length} of ${e.fields.length} fields`));
    p.append(...show.map((r) => h("span.kept-f", null, splitKey(r.key)[1])));
    if (f.length > show.length) p.append(h("span.kept-n", null, `+${f.length - show.length}`));
  }
  return p;
}

function agreeView(fullText, text) {
  const o = overlap(fullText, text);
  if (!o.total) return h("p.agree", null, "No figures or names to compare.");
  const missing = o.rows.filter((r) => !r.shared);
  return h("p.agree", { title: "Figures and names of the full answer that this answer also states. A text match, not a fact check." },
    h("b", null, `${o.shared} of ${o.total}`), " shared",
    missing.length ? h("span", null, " · only in full: ", missing.slice(0, 4).map((r) => h("code", null, r.value))) : null);
}

/** one lane on the shared clock: search, model load, engine, waiting for the first token, streaming */
function track(L, s, span, now) {
  const t = h("div.track", { role: "img", "aria-label": "timeline" });
  if (!s) return t;
  const pct = (x) => `${Math.max(0, Math.min(100, (x / span) * 100))}%`;
  const seg = (cls, a, b) => {
    if (a === null || b === null || b < a) return;
    t.append(h(`span.tseg.${cls}`, { style: { left: pct(a), width: `max(2px, ${pct(b - a)})` } }));
  };
  const searched = s.search ? s.search.t : now;
  seg("is-search", 0, searched);
  const e = L.engine;
  if (e.loadAt !== null) seg("is-load", e.loadAt, e.startAt !== null ? e.startAt : now);
  if (e.startAt !== null) seg("is-engine", e.startAt, e.end !== null ? e.end : now);
  if (L.start !== null) {
    const first = L.done ? L.start + L.done.ttft : L.text ? null : now;
    seg("is-wait", L.start, first !== null ? first : L.start);
    if (L.done) seg("is-stream", L.start + L.done.ttft, L.end);
    else if (L.text) seg("is-stream", L.start + 1, now);
  }
  return t;
}

/* ── controls ─────────────────────────────────────────────────── */

for (const q of SCENARIOS) {
  el.chips.append(h("button.chip", { type: "button", onclick: () => { el.q.value = q; ask(q); } }, q));
}
el.form.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = el.q.value.trim();
  if (q) ask(q);
});
el.q.addEventListener("input", () => { if (!state || state.status !== "running") renderVendor(); });
for (const b of el.form.querySelectorAll("[data-depth]")) {
  b.addEventListener("click", () => {
    app.depth = b.dataset.depth;
    for (const x of el.form.querySelectorAll("[data-depth]")) x.setAttribute("aria-pressed", String(x === b));
    if (state && state.question) ask(state.question);
  });
}

if (fromUrl.get("engines")) app.engines = new Set(fromUrl.get("engines").split(",").filter((id) => engine(id)));
if (fromUrl.get("depth") === "fields") el.form.querySelector('[data-depth="fields"]').click();

await detectMode();
renderMode();
renderVendor();
renderEngines();
renderModel();
render();
warmIfCached();
if (fromUrl.get("q")) { el.q.value = fromUrl.get("q"); ask(fromUrl.get("q")); }

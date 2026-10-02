/* ───────────────────────────────────────────────────────────────
   jev-attributes: Jev trims the records, then the fields.

   One catalog, two trims. RECORDS: Algolia ranks ten countries for a
   topical question; Jev answers one yes/no question per hit ("does this
   record help?"), from a short text per record, and the useless hits fold
   away. FIELDS: for the records a question needs, Jev answers one yes/no
   question per section of the record, from the question and the section
   descriptions only; the record shrinks to the sections Jev kept. BOTH
   runs the first, then the second on at most three kept records.

   No LLM answers anything here: the sizes are the evidence. Characters are
   counted; tokens are characters ÷ 4 and the page says "estimated" wherever
   it shows one. Jev's own usage is its own. Jev's answers are cached in
   this browser (cache.mjs): asking the same thing twice costs nothing.

   Two modes, found at startup:

     LOCAL    tools/jev-attributes/server.mjs answers /api/status: it holds
              the owner's Jev key, adds it to relay calls, and searches
     PUBLIC   no server of ours: the visitor pastes a Jev key (held in this
              browser, see byok.mjs), the relay forwards it, and search
              runs here on the secured key in shared/config.js
   ─────────────────────────────────────────────────────────────── */

import { ms, grouped } from "../shared/format.mjs";
import { SECTIONS, sectionSizes, trimTotals } from "./attrs.mjs";
import { relayTransport, systemOne, TARGETS } from "./client.mjs";
import { createBrowserCatalog } from "./search.mjs";
import { createKeyStore, jwtExpiry } from "./byok.mjs";
import { seenText, recordsState, recordsQuestions, requestChars, estTokens, fieldTargets, recordChars, readouts, runPipeline, partitionRecord } from "./records.mjs";
import { createJevCache, cachedCall } from "./cache.mjs";

const $ = (id) => document.getElementById(id);
const el = {
  keycard: $("keycard"), form: $("ask"), q: $("q"), go: $("go"), modes: $("modes"), chips: $("chips"),
  flow: $("flow"), stage: $("stage"), modal: $("rec-modal"),
};

/** a DOM node: h("p.cls", { title }, child, "text"); `style` takes custom properties too */
function h(spec, attrs, ...kids) {
  const [tag, ...cls] = spec.split(".");
  const n = document.createElement(tag || "div");
  if (cls.length) n.className = cls.join(" ");
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "style") for (const [p, x] of Object.entries(v)) n.style.setProperty(p, x);
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : String(v));
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) n.append(typeof k === "object" && k.nodeType ? k : String(k));
  return n;
}

const fromUrl = new URLSearchParams(location.search);

/* each chip names the mode it shows best: a topical question for the records, a named country for the fields */
const SCENARIOS = [
  { q: "Which Gulf countries export the most oil?", mode: "both" },
  { q: "Island nations that gained independence after 1960", mode: "both" },
  { q: "Where does the Danube flow?", mode: "both" },
  { q: "Peru's GDP growth", mode: "fields" },
  { q: "Which countries border Austria?", mode: "fields" },
];
const MODES = { records: "Records", fields: "Fields", both: "Both" };
const VIEW_LABELS = { name: "Name only", intro: "Name + 300\u00a0characters of background", snippet: "Name + matched snippet" };

/* the stage's scale: the sections of the biggest record on screen add up to STAGE_PX; style.css sets the floor a block never goes under */
const STAGE_PX = 300;
const RELAY_SRC = "https://github.com/algolia/agent-studio-demos/blob/main/functions/relay/%5B%5Bpath%5D%5D.js";
const README_RUN = "https://github.com/algolia/agent-studio-demos#run-it-two-modes";
const TYPESAFE = "https://typesafe.ai";

/* ── theme ────────────────────────────────────────────────────── */

(function themeToggle() {
  const btn = $("theme-toggle");
  const paint = () => {
    const dark = document.documentElement.dataset.theme === "dark";
    btn.setAttribute("aria-pressed", String(dark));
    $("theme-label").textContent = dark ? "Light" : "Dark";
    $("theme-glyph").textContent = dark ? "◑" : "◐";
  };
  btn.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("ic-theme", next); } catch (_) { /* private mode */ }
    paint();
  });
  paint();
})();

/* ── mode and key ─────────────────────────────────────────────── */

const app = {
  mode: null, // "local" | "public"
  relay: null, // "on" | "off": PUBLIC mode only, probed at startup
  localKey: false, // LOCAL: does the server hold a Jev key
  search: null, // (question, kind) → { hits, queries, ms, backend }
  getObject: null, // (objectID) → the whole record
  post: relayTransport("/relay"),
  keys: createKeyStore(),
  cache: createJevCache(),
  trim: ["records", "fields", "both"].includes(fromUrl.get("mode")) ? fromUrl.get("mode") : "both",
  view: "snippet",
};

async function detectMode() {
  const local = await fetch("/api/status", { signal: AbortSignal.timeout(1500) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (local && local.mode === "local") {
    app.mode = "local";
    app.localKey = Boolean(local.ready && local.ready.jev);
    app.search = async (q, kind) => {
      const r = await fetch(`/api/search?q=${encodeURIComponent(q)}&kind=${kind}`);
      if (!r.ok) throw new Error(`search HTTP ${r.status}`);
      return r.json();
    };
    app.getObject = async (id) => {
      const r = await fetch(`/api/object?id=${encodeURIComponent(id)}`);
      if (!r.ok) throw new Error(`getObject HTTP ${r.status}`);
      return r.json();
    };
    return;
  }
  app.mode = "public";
  app.relay = await relayState();
  await new Promise((ok) => {
    const s = document.createElement("script");
    s.src = "../shared/config.js";
    s.onload = ok;
    s.onerror = ok;
    document.head.append(s);
  });
  const cfg = window.DEMO_CONFIG && window.DEMO_CONFIG.jevAttributes;
  const catalog = cfg && cfg.appId && cfg.searchKey ? createBrowserCatalog(cfg) : null;
  const none = async () => { throw new Error("This site has no Factbook search key yet."); };
  app.search = catalog ? catalog.search : none;
  app.getObject = catalog ? catalog.getObject : none;
}

/**
 * Is this site's relay forwarding? A POST without a key answers 401 when it
 * is on; the Pages Function answers 404 while RELAY_ENABLED is unset, and a
 * host with no Function at all answers 404 or 405. Only 401 counts as on.
 */
async function relayState() {
  const r = await fetch("/relay/typesafe/systemone", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(3000),
  }).catch(() => null);
  return r && r.status === 401 ? "on" : "off";
}

function keyState() {
  const v = app.keys.get("jev");
  const exp = jwtExpiry(v);
  if (!v) return { cls: "missing", text: "not set" };
  if (exp && exp < Date.now()) return { cls: "expired", text: "expired" };
  if (exp) return { cls: "set", text: `set, expires ${new Date(exp).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}` };
  return { cls: "set", text: "set" };
}

/** why Ask cannot run right now, or null */
function blocked() {
  if (app.mode === "local") return app.localKey ? null : "The local server has no Jev key.";
  if (app.relay !== "on") return "Forwarding is off on this site.";
  const st = keyState().cls;
  if (st === "missing") return "Add your Jev key first.";
  if (st === "expired") return "Your Jev key has expired.";
  return null;
}

function cacheLink() {
  const n = app.cache.size();
  return h("button.linkish.kc-cache", {
    type: "button", disabled: n === 0,
    onclick: () => { app.cache.clear(); renderKeycard(); },
  }, n ? `Clear cache (${n} ${n === 1 ? "answer" : "answers"})` : "Cache empty");
}

function renderKeycard() {
  const k = el.keycard;
  k.textContent = "";
  k.className = "keycard";
  if (app.mode === "local" || app.relay !== "on") {
    k.classList.add("is-line");
    if (app.mode === "local") {
      k.append(h("p.kc-line", null, h(`span.pill.is-${app.localKey ? "set" : "missing"}`, null, app.localKey ? "set" : "not set"),
        app.localKey ? "Key held by the local server. " : "The local server has no Jev key. Set JEV_API_KEY, then restart it. ", cacheLink()));
    } else {
      k.append(h("p.kc-line", null, h("span.pill.is-off", null, "forwarding off"),
        "Forwarding is off on this site, so Jev is out of reach here. ",
        h("a", { href: README_RUN, target: "_blank", rel: "noopener" }, "Run it locally"), " to try it."));
    }
    return;
  }
  const st = keyState();
  const input = h("input", {
    type: "password", id: "jev-key", autocomplete: "off", spellcheck: "false", placeholder: "paste it here",
    oninput: (e) => { app.keys.set("jev", e.target.value); paintKeyState(); updateGo(); },
  });
  input.value = app.keys.get("jev"); // the property, never the attribute: a key does not belong in the markup
  const show = h("button.kc-show", {
    type: "button", "aria-pressed": "false", "aria-controls": "jev-key",
    onclick: () => {
      const on = input.type === "password";
      input.type = on ? "text" : "password";
      show.setAttribute("aria-pressed", String(on));
      show.textContent = on ? "Hide" : "Show";
    },
  }, "Show");
  const keep = h("select", { id: "keep", onchange: (e) => app.keys.setKeep(e.target.value) },
    ["memory", "tab", "device"].map((x) => h("option", { value: x, selected: app.keys.keep() === x },
      { memory: "Forget on reload", tab: "Keep for this tab", device: "Keep on this device" }[x])));
  k.append(
    h("label.kc-l", { for: "jev-key" }, "Your Jev key"),
    h("div.kc-field", null, input, show),
    h(`span.pill.is-${st.cls}`, { id: "jev-st", "aria-live": "polite" }, st.text),
    h("div.kc-opts", null,
      h("label.sr-only", { for: "keep" }, "Where to keep it"), keep,
      h("button.linkish", { type: "button", onclick: () => { app.keys.forget(); renderKeycard(); updateGo(); } }, "Forget"),
      cacheLink()),
    h("p.kc-help", null, "Get a key at ", h("a", { href: TYPESAFE, target: "_blank", rel: "noopener" }, "typesafe.ai"),
      "; it leaves this browser only to reach TypeSafe. ",
      h("a", { href: RELAY_SRC, target: "_blank", rel: "noopener" }, "This site forwards it"),
      ", because TypeSafe does not answer browsers directly."));
}

function paintKeyState() {
  const n = $("jev-st");
  if (!n) return;
  const st = keyState();
  n.className = `pill is-${st.cls}`;
  n.textContent = st.text;
}

const busy = () => Boolean(run && run.status === "running");

function updateGo() {
  const why = blocked();
  el.go.disabled = Boolean(why) || busy();
  el.go.title = why || "";
  el.go.textContent = busy() ? "Asking…" : "Ask";
}

/* ── the mode bar: what Jev trims, and what it reads of a record ── */

function renderModes() {
  el.modes.textContent = "";
  const seg = (name, opts, current, set) => h("div.seg", { role: "group", "aria-label": name },
    Object.entries(opts).map(([v, label]) => h("button.seg-b", {
      type: "button", "aria-pressed": String(v === current), "data-v": v, onclick: () => set(v),
    }, label)));
  el.modes.append(h("div.mode-row", null,
    h("span.mode-l", { "aria-hidden": "true" }, "Jev trims"),
    seg("What Jev trims", MODES, app.trim, (v) => { app.trim = v; renderModes(); if (!run) renderFlow(); })));
  if (app.trim !== "fields") {
    el.modes.append(h("div.mode-row", null,
      h("span.mode-l", { "aria-hidden": "true" }, "Jev sees"),
      seg("What Jev sees of each record", VIEW_LABELS, app.view, (v) => { app.view = v; renderModes(); })));
    el.modes.append(h("p.mode-cost", { "aria-live": "polite" }, viewCost()));
  }
}

/** "Jev reads ≈ 812 tokens": the records request for the hits on screen, under the current view */
function viewCost() {
  const hits = run && run.search && run.search.hits && run.search.hits.length && run.kind === "records" ? run.search.hits : null;
  if (!hits) return "Ask, and this line counts what Jev reads of the hits.";
  const chars = requestChars(recordsState(run.question, hits, app.view), recordsQuestions(hits));
  return `Jev reads ≈\u00a0${grouped(estTokens(chars))}\u00a0tokens of ${hits.length} records, estimated (${grouped(chars)}\u00a0characters).`;
}

/* ── one question ─────────────────────────────────────────────── */

let run = null;
let ctl = null;
let tick = null;

/** one Jev call, through the cache: the same request twice is answered here, at no cost */
function jevCall(signal) {
  return (stage, state, questions) => cachedCall(app.cache, { model: TARGETS.jev.model, state, questions },
    () => systemOne(app.post, "jev", state, questions, { keys: app.mode === "local" ? {} : app.keys.all(), signal }));
}

async function ask(question) {
  if (blocked()) return;
  if (ctl) ctl.abort();
  ctl = new AbortController();
  const signal = ctl.signal;
  const mode = app.trim;
  const r = (run = {
    question, mode, view: app.view, kind: mode === "fields" ? "fields" : "records", status: "running",
    t0: performance.now(), search: null, records: null, fields: null, recordsStart: null, fieldsStart: null,
  });
  updateGo();
  renderFlow();
  startTick();
  const live = () => run === r && !signal.aborted;
  const jev = jevCall(signal);
  try {
    await runPipeline({
      mode, question, view: r.view,
      search: (q, kind) => app.search(q, kind),
      jev: async (stage, state, questions) => {
        if (!live()) throw new Error("superseded");
        r[`${stage}Start`] = performance.now();
        renderFlow();
        return jev(stage, state, questions);
      },
      on: (stage, result) => {
        if (!live()) return;
        r[stage] = result;
        if (stage === "search") { renderStage(); renderModes(); }
        if (stage === "records") applyRecords(r);
        if (stage === "fields") applyFields(r);
        renderFlow();
      },
    });
  } catch (err) {
    if (!live()) return;
    r.search = r.search || { error: err.message };
    renderStage();
  }
  if (!live()) return;
  r.status = "done";
  stopTick();
  updateGo();
  renderFlow();
  renderKeycard();
}

function plainError(message) {
  const m = String(message).match(/HTTP (\d{3})/);
  const code = m ? Number(m[1]) : null;
  if (code === 401 || code === 403) return `Jev refused the key (HTTP ${code}).`;
  if (code === 404) return "Forwarding is off on this site (HTTP 404).";
  if (code === 429) return "Jev is rate limiting this key (HTTP 429). Try again in a minute.";
  return String(message).slice(0, 160);
}

function startTick() { stopTick(); tick = setInterval(renderFlow, 100); }
function stopTick() { if (tick) clearInterval(tick); tick = null; }

/* ── the flow ─────────────────────────────────────────────────── */

function renderFlow() {
  const r = run;
  const now = performance.now();
  el.flow.textContent = "";
  const step = (state, n, name, ...text) => h(`li.is-${state}`, null, h("span.flow-n", null, n), h("b", null, name), h("span.flow-t", null, ...text));
  const mode = r ? r.mode : app.trim;
  const stages = mode === "fields" ? ["fields"] : mode === "records" ? ["records"] : ["records", "fields"];
  if (!r) {
    el.flow.append(step("wait", "1", "Search", "Algolia finds the countries"));
    stages.forEach((s, i) => el.flow.append(step("wait", String(i + 2), s === "records" ? "Jev records" : "Jev fields",
      s === "records" ? "one yes/no per hit" : "13 yes/no questions")));
    return;
  }
  const s = r.search;
  const searchText = !s ? `${ms(now - r.t0)}…`
    : s.error ? s.error
      : `${s.queries ? `${s.queries} ${s.queries === 1 ? "query" : "queries"} · ` : ""}${s.hits.length ? `${s.hits.length} ${s.hits.length === 1 ? "record" : "records"}` : "no country found"} · ${ms(s.ms)}${s.backend === "local" ? " · searched factbook.jsonl here" : ""}`;
  el.flow.append(step(!s ? "active" : s.error ? "error" : "done", "1", "Search", searchText));
  stages.forEach((stage, i) => {
    const j = r[stage];
    const start = r[`${stage}Start`];
    let state = "wait";
    let text = [stage === "fields" && mode === "both" ? "waits for Jev records" : "waits for search"];
    if (s && !s.error && !s.hits.length) text = ["not asked: no record"];
    if (j && j.error) { state = "error"; text = [plainError(j.error)]; }
    else if (j) { state = "done"; text = jevText(j); }
    else if (start) { state = "active"; text = [`${ms(now - start)}…`]; }
    el.flow.append(step(state, String(i + 2), stage === "records" ? "Jev records" : "Jev fields", ...text));
  });
}

/** a Jev step's line: its time, its model and its own usage, or a cache hit at no cost */
function jevText(j) {
  if (j.cached) return [h("span.cached", null, "cached"), " · ", h("s.was-ms", { title: "the first call's time" }, ms(j.ms)), " · 0\u00a0tokens, cached"];
  const u = j.usage || {};
  return [`${ms(j.ms)} · ${j.model} · ${Number.isFinite(u.inputTokens) ? grouped(u.inputTokens) : "?"} in, ${Number.isFinite(u.outputTokens) ? grouped(u.outputTokens) : "?"} out tokens`];
}

/* ── the stage ────────────────────────────────────────────────── */

function renderStage() {
  const r = run;
  el.stage.textContent = "";
  if (!r || !r.search || r.search.error) { el.stage.append(ghost()); return; }
  if (!r.search.hits.length) {
    el.stage.append(h("p.stage-empty", null, r.kind === "records"
      ? "No record matched. Try other words, or pick an example."
      : "No country in that question. Name one, or pick an example."));
    return;
  }
  if (r.kind === "records") el.stage.append(recordsBlock(r));
  else el.stage.append(fieldsBlock(r, r.search.hits));
}

/** before any question: the record's shape, 13 equal blocks, no numbers */
function ghost() {
  return h("div.recs.is-one", null, h("article.rec.is-ghost", { "aria-label": "A country record, before a question" },
    h("header.rec-h", null, h("h2.rec-name", null, "A country record"), h("p.rec-sub", null, "13\u00a0sections. Ask, and watch it shrink.")),
    h("ol.secs", null, SECTIONS.map((s, i) => h("li.sec", { style: { "--h": "0px", "--i": String(i) } },
      h("div.sec-in", null, h("div.sec-box", null, h("span.sec-name", null, s.name))))))));
}

/** the button that unfolds what Jev dropped, on the block it belongs to */
function fullToggle(block, more, less) {
  const t = h("button.linkish.stage-toggle", {
    type: "button", "aria-pressed": "false",
    onclick: () => {
      const full = block.classList.toggle("is-full");
      t.setAttribute("aria-pressed", String(full));
      t.textContent = full ? less : more;
    },
  }, more);
  return t;
}

const num = (label, value, key) => h("div.num", { "data-k": key }, h("dt", null, h("span.of", null, ""), label),
  h("dd", null, h("span.roll", null, h("b.was", null, grouped(value)), h("b.now", null, ""))));

function setNum(scope, key, now, total) {
  const n = scope.querySelector(`.num[data-k="${key}"]`);
  n.querySelector(".now").textContent = grouped(now);
  n.querySelector(".of").textContent = `of ${grouped(total)} `;
}

/* ── records: ten hits, each as wide as its record ──────────────── */

function recordsBlock(r) {
  const hits = r.search.hits;
  const chars = hits.map(recordChars);
  const biggest = Math.max(1, ...chars);
  const total = chars.reduce((a, b) => a + b, 0);
  const block = h("section.block.rblock", { "aria-label": "Jev trims the records" });
  block.append(
    h("div.stage-h", null,
      h("p.stage-key", null, h("i", { "aria-hidden": "true" }), "Each bar is Jev's P(yes) that the record helps. Kept at 0.5 or more."),
      fullToggle(block, `Show all ${hits.length}\u00a0records`, "Show what Jev kept")),
    h("dl.size.rsize", null, num("records", hits.length, "records"), num("characters", total, "chars"), num("≈ tokens, estimated", estTokens(total), "tokens")),
    h("ol.hits", null, hits.map((hit, i) => h("li.hit", {
      "data-id": hit.objectID, style: { "--w": (chars[i] / biggest).toFixed(3), "--i": String(i), "--p": "0" },
    }, h("div.hit-in", null, h("button.hit-box", {
      type: "button", "aria-haspopup": "dialog", onclick: (e) => openRecord(hit, "records", e.currentTarget),
    },
    h("span.hit-rank", { "aria-hidden": "true" }, String(i + 1)),
    h("span.hit-main", null,
      h("span.hit-name", null, hit.name),
      h("span.hit-text", null, seenText(hit, r.view) || "name only")),
    h("span.hit-size", null, `${grouped(chars[i])}\u00a0chars`),
    h("span.sec-p", { "aria-hidden": "true" }, h("span.track", null, h("i")), h("b", null, ""))))))),
    h("p.verdict", null, `Jev is reading ${hits.length}\u00a0records…`));
  block.classList.add("is-reading");
  return block;
}

function applyRecords(r) {
  const block = el.stage.querySelector(".rblock");
  if (!block) return;
  block.classList.remove("is-reading");
  const verdict = block.querySelector(".verdict");
  if (r.records.error) {
    block.classList.add("is-failed");
    verdict.textContent = "No decision from Jev, so every record stays.";
    return;
  }
  const rows = new Map(r.records.rows.map((x) => [x.id, x]));
  for (const li of block.querySelectorAll(".hit")) {
    const x = rows.get(li.dataset.id);
    li.style.setProperty("--p", String(x.p ?? 0));
    li.querySelector(".sec-p b").textContent = x.p === null ? "n/a" : x.p.toFixed(2);
    li.classList.add(x.kept ? "is-kept" : "is-dropped");
    if (x.top && (x.p === null || x.p < 0.5)) li.querySelector(".hit-size").before(h("span.sec-tag", { title: "No record reached 0.5, so the likeliest stays." }, "likeliest"));
  }
  const kept = r.records.rows.filter((x) => x.kept).map((x) => x.id);
  const ro = readouts(r.search.hits, kept, null);
  setNum(block, "records", ro.afterRecords.records, ro.all.records);
  setNum(block, "chars", ro.afterRecords.chars, ro.all.chars);
  setNum(block, "tokens", ro.afterRecords.tokens, ro.all.tokens);
  verdict.textContent = `Kept ${kept.length} of ${r.search.hits.length}\u00a0records, ${pct(ro.all.chars ? ro.afterRecords.chars / ro.all.chars : null)} of the characters.`;
  requestAnimationFrame(() => requestAnimationFrame(() => { if (run === r) block.classList.add("is-scored"); }));
  if (r.mode === "records") el.stage.append(readoutView(r));
  if (r.mode === "both") {
    const targets = new Set(fieldTargets(r.records.rows).map((x) => x.id));
    el.stage.append(fieldsBlock(r, r.search.hits.filter((hit) => targets.has(hit.objectID))));
  }
}

/* ── fields: a record as 13 sections, each as tall as its characters ── */

function fieldsBlock(r, hits) {
  const sizes = new Map(hits.map((hit) => [hit.objectID, sectionSizes(hit)]));
  const biggest = Math.max(1, ...[...sizes.values()].map((rows) => trimTotals(rows, []).total.chars));
  const scale = STAGE_PX / biggest;
  const block = h("section.block.fblock", { "aria-label": "Jev trims the fields" });
  if (r.mode === "both") block.append(h("h2.block-h", null, hits.length === 1 ? "Then the kept record, by section" : `Then the ${hits.length} likeliest kept records, by section`));
  block.append(h("div.stage-h", null,
    h("p.stage-key", null, h("i", { "aria-hidden": "true" }), "Each bar is Jev's P(yes) that the question needs the section. Kept at 0.5 or more."),
    fullToggle(block, "Show all 13\u00a0sections", "Show what Jev kept")),
  h(`div.recs${hits.length === 1 ? ".is-one" : ""}`, null, hits.map((hit) => recordView(hit, sizes.get(hit.objectID), scale))));
  return block;
}

function recordView(hit, sizes, scale) {
  const tot = trimTotals(sizes, SECTIONS.map((s) => s.id)).total;
  return h("article.rec.is-reading", { "data-id": hit.objectID, "aria-label": hit.name },
    h("header.rec-h", null,
      h("h2.rec-name", null, h("button.rec-open", {
        type: "button", "aria-haspopup": "dialog", title: "Open the whole record", onclick: (e) => openRecord(hit, "fields", e.currentTarget),
      }, hit.name)),
      h("div.size-bar", { "aria-hidden": "true", style: { "--share": "1" } }, h("i")),
      h("dl.size", null,
        num("fields", tot.fields, "fields"),
        num("characters", tot.chars, "chars"),
        num("≈ tokens, estimated", tot.tokens, "tokens"))),
    h("ol.secs", null, sizes.map((row, i) => h("li.sec", {
      "data-id": row.id, style: { "--h": `${(row.chars * scale).toFixed(1)}px`, "--i": String(i), "--p": "0" },
    }, h("div.sec-in", null, h("div.sec-box", null,
      h("span.sec-name", null, row.name),
      h("span.sec-meta", null, row.fields
        ? [h("span", null, `${grouped(row.chars)}\u00a0chars`), h("span.m-f", null, ` · ${row.fields} ${row.fields === 1 ? "field" : "fields"}`)]
        : "not in this record"),
      h("span.sec-p", { "aria-hidden": "true" }, h("span.track", null, h("i")), h("b", null, ""))))))),
    h("p.verdict", null, "Jev is reading the question…"));
}

function applyFields(r) {
  const block = el.stage.querySelector(".fblock");
  if (!block) return;
  for (const art of block.querySelectorAll(".rec[data-id]")) {
    art.classList.remove("is-reading");
    const verdict = art.querySelector(".verdict");
    if (r.fields.error) {
      // no decision: nothing is scored, nothing shrinks
      art.classList.add("is-failed");
      verdict.textContent = "No decision from Jev, so the whole record stays.";
      continue;
    }
    const rows = new Map(r.fields.rows.map((x) => [x.id, x]));
    for (const li of art.querySelectorAll(".sec")) {
      const x = rows.get(li.dataset.id);
      li.style.setProperty("--p", String(x.p ?? 0));
      li.querySelector(".sec-p b").textContent = x.p === null ? "n/a" : x.p.toFixed(2);
      li.classList.add(x.picked ? "is-kept" : "is-dropped");
      if (x.byMain || x.fallback) {
        li.querySelector(".sec-meta").before(h("span.sec-tag", { title: x.byMain ? "Under 0.5, kept as the one section Jev would read first." : "No section reached 0.5, so the likeliest stays." },
          x.byMain ? "first pick" : "likeliest"));
      }
    }
    const t = trimTotals(sectionSizes(r.search.hits.find((x) => x.objectID === art.dataset.id)), keptSections(r));
    for (const key of ["fields", "chars", "tokens"]) setNum(art, key, t.kept[key], t.total[key]);
    art.querySelector(".size-bar").style.setProperty("--share", String(t.share ?? 1));
    verdict.textContent = `Kept ${t.kept.sections} of ${t.total.sections}\u00a0sections, ${pct(t.share)} of the characters.`;
  }
  if (r.fields.error) return;
  // two frames: the blocks are painted at full size before they are told to shrink, so the change animates
  requestAnimationFrame(() => requestAnimationFrame(() => { if (run === r) block.classList.add("is-scored"); }));
  if (r.mode === "both") el.stage.append(readoutView(r));
}

const keptSections = (r) => (r.fields && r.fields.rows ? r.fields.rows.filter((x) => x.picked).map((x) => x.id) : null);

/** the run in three sizes: the hits in full, after the records, after the fields */
function readoutView(r) {
  const kept = r.records && r.records.rows ? r.records.rows.filter((x) => x.kept).map((x) => x.id) : null;
  const secs = keptSections(r);
  const fielded = r.fields && secs ? r.fields.targets.map((id) => ({ id, sectionIds: secs })) : null;
  const ro = readouts(r.search.hits, kept, fielded);
  const cell = (label, x, cls = "") => h(`div.ro${cls}`, null, h("span.ro-l", null, label),
    h("b.ro-n", null, `${grouped(x.chars)}\u00a0chars`), h("span.ro-t", null, `≈\u00a0${grouped(x.tokens)}\u00a0tokens`));
  const parts = [cell(`${ro.all.records}\u00a0hits, in full`, ro.all)];
  if (ro.afterRecords) parts.push(h("span.ro-arrow", { "aria-hidden": "true" }, "→"), cell(`after records: ${ro.afterRecords.records} kept`, ro.afterRecords, ro.afterFields ? "" : ".is-final"));
  if (ro.afterFields) parts.push(h("span.ro-arrow", { "aria-hidden": "true" }, "→"), cell(`after fields: ${ro.afterFields.records} trimmed`, ro.afterFields, ".is-final"));
  const last = ro.afterFields || ro.afterRecords;
  return h("section.readout", { "aria-label": "Sizes" },
    h("div.ro-row", null, parts),
    h("p.ro-note", null, `${pct(ro.all.chars ? last.chars / ro.all.chars : null)} of the characters left. Counted from the records; tokens are characters ÷ 4, estimated.`));
}

const pct = (share) => {
  if (share === null) return "none";
  const p = share * 100;
  return p > 0 && p < 1 ? "under 1%" : `${Math.round(p)}%`;
};

/* ── the whole record, in a modal ─────────────────────────────── */

let opener = null;

async function openRecord(hit, stage, from) {
  const r = run;
  opener = from;
  const m = el.modal;
  m.textContent = "";
  m.append(h("div.m-in", null, h("p.m-wait", null, `Fetching ${hit.name}…`)));
  if (!m.open) m.showModal();
  let record = null;
  let note = null;
  try {
    record = await app.getObject(hit.objectID);
  } catch (_) {
    record = Object.fromEntries(Object.entries(hit).filter(([k]) => !k.startsWith("_")));
    note = "getObject did not answer, so this is the record as search returned it.";
  }
  if (!m.open) return;
  const kept = r && r.fields && r.fields.rows && r.fields.targets.includes(hit.objectID) ? new Set(keptSections(r)) : null;
  const part = partitionRecord(record, { stage, view: r ? r.view : app.view, hit, kept });
  m.textContent = "";
  m.append(modalBody(record, part, stage, note));
  m.querySelector(".m-close").focus();
}

function modalBody(record, part, stage, note) {
  const c = part.counts;
  const legend = h("p.m-legend", null,
    h("span.lg.is-seen", null, "seen by Jev"), h("span.lg.is-unseen", null, "not seen"),
    part.sections.some((s) => s.kept !== null) ? [h("span.lg.is-kept", null, "kept section"), h("span.lg.is-dropped", null, "dropped section")] : null);
  return h("div.m-in", null,
    h("header.m-h", null,
      h("h2.m-name", { id: "m-title" }, h(`span.${part.name.seen ? "seen" : "unseen"}`, null, record.name)),
      h("button.m-close", { type: "button", onclick: closeRecord }, "Close")),
    legend,
    h("p.m-counts", null, `Jev read ${grouped(c.seen.chars)}\u00a0characters (≈\u00a0${grouped(c.seen.tokens)}\u00a0tokens). `
      + `Not seen: ${grouped(c.unseen.chars)}\u00a0characters (≈\u00a0${grouped(c.unseen.tokens)}\u00a0tokens). Estimated.`),
    note ? h("p.m-note", null, note) : null,
    stage === "fields" ? h("section.m-desc", null,
      h("h3", null, "What Jev read: the question and the 13\u00a0section descriptions, no record"),
      h("ul", null, part.descriptions.map((d) => h("li.seen", null, d)))) : null,
    part.sections.filter((s) => s.fields.length).map((s) => h(`section.m-sec${s.kept === null ? "" : s.kept ? ".is-kept" : ".is-dropped"}`, null,
      h("h3", null, s.name, s.kept === null ? null : h("span.m-tag", null, s.kept ? "kept" : "dropped")),
      h("dl", null, s.fields.flatMap((f) => [h("dt", null, f.field),
        h("dd", null, f.parts.map((p) => h(`span.${p.seen ? "seen" : "unseen"}`, null, p.text)))])))));
}

function closeRecord() {
  if (el.modal.open) el.modal.close();
}

el.modal.addEventListener("close", () => { if (opener && opener.isConnected) opener.focus(); opener = null; });
// a click on the backdrop lands on the dialog itself, outside its content
el.modal.addEventListener("click", (e) => { if (e.target === el.modal) closeRecord(); });

/* ── controls ─────────────────────────────────────────────────── */

for (const s of SCENARIOS) {
  el.chips.append(h("button.chip", {
    type: "button", "data-mode": s.mode, title: s.mode === "fields" ? "Runs in Fields" : "Runs in Both, or Records",
    onclick: () => {
      if (s.mode === "fields" && app.trim !== "fields") app.trim = "fields";
      if (s.mode !== "fields" && app.trim === "fields") app.trim = "both";
      renderModes();
      if (!run) renderFlow();
      el.q.value = s.q;
      if (blocked()) el.q.focus(); else ask(s.q);
    },
  }, s.q));
}
el.form.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = el.q.value.trim();
  if (q) ask(q);
});

renderModes();
renderFlow();
renderStage();
await detectMode();
renderKeycard();
updateGo();
if (fromUrl.get("q")) {
  // a link may fill the question in, but it spends no key: it waits for a click on Ask
  el.q.value = fromUrl.get("q").slice(0, 300);
  el.go.focus();
}

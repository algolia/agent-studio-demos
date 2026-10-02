/* ───────────────────────────────────────────────────────────────
   jev-attributes — Jev trims the record.

   A question comes in; Algolia finds the countries it names; Jev answers
   one yes/no question per section of the record, in one request; the
   record on screen shrinks to the sections Jev kept (P(yes) ≥ 0.5, plus
   its `main` pick). No LLM answers anything here: the sizes are the
   evidence. Characters are counted; tokens are characters ÷ 4 and the page
   says "estimated" wherever it shows one. Jev's own usage is its own.

   Two modes, found at startup:

     LOCAL    tools/jev-attributes/server.mjs answers /api/status: it holds
              the owner's Jev key, adds it to relay calls, and searches
     PUBLIC   no server of ours: the visitor pastes a Jev key (held in this
              browser, see byok.mjs), the relay forwards it, and search
              runs here on the secured key in shared/config.js
   ─────────────────────────────────────────────────────────────── */

import { ms, grouped } from "../shared/format.mjs";
import { SECTIONS, sectionState, sectionQuestions, pickSections, sectionSizes, trimTotals } from "./attrs.mjs";
import { relayTransport, systemOne } from "./client.mjs";
import { createBrowserSearch } from "./search.mjs";
import { createKeyStore, jwtExpiry } from "./byok.mjs";

const $ = (id) => document.getElementById(id);
const el = {
  keycard: $("keycard"), form: $("ask"), q: $("q"), go: $("go"), chips: $("chips"), flow: $("flow"), stage: $("stage"),
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

const SCENARIOS = [
  "Peru's GDP growth",
  "Which countries border Austria?",
  "Compare Japan and Germany military spending",
  "What languages are spoken in Switzerland?",
];

const MAX_RECORDS = 2;
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
  search: null,
  post: relayTransport("/relay"),
  keys: createKeyStore(),
};

async function detectMode() {
  const local = await fetch("/api/status", { signal: AbortSignal.timeout(1500) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (local && local.mode === "local") {
    app.mode = "local";
    app.localKey = Boolean(local.ready && local.ready.jev);
    app.search = async (q) => {
      const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      if (!r.ok) throw new Error(`search HTTP ${r.status}`);
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
  app.search = cfg && cfg.appId && cfg.searchKey
    ? createBrowserSearch(cfg)
    : async () => { throw new Error("This site has no Factbook search key yet."); };
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
  if (app.relay !== "on") return "The relay is off on this site.";
  const st = keyState().cls;
  if (st === "missing") return "Add your Jev key first.";
  if (st === "expired") return "Your Jev key has expired.";
  return null;
}

function renderKeycard() {
  const k = el.keycard;
  k.textContent = "";
  k.className = "keycard";
  if (app.mode === "local" || app.relay !== "on") {
    k.classList.add("is-line");
    if (app.mode === "local") {
      k.append(h("p.kc-line", null, h(`span.pill.is-${app.localKey ? "set" : "missing"}`, null, app.localKey ? "set" : "not set"),
        app.localKey ? "Key held by the local server." : "The local server has no Jev key. Set JEV_API_KEY, then restart it."));
    } else {
      k.append(h("p.kc-line", null, h("span.pill.is-off", null, "relay off"),
        "The relay is off on this site, so Jev is out of reach here. ",
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
      h("button.linkish", { type: "button", onclick: () => { app.keys.forget(); renderKeycard(); updateGo(); } }, "Forget")),
    h("p.kc-help", null, "Get a key at ", h("a", { href: TYPESAFE, target: "_blank", rel: "noopener" }, "typesafe.ai"),
      "; it leaves this browser only to reach TypeSafe through ",
      h("a", { href: RELAY_SRC, target: "_blank", rel: "noopener" }, "this site's relay"), "."));
}

function paintKeyState() {
  const n = $("jev-st");
  if (!n) return;
  const st = keyState();
  n.className = `pill is-${st.cls}`;
  n.textContent = st.text;
}

function updateGo() {
  const why = blocked();
  const busy = Boolean(run && (run.status === "search" || run.status === "jev"));
  el.go.disabled = Boolean(why) || busy;
  el.go.title = why || "";
  el.go.textContent = busy ? "Asking…" : "Ask";
}

/* ── one question ─────────────────────────────────────────────── */

let run = null;
let ctl = null;
let tick = null;

async function ask(question) {
  if (blocked()) return;
  if (ctl) ctl.abort();
  ctl = new AbortController();
  const signal = ctl.signal;
  const r = (run = { question, status: "search", t0: performance.now(), search: null, jev: null, sizes: new Map() });
  el.stage.classList.remove("is-scored", "is-full");
  updateGo();
  renderFlow();
  startTick();

  let s;
  try {
    s = await app.search(question);
  } catch (err) {
    if (run !== r) return;
    r.search = { error: err.message };
    return finish(r, "error");
  }
  if (run !== r) return;
  const hits = s.hits.slice(0, MAX_RECORDS);
  r.search = { ms: s.ms, hits, found: s.hits.length, backend: s.backend };
  for (const hit of hits) r.sizes.set(hit.objectID, sectionSizes(hit));
  renderStage();
  if (!hits.length) return finish(r, "done");

  r.status = "jev";
  r.jev = { start: performance.now() };
  renderFlow();
  try {
    // the data rule: Jev gets the question and the section descriptions, never a record
    const a = await systemOne(app.post, "jev", sectionState(question), sectionQuestions(), {
      keys: app.mode === "local" ? {} : app.keys.all(), signal,
    });
    if (run !== r) return;
    Object.assign(r.jev, { ms: performance.now() - r.jev.start, model: a.model, usage: a.usage, rows: pickSections(a.answers) });
    finish(r, "done");
  } catch (err) {
    if (run !== r || signal.aborted) return;
    r.jev.error = plainError(err.message);
    finish(r, "error");
  }
}

function finish(r, status) {
  r.status = status;
  stopTick();
  updateGo();
  renderFlow();
  if (r.jev) applyJev(r);
}

function plainError(message) {
  const m = String(message).match(/HTTP (\d{3})/);
  const code = m ? Number(m[1]) : null;
  if (code === 401 || code === 403) return `Jev refused the key (HTTP ${code}).`;
  if (code === 404) return "The relay is off on this site (HTTP 404).";
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
  const step = (state, n, name, text) => h(`li.is-${state}`, null, h("span.flow-n", null, n), h("b", null, name), h("span.flow-t", null, text));
  if (!r) {
    el.flow.append(step("wait", "1", "Search", "Algolia finds the countries"), step("wait", "2", "Jev", "one request, 13 yes/no questions"));
    return;
  }
  const s = r.search;
  const searchText = !s ? `${ms(now - r.t0)}…`
    : s.error ? s.error
      : `${s.found ? `${s.found} found` : "no country found"} · ${ms(s.ms)}${s.backend === "local" ? " · searched factbook.jsonl here" : ""}`;
  el.flow.append(step(!s ? "active" : s.error ? "error" : "done", "1", "Search", searchText));
  const j = r.jev;
  let jevText = "waits for search";
  let jevState = "wait";
  if (s && !s.error && !s.hits.length) jevText = "not asked: no record to trim";
  if (j && j.error) { jevState = "error"; jevText = j.error; }
  else if (j && j.rows) {
    jevState = "done";
    const u = j.usage || {};
    jevText = `${ms(j.ms)} · ${j.model} · ${Number.isFinite(u.inputTokens) ? grouped(u.inputTokens) : "?"} in, ${Number.isFinite(u.outputTokens) ? grouped(u.outputTokens) : "?"} out tokens`;
  } else if (j) { jevState = "active"; jevText = `${ms(now - j.start)}…`; }
  el.flow.append(step(jevState, "2", "Jev", jevText));
}

/* ── the stage ────────────────────────────────────────────────── */

function renderStage() {
  const r = run;
  el.stage.textContent = "";
  if (!r || !r.search || r.search.error) { el.stage.append(ghost()); return; }
  if (!r.search.hits.length) {
    el.stage.append(h("p.stage-empty", null, "No country in that question. Name one, or pick an example."));
    return;
  }
  const biggest = Math.max(1, ...[...r.sizes.values()].map((rows) => trimTotals(rows, []).total.chars));
  const scale = STAGE_PX / biggest;
  el.stage.append(stageHead(), h(`div.recs${r.search.hits.length === 1 ? ".is-one" : ""}`, null, r.search.hits.map((hit) => recordView(hit, r.sizes.get(hit.objectID), scale))));
}

/** before any question: the record's shape, 13 equal blocks, no numbers */
function ghost() {
  return h("div.recs.is-one", null, h("article.rec.is-ghost", { "aria-label": "A country record, before a question" },
    h("header.rec-h", null, h("h2.rec-name", null, "A country record"), h("p.rec-sub", null, "13 sections. Ask, and watch it shrink.")),
    h("ol.secs", null, SECTIONS.map((s, i) => h("li.sec", { style: { "--h": "0px", "--i": String(i) } },
      h("div.sec-in", null, h("div.sec-box", null, h("span.sec-name", null, s.name))))))));
}

function stageHead() {
  const toggle = h("button.linkish.stage-toggle", {
    type: "button", "aria-pressed": "false",
    onclick: () => {
      const full = el.stage.classList.toggle("is-full");
      toggle.setAttribute("aria-pressed", String(full));
      toggle.textContent = full ? "Show what Jev kept" : "Show all 13\u00a0sections";
    },
  }, "Show all 13\u00a0sections");
  return h("div.stage-h", null,
    h("p.stage-key", null, h("i", { "aria-hidden": "true" }), "Each bar is Jev's P(yes) that the question needs the section. Kept at 0.5 or more."),
    toggle);
}

function recordView(hit, sizes, scale) {
  const tot = trimTotals(sizes, SECTIONS.map((s) => s.id)).total;
  const num = (label, value, key) => h("div.num", { "data-k": key }, h("dt", null, h("span.of", null, ""), label),
    h("dd", null, h("span.roll", null, h("b.was", null, grouped(value)), h("b.now", null, ""))));
  return h("article.rec.is-reading", { "data-id": hit.objectID, "aria-label": hit.name },
    h("header.rec-h", null,
      h("h2.rec-name", null, hit.name),
      h("div.size-bar", { "aria-hidden": "true", style: { "--share": "1" } }, h("i")),
      h("dl.size", null,
        num("fields", tot.fields, "fields"),
        num("characters", tot.chars, "chars"),
        num("≈ tokens, estimated", tot.tokens, "tokens"))),
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

function applyJev(r) {
  for (const art of el.stage.querySelectorAll(".rec[data-id]")) {
    art.classList.remove("is-reading");
    const verdict = art.querySelector(".verdict");
    if (r.jev.error) {
      art.classList.add("is-failed");
      verdict.textContent = "No decision from Jev, so the whole record stays.";
      continue;
    }
    const rows = new Map(r.jev.rows.map((x) => [x.id, x]));
    for (const li of art.querySelectorAll(".sec")) {
      const x = rows.get(li.dataset.id);
      li.style.setProperty("--p", String(x.p ?? 0));
      li.querySelector(".sec-p b").textContent = x.p === null ? "—" : x.p.toFixed(2);
      li.classList.add(x.picked ? "is-kept" : "is-dropped");
      if (x.byMain || x.fallback) {
        li.querySelector(".sec-meta").before(h("span.sec-tag", { title: x.byMain ? "Under 0.5, kept as the one section Jev would read first." : "No section reached 0.5, so the likeliest stays." },
          x.byMain ? "first pick" : "likeliest"));
      }
    }
    const kept = r.jev.rows.filter((x) => x.picked).map((x) => x.id);
    const t = trimTotals(r.sizes.get(art.dataset.id), kept);
    for (const key of ["fields", "chars", "tokens"]) {
      const n = art.querySelector(`.num[data-k="${key}"]`);
      n.querySelector(".now").textContent = grouped(t.kept[key]);
      n.querySelector(".of").textContent = `of ${grouped(t.total[key])} `;
    }
    art.querySelector(".size-bar").style.setProperty("--share", String(t.share ?? 1));
    verdict.textContent = `Kept ${t.kept.sections} of ${t.total.sections}\u00a0sections, ${pct(t.share)} of the characters.`;
  }
  // two frames: the blocks are painted at full size before they are told to shrink, so the change animates
  requestAnimationFrame(() => requestAnimationFrame(() => el.stage.classList.add("is-scored")));
}

const pct = (share) => {
  if (share === null) return "none";
  const p = share * 100;
  return p > 0 && p < 1 ? "under 1%" : `${Math.round(p)}%`;
};

/* ── controls ─────────────────────────────────────────────────── */

for (const q of SCENARIOS) {
  el.chips.append(h("button.chip", { type: "button", onclick: () => { el.q.value = q; if (blocked()) el.q.focus(); else ask(q); } }, q));
}
el.form.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = el.q.value.trim();
  if (q) ask(q);
});

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

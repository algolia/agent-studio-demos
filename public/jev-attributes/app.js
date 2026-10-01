/* ───────────────────────────────────────────────────────────────
   jev-attributes — one question, two lanes, one stream.

   The page posts the question to the local proxy (tools/jev-attributes/
   server.mjs) and draws what comes back: the hits, Jev's P(yes) per section,
   and two answers from the same model, one on the whole records and one on
   what Jev kept. Every token count is the API's own; the page computes only
   the saving between them.
   ─────────────────────────────────────────────────────────────── */

import { createSseParser } from "../shared/sse.mjs";
import { ms, grouped } from "../shared/format.mjs";
import { SECTIONS, THRESHOLD, savingPct, overlap, splitKey } from "./attrs.mjs";

const $ = (id) => document.getElementById(id);
const el = {
  form: $("ask"), q: $("q"), go: $("go"), chips: $("chips"), flow: $("flow"),
  saving: $("saving"), picks: $("picks"), full: $("lane-full"), filtered: $("lane-filtered"), check: $("check"),
};

/** a DOM node: h("p.cls", { title }, child, "text") */
function h(spec, attrs, ...kids) {
  const [tag, ...cls] = spec.split(".");
  const n = document.createElement(tag || "div");
  if (cls.length) n.className = cls.join(" ");
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "style") Object.assign(n.style, v);
    else if (k === "html") n.innerHTML = v;
    else n.setAttribute(k, v === true ? "" : String(v));
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) n.append(typeof k === "object" && k.nodeType ? k : String(k));
  return n;
}

const SCENARIOS = [
  "Peru's GDP growth",
  "Which countries border Austria?",
  "Compare Japan and Germany military spending",
  "What languages are spoken in Switzerland?",
  "Population over 65 in Italy",
  "Main exports of Chile",
  "What is the capital of Burma?",
  "How many airports does Kenya have?",
];

const LANES = {
  full: { label: "Full records", tag: "FULL" },
  filtered: { label: "Jev-filtered", tag: "JEV-FILTERED" },
};

let depth = "sections";
let state = null;
let ctl = null;
let tick = null;

const freshLane = () => ({ start: null, keys: null, chars: null, text: "", done: null, error: null });
function fresh(question) {
  return {
    question, depth, status: "running", sentAt: performance.now(), search: null,
    jev: { sections: null, fields: null, ms: null, sectionsMs: null, fieldsMs: null, done: null },
    lanes: { full: freshLane(), filtered: freshLane() }, error: null, end: null,
  };
}

/* ── the run ──────────────────────────────────────────────────── */

async function run(question) {
  if (ctl) ctl.abort();
  ctl = new AbortController();
  const s = (state = fresh(question));
  render();
  startTick();
  const parser = createSseParser((evt) => { if (state === s) apply(s, evt); });
  try {
    const res = await fetch("/api/run", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, depth }), signal: ctl.signal,
    });
    if (!res.ok || !res.body) throw new Error(`proxy HTTP ${res.status}`);
    const reader = res.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      parser.push(value);
      render();
    }
    parser.end();
  } catch (err) {
    if (err.name === "AbortError") return;
    s.error = /fetch|proxy/i.test(err.message) ? "The proxy is not running. Start tools/jev-attributes/server.mjs." : err.message;
  }
  if (state === s) {
    s.status = s.error ? "error" : "done";
    stopTick();
    render();
  }
}

function apply(s, e) {
  switch (e.type) {
    case "search": s.search = e; break;
    case "lane": Object.assign(s.lanes[e.lane], { start: e.t, keys: e.keys, chars: e.chars }); break;
    case "jev":
      if (e.stage === "sections") { s.jev.sections = e.rows; s.jev.sectionsMs = e.ms; } else { s.jev.fields = e.rows; s.jev.fieldsMs = e.ms; }
      break;
    case "jevDone": s.jev.ms = e.ms; s.jev.done = e.t; break;
    case "delta": s.lanes[e.lane].text += e.text; break;
    case "done": s.lanes[e.lane].done = e; s.lanes[e.lane].end = e.t; break;
    case "error":
      if (e.lane) s.lanes[e.lane].error = e.message; else s.error = e.message;
      break;
    case "end": s.end = e.t; break;
    default: break;
  }
}

/** the lanes' clocks move while the stream is quiet, ten times a second */
function startTick() {
  stopTick();
  tick = setInterval(renderLanes, 100);
}
function stopTick() { if (tick) clearInterval(tick); tick = null; }

/* ── rendering ────────────────────────────────────────────────── */

function render() {
  renderFlow();
  renderSaving();
  renderPicks();
  renderLanes();
  renderCheck();
  el.go.textContent = state && state.status === "running" ? "Asking…" : "Ask";
}

function renderFlow() {
  const s = state;
  el.flow.textContent = "";
  if (!s) return;
  const step = (cls, n, title, detail) => h(`li.${cls}`, null, h("span.flow-n", null, n), h("b", null, title), h("span", null, detail));
  const hits = s.search ? s.search.hits : null;
  el.flow.append(
    step(hits ? "is-done" : "is-active", "1", "Search",
      hits ? `${hits.length ? hits.map((x) => x.name).join(", ") : "no country found"} · ${ms(s.search.ms)}` : "…"),
    step(s.jev.done ? "is-done" : hits && hits.length ? "is-active" : "is-wait", "2", "Jev",
      s.jev.done !== null
        ? `${SECTIONS.length} questions${s.jev.fields ? ` + ${s.jev.fields.length}` : ""} · ${ms(s.jev.ms)}`
        : hits && !hits.length ? "not asked" : "…"),
    step(s.lanes.full.done && s.lanes.filtered.done ? "is-done" : s.lanes.full.start !== null ? "is-active" : "is-wait", "3", "LLM",
      s.lanes.full.done ? `${s.lanes.full.done.model || "same model"} · both lanes` : "both lanes, one model"),
  );
  if (s.search && s.search.backend === "local") el.flow.append(h("li.is-note", null, "Searched factbook.jsonl locally: no index answered."));
  if (s.error) el.flow.append(h("li.is-error", null, s.error));
}

function renderSaving() {
  const s = state;
  el.saving.textContent = "";
  if (!s) {
    el.saving.append(h("p.saving-empty", null, "Pick a question. The saving shows here."));
    return;
  }
  if (s.search && !s.search.hits.length) {
    el.saving.append(h("p.saving-empty", null, "No country in that question. Name one, or pick a chip."));
    return;
  }
  const a = s.lanes.full.done && s.lanes.full.done.usage && s.lanes.full.done.usage.inputTokens;
  const b = s.lanes.filtered.done && s.lanes.filtered.done.usage && s.lanes.filtered.done.usage.inputTokens;
  const pct = savingPct(a, b);
  const big = pct === null ? "…" : `${pct <= 0 ? "−" : "+"}${Math.abs(Math.round(pct))}%`;
  const width = (n) => (Number.isFinite(a) && Number.isFinite(n) && a > 0 ? `${Math.min(100, (n / a) * 100)}%` : "0%");
  el.saving.append(
    h("div.saving-big", { "aria-label": pct === null ? "saving pending" : `${big} input tokens` },
      h("b", { class: pct !== null && pct > 0 ? "is-worse" : "" }, big), h("span", null, "input tokens")),
    h("div.bars", null,
      bar("Full", a, Number.isFinite(a) ? "100%" : "0%", "is-full"),
      bar("Jev-filtered", b, width(b), "is-filtered")),
  );
}

function bar(label, n, w, cls) {
  return h(`div.bar.${cls}`, null,
    h("span.bar-l", null, label),
    h("span.bar-t", null, h("i", { style: { width: w } })),
    h("span.bar-n", null, Number.isFinite(n) ? grouped(n) : "…"));
}

function renderPicks() {
  const s = state;
  el.picks.textContent = "";
  const noHits = s && s.search && !s.search.hits.length;
  if (!s || noHits || !s.jev.sections) {
    el.picks.hidden = !s || noHits;
    if (s) el.picks.append(h("p.picks-h", null, h("b", null, "Jev"), " reading the question…"));
    return;
  }
  el.picks.hidden = false;
  const kept = s.jev.sections.filter((r) => r.picked).length;
  const fallback = s.jev.sections.some((r) => r.fallback);
  el.picks.append(h("p.picks-h", null,
    h("b", null, `Kept ${kept} of ${SECTIONS.length}\u00a0sections`),
    fallback && h("span.picks-fb", null, " · none cleared the line, so the top one stays"),
    h("span", { title: "Jev answers one yes/no question per section, all in one request. A section at or over the line is kept." },
      ` · P(yes) ≥ ${THRESHOLD} · ${ms(s.jev.sectionsMs)}`)));
  const list = h("ul.sections", { style: { "--line-at": `${THRESHOLD * 100}%` } });
  for (const r of s.jev.sections) {
    list.append(h(`li${r.picked ? ".is-picked" : ""}`, { title: r.fallback ? "Nothing cleared the line, so the top section is kept." : null },
      h("span.sec-name", null, r.name),
      h("span.sec-bar", null, h("i", { style: { width: `${Math.round((r.p || 0) * 100)}%` } })),
      h("span.sec-p", null, r.p === null ? "—" : r.p.toFixed(2))));
  }
  el.picks.append(list);
  if (s.jev.fields) {
    const picked = s.jev.fields.filter((r) => r.picked).sort((x, y) => y.p - x.p);
    el.picks.append(h("p.picks-h.is-fields", null,
      h("b", null, `Then kept ${picked.length} of ${s.jev.fields.length} fields`), ` · ${ms(s.jev.fieldsMs)}`));
    el.picks.append(h("ul.fields", null, picked.map((r) =>
      h("li", null, h("span", null, splitKey(r.key)[1]), h("b", null, r.p.toFixed(2))))));
  }
}

function renderLanes() {
  const s = state;
  const now = s ? (s.status === "running" ? performance.now() - s.sentAt : Math.max(s.end || 0, 1)) : 1;
  const ends = s ? ["full", "filtered"].map((k) => s.lanes[k].end || 0) : [];
  const span = Math.max(now, ...ends, 1);
  for (const k of Object.keys(LANES)) laneView(el[k], k, s, span, now);
}

function laneView(node, key, s, span, now) {
  const L = LANES[key];
  node.textContent = "";
  const lane = s ? s.lanes[key] : freshLane();
  const idle = !s || (s.search && !s.search.hits.length);
  const d = lane.done;
  const u = (d && d.usage) || {};
  node.append(h("header.lane-h", null,
    h("p.lane-tag", null, L.tag),
    h("p.lane-w", null, lane.keys === null ? (idle ? "" : "waiting…") : `${grouped(lane.keys)} attributes · ${grouped(lane.chars)}\u00a0chars`)));
  node.append(h("div.nums", null,
    h("div.num.is-in", null, h("b", null, Number.isFinite(u.inputTokens) ? grouped(u.inputTokens) : idle ? "—" : "…"), h("span", null, "input tokens")),
    h("div.num", null, h("b", null, Number.isFinite(u.outputTokens) ? grouped(u.outputTokens) : idle ? "—" : "…"), h("span", null, "output tokens")),
  ));
  node.append(track(key, idle ? null : s, span, now));
  const wait = idle ? "—" : "…";
  const times = [];
  if (key === "filtered") times.push(h("li.is-jev", null, h("b", null, s && s.jev.ms !== null ? ms(s.jev.ms) : wait), " Jev"));
  times.push(h("li", null, h("b", null, d ? ms(d.ttft) : wait), " first token"));
  times.push(h("li", null, h("b", null, d ? ms(lane.end) : wait), " answer done",
    h("span.sr-only", null, " since the question was sent")));
  if (Number.isFinite(u.cachedTokens) && u.cachedTokens > 0) times.push(h("li.is-cache", { title: "Input tokens the gateway served from its prefix cache." }, `${grouped(u.cachedTokens)} cached`));
  node.append(h("ul.times", null, times));
  const ans = h("div.answer");
  if (lane.error) ans.append(h("p.is-error", null, lane.error));
  else if (lane.text) ans.innerHTML = window.renderMarkdown ? window.renderMarkdown(lane.text) : "";
  else ans.append(h("p.answer-empty", null, idle ? "The answer appears here." : "…"));
  node.append(ans);
}

/** one lane on the shared clock: search, Jev, waiting for the first token, streaming */
function track(key, s, span, now) {
  const t = h("div.track", { role: "img", "aria-label": `${LANES[key].label} timeline` });
  if (!s) return t;
  const pct = (x) => `${Math.max(0, Math.min(100, (x / span) * 100))}%`;
  const seg = (cls, a, b, title) => {
    if (a === null || b === null || b < a) return;
    t.append(h(`span.tseg.${cls}`, { style: { left: pct(a), width: `max(2px, ${pct(b - a)})` }, title }));
  };
  const lane = s.lanes[key];
  const searched = s.search ? s.search.t : now;
  seg("is-search", 0, searched, "search");
  if (key === "filtered" && s.search) seg("is-jev", searched, s.jev.done !== null ? s.jev.done : now, "Jev");
  if (lane.start !== null) {
    const first = lane.done ? lane.start + lane.done.ttft : lane.text ? null : now;
    seg("is-wait", lane.start, first !== null ? first : lane.start, "waiting for the first token");
    if (lane.done) seg("is-stream", lane.start + lane.done.ttft, lane.end, "streaming");
    else if (lane.text) seg("is-stream", lane.start + 1, now, "streaming");
  }
  return t;
}

function renderCheck() {
  const s = state;
  el.check.textContent = "";
  if (!s || !s.lanes.full.done || !s.lanes.filtered.done) return;
  const o = overlap(s.lanes.full.text, s.lanes.filtered.text);
  if (!o.total) {
    el.check.append(h("p.check-h", null, "No figures or names to compare. Read both answers."));
    return;
  }
  el.check.append(h("p.check-h", null,
    h("b", null, `${o.shared} of ${o.total}`),
    h("span", { title: "A text match on the figures and names in the full answer. It is not a fact check: read both answers." },
      " figures and names in the full answer also appear in the filtered one")));
  el.check.append(h("ul.facts", null, o.rows.map((r) =>
    h(`li.${r.shared ? "is-shared" : "is-missing"}`, { title: r.shared ? "in both answers" : "only in the full answer" },
      h("span", { "aria-hidden": "true" }, r.shared ? "✓" : "✗"), ` ${r.value}`))));
}

/* ── controls ─────────────────────────────────────────────────── */

for (const q of SCENARIOS) {
  const b = h("button.chip", { type: "button" }, q);
  b.addEventListener("click", () => { el.q.value = q; run(q); });
  el.chips.append(b);
}
el.form.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = el.q.value.trim();
  if (q) run(q);
});
for (const b of el.form.querySelectorAll("[data-depth]")) {
  b.addEventListener("click", () => {
    depth = b.dataset.depth;
    for (const x of el.form.querySelectorAll("[data-depth]")) x.setAttribute("aria-pressed", String(x === b));
    if (state && state.question) run(state.question);
  });
}

const fromUrl = new URLSearchParams(location.search);
if (fromUrl.get("depth") === "fields") el.form.querySelector('[data-depth="fields"]').click();
render();
if (fromUrl.get("q")) { el.q.value = fromUrl.get("q"); run(fromUrl.get("q")); }

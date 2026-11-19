/* Query rewrite demo — raw keyword search left, task states right. */
"use strict";

const FORM = document.getElementById("form");
const INPUT = document.getElementById("message");
const CHIPS = document.getElementById("chips");
const STATUS = document.getElementById("status");
const RAW = document.getElementById("raw");
const RAW_META = document.getElementById("raw-meta");
const STATES = document.getElementById("states");
const STATES_META = document.getElementById("states-meta");

const vals = (list) =>
  Array.isArray(list) && list.length
    ? `<div class="vals">${list.map((v) => `<span class="val">${Rush.esc(v)}</span>`).join("")}</div>`
    : "";

const FILTER_KEYS = ["facetFilters", "numericFilters", "filters"];
const stateFilters = (s) => {
  const src = { ...(s.filters || {}), ...s };
  const out = {};
  for (const k of FILTER_KEYS) if (src[k] && (typeof src[k] === "string" || src[k].length)) out[k] = src[k];
  return out;
};
const filterVals = (f) => vals(FILTER_KEYS.flatMap((k) => (f[k] ? [].concat(f[k]).flat() : [])));

const none = (msg) => `<li class="hit-none">${Rush.esc(msg)}</li>`;
const renderHits = (hits, msg) => (hits.length ? hits.map((h) => Rush.hit(h)).join("") : none(msg));

let rawSeq = 0;
let rewriteSeq = 0;

/* Left panel: the raw message as the keyword engine sees it, on every keystroke. */
async function rawSearch(q) {
  const seq = ++rawSeq;
  try {
    const { hits, nbHits, ms } = await TasksCommon.search(q, { hitsPerPage: 6, relaxed: true });
    if (seq !== rawSeq) return;
    RAW_META.textContent = `${ms} ms · ${nbHits} total`;
    RAW.innerHTML = renderHits(hits, "Nothing close, even with typos, plurals and dropped words.");
  } catch (e) {
    if (seq === rawSeq) RAW.innerHTML = none(e.message);
  }
}

/* Right panel: one task call, then every state searched at once. */
async function rewrite(q) {
  const seq = ++rewriteSeq;
  STATES_META.textContent = "rewriting…";
  try {
    const { output, usage, ms } = await TasksCommon.run("algolia_query_generation", {
      message: q,
      agentContext: { facets: ["brand", "price"] },
    });
    if (seq !== rewriteSeq) return;
    const states = (output && output.states) || [];
    if (!states.length) throw new Error("task returned no states");
    const tokens = usage ? ` · ${usage.totalTokens ?? "?"} tokens` : "";
    STATES_META.textContent = `rewrite ${ms} ms${tokens}`;
    STATES.innerHTML = states
      .map((s, i) => {
        const f = stateFilters(s);
        return `
      <article class="state" data-i="${i}">
        <header class="state-head">
          <span class="state-n">#${i + 1}</span>
          <code class="state-query">${Rush.esc(s.query)}</code>
          <span class="state-ms"></span>
        </header>
        ${filterVals(f)}
        ${s.why ? `<p class="state-why">${Rush.esc(s.why)}</p>` : ""}
        <ul class="hits">${none("searching…")}</ul>
      </article>`;
      })
      .join("");
    await Promise.all(
      states.map(async (s, i) => {
        const card = STATES.querySelector(`[data-i="${i}"]`);
        try {
          const { hits, nbHits, ms: sms } = await TasksCommon.search(s.query || "", {
            hitsPerPage: 6,
            filters: stateFilters(s),
            relaxed: true,
          });
          if (seq !== rewriteSeq) return;
          card.querySelector(".state-ms").textContent = `${sms} ms · ${nbHits} total`;
          card.querySelector(".hits").innerHTML = renderHits(hits, "This state finds nothing.");
        } catch (e) {
          card.querySelector(".hits").innerHTML = none(e.message);
        }
      }),
    );
  } catch (e) {
    if (seq !== rewriteSeq) return;
    STATES_META.textContent = "";
    STATES.innerHTML = `<article class="state"><p class="state-why">${Rush.esc(e.message)}</p></article>`;
  }
}

let rewriteTimer;
/* Keystroke: raw search now, rewrite once the typing settles. now=true fires both. */
function run(q, now = true) {
  q = q.trim();
  clearTimeout(rewriteTimer);
  if (!q) {
    rawSeq++;
    rewriteSeq++;
    RAW.innerHTML = "";
    STATES.innerHTML = "";
    RAW_META.textContent = "";
    STATES_META.textContent = "";
    return;
  }
  Rush.activeChip(CHIPS, q);
  STATUS.textContent = "";
  rewriteSeq++;
  STATES.innerHTML = `<article class="state"><ul class="hits">${none("rewriting…")}</ul></article>`;
  rawSearch(q);
  if (now) rewrite(q);
  else {
    STATES_META.textContent = "waiting for you to stop typing…";
    rewriteTimer = setTimeout(() => rewrite(q), 450);
  }
}

FORM.addEventListener("submit", (e) => {
  e.preventDefault();
  run(INPUT.value);
});
INPUT.addEventListener("input", () => run(INPUT.value, false));
Rush.chips(CHIPS, (q) => {
  INPUT.value = q;
  run(q);
});

if (Rush.guard()) {
  INPUT.value = "glowy serum but not dior";
  run(INPUT.value);
}

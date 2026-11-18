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

/* Left panel: the raw keyword truth, as fast as the search round-trip. */
async function rawSearch(q) {
  try {
    const { hits, nbHits, ms } = await TasksCommon.search(q, { hitsPerPage: 6 });
    RAW_META.textContent = `${ms} ms · ${nbHits} total`;
    RAW.innerHTML = hits.length
      ? hits.map((h) => Rush.hit(h)).join("")
      : `<li class="hit-none">0 hits as written — every word has to match.</li>`;
  } catch (e) {
    RAW.innerHTML = `<li class="hit-none">${Rush.esc(e.message)}</li>`;
  }
}

/* Right panel: one task call, its states, each runnable. */
async function rewrite(q) {
  STATES_META.textContent = "task in flight…";
  try {
    const { output, usage, ms } = await TasksCommon.run("algolia_query_generation", {
      message: q,
      agentContext: { facets: ["brand", "colors", "price"] },
    });
    const states = (output && output.states) || [];
    if (!states.length) throw new Error("task returned no states");
    const tokens = usage ? ` · ${usage.totalTokens ?? "?"} tokens` : "";
    STATES_META.textContent = `rewrite ${ms} ms${tokens}`;
    STATES.innerHTML = states
      .map(
        (s, i) => `
      <article class="state" data-state="${Rush.esc(JSON.stringify(s))}">
        <header class="state-head">
          <span class="state-n">#${i + 1}</span>
          <code class="state-query">${Rush.esc(s.query)}</code>
          <span class="state-ms"></span>
        </header>
        ${vals(s.facetFilters)}
        ${vals(s.numericFilters)}
        ${s.why ? `<p class="state-why">${Rush.esc(s.why)}</p>` : ""}
        <div class="state-actions">
          <button type="button" class="run">Run live ▸</button>
        </div>
        <ul class="hits"></ul>
      </article>`
      )
      .join("");
  } catch (e) {
    STATES_META.textContent = "";
    STATES.innerHTML = `<article class="state"><p class="state-why">${Rush.esc(e.message)}</p></article>`;
  }
}

async function runLive(btn) {
  const card = btn.closest(".state");
  const state = JSON.parse(card.dataset.state);
  const out = card.querySelector(".hits");
  btn.disabled = true;
  try {
    const filters = {};
    if (state.facetFilters) filters.facetFilters = state.facetFilters;
    if (state.numericFilters) filters.numericFilters = state.numericFilters;
    const { hits, ms } = await TasksCommon.search(state.query || "", { hitsPerPage: 6, filters });
    card.querySelector(".state-ms").textContent = `${ms} ms`;
    out.innerHTML = hits.length
      ? hits.map((h) => Rush.hit(h)).join("")
      : `<li class="hit-none">0 hits — this state finds nothing as written.</li>`;
  } catch (e) {
    out.innerHTML = `<li class="hit-none">${Rush.esc(e.message)}</li>`;
  } finally {
    btn.disabled = false;
  }
}

function run(q) {
  q = q.trim();
  if (!q) return;
  INPUT.value = q;
  Rush.activeChip(CHIPS, q);
  STATUS.textContent = "";
  RAW.innerHTML = "";
  STATES.innerHTML = "";
  RAW_META.textContent = "searching…";
  rewrite(q);
  rawSearch(q);
}

FORM.addEventListener("submit", (e) => {
  e.preventDefault();
  run(INPUT.value);
});
Rush.chips(CHIPS, run);
STATES.addEventListener("click", (e) => {
  const b = e.target.closest("button.run");
  if (b) runLive(b);
});

if (Rush.guard()) {
  run("glowy serum but not dior");
}

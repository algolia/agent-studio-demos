/* Rerank demo — pools preloaded, keyword order left, raw-then-rerank FLIP right. */
"use strict";

/* ?engine=decisions ranks with the /decisions endpoint (one score question per
   hit) instead of the rerank task. Same page, same panels, same latency line. */
const ENGINE = new URLSearchParams(window.location.search).get("engine") === "decisions" ? "decisions" : "tasks";
const POOL_N = ENGINE === "decisions" ? 32 : 20;
const TOP_K = 10;
const DESCRIPTION_CAP = 240;

const FORM = document.getElementById("form");
const INPUT = document.getElementById("message");
const CHIPS = document.getElementById("chips");
const STATUS = document.getElementById("status");
const RAW = document.getElementById("raw");
const RAW_META = document.getElementById("raw-meta");
const RANKED = document.getElementById("ranked");
const RANK_META = document.getElementById("rank-meta");
const REFLECTION = document.getElementById("reflection");
const REF_MOVE = document.getElementById("reflection-move");
const REF_NOTE = document.getElementById("reflection-note");

/* query → pool, warmed on load for every example chip. */
const warm = new Map();
let current = "";
let inflight = false;
let queued = false;
let agentIds = new Set();

const row = (h, badge, cls) => Rush.hit(h, { badge, cls });

/* Exactly min(TOP_K, pool) ids: the agent's order, deduped and validated,
   then any missing slots filled in keyword order — marked as fallback.
   The task promises min(topK, N); this keeps the panel honest when a run
   returns 9. */
function mergeRanked(hits, rankedIds) {
  const inPool = new Set(hits.map((h) => h.objectID));
  const seen = new Set();
  const ids = [];
  for (const r of rankedIds || []) {
    const id = r && r.objectId;
    if (!id || !inPool.has(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  for (const h of hits) {
    if (ids.length >= TOP_K) break;
    if (!seen.has(h.objectID)) {
      seen.add(h.objectID);
      ids.push(h.objectID);
    }
  }
  return ids;
}

const poolKey = (q) => `${q}\u0000${Rush.facetFilter()}`;

async function fetchPool(q) {
  const { hits, nbHits, ms, usedFallback } = await TasksCommon.search(q, {
    hitsPerPage: POOL_N,
    fallback: true,
    filters: Rush.withFacet(),
  });
  return { hits, nbHits, ms, usedFallback };
}

/* Left panel: keyword truth. */
function renderRaw(pool) {
  RAW.innerHTML = pool.hits.map((h) => row(h)).join("");
  const ladder = pool.usedFallback ? " (allOptional)" : "";
  RAW_META.textContent = `search ${pool.ms} ms${ladder} · ${pool.nbHits} total`;
}

/* Right panel: pool order now, FLIP to agent order when the task lands. */
function renderRanked(pool) {
  RANKED.innerHTML = pool.hits.map((h) => row(h)).join("");
  RANK_META.textContent = "raw pool order — task in flight…";
}

function renderAgentOrder(pool, ids, rerankMs, usage, label = "rerank") {
  const kwPos = new Map(pool.hits.map((h, i) => [h.objectID, i + 1]));
  const top = new Set(ids);
  const order = [...ids, ...pool.hits.map((h) => h.objectID).filter((id) => !top.has(id))];
  const byId = new Map(pool.hits.map((h) => [h.objectID, h]));
  const fallback = new Set(ids.filter((id) => !agentIds.has(id)));

  Rush.flip(RANKED, () => {
    RANKED.innerHTML = order
      .map((id) => {
        const h = byId.get(id);
        if (!h) return "";
        if (!top.has(id)) return row(h, "", "below-cut");
        const kw = kwPos.get(id);
        const cls = kw > ids.indexOf(id) + 1 ? "up" : kw < ids.indexOf(id) + 1 ? "down" : "";
        const tag = fallback.has(id) ? `<span class="badge fallback" title="kept in keyword order">kw #${kw}</span>`
          : `<span class="badge ${cls}" title="keyword position">kw #${kw}</span>`;
        return row(h, tag);
      })
      .join("");
  });
  const tokens = usage ? ` · ${usage.totalTokens ?? "?"} tokens` : "";
  RANK_META.textContent = `${label} ${rerankMs} ms${tokens} · top ${ids.length} of ${pool.hits.length}`;

  let up = 0;
  let down = 0;
  ids.forEach((id, i) => {
    const kw = kwPos.get(id);
    if (kw > i + 1) up += 1;
    else if (kw < i + 1) down += 1;
  });
  const top1Kw = kwPos.get(ids[0]);
  REF_MOVE.textContent =
    top1Kw === 1 ? "Keyword's own #1 kept the crown — the agent agreed." : `The agent's #1 sat at keyword #${top1Kw}.`;
  REF_NOTE.textContent = `${up} rose, ${down} fell, ${fallback.size} fallback-kept`;
  REFLECTION.classList.remove("hidden");
}

/* The rerank task. Ids go out as "1".."N": every id the agent writes back costs
   output tokens, and a 7-digit objectID costs several. Mapped back here. */
async function rankByTask(pool, q) {
  const taskPool = pool.hits.map((h, i) => ({
    objectID: String(i + 1),
    name: h.name || "",
    ...(h.description ? { description: String(h.description).slice(0, DESCRIPTION_CAP) } : {}),
  }));
  const { output, usage, ms } = await TasksCommon.run("algolia_rerank", {
    query: q,
    hits: taskPool,
    topK: TOP_K,
  });
  const ranked = ((output && output.rankedIds) || []).map((r) => ({
    objectId: pool.hits[Number(r && r.objectId) - 1]?.objectID,
  }));
  return { ranked, usage, ms };
}

const CRITERIA = ["not relevant", "somewhat relevant", "relevant"];

/* One /decisions call, one score question per hit; order is value x confidence.
   A value may come back as a number or as the criterion's own words. */
async function rankByDecisions(pool, q) {
  const questions = {};
  pool.hits.forEach((h, i) => {
    const leaf = (h.categories_as_list || []).slice(-1)[0] || "";
    const product = [h.name, h.brand, leaf].filter(Boolean).map(Rush.undent).join(" / ");
    /* check-copy: off */
    questions[`h${i}`] = {
      type: "score",
      instructions: `How relevant is this product to the shopper's request? Product: ${product}`,
      criteria: CRITERIA,
    };
    /* check-copy: on */
  });
  const { answers, ms } = await TasksCommon.decide(q, questions);
  const level = (v) => (typeof v === "string" && CRITERIA.indexOf(v) >= 0 ? CRITERIA.indexOf(v) : Number(v));
  const scored = pool.hits
    .map((h, i) => {
      const a = answers[`h${i}`] || {};
      const s = level(a.value) * (Number(a.confidence) || 0);
      return { h, i, s: Number.isFinite(s) ? s : -1 };
    })
    .sort((x, y) => y.s - x.s || x.i - y.i);
  return { ranked: scored.slice(0, TOP_K).map((x) => ({ objectId: x.h.objectID })), usage: null, ms };
}

async function rerank(pool) {
  inflight = true;
  const q = current;
  try {
    const { ranked, usage, ms } = ENGINE === "decisions" ? await rankByDecisions(pool, q) : await rankByTask(pool, q);
    if (q !== current) return;
    agentIds = new Set(ranked.map((r) => r.objectId).filter(Boolean));
    const ids = mergeRanked(pool.hits, ranked);
    renderAgentOrder(pool, ids, ms, usage, ENGINE === "decisions" ? "decisions" : "rerank");
    STATUS.textContent = "";
  } catch (e) {
    RANK_META.textContent = "";
    STATUS.textContent = e.message;
  } finally {
    inflight = false;
    if (queued) {
      queued = false;
      run(current);
    }
  }
}

async function run(q) {
  q = q.trim();
  if (!q || inflight) return;
  current = q;
  INPUT.value = q;
  Rush.activeChip(CHIPS, q);
  REFLECTION.classList.add("hidden");
  STATUS.textContent = "";
  RAW.innerHTML = "";
  RANKED.innerHTML = "";

  const key = poolKey(q);
  let pool = warm.get(key);
  if (!pool) {
    RAW_META.textContent = "searching…";
    try {
      pool = await fetchPool(q);
      if (q !== current) return;
      warm.set(key, pool);
    } catch (e) {
      RAW_META.textContent = "";
      STATUS.textContent = e.message;
      return;
    }
  }
  if (!pool.hits.length) {
    renderRaw(pool);
    RANKED.innerHTML = "";
    RANK_META.textContent = "no pool to rerank — even the fallback found nothing.";
    return;
  }
  renderRaw(pool);
  renderRanked(pool);
  rerank(pool);
}

/* Warm every example's pool on load so a click shows results instantly. */
async function warmup() {
  for (const btn of CHIPS.querySelectorAll("button[data-q]")) {
    const q = btn.dataset.q;
    if (warm.has(poolKey(q))) continue;
    try {
      warm.set(poolKey(q), await fetchPool(q));
      if (!current) run(q); // first example runs itself, once its pool is warm
    } catch (e) {
      /* a cold example just fetches on click */
    }
  }
}

FORM.addEventListener("submit", (e) => {
  e.preventDefault();
  run(INPUT.value);
});
Rush.chips(CHIPS, run);
if (window.Mic) window.Mic.attach(INPUT, { onFinal: run });

if (Rush.guard()) {
  warmup();
  Rush.facets(document.getElementById("facets"), () => {
    const q = current || INPUT.value;
    if (inflight) queued = true;
    else if (q.trim()) run(q);
  });
}

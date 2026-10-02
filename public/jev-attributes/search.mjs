/* ───────────────────────────────────────────────────────────────
   search.mjs: find the records a question needs, in the Factbook index.

   Pure apart from fetch. The local proxy (tools/jev-attributes/algolia.mjs)
   and the page in public mode send the same queries and keep hits by the
   same rules, so a question finds the same countries either way.

   One question is one multi-query (Algolia's `queries` endpoint): a query per
   name phrase the question holds ("Peru", "Germany", "Lebanon"), on the
   name and aliases only, then the whole question. A fields question asks
   the whole question of the names too; a records question asks it of four
   topical fields as well, with ~40-word snippets for Jev to read. The hits
   are joined by objectID, names first, and capped.

   In public mode the page holds a SECURED key: an HMAC of a search-only
   parent key, restricted to the Factbook index names below and with
   analytics forced off. The parent never reaches a browser
   (scripts/factbook-secured-key.mjs derives it on the maintainer's machine).
   ─────────────────────────────────────────────────────────────── */

/** the name the demo wants first; the app's keys are scoped to `esci_*`, so the second carries the records today */
export const INDEX_NAMES = ["demo_factbook", "esci_demo_factbook"];

/** searchable after the name, and snippeted, for a records question */
export const TOPICAL = ["Introduction.Background", "Geography.Location", "Economy.Economic overview", "Geography.Major rivers (by length in km)"];
export const SNIPPET_WORDS = 40;
export const NAME_ATTRS = ["name", "aliases"];

/** records per question: a fields question trims at most 3, a records question ranks 10 */
export const CAP = { fields: 3, records: 10 };
/** at most this many name phrases are searched, and this many records kept per phrase */
export const MAX_PHRASES = 8;
const PER_PHRASE = 2;

const BASE = {
  analytics: false, clickAnalytics: false, getRankingInfo: true, attributesToHighlight: [],
  // whole words only: "Mars" is not the start of "Marshall Islands"
  queryType: "prefixNone",
};
const SNIPPETS = { attributesToSnippet: TOPICAL.map((a) => `${a}:${SNIPPET_WORDS}`), restrictHighlightAndSnippetArrays: false, snippetEllipsisText: "…" };

/** the whole question, as a fields question: the names only, as the page always searched */
export function queryParams(query) {
  return { query, hitsPerPage: 10, ...BASE, removeWordsIfNoResults: "allOptional", restrictSearchableAttributes: NAME_ATTRS, attributesToSnippet: [] };
}

/** the whole question, as a records question: every word optional, ranked by words matched, snippets on */
export function recordsParams(query) {
  return { query, hitsPerPage: CAP.records, ...BASE, removeWordsIfNoResults: "allOptional", optionalWords: [query], ...SNIPPETS };
}

/** one name phrase: the names only, every word required, a plural is not an exact match */
export function nameParams(phrase, kind) {
  return {
    query: phrase, hitsPerPage: 3, ...BASE, removeWordsIfNoResults: "none", restrictSearchableAttributes: NAME_ATTRS, alternativesAsExact: [],
    ...(kind === "records" ? SNIPPETS : { attributesToSnippet: [] }),
  };
}

/* words that start a question, or join one, and never name a country */
const STOP = new Set([
  "a an and are as at be by can compare could countries country did do does for from give has have how i in is it its",
  "list main many me most much name nations of on or show should tell than that the their them these they this those to",
  "was were what when where which who whose why will with would",
].join(" ").split(" "));

/**
 * The name phrases a question holds: runs of capitalised words, up to 3 long,
 * with apostrophe-s stripped and stop words skipped, split on commas and "and".
 * A possessive ends a run ("Peru's GDP" is Peru, then GDP), and so does an
 * all-capitals word, which is a phrase of its own ("Japan GDP", "UAE").
 * `initial` marks a phrase that starts the question, where a capital proves
 * nothing ("Island nations…"): it must then match a name exactly.
 */
export function namePhrases(question) {
  const text = String(question || "").replace(/['’]s\b/g, ",");
  const out = [];
  const seen = new Set();
  let first = true;
  for (const seg of text.split(/[,;:?!()]|\s\band\b\s|\s\bAnd\b\s|\.(?:\s|$)/)) {
    let run = [];
    let runInitial = false;
    const flush = () => {
      for (let i = 0; i < run.length; i += 3) {
        const phrase = run.slice(i, i + 3).join(" ");
        const key = phrase.toLowerCase();
        if (!seen.has(key) && out.length < MAX_PHRASES) { seen.add(key); out.push({ phrase, initial: runInitial && i === 0 }); }
      }
      run = [];
      runInitial = false;
    };
    for (const word of seg.match(/[\p{L}\p{M}][\p{L}\p{M}\p{N}'’.-]*/gu) || []) {
      const w = word.replace(/[.'’-]+$/, "");
      const capital = /^\p{Lu}/u.test(w) && !STOP.has(w.toLowerCase());
      const acronym = capital && w.length > 1 && w === w.toUpperCase();
      if (acronym) {
        flush();
        runInitial = first;
        run.push(w);
        flush();
      } else if (capital) {
        if (!run.length) runInitial = first;
        run.push(w);
      } else flush();
      first = false;
    }
    flush();
  }
  return out;
}

/**
 * Hits for one name phrase that really are that name: no typo, every word
 * of the phrase matched, on the name itself or exactly on an alias. A phrase
 * that starts the question needs an exact match. At most PER_PHRASE.
 */
export function nameMatches(hits, { phrase, initial }) {
  const n = phrase.split(/\s+/).length;
  return (hits || []).filter((h) => {
    const i = h._rankingInfo || {};
    if ((i.nbTypos ?? 1) !== 0 || (i.words ?? 0) < n) return false;
    const onName = (i.firstMatchedWord ?? 1e9) < 1000;
    const exact = (i.nbExactWords ?? 0) >= n;
    return initial ? exact && (i.firstMatchedWord ?? 1e9) < 2000 : onName || exact;
  }).slice(0, PER_PHRASE);
}

/**
 * With every word optional, "Population over 65 in Italy" also matches
 * Switzerland on a typo of "Itali" in one of its other names. Keep the hits
 * that matched the most words, then those that matched on the name itself,
 * then the fewest typos: the countries the question names, and no tail.
 */
export function bestMatches(hits) {
  const info = (h) => h._rankingInfo || {};
  if (!hits.length) return hits;
  const most = Math.max(...hits.map((h) => info(h).words ?? 0));
  let keep = hits.filter((h) => (info(h).words ?? 0) === most);
  const byName = keep.filter((h) => (info(h).firstMatchedWord ?? 0) < 1000);
  if (byName.length) keep = byName;
  const fewest = Math.min(...keep.map((h) => info(h).nbTypos ?? 0));
  return keep.filter((h) => (info(h).nbTypos ?? 0) === fewest);
}

/**
 * The queries one question sends, in order: one per name phrase, then the
 * whole question. `kind` is "fields" or "records".
 */
export function planQueries(question, kind) {
  const plan = namePhrases(question).map((p) => ({ type: "name", ...p, params: nameParams(p.phrase, kind) }));
  plan.push({ type: "whole", params: kind === "records" ? recordsParams(question) : queryParams(question) });
  return plan;
}

/** every list joined by objectID, the first occurrence wins, in list order then Algolia order, capped */
export function unionHits(lists, cap) {
  const seen = new Set();
  const out = [];
  for (const list of lists) for (const h of list) {
    if (!h || seen.has(h.objectID)) continue;
    seen.add(h.objectID);
    out.push(h);
  }
  return out.slice(0, cap);
}

/** Algolia's answers to a plan → the hits the page shows: names first, then the whole question, capped */
export function mergeResults(plan, results, kind) {
  const lists = plan.map((q, i) => {
    const hits = (results[i] && results[i].hits) || [];
    if (q.type === "name") return nameMatches(hits, q);
    return kind === "records" ? hits : bestMatches(hits);
  });
  return unionHits(lists, CAP[kind] ?? CAP.fields).map((h) => keepHit(h, kind));
}

/** a hit without Algolia's `_` keys: the record as indexed */
export function stripMeta(hit) {
  const out = {};
  for (const [k, v] of Object.entries(hit)) if (!k.startsWith("_")) out[k] = v;
  return out;
}

/** a records hit keeps its snippets, which belong to no section; a fields hit is the record alone */
function keepHit(hit, kind) {
  const rec = stripMeta(hit);
  if (kind === "records" && hit._snippetResult) rec._snippetResult = hit._snippetResult;
  return rec;
}

/** a params object as the multi-query wants it: a query string, arrays as JSON */
export function encodeParams(params) {
  return new URLSearchParams(Object.entries(params).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])).toString();
}

/** the body of one multi-query: every query of the plan, on one index, none skipped */
export function multiBody(plan, index) {
  return { requests: plan.map((q) => ({ indexName: index, params: encodeParams(q.params) })), strategy: "none" };
}

/** the request a getObject sends: one record by objectID, whole */
export function objectRequest(appId, index, objectID) {
  return {
    url: `https://${appId}-dsn.algolia.net/1/indexes/${encodeURIComponent(index)}/${encodeURIComponent(objectID)}`,
    method: "GET",
  };
}

/**
 * Search and fetch from a browser with a secured key. Tries each allowed
 * index name in order and remembers the first that answers.
 *   search(question, kind) → { hits, queries, index, backend, ms }
 *   getObject(objectID) → the record as indexed
 */
export function createBrowserCatalog({ appId, searchKey, indexes = INDEX_NAMES }, fetchImpl = (...a) => fetch(...a)) {
  let resolved = null;
  const headers = { "X-Algolia-Application-Id": appId, "X-Algolia-API-Key": searchKey };
  async function tryIndexes(fn) {
    let last = null;
    for (const index of resolved ? [resolved] : indexes) {
      const res = await fn(index);
      if (res.status === 200) { resolved = index; return { res, index }; }
      last = res.status;
      if (res.status !== 403 && res.status !== 404) break;
    }
    throw new Error(`Algolia HTTP ${last}`);
  }
  return {
    async search(question, kind = "fields") {
      const t0 = performance.now();
      const plan = planQueries(question, kind);
      const { res, index } = await tryIndexes((ix) => fetchImpl(`https://${appId}-dsn.algolia.net/1/indexes/*/queries`, {
        method: "POST", headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(multiBody(plan, ix)), signal: AbortSignal.timeout(8000),
      }));
      const json = await res.json();
      return { hits: mergeResults(plan, json.results || [], kind), queries: plan.length, index, backend: "algolia", ms: performance.now() - t0 };
    },
    async getObject(objectID) {
      const { res } = await tryIndexes((ix) => {
        const r = objectRequest(appId, ix, objectID);
        return fetchImpl(r.url, { method: r.method, headers, signal: AbortSignal.timeout(8000) });
      });
      return res.json();
    },
  };
}

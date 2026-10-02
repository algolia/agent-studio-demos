/* ───────────────────────────────────────────────────────────────
   algolia.mjs — the Factbook index: settings, records, search.

   Two names, tried in order. `demo_factbook` is the name the demo wants;
   the keys on this app are scoped to `esci_*`, so when Algolia refuses the
   first name the second one carries the same records. A third fallback is
   no index at all: search runs over factbook.jsonl on this machine, behind
   the same function, and says so in its result.

   Nothing here touches any other index: every call goes through `url()`,
   which refuses a name outside INDEX_NAMES, or is the multi-query, whose
   requests name an index from that list.
   ─────────────────────────────────────────────────────────────── */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INDEX_NAMES, TOPICAL, SNIPPET_WORDS, CAP, planQueries, mergeResults, multiBody } from "../../public/jev-attributes/search.mjs";

export { INDEX_NAMES };
export const RECORDS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "factbook.jsonl");

/* Two kinds of question share this index. A fields question names a country,
   so it searches `name` and `aliases` only (restrictSearchableAttributes, see
   search.mjs). A records question is topical ("oil exporters in the Gulf"),
   so four topical fields are searchable after the name, unordered, and come
   back as ~40-word snippets for Jev to read: three prose fields, and the
   rivers, which no prose field names ("Where does the Danube flow?"). All
   words optional, so "Main exports of Chile" finds Chile; stop words and
   short-word typos off, so "of" and "main" do not pull in the Isle of Man or
   Mali. */
export const SETTINGS = {
  searchableAttributes: ["name", "aliases", ...TOPICAL.map((a) => `unordered(${a})`)],
  indexLanguages: ["en"],
  queryLanguages: ["en"],
  removeStopWords: ["en"],
  ignorePlurals: ["en"],
  minWordSizefor1Typo: 5,
  minWordSizefor2Typos: 9,
  removeWordsIfNoResults: "allOptional",
  attributesToHighlight: [],
  attributesToSnippet: TOPICAL.map((a) => `${a}:${SNIPPET_WORDS}`),
  restrictHighlightAndSnippetArrays: false,
  attributeForDistinct: null,
};

const TIMEOUT_MS = 8000;

function url(app, index, suffix) {
  if (!INDEX_NAMES.includes(index)) throw new Error(`refusing index ${index}: not a demo index`);
  return `https://${app}.algolia.net/1/indexes/${encodeURIComponent(index)}${suffix}`;
}

async function call(app, key, method, u, body) {
  const res = await fetch(u, {
    method,
    headers: { "X-Algolia-Application-Id": app, "X-Algolia-API-Key": key, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS * 4),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
  return { status: res.status, json, message: (json && json.message) || text.slice(0, 200) };
}

export async function waitTask(app, key, index, taskID) {
  for (let i = 0; i < 120; i++) {
    const r = await call(app, key, "GET", url(app, index, `/task/${taskID}`));
    if (r.json && r.json.status === "published") return;
    await new Promise((ok) => setTimeout(ok, 500));
  }
  throw new Error(`task ${taskID} on ${index} not published after 60 s`);
}

export const setSettings = (app, key, index) => call(app, key, "PUT", url(app, index, "/settings"), SETTINGS);
export const batch = (app, key, index, records) =>
  call(app, key, "POST", url(app, index, "/batch"), { requests: records.map((body) => ({ action: "updateObject", body })) });

/* ── search ──────────────────────────────────────────────────── */

let localRecords = null;
function local() {
  if (!localRecords) {
    localRecords = fs.readFileSync(RECORDS_FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }
  return localRecords;
}

const STOP = new Set("a an and are as at be by compare countries country does for from has have how in is it its main many most of on or over spoken the to under versus vs what which who with".split(" "));
const words = (s) => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/'s\b/g, "").split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w));

/** the fallback: a whole-word match on the record's name, ranked by words matched */
export function searchLocal(query, hitsPerPage = 3) {
  const q = new Set(words(query));
  return local()
    .map((r) => ({ r, n: words(r.name).filter((w) => q.has(w)).length }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n || a.r.name.length - b.r.name.length)
    .slice(0, hitsPerPage)
    .map((x) => x.r);
}

let resolved = null; // the index name that answered, once one has

/**
 * Search the Factbook index with the page's multi-query. `kind` is "fields"
 * or "records". Returns { hits, queries, index, backend, ms }; backend is
 * "algolia" or "local", index the name that answered.
 */
export async function search({ app, key }, question, kind = "fields") {
  const t0 = performance.now();
  const plan = planQueries(question, kind);
  if (app && key) {
    for (const index of resolved ? [resolved] : INDEX_NAMES) {
      try {
        const r = await call(app, key, "POST", `https://${app}-dsn.algolia.net/1/indexes/*/queries`, multiBody(plan, index));
        if (r.status === 200 && r.json) {
          resolved = index;
          return { hits: mergeResults(plan, r.json.results || [], kind), queries: plan.length, index, backend: "algolia", ms: performance.now() - t0 };
        }
        if (r.status !== 403 && r.status !== 404) throw new Error(`HTTP ${r.status}: ${r.message}`);
      } catch (err) {
        if (resolved) throw err;
      }
    }
  }
  return { hits: searchLocal(question, CAP[kind] ?? CAP.fields), queries: 0, index: "factbook.jsonl", backend: "local", ms: performance.now() - t0 };
}

/** one whole record by objectID, as the page's getObject reads it; the local file when Algolia has no key */
export async function getObject({ app, key }, objectID) {
  if (app && key) {
    for (const index of resolved ? [resolved] : INDEX_NAMES) {
      const r = await call(app, key, "GET", url(app, index, `/${encodeURIComponent(objectID)}`));
      if (r.status === 200 && r.json) { resolved = index; return r.json; }
      if (r.status !== 403) throw new Error(`HTTP ${r.status}: ${r.message}`);
    }
  }
  const rec = local().find((x) => x.objectID === objectID);
  if (!rec) throw new Error("no such record");
  return rec;
}

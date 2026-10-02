/* ───────────────────────────────────────────────────────────────
   search.mjs — find the countries a question names, in the Factbook index.

   Pure apart from fetch. The local proxy (tools/jev-attributes/algolia.mjs)
   and the page in public mode send the same parameters and keep hits by the
   same rule, so a question finds the same countries either way.

   In public mode the page holds a SECURED key: an HMAC of a search-only
   parent key, restricted to the Factbook index names below and with
   analytics forced off. The parent never reaches a browser
   (scripts/factbook-secured-key.mjs derives it on the maintainer's machine).
   ─────────────────────────────────────────────────────────────── */

/** the name the demo wants first; the app's keys are scoped to `esci_*`, so the second carries the records today */
export const INDEX_NAMES = ["demo_factbook", "esci_demo_factbook"];

/** what every search sends, whoever sends it */
export function queryParams(query) {
  return {
    query, hitsPerPage: 10, analytics: false, clickAnalytics: false,
    removeWordsIfNoResults: "allOptional", getRankingInfo: true, attributesToHighlight: [],
    // whole words only: "Mars" is not the start of "Marshall Islands"
    queryType: "prefixNone",
  };
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

/** a hit without Algolia's `_` keys: the record as indexed */
export function stripMeta(hit) {
  const out = {};
  for (const [k, v] of Object.entries(hit)) if (!k.startsWith("_")) out[k] = v;
  return out;
}

/**
 * Search from a browser with a secured key. Tries each allowed index name in
 * order and remembers the first that answers. Returns { hits, index, backend, ms }.
 */
export function createBrowserSearch({ appId, searchKey, indexes = INDEX_NAMES }, fetchImpl = (...a) => fetch(...a)) {
  let resolved = null;
  return async function search(query, hitsPerPage = 3) {
    const t0 = performance.now();
    let last = null;
    for (const index of resolved ? [resolved] : indexes) {
      const res = await fetchImpl(`https://${appId}-dsn.algolia.net/1/indexes/${encodeURIComponent(index)}/query`, {
        method: "POST",
        headers: { "X-Algolia-Application-Id": appId, "X-Algolia-API-Key": searchKey, "Content-Type": "application/json" },
        body: JSON.stringify(queryParams(query)),
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 200) {
        resolved = index;
        const json = await res.json();
        return { hits: bestMatches(json.hits || []).slice(0, hitsPerPage).map(stripMeta), index, backend: "algolia", ms: performance.now() - t0 };
      }
      last = res.status;
      if (res.status !== 403 && res.status !== 404) break;
    }
    throw new Error(`Algolia search HTTP ${last}`);
  };
}

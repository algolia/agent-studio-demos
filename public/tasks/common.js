/* ───────────────────────────────────────────────────────────────
   tasks/common.js — one task runner, two demo pages.

   A "task" is Agent Studio's stateless structured completion:
   POST /1/agents/{id}/tasks with {task, input}, schema-validated
   output, cache bypassed (?cache=false) so every timing is real.

   The key in config.js is visible to the browser: it must be a
   search-only key (it also carries the /tasks ACL on demo apps).

   Nothing here knows which task the page runs — the pages bring
   the task name and render their own output.
   ─────────────────────────────────────────────────────────────── */

(function (global) {
  "use strict";

  function cfg() {
    return (global.DEMO_CONFIG && global.DEMO_CONFIG.tasks) || null;
  }

  function ready() {
    const c = cfg();
    return Boolean(c && c.host && c.appId && c.apiKey && c.agentId && c.index);
  }

  function missing() {
    const c = cfg() || {};
    return ["host", "appId", "apiKey", "agentId", "index"].filter((k) => !c[k]);
  }

  /* Where /tasks and /decisions calls go: the config's host, or ?api=<origin>
     for a local Agent Studio (recording runs). Loopback names only, so a
     shared link can never send the demo's key to somebody else's server. */
  function apiBase() {
    const c = cfg();
    try {
      const u = new URL(new URLSearchParams(global.location.search).get("api") || "");
      const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname.endsWith(".localhost");
      if (local && /^https?:$/.test(u.protocol)) return u.origin;
    } catch (e) {
      /* no override, or not a URL */
    }
    return c.host;
  }

  const overridden = () => apiBase() !== (cfg() || {}).host;

  /** One POST to an agent endpoint. Resolves {body, ms}; rejects with a readable message. */
  async function agentPost(path, label, payload) {
    const c = cfg();
    const started = performance.now();
    let res;
    try {
      res = await fetch(`${apiBase()}/1/agents/${encodeURIComponent(c.agentId)}/${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Algolia-Application-Id": c.appId,
          "X-Algolia-API-Key": c.apiKey,
        },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      throw new Error(`${label} endpoint unreachable: ${e.message}`);
    }
    const ms = Math.round(performance.now() - started);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${label}: HTTP ${res.status} ${body.message || ""}`.trim());
    return { body, ms };
  }

  /** One task run. Resolves {output, usage, ms}; rejects with a readable message. */
  async function run(task, input) {
    const { body, ms } = await agentPost("tasks?cache=false", `task ${task}`, { task, input });
    return { output: body.output, usage: body.usage, ms };
  }

  /** One decisions call: {state, questions} in, {engine, answers, ms} out. */
  async function decide(state, questions) {
    const { body, ms } = await agentPost("decisions", "decisions", { state, questions });
    return { engine: body.engine, answers: body.answers || {}, ms };
  }

  /** One POST to the index's query endpoint. Resolves {data, ms}. */
  async function post(body) {
    const c = cfg();
    const started = performance.now();
    let res;
    try {
      res = await fetch(`https://${c.appId.toLowerCase()}-dsn.algolia.net/1/indexes/${encodeURIComponent(c.index)}/query`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Algolia-Application-Id": c.appId,
          "X-Algolia-API-Key": c.apiKey,
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new Error(`search unreachable: ${e.message}`);
    }
    const ms = Math.round(performance.now() - started);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`search: HTTP ${res.status} ${data.message || ""}`.trim());
    return { data, ms };
  }

  /** The commonest values of each attribute: {brand: [{value, count}, …]}. No hits fetched. */
  async function facets(attrs, top = 8) {
    const { data } = await post({ query: "", hitsPerPage: 0, facets: attrs, maxValuesPerFacet: top });
    const out = {};
    for (const a of attrs) {
      out[a] = Object.entries((data.facets && data.facets[a]) || {})
        .map(([value, count]) => ({ value, count }))
        .sort((x, y) => y.count - x.count)
        .slice(0, top);
    }
    return out;
  }

  /** One index search. Resolves {hits, nbHits, ms}.
   *  fallback: on 0 hits, retry once with removeWordsIfNoResults=allOptional and
   *  flag it (usedFallback) — the raw miss stays visible, the page keeps a pool. */
  async function search(query, { hitsPerPage = 20, filters, fallback = false, relaxed = false } = {}) {
    const base = {
      query,
      hitsPerPage,
      attributesToRetrieve: [
        "objectID", "name", "brand", "price", "currency", "image", "url", "description", "colors", "categories_as_list",
      ],
    };
    /* Query-time relevance an index with sane settings would already carry:
       typos, plurals, prefix on the last word, and words dropped rather than
       a dead end. The raw side of a comparison must not be a strawman. */
    if (relaxed) {
      Object.assign(base, {
        typoTolerance: true,
        ignorePlurals: true,
        queryType: "prefixLast",
        removeWordsIfNoResults: "allOptional",
      });
    }
    if (filters) Object.assign(base, filters);

    async function once(body) {
      const { data, ms } = await post(body);
      return { hits: data.hits || [], nbHits: data.nbHits || 0, ms };
    }

    const first = await once(base);
    if (first.hits.length || !fallback) return first;
    const second = await once({ ...base, removeWordsIfNoResults: "allOptional" });
    return { ...second, usedFallback: true };
  }

  global.TasksCommon = { cfg, ready, missing, run, decide, apiBase, overridden, search, facets };
})(window);

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

  /** One task run. Resolves {output, usage, ms}; rejects with a readable message. */
  async function run(task, input) {
    const c = cfg();
    const started = performance.now();
    let res;
    try {
      res = await fetch(`${c.host}/1/agents/${encodeURIComponent(c.agentId)}/tasks?cache=false`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Algolia-Application-Id": c.appId,
          "X-Algolia-API-Key": c.apiKey,
        },
        body: JSON.stringify({ task, input }),
      });
    } catch (e) {
      throw new Error(`task endpoint unreachable: ${e.message}`);
    }
    const ms = Math.round(performance.now() - started);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`task ${task}: HTTP ${res.status} ${body.message || ""}`.trim());
    }
    return { output: body.output, usage: body.usage, ms };
  }

  /** One index search. Resolves {hits, nbHits, ms}.
   *  fallback: on 0 hits, retry once with removeWordsIfNoResults=allOptional and
   *  flag it (usedFallback) — the raw miss stays visible, the page keeps a pool. */
  async function search(query, { hitsPerPage = 20, filters, fallback = false } = {}) {
    const c = cfg();
    const host = `https://${c.appId.toLowerCase()}-dsn.algolia.net`;
    const base = {
      query,
      hitsPerPage,
      attributesToRetrieve: ["objectID", "name", "brand", "price", "currency", "image", "url", "description", "colors"],
    };
    if (filters) Object.assign(base, filters);

    async function once(body) {
      const started = performance.now();
      let res;
      try {
        res = await fetch(`${host}/1/indexes/${encodeURIComponent(c.index)}/query`, {
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
      return { hits: data.hits || [], nbHits: data.nbHits || 0, ms };
    }

    const first = await once(base);
    if (first.hits.length || !fallback) return first;
    const second = await once({ ...base, removeWordsIfNoResults: "allOptional" });
    return { ...second, usedFallback: true };
  }

  global.TasksCommon = { cfg, ready, missing, run, search };
})(window);

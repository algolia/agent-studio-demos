/* ───────────────────────────────────────────────────────────────
   live.js → window.GuardrailLive

   Race guardrails on an exam, from this browser, on your own app.

   Every message goes to POST /1/agents/{id}/completions. The agent's input
   guardrail answers in the stream: a data-guardrail-violation event means
   blocked, a stream that ends without one means allowed.

   The fighters are either your own agents, or temporary ones this page makes:
   one per model, named EVAL_GUARDRAILS_…, carrying the same guardrail rules
   (the battle's config, or one read from an agent of yours). They are
   published, raced, then deleted.

   What this file will and will not do:
     - the key lives in one closure variable, never in storage, a URL or a log
     - only the request shapes in ROUTES can leave; all others throw before
       fetch. The writes are fenced further: a create must carry the
       EVAL_GUARDRAILS_ name, and publish or delete only reach agents this
       page made, or agents a fresh read shows carry that name
     - nothing ever edits an existing agent: there is no PATCH at all
     - cache, memory and analytics are off on every completion, so a run
       never reuses an answer, never feeds agent memory and stays out of your
       search analytics; the conversations themselves are still kept under
       the agent's own retention setting, like any other completion

   The core takes `fetch` as an argument, so tests/guardrail-live.test.js
   runs it against a fake server.
   ─────────────────────────────────────────────────────────────── */

(function (global) {
  "use strict";

  const HOSTS = {
    eu: "https://agent-studio.eu.algolia.com",
    us: "https://agent-studio.us.algolia.com",
  };
  const MAX_CASES = 200;
  const MAX_AGENTS = 4;
  const IN_FLIGHT = 3;
  const TEMP_PREFIX = "EVAL_GUARDRAILS_";
  const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
  const isUuid = (s) => new RegExp(`^${UUID}$`).test(String(s || "").trim());
  const idOf = (path) => (path.match(new RegExp(`^/1/agents/(${UUID})`)) || [])[1];

  /** the only calls this page can make; everything else throws before fetch */
  const ROUTES = [
    ["GET", /^\/1\/agents$/],
    ["GET", new RegExp(`^/1/agents/${UUID}$`)],
    ["GET", /^\/1\/providers$/],
    ["GET", new RegExp(`^/1/providers/${UUID}/models$`)],
    ["POST", new RegExp(`^/1/agents/${UUID}/completions$`)],
    ["POST", /^\/1\/agents$/],
    ["POST", new RegExp(`^/1/agents/${UUID}/publish$`)],
    ["DELETE", new RegExp(`^/1/agents/${UUID}$`)],
  ];
  const routeAllowed = (method, path) => ROUTES.some(([m, re]) => m === method && re.test(path));

  /** ids this page may publish or delete: made here, or read back with the temp name */
  const owned = new Set();

  const COMPLETION_QUERY = "compatibilityMode=ai-sdk-5&stream=true&cache=false&memory=false&analytics=false";

  /** one request, checked against ROUTES and the write fence; creds = { region, appId, apiKey } */
  function call(fetchImpl, creds, method, path, { query = "", body, keepalive = false } = {}) {
    if (!routeAllowed(method, path)) throw new Error(`blocked by this page: ${method} ${path}`);
    if (method === "POST" && path === "/1/agents" && !(body && String(body.name).startsWith(TEMP_PREFIX))) {
      throw new Error(`blocked by this page: a new agent must be named ${TEMP_PREFIX}…`);
    }
    const writesOne = method === "DELETE" || path.endsWith("/publish");
    if (writesOne && !owned.has(idOf(path))) throw new Error("blocked by this page: not a temporary agent");
    const host = HOSTS[creds.region];
    if (!host) throw new Error("unknown region");
    return fetchImpl(host + path + (query ? "?" + query : ""), {
      method,
      headers: {
        "content-type": "application/json",
        "X-Algolia-Application-Id": creds.appId,
        "X-Algolia-API-Key": creds.apiKey,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      keepalive,
    });
  }

  /**
   * An ai-sdk-5 event stream → { verdict, category, stage, error }.
   * verdict: "blocked" | "allowed" | null (null = the guardrail or the call broke)
   */
  function readVerdict(streamText) {
    let blocked = null, error = null;
    for (const line of String(streamText).split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let evt;
      try { evt = JSON.parse(payload); } catch (_) { continue; }
      if (evt.type === "data-guardrail-violation") {
        blocked = { category: (evt.data && evt.data.category) || "", type: (evt.data && evt.data.guardrailType) || "" };
      } else if (evt.type === "data-guardrail-error") {
        error = "guardrail error";
      } else if (evt.type === "error") {
        error = "stream error";
      }
    }
    if (blocked) return { verdict: "blocked", category: blocked.category, stage: blocked.type, error: null };
    if (error) return { verdict: null, category: "", stage: "", error };
    return { verdict: "allowed", category: "", stage: "", error: null };
  }

  /** a status code → a sentence, never the response body (it may echo input) */
  function statusText(status) {
    if (status === 401 || status === 403) return `${status}: this key cannot do that`;
    if (status === 404) return "404: no such agent in this app and region";
    if (status === 422) return "422: the agent refused the request";
    if (status === 429) return "429: rate limited";
    return `HTTP ${status}`;
  }

  /** every page of a paginated list, up to maxPages of 100 */
  async function listAll(fetchImpl, creds, path, maxPages = 10) {
    const out = [];
    for (let page = 1; page <= maxPages; page++) {
      const res = await call(fetchImpl, creds, "GET", path, { query: `page=${page}&limit=100` });
      if (!res.ok) throw Object.assign(new Error(statusText(res.status)), { status: res.status });
      const d = await res.json();
      out.push(...(d.data || []));
      const pages = d.pagination && d.pagination.totalPages;
      if (!pages || page >= pages) break;
    }
    return out;
  }

  /** providers with their model names: [{ id, name, providerName, models: [] }] */
  async function providersWithModels(fetchImpl, creds) {
    const list = await listAll(fetchImpl, creds, "/1/providers");
    return Promise.all(list.map(async (p) => {
      let models = [];
      try {
        const r = await call(fetchImpl, creds, "GET", `/1/providers/${p.id}/models`);
        if (r.ok) models = await r.json();
      } catch (e) { /* a provider whose models cannot be read is still listed */ }
      return { id: p.id, name: p.name, providerName: p.providerName, models: Array.isArray(models) ? models : [] };
    }));
  }

  const guardrailOf = (agent) => (agent && agent.config && agent.config.guardrail) || null;
  const guardrailOn = (agent) => !!(guardrailOf(agent) && guardrailOf(agent).enabled);

  /** the rules part of a guardrail (scope, categories, allowed examples), without its own model */
  function rulesOf(g) {
    const cats = (g.categories || []).map((c) => {
      const o = { name: c.name, description: c.description || null, examples: c.examples || null };
      if (c.scope) o.scope = c.scope;
      if (c.fallbackResponse) o.fallbackResponse = c.fallbackResponse;
      return o;
    });
    return { scope: g.scope || null, noViolationExamples: g.noViolationExamples || g.no_violation_examples || null, categories: cats };
  }

  const slug = (s) => String(s || "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);

  /* this text goes to the model, not the reader */
  /* check-copy: off */
  const tempInstructions = (scope) =>
    "You are the shopping assistant for this shop. Answer in two short sentences at most.\n\nShop: " + (scope || "an online shop");
  /* check-copy: on */

  /**
   * One temporary fighter: created with the rules on the given model (the
   * guardrail and the agent itself both use it), then published.
   * → { id, name, label }
   */
  async function createTemp(fetchImpl, creds, { providerId, model, rules, tag = "" }) {
    const name = `${TEMP_PREFIX}${slug(model)}_${tag || Math.random().toString(36).slice(2, 8)}`;
    const body = {
      name,
      description: "Temporary agent made by the guardrail battle page. Deleted after the race.",
      providerId, model,
      instructions: tempInstructions(rules.scope),
      config: { guardrail: { ...rules, enabled: true, providerId, model } },
      tools: [],
    };
    const res = await call(fetchImpl, creds, "POST", "/1/agents", { body });
    if (!res.ok) throw Object.assign(new Error(`create ${model}: ${statusText(res.status)}`), { status: res.status });
    const a = await res.json();
    if (!isUuid(a.id) || a.name !== name) throw new Error(`create ${model}: unexpected answer`);
    owned.add(a.id);
    const pub = await call(fetchImpl, creds, "POST", `/1/agents/${a.id}/publish`);
    if (!pub.ok) throw Object.assign(new Error(`publish ${model}: ${statusText(pub.status)}`), { status: pub.status, id: a.id });
    return { id: a.id, name, label: model };
  }

  /** delete one temporary agent; true when it is gone */
  async function removeTemp(fetchImpl, creds, id, { keepalive = false } = {}) {
    const res = await call(fetchImpl, creds, "DELETE", `/1/agents/${id}`, { keepalive });
    if (res.ok || res.status === 404) { owned.delete(id); return true; }
    return false;
  }

  /** temporary agents left on the app by an earlier run; they become deletable here */
  async function findLeftovers(fetchImpl, creds) {
    const all = await listAll(fetchImpl, creds, "/1/agents");
    const left = all.filter((a) => isUuid(a.id) && String(a.name).startsWith(TEMP_PREFIX));
    left.forEach((a) => owned.add(a.id));
    return left;
  }

  /** one message through one agent → { verdict, category, stage, ms, error } */
  async function judge(fetchImpl, creds, agentId, message, now) {
    const t0 = now();
    try {
      const res = await call(fetchImpl, creds, "POST", `/1/agents/${agentId}/completions`, {
        query: COMPLETION_QUERY,
        body: { messages: [{ role: "user", parts: [{ type: "text", text: message }] }] },
      });
      if (!res.ok) return { verdict: null, category: "", ms: now() - t0, error: statusText(res.status) };
      const v = readVerdict(await res.text());
      return { ...v, ms: now() - t0 };
    } catch (e) {
      return { verdict: null, category: "", ms: now() - t0, error: e && e.message === "Failed to fetch" ? "network or CORS" : "request failed" };
    }
  }

  /**
   * Every agent on every case. Agents run side by side, each with at most
   * IN_FLIGHT calls open. onResult fires per answer; stop() ends the run early.
   */
  function race({ fetchImpl, creds, agents, cases, onResult = () => {}, now = () => performance.now() }) {
    let stopped = false;
    const results = [];
    const lane = async (agentId) => {
      let next = 0;
      const worker = async () => {
        while (!stopped && next < cases.length) {
          const i = next++;
          const r = await judge(fetchImpl, creds, agentId, cases[i].message, now);
          const row = { agentId, index: i, expected: cases[i].expected, ...r };
          results.push(row);
          onResult(row);
        }
      };
      await Promise.all(Array.from({ length: Math.min(IN_FLIGHT, cases.length) }, worker));
    };
    const done = Promise.all(agents.map(lane)).then(() => results);
    return { done, stop: () => { stopped = true; } };
  }

  /** the race, one row per (message, agent), as CSV text; labels: { id: "model name" } */
  function resultsCsv(cases, agents, results, labels = {}) {
    const label = (id) => labels[id] || `agent ${agents.indexOf(id) + 1}`;
    const rows = results.slice().sort((a, b) => a.index - b.index || agents.indexOf(a.agentId) - agents.indexOf(b.agentId))
      .map((r) => ({
        message: cases[r.index].message, expected: r.expected, agent: label(r.agentId), agent_id: r.agentId,
        verdict: r.verdict || "", correct: r.verdict ? String(r.verdict === r.expected) : "",
        category: r.category || "", stage: r.stage || "", ms: Math.round(r.ms), error: r.error || "",
      }));
    return global.GuardrailCsv.toCsv(rows, ["message", "expected", "agent", "agent_id", "verdict", "correct", "category", "stage", "ms", "error"]);
  }

  /** per agent: the error split with intervals, plus median time to a verdict */
  function summarize(agents, results) {
    return agents.map((id) => {
      const mine = results.filter((r) => r.agentId === id);
      return { agentId: id, ...global.GuardrailStats.split(mine), p50ms: global.GuardrailStats.p50(mine.map((r) => r.ms)) };
    });
  }

  global.GuardrailLive = {
    HOSTS, MAX_CASES, MAX_AGENTS, IN_FLIGHT, ROUTES, COMPLETION_QUERY, TEMP_PREFIX,
    isUuid, routeAllowed, call, readVerdict, statusText, listAll, providersWithModels,
    guardrailOf, guardrailOn, rulesOf, createTemp, removeTemp, findLeftovers,
    judge, race, resultsCsv, summarize,
  };
})(window);

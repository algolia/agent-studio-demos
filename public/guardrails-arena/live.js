/* ───────────────────────────────────────────────────────────────
   live.js → window.GuardrailLive

   Race guardrails on an exam, from this browser, on your own app.

   Every message goes to POST /1/agents/{id}/completions. The agent's input
   guardrail answers in the stream: a data-guardrail-violation event means
   blocked, a stream that ends without one means allowed.

   The fighters are either your own agents, or temporary ones this page makes:
   one per model, named EVAL_GUARDRAILS_…, carrying the same guardrail rules
   (the Arena's config, or one read from an agent of yours). They are
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
  const MAX_AGENTS = 10;
  const MAX_REPEATS = 5;
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

  /*
   * Which models to offer first. A guardrail runs on every message, so the
   * small, fast tiers lead; flagship models follow; names that are clearly not
   * chat models (embeddings, speech, images) sink to the end. Within a tier the
   * newest version leads, and a moving alias beats a dated snapshot.
   */
  const NOT_CHAT = /embed|tts|whisper|audio|speech|realtime|transcri|image|dall-e|moderation|rerank/i;
  const FAST = /mini|nano|flash|haiku|luna|lite|small|fast|instant|tiny|\b[1-9]b\b|-[1-9]b|8x7b|turbo/i;
  const TIERS = ["fast", "strong", "other"];
  const versionOf = (m) => {
    // the first small number is the version; a date or a 2503-style build number is not
    const v = (String(m).replace(/20\d{2}-?\d{2}-?\d{2}/g, "").match(/\d+(?:[.-]\d(?!\d))?/g) || [])
      .map((s) => parseFloat(s.replace("-", "."))).find((x) => x < 100);
    // no number at all is a moving alias to the newest model (luna), so it leads its tier
    return /\d/.test(m) ? v || 0 : 99;
  };
  const tierOf = (m) => (NOT_CHAT.test(m) ? "other" : FAST.test(m) ? "fast" : "strong");

  /** providers with models → one ranked list: [{ providerId, providerName, model, tier }] */
  function rankModels(providers) {
    const rows = [];
    for (const p of providers || []) {
      for (const m of p.models || []) rows.push({ providerId: p.id, providerName: p.name, model: String(m), tier: tierOf(String(m)) });
    }
    const dated = (m) => (/20\d{2}-?\d{2}-?\d{2}|preview|exp/i.test(m) ? 1 : 0);
    return rows.sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier) ||
      versionOf(b.model) - versionOf(a.model) || dated(a.model) - dated(b.model) ||
      a.model.length - b.model.length || a.model.localeCompare(b.model));
  }

  /** a starting lineup: the best fast and the best strong model of each provider, up to k */
  function suggestLineup(ranked, k = 4) {
    const out = [];
    for (const tier of ["fast", "strong"]) {
      const seen = new Set();
      for (const r of ranked) {
        if (r.tier !== tier || seen.has(r.providerId)) continue;
        seen.add(r.providerId);
        out.push(r);
      }
    }
    return out.slice(0, k);
  }

  const guardrailOf = (agent) => (agent && agent.config && agent.config.guardrail) || null;
  const guardrailOn = (agent) => !!(guardrailOf(agent) && guardrailOf(agent).enabled);

  /** the rules part of a guardrail (scope, categories, allowed examples), without its own model */
  function rulesOf(g) {
    const cats = (g.categories || []).map((c) => {
      const o = { name: c.name, description: c.description || null, examples: c.examples || null };
      if (c.scope) o.scope = c.scope;
      if (c.fallbackResponse || c.fallback_response) o.fallbackResponse = c.fallbackResponse || c.fallback_response;
      return o;
    });
    return { scope: g.scope || null, noViolationExamples: g.noViolationExamples || g.no_violation_examples || null, categories: cats };
  }

  /** a config of the frozen run by candidate id (heldout.json names "r0" and "final" by id) */
  function runConfig(run, id) {
    const c = (run.rounds || []).flatMap((r) => r.candidates || []).find((x) => x.id === id);
    if (!c || !c.config) throw new Error(`no config ${id} in the run`);
    return c.config;
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
      description: "Temporary agent made by the Guardrails Arena page. Deleted after the race.",
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
   * inFlight calls open. Rows carry `repeat`, so reruns of one exam stay
   * apart. onResult fires per answer; stop() ends the run early.
   */
  function race({ fetchImpl, creds, agents, cases, repeat = 0, inFlight = IN_FLIGHT, onResult = () => {}, now = () => performance.now() }) {
    let stopped = false;
    const results = [];
    const lane = async (agentId) => {
      let next = 0;
      const worker = async () => {
        while (!stopped && next < cases.length) {
          const i = next++;
          const r = await judge(fetchImpl, creds, agentId, cases[i].message, now);
          const row = { agentId, index: i, repeat, expected: cases[i].expected, ...r };
          results.push(row);
          onResult(row);
        }
      };
      await Promise.all(Array.from({ length: Math.min(inFlight, cases.length) }, worker));
    };
    const done = Promise.all(agents.map(lane)).then(() => results);
    return { done, stop: () => { stopped = true; } };
  }

  /* a row belongs to a fighter: a model raced through temporary agents, or one of your agents */
  const fighterOf = (r) => r.fighter || r.agentId;

  /** the race, one row per (message, fighter, rerun), as CSV text; labels: { fighter: "model name" } */
  function resultsCsv(cases, fighters, results, labels = {}) {
    const label = (k) => labels[k] || `agent ${fighters.indexOf(k) + 1}`;
    const rows = results.slice().sort((a, b) => (a.repeat || 0) - (b.repeat || 0) || a.index - b.index ||
      fighters.indexOf(fighterOf(a)) - fighters.indexOf(fighterOf(b)))
      .map((r) => ({
        message: cases[r.index].message, expected: r.expected, agent: label(fighterOf(r)), agent_id: r.agentId,
        repeat: (r.repeat || 0) + 1,
        verdict: r.verdict || "", correct: r.verdict ? String(r.verdict === r.expected) : "",
        category: r.category || "", stage: r.stage || "", ms: Math.round(r.ms), error: r.error || "",
      }));
    return global.GuardrailCsv.toCsv(rows, ["message", "expected", "agent", "agent_id", "repeat", "verdict", "correct", "category", "stage", "ms", "error"]);
  }

  /**
   * Per fighter: the error split, balanced accuracy with a message-level
   * interval, how often a verdict flips between reruns, balanced accuracy per
   * rerun, and time to a verdict. Sorted best first; `vsTop` pairs each one
   * with the leader on the same messages.
   */
  function summarize(fighters, results) {
    const S = global.GuardrailStats;
    const rows = fighters.map((k) => {
      const mine = results.filter((r) => fighterOf(r) === k);
      const reps = [...new Set(mine.map((r) => r.repeat || 0))].sort((a, b) => a - b);
      return {
        fighter: k, agentId: k, ...S.split(mine), ba: S.balancedCi(mine), flips: S.flips(mine),
        perRepeat: reps.map((x) => S.split(mine.filter((r) => (r.repeat || 0) === x)).balanced),
        p50ms: S.p50(mine.map((r) => r.ms)), p90ms: S.pq(mine.map((r) => r.ms), 0.9), mine,
      };
    });
    rows.sort((a, b) => (b.ba.rate == null ? -1 : b.ba.rate) - (a.ba.rate == null ? -1 : a.ba.rate) || (a.p50ms || 0) - (b.p50ms || 0));
    const top = rows[0];
    for (const r of rows) r.vsTop = r === top ? null : S.paired(top.mine, r.mine);
    for (const r of rows) delete r.mine;
    return rows;
  }

  global.GuardrailLive = {
    HOSTS, MAX_CASES, MAX_AGENTS, MAX_REPEATS, IN_FLIGHT, ROUTES, COMPLETION_QUERY, TEMP_PREFIX,
    isUuid, routeAllowed, call, readVerdict, statusText, listAll, providersWithModels,
    rankModels, suggestLineup, guardrailOf, guardrailOn, rulesOf, runConfig, createTemp, removeTemp, findLeftovers,
    judge, race, resultsCsv, summarize,
  };
})(window);

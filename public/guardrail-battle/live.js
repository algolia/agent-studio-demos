/* ───────────────────────────────────────────────────────────────
   live.js → window.GuardrailLive

   Race your own Agent Studio agents on an exam, from this browser.

   Every message goes to POST /1/agents/{id}/completions on your app. The
   agent's input guardrail answers in the stream: a data-guardrail-violation
   event means blocked, a stream that ends without one means allowed.

   What this file will and will not do:
     - the key lives in one closure variable, never in storage, a URL or a log
     - four request shapes are allowed (see ROUTES), all others throw before
       fetch; nothing here creates, edits or deletes anything on your app
     - cache, memory and analytics are off on every completion, so a run
       never reuses an answer, never feeds agent memory and stays out of your
       search analytics; the conversations themselves are still kept under
       the agent's own retention setting, like any other completion

   The core is pure and takes `fetch` as an argument, so
   tests/guardrail-live.test.js runs it against a fake server.
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
  const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
  const isUuid = (s) => new RegExp(`^${UUID}$`).test(String(s || "").trim());

  /** the only calls this page can make; everything else throws before fetch */
  const ROUTES = [
    ["GET", new RegExp(`^/1/agents/${UUID}$`)],
    ["GET", /^\/1\/providers$/],
    ["GET", new RegExp(`^/1/providers/${UUID}/models$`)],
    ["POST", new RegExp(`^/1/agents/${UUID}/completions$`)],
  ];
  const routeAllowed = (method, path) => ROUTES.some(([m, re]) => m === method && re.test(path));

  const COMPLETION_QUERY = "compatibilityMode=ai-sdk-5&stream=true&cache=false&memory=false&analytics=false";

  /** one request, checked against ROUTES; creds = { region, appId, apiKey } */
  function call(fetchImpl, creds, method, path, { query = "", body } = {}) {
    if (!routeAllowed(method, path)) throw new Error(`blocked by this page: ${method} ${path}`);
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
    });
  }

  /**
   * An ai-sdk-5 event stream → { verdict, category, error }.
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

  /** one message through one agent → { verdict, category, ms, error } */
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

  /** the race, one row per (message, agent), as CSV text */
  function resultsCsv(cases, agents, results) {
    const label = (id) => `agent ${agents.indexOf(id) + 1}`;
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
    HOSTS, MAX_CASES, MAX_AGENTS, IN_FLIGHT, ROUTES, COMPLETION_QUERY,
    isUuid, routeAllowed, call, readVerdict, statusText, judge, race, resultsCsv, summarize,
  };
})(window);

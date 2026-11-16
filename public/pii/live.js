/* ───────────────────────────────────────────────────────────────
   live.js — the optional live mode: one message to your own agent.

   POST /1/agents/{id}/completions, the same call and query as the
   Guardrails Arena (cache, memory and analytics off). The conversation is
   still kept under the agent's own retention setting, like any completion.

   What this file will and will not do:
     - the key is an argument, held by the caller in one closure variable;
       never storage, a URL or a log
     - one route only: POST completions on a UUID agent id; anything else
       throws before fetch
     - an error becomes a status sentence, never the response body (it may
       echo the message)

   `fetchImpl` is an argument, so tests/pii.test.js runs it against a fake.
   ─────────────────────────────────────────────────────────────── */

export const HOSTS = {
  eu: "https://agent-studio.eu.algolia.com",
  us: "https://agent-studio.us.algolia.com",
};
export const COMPLETION_QUERY = "compatibilityMode=ai-sdk-5&stream=true&cache=false&memory=false&analytics=false";
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export const isUuid = (s) => UUID.test(String(s || "").trim());

/** an ai-sdk-5 event stream → { text, error } */
export function readStream(streamText) {
  let text = "";
  let error = null;
  for (const line of String(streamText).split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let evt;
    try { evt = JSON.parse(payload); } catch (_) { continue; }
    if (evt.type === "text-delta" && typeof evt.delta === "string") text += evt.delta;
    else if (evt.type === "data-guardrail-violation") error = "blocked by the agent's guardrail";
    else if (evt.type === "error") error = "stream error";
  }
  return { text, error: text ? null : error };
}

export function statusText(status) {
  if (status === 401 || status === 403) return `${status}: this key cannot do that`;
  if (status === 404) return "404: no such agent in this app and region";
  if (status === 422) return "422: the agent refused the request";
  if (status === 429) return "429: rate limited";
  return `HTTP ${status}`;
}

/** creds = { region, appId, apiKey, agentId } → { text, error } */
export async function complete(fetchImpl, creds, message) {
  const host = HOSTS[creds.region];
  if (!host) throw new Error("unknown region");
  if (!isUuid(creds.agentId)) throw new Error("the agent id is not a UUID");
  const url = `${host}/1/agents/${creds.agentId.trim()}/completions?${COMPLETION_QUERY}`;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Algolia-Application-Id": creds.appId,
        "X-Algolia-API-Key": creds.apiKey,
      },
      body: JSON.stringify({ messages: [{ role: "user", parts: [{ type: "text", text: message }] }] }),
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
    });
    if (!res.ok) return { text: "", error: statusText(res.status) };
    return readStream(await res.text());
  } catch (e) {
    return { text: "", error: e && e.message === "Failed to fetch" ? "network or CORS" : "request failed" };
  }
}

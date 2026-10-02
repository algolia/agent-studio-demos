/* ───────────────────────────────────────────────────────────────
   client.mjs — the three remote calls the demo makes, over one transport.

     systemOne   POST <base>/systemone   Jev (TypeSafe) or Laya (Enablers)
     chat        POST <base>/chat/completions, streamed, usage read off the wire
     chatOnce    the same, not streamed: the LLM picker's JSON

   A transport is `post(route, body, { auth, timeoutMs, signal }) → Response`.
   The page posts to the relay at /relay/<route> on its own origin (the local
   proxy, or the stateless pass-through when deployed); the study posts to
   the vendors directly. The routes are the relay's allowlist: nothing else
   can be reached through it.
   ─────────────────────────────────────────────────────────────── */

import { createSseParser } from "../shared/sse.mjs";

/** route → upstream. The relay (functions/relay/[[path]].js) carries a copy; a test keeps them equal. */
export const ROUTES = {
  "typesafe/systemone": "https://api.typesafe.ai/v1/systemone",
  "laya/systemone": "https://inference-staging.api.enablers.algolia.net/v1/systemone",
  "enablers/chat/completions": "https://inference-eu.api.enablers.algolia.net/v1/chat/completions",
};

/** the System One targets: same request shape, different base, model and key */
export const TARGETS = {
  jev: { route: "typesafe/systemone", model: "jev-1.13.0", key: "jev", timeoutMs: 20000, attempts: 3 },
  // CPU-served: never a read timeout under 120 s
  laya: { route: "laya/systemone", model: "laya-auto", key: "enablers", timeoutMs: 180000, attempts: 2 },
};

export const ANSWER_MODEL = "medium";
export const PICKER_MODEL = "small";
const MAX_TOKENS = 16384;
const RETRY = new Set([429, 500, 502, 503, 504, 529]);
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

/** the page's transport: same-origin relay, the visitor's key in the header or none (the local proxy adds the owner's) */
export function relayTransport(base = "/relay", fetchImpl = (...a) => fetch(...a)) {
  return (route, body, { auth, timeoutMs, signal } = {}) => fetchImpl(`${base}/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    body: JSON.stringify(body),
    signal: combine(signal, timeoutMs),
  });
}

/** the study's transport: straight to the vendor */
export function directTransport(fetchImpl = (...a) => fetch(...a)) {
  return (route, body, { auth, timeoutMs, signal } = {}) => fetchImpl(ROUTES[route], {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth}` },
    body: JSON.stringify(body),
    signal: combine(signal, timeoutMs),
  });
}

function combine(signal, timeoutMs) {
  const list = [signal, timeoutMs ? AbortSignal.timeout(timeoutMs) : null].filter(Boolean);
  if (!list.length) return undefined;
  return list.length === 1 ? list[0] : AbortSignal.any(list);
}

/**
 * One System One call. Retries 429 and 5xx with capped backoff, Retry-After
 * honoured. Resolves { answers, ms, model, usage, attempts }; `ms` times the
 * attempt that answered.
 */
export async function systemOne(post, target, state, questions, { keys = {}, signal } = {}) {
  const t = TARGETS[target];
  const body = { model: t.model, state, questions };
  let last = null;
  for (let attempt = 1; attempt <= t.attempts; attempt++) {
    const t0 = performance.now();
    let res;
    try {
      res = await post(t.route, body, { auth: keys[t.key], timeoutMs: t.timeoutMs, signal });
    } catch (err) {
      if (signal && signal.aborted) throw err;
      last = err;
      await sleep(Math.min(2 ** attempt * 250, 4000));
      continue;
    }
    const ms = performance.now() - t0;
    if (RETRY.has(res.status) && attempt < t.attempts) {
      const after = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 8000) : 2 ** attempt * 250);
      continue;
    }
    const text = await res.text();
    if (res.status !== 200) throw new Error(`${target} HTTP ${res.status}: ${text.slice(0, 160)}`);
    const json = JSON.parse(text);
    const u = json.usage || {};
    return {
      answers: json.answers || {}, ms, model: json.model || t.model, attempts: attempt,
      usage: { inputTokens: u.input_tokens ?? null, outputTokens: u.output_tokens ?? null },
    };
  }
  throw new Error(`${target} unreachable after ${t.attempts} attempts: ${last ? last.message : "retries exhausted"}`);
}

const usageOf = (u) => (u ? {
  inputTokens: u.prompt_tokens ?? null,
  outputTokens: u.completion_tokens ?? null,
  cachedTokens: (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) ?? null,
} : null);

/**
 * Stream one completion. onDelta(text, tMs) per content chunk. `cacheSalt`
 * isolates the gateway's prefix cache (vLLM `cache_salt`): a fresh salt per
 * lane per run, so the latency on screen is never a cache hit left by the
 * previous click. Resolves { text, usage, model, ttft, total }.
 */
export async function chat(post, messages, { model = ANSWER_MODEL, keys = {}, onDelta, cacheSalt, signal } = {}) {
  const t0 = performance.now();
  const res = await post("enablers/chat/completions", {
    model, messages, max_tokens: MAX_TOKENS, temperature: 0,
    stream: true, stream_options: { include_usage: true },
    ...(cacheSalt ? { cache_salt: cacheSalt } : {}),
  }, { auth: keys.enablers, timeoutMs: 180000, signal });
  if (res.status !== 200) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const out = { text: "", usage: null, model: null, ttft: null, total: null };
  const parser = createSseParser((evt) => {
    if (evt.type === "[DONE]") return;
    if (evt.model) out.model = evt.model;
    const delta = evt.choices && evt.choices[0] && evt.choices[0].delta && evt.choices[0].delta.content;
    if (delta) {
      const t = performance.now() - t0;
      if (out.ttft === null) out.ttft = t;
      out.text += delta;
      if (onDelta) onDelta(delta, t);
    }
    if (evt.usage) out.usage = usageOf(evt.usage);
  });
  const reader = res.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    parser.push(value);
  }
  parser.end();
  out.total = performance.now() - t0;
  return out;
}

/** one completion, not streamed: { text, usage, model, ms } */
export async function chatOnce(post, messages, { model = PICKER_MODEL, keys = {}, signal } = {}) {
  const t0 = performance.now();
  const res = await post("enablers/chat/completions", {
    model, messages, max_tokens: MAX_TOKENS, temperature: 0, response_format: { type: "json_object" },
  }, { auth: keys.enablers, timeoutMs: 120000, signal });
  const text = await res.text();
  if (res.status !== 200) throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 160)}`);
  const json = JSON.parse(text);
  const msg = json.choices && json.choices[0] && json.choices[0].message;
  return { text: (msg && msg.content) || "", usage: usageOf(json.usage), model: json.model || model, ms: performance.now() - t0 };
}

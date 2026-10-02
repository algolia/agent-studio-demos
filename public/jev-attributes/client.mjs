/* ───────────────────────────────────────────────────────────────
   client.mjs: the one remote call the page makes: Jev, over a transport.

     systemOne   POST <base>/systemone   Jev (TypeSafe System One)

   A transport is `post(route, body, { auth, timeoutMs, signal }) → Response`.
   The page posts to the relay at /relay/<route> on its own origin (the local
   server, or the stateless pass-through when deployed); the study posts to
   the vendor directly (tools/jev-attributes/arms.mjs). ROUTES is the relay's
   allowlist: nothing else can be reached through it.
   ─────────────────────────────────────────────────────────────── */

/** route → upstream. The relay (functions/relay/[[path]].js) carries a copy; a test keeps them equal. */
export const ROUTES = {
  "typesafe/systemone": "https://api.typesafe.ai/v1/systemone",
};

/** the System One target the page asks: its route, model and the key it needs */
export const TARGETS = {
  jev: { name: "jev", route: "typesafe/systemone", model: "jev-1.13.0", key: "jev", timeoutMs: 20000, attempts: 3 },
};

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

function combine(signal, timeoutMs) {
  const list = [signal, timeoutMs ? AbortSignal.timeout(timeoutMs) : null].filter(Boolean);
  if (!list.length) return undefined;
  return list.length === 1 ? list[0] : AbortSignal.any(list);
}

/**
 * One System One call to `target`: a name in TARGETS, or a target object of
 * the same shape (the study passes Laya's). Retries 429 and 5xx with capped
 * backoff, Retry-After honoured. Resolves { answers, ms, model, usage,
 * attempts }; `ms` times the attempt that answered.
 */
export async function systemOne(post, target, state, questions, { keys = {}, signal } = {}) {
  const t = typeof target === "string" ? TARGETS[target] : target;
  const name = t.name || target;
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
    if (res.status !== 200) throw new Error(`${name} HTTP ${res.status}: ${text.slice(0, 160)}`);
    const json = JSON.parse(text);
    const u = json.usage || {};
    return {
      answers: json.answers || {}, ms, model: json.model || t.model, attempts: attempt,
      usage: { inputTokens: u.input_tokens ?? null, outputTokens: u.output_tokens ?? null },
    };
  }
  throw new Error(`${name} unreachable after ${t.attempts} attempts: ${last ? last.message : "retries exhausted"}`);
}

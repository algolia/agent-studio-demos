/* ───────────────────────────────────────────────────────────────
   jev.mjs — TypeSafe "System One", the typed-question API Jev answers on.

     POST https://api.typesafe.ai/v1/systemone
     { model, state: { body }, questions: { id: { type: "noul", instructions } } }
     → { model, answers: { id: { noul: P(yes) } }, usage: { input_tokens, output_tokens } }

   Same shape and retry rules as the agentic-evals client: retry on 429 and
   5xx with capped backoff (Retry-After honoured), fixed connect and read
   timeouts. The key stays in this process.

   Data rule: Jev is an external vendor. Only public or synthetic text goes
   to it — here, a question the visitor types about public-domain Factbook data.
   ─────────────────────────────────────────────────────────────── */

export const JEV_BASE = "https://api.typesafe.ai/v1";
export const JEV_MODEL = "jev-1.13.0";
const RETRY = new Set([429, 500, 502, 503, 504, 529]);
const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 20000;

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

/** one System One call → { answers, ms, model, usage, attempts } or throws */
export async function ask(key, body, questions) {
  if (!key) throw new Error("JEV_API_KEY is not set");
  const payload = JSON.stringify({ model: JEV_MODEL, state: { body }, questions });
  let last = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const t0 = performance.now();
    let res;
    try {
      res = await fetch(`${JEV_BASE}/systemone`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: payload,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      last = err;
      await sleep(Math.min(2 ** attempt * 250, 4000));
      continue;
    }
    const ms = performance.now() - t0;
    if (RETRY.has(res.status) && attempt < MAX_ATTEMPTS) {
      const after = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 2 ** attempt * 250);
      continue;
    }
    const text = await res.text();
    if (res.status !== 200) throw new Error(`Jev HTTP ${res.status}: ${text.slice(0, 200)}`);
    const json = JSON.parse(text);
    const u = json.usage || {};
    return {
      answers: json.answers || {}, ms, model: json.model || JEV_MODEL, attempts: attempt,
      usage: { inputTokens: u.input_tokens ?? null, outputTokens: u.output_tokens ?? null },
    };
  }
  throw new Error(`Jev unreachable after ${MAX_ATTEMPTS} attempts: ${last ? last.message : "retries exhausted"}`);
}

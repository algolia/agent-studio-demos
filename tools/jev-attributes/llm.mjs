/* ───────────────────────────────────────────────────────────────
   llm.mjs — one streamed chat completion on Enablers, usage read off the wire.

   Enablers is OpenAI-compatible. Auth is a short-lived OIDC token minted from
   the maintainer's own `vault login` (tier `enablers`), held in memory, and
   re-minted once on a 401. No static key exists for this path by design.

   Token counts are the API's own: the stream ends with a usage chunk
   (`stream_options.include_usage`), and nothing here estimates a count.
   ─────────────────────────────────────────────────────────────── */

import { execFile } from "node:child_process";
import { createSseParser } from "../../public/shared/sse.mjs";

export const LLM_BASE = process.env.ENABLERS_BASE_URL || "https://inference-eu.api.enablers.algolia.net/v1";
export const LLM_MODEL = process.env.ENABLERS_MODEL || "medium";
const MAX_TOKENS = 16384;
const CONNECT_MS = 10000;
const READ_MS = 120000;

let token = null;

function mint() {
  const tier = process.env.ENABLERS_VAULT_TIER || "enablers";
  return new Promise((ok, fail) => {
    execFile("vault", ["read", "-field=token", `identity/oidc/token/${tier}`], { timeout: 15000 }, (err, stdout) => {
      const t = String(stdout || "").trim();
      if (err || !t) fail(new Error("Vault mint failed: run `vault login -method=oidc`"));
      else ok(t);
    });
  });
}

async function bearer(fresh = false) {
  if (!token || fresh) token = await mint();
  return token;
}

/**
 * Stream one completion. Calls onDelta(text, tMs) per content chunk.
 * Resolves { text, usage: { inputTokens, outputTokens, cachedTokens }, model, ttft, total }.
 */
export async function complete(messages, onDelta, { signal } = {}) {
  const t0 = performance.now();
  const body = JSON.stringify({
    model: LLM_MODEL, messages, max_tokens: MAX_TOKENS, temperature: 0,
    stream: true, stream_options: { include_usage: true },
  });
  let res = null;
  let ctl = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    ctl = new AbortController();
    if (signal) signal.addEventListener("abort", () => ctl.abort(signal.reason), { once: true });
    const connect = setTimeout(() => ctl.abort(new Error("connect timeout")), CONNECT_MS);
    try {
      res = await fetch(`${LLM_BASE}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${await bearer(attempt > 0)}` },
        body, signal: ctl.signal,
      });
    } finally {
      clearTimeout(connect);
    }
    if (res.status !== 401) break;
  }
  if (res.status !== 200) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const read = setTimeout(() => ctl.abort(new Error("read timeout")), READ_MS);
  const out = { text: "", usage: null, model: null, ttft: null, total: null };
  const parser = createSseParser((evt) => {
    if (evt.type === "[DONE]") return;
    if (evt.model) out.model = evt.model;
    const delta = evt.choices && evt.choices[0] && evt.choices[0].delta && evt.choices[0].delta.content;
    if (delta) {
      const t = performance.now() - t0;
      if (out.ttft === null) out.ttft = t;
      out.text += delta;
      onDelta(delta, t);
    }
    if (evt.usage) {
      const d = evt.usage.prompt_tokens_details || {};
      out.usage = {
        inputTokens: evt.usage.prompt_tokens ?? null,
        outputTokens: evt.usage.completion_tokens ?? null,
        cachedTokens: d.cached_tokens ?? null,
      };
    }
  });
  try {
    for await (const chunk of res.body) parser.push(chunk);
    parser.end();
  } finally {
    clearTimeout(read);
  }
  out.total = performance.now() - t0;
  return out;
}

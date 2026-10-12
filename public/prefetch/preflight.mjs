/* ───────────────────────────────────────────────────────────────
   preflight.mjs: can both agents answer, before anyone presses Run?

   /status 200 says the backend is up, not that an agent exists or that its
   model answers. So the page sends each lane's agent one short message, the
   same request a lane sends, and reads the stream only until the model
   starts answering. One call per lane per page load; a pass is kept for
   the session, a failure never is, so a fixed agent shows on reload.

   Pure apart from the fetch it is handed: no DOM, no storage.
   ─────────────────────────────────────────────────────────────── */

import { completionQuery } from "../main-demo/configs.mjs";
import { createSseParser } from "../main-demo/stream.mjs";

/* check-copy: off */
/** the probe's message: short, and under prefetch's two-word gate, so no search runs */
export const PROBE_TEXT = "Hello";
/* check-copy: on */

/** a failed call, said in a few words */
export function reasonFor(status, message) {
  if (status === 404) return "agent not found on this backend";
  if (status === 401 || status === 403) return "the key was refused";
  if (status === 429) return "rate limited";
  if (status >= 500) return `backend error (HTTP ${status})`;
  if (message) return String(message).slice(0, 80);
  return status ? `HTTP ${status}` : "no answer";
}

/** the completions request a lane makes, with one short user message */
export function probeRequest({ host, appId, apiKey }, agentId) {
  const q = new URLSearchParams(completionQuery()).toString();
  return {
    url: `${host}/1/agents/${agentId}/completions?${q}`,
    init: {
      method: "POST",
      headers: { "content-type": "application/json", "x-algolia-application-id": appId || "", "x-algolia-api-key": apiKey || "" },
      body: JSON.stringify({ messages: [{ id: "preflight", role: "user", parts: [{ type: "text", text: PROBE_TEXT }] }] }),
    },
  };
}

/**
 * One probe: { ok: true } once the model starts answering (text or a tool
 * call), else { ok: false, reason }. Stops reading at the first sign either way.
 */
export async function probeAgent(fetchFn, cfg, agentId, { timeoutMs = 20000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const { url, init } = probeRequest(cfg, agentId);
  try {
    let res;
    try {
      res = await fetchFn(url, { ...init, signal: ctl.signal });
    } catch (_) {
      return { ok: false, reason: ctl.signal.aborted ? "no answer in time" : "backend unreachable" };
    }
    if (!res.ok) {
      let message = "";
      try { message = (await res.json()).message || ""; } catch (_) { /* not JSON */ }
      return { ok: false, reason: reasonFor(res.status, message) };
    }
    if (!res.body) return { ok: false, reason: "empty answer" };
    let verdict = null;
    const parser = createSseParser((evt) => {
      if (verdict) return;
      if (evt.type === "error") verdict = { ok: false, reason: String(evt.errorText || "the model call failed").slice(0, 80) };
      else if (evt.type === "text-delta" || evt.type === "tool-input-start") verdict = { ok: true };
    });
    const reader = res.body.getReader();
    try {
      while (!verdict) {
        const { value, done } = await reader.read();
        if (done) break;
        parser.push(value);
      }
      parser.end();
    } catch (_) {
      if (!verdict) verdict = { ok: false, reason: ctl.signal.aborted ? "no answer in time" : "stream interrupted" };
    }
    try { await reader.cancel(); } catch (_) { /* already closed */ }
    return verdict || { ok: false, reason: "no answer" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The page's state from the lanes' probe results ({ a, b }, undefined while
 * pending): { phase: "checking" | "ready" | "unavailable", text }.
 */
export function preflightState(results, lanes) {
  const r = results || {};
  const failed = lanes.filter((l) => r[l.key] && !r[l.key].ok);
  if (failed.length) {
    return { phase: "unavailable", text: `Live unavailable: ${failed.map((l) => `${l.label}: ${r[l.key].reason}`).join("; ")}.` };
  }
  if (lanes.some((l) => !r[l.key])) return { phase: "checking", text: "Checking agents…" };
  return { phase: "ready", text: "Ready" };
}

/** the session key for a passing probe: same backend, same agent */
export function cacheKey(host, agentId) {
  return `prefetch-preflight:${host}:${agentId}`;
}

/** why a lane's turn produced no answer, or null when it did */
export function laneFailure(view) {
  if (!view || view.status === "sending" || view.status === "streaming") return null;
  if (view.httpStatus >= 400) return reasonFor(view.httpStatus);
  if (view.status === "error" || (view.errors && view.errors.length)) {
    return String((view.errors && view.errors[0]) || "the call failed").slice(0, 80);
  }
  return null;
}

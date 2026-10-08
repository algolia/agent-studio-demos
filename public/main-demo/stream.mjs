/* ───────────────────────────────────────────────────────────────
   stream.mjs — reading one ai-sdk-5 completion as it arrives.

   Pure: no DOM, no fetch. The lane tees the response body, feeds the copy
   through `createSseParser`, and hands each event to `createTurn().observe`
   with the time it arrived. What comes out is the timeline strip, the hits
   panel and the wire drawer, all from the same events the Chat widget saw.
   ─────────────────────────────────────────────────────────────── */

/** split an SSE byte stream into parsed `data:` payloads */
export function createSseParser(onEvent) {
  const dec = new TextDecoder();
  let buf = "";
  const flushLine = (line) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload) return;
    if (payload === "[DONE]") { onEvent({ type: "[DONE]" }); return; }
    let evt;
    try { evt = JSON.parse(payload); } catch (_) { return; }
    if (evt && typeof evt === "object") onEvent(evt);
  };
  return {
    push(chunk) {
      buf += typeof chunk === "string" ? chunk : dec.decode(chunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) flushLine(line.replace(/\r$/, ""));
    },
    end() { if (buf) flushLine(buf); buf = ""; },
  };
}

/**
 * The backend's account of the prefetch: one `data-search_prefetch` part per
 * user turn on a prefetch agent, skipped turns included, sent before the
 * prefetched search (docs/SEARCH_PREFETCH.md, "Stream part").
 *
 *   { decision, nbHits, latencyMs, toolName, index, toolCallId }
 *
 * It never carries hits: the visible search tool parts do, and the
 * prefetched search is the tool call whose id is `toolCallId`.
 */
export function isPrefetchPart(evt) {
  return Boolean(evt) && evt.type === "data-search_prefetch";
}

/* check-copy: off */
const DECISIONS = {
  injected_candidate: "injected",
  skipped_eval_mode: "skipped: eval mode",
  skipped_no_mcp_tool: "skipped: no MCP search tool",
  skipped_no_user_turn: "skipped: no user turn",
  skipped_too_few_tokens: "skipped: too few words",
  skipped_no_index: "skipped: no index",
  skipped_no_hits: "skipped: no hits",
  error: "error",
};
/* check-copy: on */

/** a decision as the lane prints it; an unknown one prints as itself */
export function decisionLabel(decision) {
  return DECISIONS[decision] || String(decision || "reported");
}

/** the agent's own search tool, in any of its names (native, per-index, MCP); memory search is not one */
export function isSearchTool(name) {
  const n = String(name || "").toLowerCase();
  return n.includes("search") && !n.includes("memory");
}

/**
 * Token usage, wherever the backend puts it. Today: `data-total-usage`,
 * streamed when the agent config says `sendUsage: true`. The other two
 * spellings are the hook for a future `data-usage` part or usage carried in
 * message metadata. Returns { inputTokens, outputTokens } or null.
 */
export function usageOf(evt) {
  const t = String((evt && evt.type) || "");
  const raw = t === "data-total-usage" || t === "data-usage"
    ? evt.data && (evt.data.usage || evt.data)
    : evt && evt.messageMetadata && evt.messageMetadata.usage;
  if (!raw || typeof raw !== "object") return null;
  const n = (v) => (Number.isFinite(v) ? v : null);
  const out = { inputTokens: n(raw.inputTokens), outputTokens: n(raw.outputTokens) };
  return out.inputTokens === null && out.outputTokens === null ? null : out;
}

/** the hits array of a tool output, or null */
export function hitsOf(output) {
  if (!output || typeof output !== "object") return null;
  if (Array.isArray(output.hits)) return output.hits;
  // MCP-shaped results carry the JSON as text content
  if (Array.isArray(output.content)) {
    for (const c of output.content) {
      if (c && c.type === "text" && typeof c.text === "string") {
        try {
          const j = JSON.parse(c.text);
          if (j && Array.isArray(j.hits)) return j.hits;
        } catch (_) { /* not JSON */ }
      }
    }
  }
  return null;
}

/**
 * One turn's observations. `t` is milliseconds since the request went out.
 * `view()` is what the strip draws; nothing in it is estimated.
 */
export function createTurn({ text = "", sentAt = 0 } = {}) {
  const s = {
    text,
    sentAt,
    status: "sending",       // sending → streaming → done | error
    ttfb: null,              // headers arrived
    ttft: null,              // first text-delta
    total: null,
    httpStatus: null,
    cache: null,             // X-Cache, when the backend served a stored answer
    prefetchPart: null,      // payload of the latest data-search_prefetch part
    prefetchParts: 0,        // how many came: 1 per user turn on a prefetch agent
    modelCalls: 0,           // start-step events: one per LLM call
    started: [],             // tool-input-start ids; the prefetched one is left out of the model's calls
    toolErrors: 0,           // tool-input-error events: calls the model wrote wrong, each one a wasted step
    usage: null,             // { inputTokens, outputTokens }, when the agent streams usage (see usageOf)
    tools: new Map(),        // toolCallId → { name, start, end, error, input }
    toolOrder: [],
    hits: [],                // latest search output
    hitsTool: null,
    grouped: null,           // { intro, groups } of a grouped-results input
    suggestions: [],
    errors: [],
    events: [],              // [{ t, evt }] for the wire drawer
    answer: "",
  };

  const tool = (id, name, t) => {
    if (!s.tools.has(id)) {
      s.tools.set(id, { id, name: name || "tool", start: t, end: null, error: null, input: null });
      s.toolOrder.push(id);
    }
    const rec = s.tools.get(id);
    if (name && rec.name === "tool") rec.name = name;
    return rec;
  };

  return {
    state: s,
    /** response headers arrived */
    headers(t, { status, get }) {
      s.ttfb = t;
      s.httpStatus = status;
      s.status = status >= 200 && status < 300 ? "streaming" : "error";
      const cache = get("x-cache");
      if (cache) s.cache = cache;
    },
    observe(t, evt) {
      if (s.events.length < 600) s.events.push({ t, evt });
      const u = usageOf(evt);
      if (u) s.usage = u;
      switch (evt.type) {
        case "start-step":
          s.modelCalls += 1;
          break;
        case "text-delta":
          if (s.ttft === null) s.ttft = t;
          s.answer += evt.delta || "";
          break;
        case "tool-input-start":
          tool(evt.toolCallId, evt.toolName, t);
          if (!s.started.includes(evt.toolCallId)) s.started.push(evt.toolCallId);
          break;
        case "tool-input-available": {
          const rec = tool(evt.toolCallId, evt.toolName, t);
          rec.input = evt.input;
          if (evt.input && Array.isArray(evt.input.groups)) s.grouped = evt.input;
          break;
        }
        case "tool-output-available": {
          const rec = tool(evt.toolCallId, null, t);
          rec.end = t;
          const hits = hitsOf(evt.output);
          if (hits) { s.hits = hits; s.hitsTool = rec.name; }
          break;
        }
        case "tool-output-error":
        case "tool-input-error": {
          if (evt.type === "tool-input-error") s.toolErrors += 1;
          const rec = tool(evt.toolCallId, evt.toolName, t);
          rec.end = t;
          rec.error = evt.errorText || "tool error";
          break;
        }
        case "data-suggestions": {
          const raw = evt.data && (evt.data.suggestions || evt.data);
          if (Array.isArray(raw)) s.suggestions = raw.filter((x) => typeof x === "string");
          break;
        }
        case "error":
          s.errors.push(evt.errorText || "stream error");
          break;
        default:
          if (isPrefetchPart(evt) && evt.data && typeof evt.data === "object") {
            s.prefetchParts += 1;
            // a fixed id: a repeat replaces the first, as it does in the Chat widget
            s.prefetchPart = evt.data;
          }
      }
    },
    finish(t, { error } = {}) {
      s.total = t;
      if (error) { s.status = "error"; s.errors.push(String(error)); } else if (s.status !== "error") s.status = "done";
    },
    view() { return viewOf(s); },
  };
}

/** the strip's view model: marks along one axis, and the tool rows under it */
export function viewOf(s) {
  const passiveId = (s.prefetchPart && s.prefetchPart.toolCallId) || null;
  const searchMs = s.prefetchPart && Number.isFinite(s.prefetchPart.latencyMs) ? s.prefetchPart.latencyMs : null;
  const tools = s.toolOrder.map((id) => {
    const r = s.tools.get(id);
    if (id === passiveId && searchMs !== null) {
      // the pair streams after the search finished: its wire time is ~0, the part holds the real one
      const start = Math.max(0, r.start - searchMs);
      return { id, name: r.name, start, open: false, end: r.start, duration: r.start - start,
        error: r.error, passive: true, search: false };
    }
    // a call still open when the turn ended stops at the turn's end, never past it
    const end = r.end === null ? (s.total !== null ? s.total : null) : Math.min(r.end, s.total ?? r.end);
    return {
      id, name: r.name, start: r.start, open: r.end === null,
      end, duration: end === null ? null : Math.max(0, end - r.start),
      error: r.error, passive: id === passiveId,
      search: id !== passiveId && isSearchTool(r.name),
    };
  });
  const span = s.total !== null ? s.total
    : Math.max(s.ttfb || 0, s.ttft || 0, ...tools.map((x) => x.end || x.start || 0), 1);
  const marks = [
    { id: "sent", label: "sent", t: 0 },
    s.ttfb !== null && { id: "ttfb", label: "first byte", t: s.ttfb },
    s.ttft !== null && { id: "ttft", label: "first token", t: s.ttft },
    s.total !== null && { id: "total", label: "total", t: s.total },
  ].filter(Boolean);
  return {
    status: s.status, span, marks, tools, searches: tools.filter((x) => x.search).length,
    ttfb: s.ttfb, ttft: s.ttft, total: s.total,
    prefetchPart: s.prefetchPart, prefetchParts: s.prefetchParts, cache: s.cache, errors: s.errors,
    modelCalls: s.modelCalls, toolCalls: s.started.filter((id) => id !== passiveId).length, toolErrors: s.toolErrors, usage: s.usage,
    hits: s.hits, hitsTool: s.hitsTool, grouped: s.grouped,
    httpStatus: s.httpStatus,
  };
}

/**
 * The turn's searches, split by who ran them.
 *
 *   passive: the prefetch, run by the platform before the model's first call;
 *            1 when the part names the tool call it injected (`toolCallId`)
 *   active:  search calls the model wrote itself
 *   searchedAnyway: after an injected prefetch, whether the model searched
 *            itself too; read off the stream, null until the turn settles it
 *   reported: a part came; a prefetch lane without one is on a backend that
 *            does not stream it
 *
 * A prefetch the backend skipped (too few words, no hits) injected nothing:
 * its part has no toolCallId, and the passive count is 0.
 */
export function searchCounts(prefetchOn, view) {
  const active = view ? view.searches : 0;
  const part = (view && view.prefetchPart) || null;
  if (!part) return { passive: 0, active, part: null, searchedAnyway: null, reported: false, expected: prefetchOn };
  const passive = part.toolCallId ? 1 : 0;
  const done = view.status === "done" || view.status === "error";
  const searchedAnyway = !passive ? null : active > 0 ? true : done ? false : null;
  return { passive, active, part, searchedAnyway, reported: true, expected: prefetchOn };
}

/** "412 ms", "1.9 s" — one rule, so the strip and the report agree */
export function ms(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  if (v < 1000) return `${Math.round(v)}\u00a0ms`;
  return `${(v / 1000).toFixed(v < 10000 ? 2 : 1)}\u00a0s`;
}

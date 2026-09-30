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

/** a stream part that says the backend prefetched, in any spelling it may take */
export function isPrefetchPart(evt) {
  const t = String((evt && evt.type) || "").toLowerCase().replace(/-/g, "_");
  return t === "search_prefetch" || t === "data_search_prefetch";
}

/** the agent's own search tool, in any of its names (native, per-index, MCP); memory search is not one */
export function isSearchTool(name) {
  const n = String(name || "").toLowerCase();
  return n.includes("search") && !n.includes("memory");
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
    prefetch: null,          // { source: "header" | "stream" | "persisted-pair", detail }
    prefetchPart: null,      // payload of a data-search_prefetch part, once the backend streams one
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
      const pf = get("x-search-prefetch");
      if (pf) s.prefetch = { source: "header", detail: pf };
      const cache = get("x-cache");
      if (cache) s.cache = cache;
    },
    observe(t, evt) {
      if (s.events.length < 600) s.events.push({ t, evt });
      switch (evt.type) {
        case "text-delta":
          if (s.ttft === null) s.ttft = t;
          s.answer += evt.delta || "";
          break;
        case "tool-input-start":
          tool(evt.toolCallId, evt.toolName, t);
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
          if (isPrefetchPart(evt)) {
            if (!s.prefetch) s.prefetch = { source: "stream", detail: evt.data || null };
            if (evt.data && typeof evt.data === "object") s.prefetchPart = evt.data;
          }
      }
      // persisted_tool_pair streams the fabricated call; its id says what it is
      if (!s.prefetch && typeof evt.toolCallId === "string" && evt.toolCallId.startsWith("prefetch_")) {
        s.prefetch = { source: "persisted-pair", detail: evt.toolCallId };
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
  const tools = s.toolOrder.map((id) => {
    const r = s.tools.get(id);
    return {
      id, name: r.name, start: r.start,
      end: r.end, duration: r.end === null ? null : r.end - r.start,
      error: r.error, prefetched: id.startsWith("prefetch_"),
      search: !id.startsWith("prefetch_") && isSearchTool(r.name),
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
    prefetch: s.prefetch, prefetchPart: s.prefetchPart, cache: s.cache, errors: s.errors,
    hits: s.hits, hitsTool: s.hitsTool, grouped: s.grouped,
    httpStatus: s.httpStatus,
  };
}

/**
 * What prefetch did this turn, as far as the page can tell.
 *
 *   state: "off" | "waiting" | "used" | "searched" | "skipped"
 *   searches: the model's own search calls
 *   confirmed: true only when a data-search_prefetch part said so
 *
 * Until the backend streams that part, "used" and "searched" are read off
 * the tool calls: a prefetch lane whose model never searched used the hits.
 */
export function prefetchVerdict(prefetchOn, view) {
  const searches = view ? view.searches : 0;
  const part = view && view.prefetchPart;
  if (!prefetchOn) return { state: "off", searches, confirmed: false, part: null };
  if (part && part.injected === false) return { state: "skipped", searches, confirmed: true, part };
  if (searches > 0) return { state: "searched", searches, confirmed: Boolean(part), part };
  if (!view || view.status !== "done") return { state: "waiting", searches, confirmed: false, part };
  return { state: "used", searches, confirmed: Boolean(part), part };
}

/** "412 ms", "1.9 s" — one rule, so the strip and the report agree */
export function ms(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  if (v < 1000) return `${Math.round(v)}\u00a0ms`;
  return `${(v / 1000).toFixed(v < 10000 ? 2 : 1)}\u00a0s`;
}

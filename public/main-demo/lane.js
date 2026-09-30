/* ───────────────────────────────────────────────────────────────
   lane.js — one agent, one conversation, one React root.

   A lane is an InstantSearch instance with a Chat widget bound to one agent
   variant, plus what the widget does not show: a timeline of the request,
   the hits the search tool returned, and the raw ai-sdk-5 events. The page
   mounts one lane in Chat mode and two in RAG race mode; they share this
   code and nothing else — separate roots, separate state, separate chats.

   Everything the side panels show comes from one place: the transport's
   fetch. It tees the response body, so the widget reads one copy and
   stream.mjs reads the other, event for event.
   ─────────────────────────────────────────────────────────────── */

import React from "react";
import { createRoot } from "react-dom/client";
import htm from "htm";
import { InstantSearch, Chat, ChatInlineLayout } from "react-instantsearch";
import {
  TOGGLES, PREFETCH_FORMATS, normalize, resolveVariant, completionQuery, agentName,
} from "./configs.mjs";
import { createSseParser, createTurn, ms } from "./stream.mjs";
import { createFixtureFetch } from "./fixture.mjs";

const html = htm.bind(React.createElement);
const { useState, useMemo, useRef, useEffect, useCallback } = React;

/* ── Records → cards ──────────────────────────────────────────── */

const pick = (item, names) => {
  for (const n of names) {
    const v = n.split(".").reduce((o, k) => (o == null ? o : o[k]), item);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
};

const FIELD_DEFAULTS = {
  title: ["name", "title", "product_name", "label"],
  image: ["image", "image_url", "imageUrl", "thumbnail", "images.0", "picture"],
  price: ["price.value", "price", "salePrice", "sale_price", "price_usd"],
  line: ["description", "short_description", "brand", "category", "categories.0"],
};

function fieldsFrom(cfg) {
  const f = (cfg && cfg.fields) || {};
  const out = {};
  for (const k of Object.keys(FIELD_DEFAULTS)) {
    out[k] = f[k] ? [].concat(f[k], FIELD_DEFAULTS[k]) : FIELD_DEFAULTS[k];
  }
  return out;
}

function priceText(p) {
  if (p === undefined) return "";
  if (typeof p === "number") return `$${p % 1 ? p.toFixed(2) : p}`;
  return String(p);
}

function lineText(v) {
  const s = Array.isArray(v) ? v.join(", ") : String(v || "");
  return s.length > 90 ? s.slice(0, 88).trimEnd() + "…" : s;
}

function makeCard(fields) {
  return function ProductCard({ item }) {
    const title = pick(item, fields.title) || item.objectID;
    const image = pick(item, fields.image);
    const why = item.__groupedToolResult && item.__groupedToolResult.why;
    return html`<article class="pcard">
      <div class="pcard-img">${image
        ? html`<img src=${String(image)} alt="" loading="lazy" />`
        : html`<span aria-hidden="true">${String(title).slice(0, 1)}</span>`}</div>
      <div class="pcard-body">
        <p class="pcard-title">${String(title)}</p>
        <p class="pcard-price">${priceText(pick(item, fields.price))}</p>
        <p class="pcard-line">${why ? why : lineText(pick(item, fields.line))}</p>
      </div>
    </article>`;
  };
}

/* ── The timeline strip ───────────────────────────────────────── */

function Timeline({ view, fixture }) {
  if (!view) {
    return html`<div class="tl is-empty"><div class="tl-track"></div>
      <p class="tl-legend">Timings appear here after the first message.</p></div>`;
  }
  const pct = (t) => `${Math.min(100, Math.max(0, (t / view.span) * 100))}%`;
  return html`<div class=${"tl is-" + view.status}>
    <div class="tl-track" role="img" aria-label=${`first byte ${ms(view.ttfb)}, first token ${ms(view.ttft)}, total ${ms(view.total)}`}>
      ${view.tools.map((x) => html`<span key=${x.id}
        class=${"tl-tool" + (x.error ? " is-error" : "") + (x.prefetched ? " is-prefetch" : "")}
        style=${{ left: pct(x.start), width: `max(3px, ${pct((x.end ?? view.span) - x.start)})` }}
        title=${`${x.name} ${ms(x.duration)}`}></span>`)}
      ${view.marks.map((m) => html`<span key=${m.id} class=${"tl-mark is-" + m.id} style=${{ left: pct(m.t) }}></span>`)}
    </div>
    <ul class="tl-legend">
      <li class="is-ttfb"><b>${ms(view.ttfb)}</b> first byte</li>
      <li class="is-ttft"><b>${ms(view.ttft)}</b> first token</li>
      ${view.tools.map((x) => html`<li key=${x.id} class=${"is-tool" + (x.error ? " is-error" : "")}>
        <b>${x.duration === null ? "…" : ms(x.duration)}</b> <code>${x.name}</code></li>`)}
      <li class="is-total"><b>${view.total === null ? "…" : ms(view.total)}</b> total</li>
      ${view.cache && html`<li class="is-cache">cache ${view.cache}</li>`}
      ${fixture && html`<li class="is-fixture">replayed fixture</li>`}
    </ul>
  </div>`;
}

/* ── The config panel ─────────────────────────────────────────── */

function ConfigPanel({ toggles, onChange, resolution, disabled }) {
  const set = (k, v) => onChange(normalize({ ...toggles, [k]: v }));
  const entry = resolution.entry || {};
  const how = resolution.status === "agent" ? html`agent <code>${entry.name || agentName(toggles)}</code>`
    : resolution.status === "query" ? html`<code>${entry.name}</code> + <code>?searchPrefetch=false</code>`
      : html`no agent yet`;
  return html`<details class="cfg">
    <summary><span class="cfg-h">Config</span> <span class="cfg-how">${how}</span></summary>
    <div class="cfg-body">
      ${TOGGLES.map((tg) => tg.kind === "prefetch"
        ? html`<div class="cfg-row" key=${tg.id}>
            <label class="sw"><input type="checkbox" disabled=${disabled}
              checked=${toggles.prefetch !== "off"}
              onChange=${(e) => set("prefetch", e.target.checked ? (toggles.lastFormat || "tool_pair") : "off")} />
              <span>${tg.label}</span></label>
            <select aria-label="Injection format" disabled=${disabled || toggles.prefetch === "off"}
              value=${toggles.prefetch === "off" ? (toggles.lastFormat || "tool_pair") : toggles.prefetch}
              onChange=${(e) => set("prefetch", e.target.value)}>
              ${PREFETCH_FORMATS.map((f) => html`<option key=${f} value=${f}>${f}</option>`)}
            </select>
          </div>`
        : html`<div class="cfg-row" key=${tg.id}>
            <label class="sw"><input type="checkbox" disabled=${disabled} checked=${toggles[tg.id]}
              onChange=${(e) => set(tg.id, e.target.checked)} /><span>${tg.label}</span></label>
          </div>`)}
      <p class="cfg-model">${entry.model
        ? html`<code>${entry.model}</code>${entry.provider ? html` · ${entry.provider}` : ""}`
        : "model unknown"}</p>
    </div>
  </details>`;
}

/* ── Hits, and the wire ───────────────────────────────────────── */

function HitsPanel({ view, Card }) {
  const hits = (view && view.hits) || [];
  if (!hits.length) return null;
  return html`<section class="hits" aria-label="Search hits">
    <p class="hits-h"><b>${hits.length}</b> hits from <code>${view.hitsTool}</code></p>
    <div class="hits-row">${hits.slice(0, 12).map((h) => html`<${Card} key=${h.objectID} item=${h} />`)}</div>
  </section>`;
}

function Wire({ turn }) {
  const events = (turn && turn.state.events) || [];
  return html`<details class="wire">
    <summary>wire · ${events.length} events</summary>
    <pre>${events.map(({ t, evt }) => {
      const s = JSON.stringify(evt);
      return `+${String(Math.round(t)).padStart(5)}ms ${s.length > 400 ? s.slice(0, 400) + "…" : s}\n`;
    }).join("")}</pre>
  </details>`;
}

function Missing({ resolution }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    try { navigator.clipboard.writeText(resolution.command); setCopied(true); } catch (_) { /* no clipboard */ }
  };
  return html`<div class="missing">
    <p><b>No agent for this setup yet.</b> Create it, then reload:</p>
    <pre><code>${resolution.command}</code></pre>
    <button type="button" class="btn-quiet" onClick=${copy}>${copied ? "Copied" : "Copy command"}</button>
  </div>`;
}

/* ── The lane ─────────────────────────────────────────────────── */

const STUB_CLIENT = {
  search: async (requests) => ({
    results: requests.map((r) => ({
      hits: [], nbHits: 0, page: 0, nbPages: 0, hitsPerPage: 0, processingTimeMS: 0,
      exhaustiveNbHits: true, query: (r.params && r.params.query) || "", params: "", index: r.indexName,
    })),
  }),
};

function LaneApp({ controller, label, cfg, variants, searchClient, initialToggles, fixture }) {
  const [toggles, setToggles] = useState(() => normalize(initialToggles));
  const [turn, setTurn] = useState(null);
  const [, setTick] = useState(0);
  const chatRef = useRef(null);
  const fields = useMemo(() => fieldsFrom(cfg), [cfg]);
  const Card = useMemo(() => makeCard(fields), [fields]);
  const resolution = useMemo(() => resolveVariant(toggles, variants), [toggles, variants]);

  // one redraw per frame, however fast the events come
  const frame = useRef(0);
  const redraw = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => { frame.current = 0; setTick((n) => n + 1); });
  }, []);

  const transport = useMemo(() => {
    if (resolution.status === "missing") return null;
    const q = new URLSearchParams(completionQuery(resolution)).toString();
    const api = `${cfg.host}/1/agents/${resolution.agentId}/completions?${q}`;
    const upstream = fixture ? createFixtureFetch({ prefetch: toggles.prefetch }) : window.fetch.bind(window);
    const observed = async (url, init) => {
      let text = "";
      try {
        const msgs = JSON.parse(init.body).messages || [];
        const last = msgs.filter((m) => m.role === "user").pop();
        text = last ? (last.parts || []).filter((p) => p.type === "text").map((p) => p.text).join(" ") : "";
      } catch (_) { /* opaque body */ }
      const t0 = performance.now();
      const now = () => performance.now() - t0;
      const tr = createTurn({ text });
      setTurn(tr);
      let res;
      try {
        res = await upstream(url, init);
      } catch (e) {
        tr.finish(now(), { error: e.message || "network error" });
        redraw();
        throw e;
      }
      tr.headers(now(), { status: res.status, get: (h) => res.headers.get(h) });
      redraw();
      if (!res.body) { tr.finish(now()); redraw(); return res; }
      const [mine, theirs] = res.body.tee();
      (async () => {
        const parser = createSseParser((evt) => {
          if (evt.type === "[DONE]") return;
          tr.observe(now(), evt);
          redraw();
        });
        const reader = theirs.getReader();
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            parser.push(value);
          }
          parser.end();
          tr.finish(now());
        } catch (e) {
          tr.finish(now(), { error: e.message || "stream interrupted" });
        }
        redraw();
      })();
      return new Response(mine, { status: res.status, statusText: res.statusText, headers: res.headers });
    };
    return {
      api,
      headers: {
        "x-algolia-application-id": cfg.appId || "",
        "x-algolia-api-key": cfg.agentStudioApiKey || "",
      },
      fetch: observed,
    };
  }, [resolution.status, resolution.agentId, cfg, fixture, toggles.prefetch, redraw]);

  // the page drives the lane through this object, never through React
  useEffect(() => {
    controller.send = (text) => {
      if (!chatRef.current) return false;
      chatRef.current.sendMessage({ text });
      return true;
    };
    controller.ready = () => Boolean(chatRef.current);
    return () => { controller.send = () => false; controller.ready = () => false; };
  });

  const view = turn ? turn.view() : null;
  const onToggles = (next) => {
    const lastFormat = next.prefetch !== "off" ? next.prefetch : toggles.prefetch !== "off" ? toggles.prefetch : toggles.lastFormat;
    setToggles({ ...next, lastFormat });
    setTurn(null);
  };
  const busy = view && (view.status === "sending" || view.status === "streaming");
  const chatKey = `${resolution.status}:${resolution.agentId || resolution.key}:${fixture ? "fx" : "live"}`;
  const badge = view && view.prefetch;

  return html`<div class="lane-inner">
    <header class="lane-h">
      <p class="lane-label">${label}</p>
      <p class="lane-badges">
        ${badge && html`<span class="badge is-prefetch" title=${String(badge.detail || "")}>prefetch · ${badge.source}</span>`}
        ${resolution.status === "query" && html`<span class="badge is-query">prefetch off per request</span>`}
        ${fixture && html`<span class="badge is-fixture">fixture</span>`}
      </p>
    </header>
    <${ConfigPanel} toggles=${toggles} onChange=${onToggles} resolution=${resolution} disabled=${busy} />
    <${Timeline} view=${view} fixture=${fixture} />
    <div class="lane-chat">
      ${transport
        ? html`<${InstantSearch} key=${chatKey} searchClient=${searchClient || STUB_CLIENT}
              indexName=${cfg.indexName || "products"} future=${{ preserveSharedStateOnUnmount: true }}>
            <${Chat} ref=${chatRef} transport=${transport} layoutComponent=${ChatInlineLayout}
              persistence=${false} itemComponent=${Card}
              translations=${{
                header: { title: (resolution.entry && resolution.entry.name) || label },
                prompt: { textareaPlaceholder: "Ask about a product" },
              }} />
          </${InstantSearch}>`
        : html`<${Missing} resolution=${resolution} />`}
    </div>
    <${HitsPanel} view=${view} Card=${Card} />
    <${Wire} turn=${turn} />
  </div>`;
}

/**
 * Mount one lane. Returns the controller the page drives:
 *   { send(text) → boolean, ready() → boolean, unmount() }
 */
export function mountLane(el, { label, cfg, variants, searchClient, initialToggles, fixture }) {
  const controller = { send: () => false, ready: () => false };
  const root = createRoot(el);
  root.render(html`<${LaneApp} controller=${controller} label=${label} cfg=${cfg} variants=${variants}
    searchClient=${searchClient} initialToggles=${initialToggles} fixture=${fixture} />`);
  controller.unmount = () => root.unmount();
  return controller;
}

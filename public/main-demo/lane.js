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
import { createSseParser, createTurn, ms, prefetchVerdict } from "./stream.mjs";
import { createFixtureFetch } from "./fixture.mjs";
import { pick, imageCandidates, fieldsFrom, priceText, lineText } from "./fields.mjs";
import { decode as decodeBlurhash } from "blurhash";

const html = htm.bind(React.createElement);
const { useState, useMemo, useRef, useEffect, useCallback } = React;

/* ── Records → cards ──────────────────────────────────────────── */

/** a record's BlurHash, drawn small and stretched: its own colors, no network */
function Blur({ hash }) {
  const ref = useRef(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    try {
      const px = decodeBlurhash(hash, 32, 24);
      const ctx = c.getContext("2d");
      const img = ctx.createImageData(32, 24);
      img.data.set(px);
      ctx.putImageData(img, 0, 0);
    } catch (_) { /* not a valid hash: the letter underneath shows */ }
  }, [hash]);
  return html`<canvas ref=${ref} width="32" height="24" class="pcard-blur" aria-hidden="true"></canvas>`;
}

let imageFailureLogged = false;

function makeCard(fields) {
  return function ProductCard({ item }) {
    const title = pick(item, fields.title) || item.objectID;
    const images = imageCandidates(item, fields.image);
    const blur = pick(item, fields.blurhash);
    // on a failed load, try the record's next image before giving up
    const [attempt, setAttempt] = useState(0);
    const src = images[attempt];
    const why = item.__groupedToolResult && item.__groupedToolResult.why;
    const failed = (e) => {
      if (!imageFailureLogged) {
        imageFailureLogged = true;
        console.warn("main-demo: a product image failed to load; showing the record's next image or its blur", e.target.currentSrc);
      }
      setAttempt((n) => n + 1);
    };
    return html`<article class="pcard">
      <div class="pcard-img">${src
        ? html`<img key=${src} src=${String(src)} alt="" loading="lazy" onError=${failed} />`
        : blur
          ? html`<${Blur} hash=${String(blur)} />`
          : html`<span aria-hidden="true">${String(title).slice(0, 1)}</span>`}</div>
      <div class="pcard-body">
        <p class="pcard-title">${String(title)}</p>
        <p class="pcard-price">${priceText(pick(item, fields.price), pick(item, fields.currency))}</p>
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
  const kind = (x) => (x.error ? " is-error" : x.prefetched ? " is-prefetch" : x.search ? " is-search" : " is-other");
  let n = 0;
  const numbered = view.tools.map((x) => ({ ...x, nth: x.search ? ++n : 0 }));
  return html`<div class=${"tl is-" + view.status}>
    <div class="tl-track" role="img"
      aria-label=${`first byte ${ms(view.ttfb)}, first token ${ms(view.ttft)}, ${view.searches} search calls, full paint ${ms(view.total)}`}>
      ${numbered.map((x) => html`<span key=${x.id} class=${"tl-tool" + kind(x)}
        style=${{ left: pct(x.start), width: `max(3px, ${pct((x.end ?? view.span) - x.start)})` }}
        title=${`${x.name} ${ms(x.duration)}`}>${x.nth ? html`<i>${x.nth}</i>` : ""}</span>`)}
      ${view.marks.map((m) => html`<span key=${m.id} class=${"tl-mark is-" + m.id} style=${{ left: pct(m.t) }}></span>`)}
    </div>
    <ul class="tl-legend">
      <li class="is-ttfb"><b>${ms(view.ttfb)}</b> first byte</li>
      <li class="is-ttft"><b>${ms(view.ttft)}</b> first token</li>
      <li class="is-total"><b>${view.total === null ? "…" : ms(view.total)}</b> full paint</li>
      ${view.httpStatus >= 400 && html`<li class="is-error">HTTP ${view.httpStatus}</li>`}
      ${view.cache && html`<li class="is-cache">cache ${view.cache}</li>`}
      ${fixture && html`<li class="is-fixture">replayed fixture</li>`}
    </ul>
    <ul class="tl-legend tl-tools">
      <li class="is-count"><b>${view.searches}</b> ${view.searches === 1 ? "search call" : "search calls"}</li>
      ${numbered.map((x) => html`<li key=${x.id} class=${"is-tool" + kind(x)}>
        ${x.nth ? html`<span class="tl-nth">${x.nth}</span>` : ""}<b>${x.duration === null ? "…" : ms(x.duration)}</b> <code>${x.name}</code></li>`)}
    </ul>
  </div>`;
}

/* ── Prefetch: which lane has it, and what it did ─────────────── */

const INFERRED_TIP = "Read off the model's tool calls. The backend does not stream its prefetch decision yet.";

/** what the page learned about prefetch this turn, in one line */
function Verdict({ verdict, view }) {
  const { state, searches, confirmed, part } = verdict;
  if (!view && state !== "off") return html`<p class="verdict is-idle">Searches before the model's first call</p>`;
  if (!view) return html`<p class="verdict is-idle">The model runs its own search</p>`;
  const times = (k) => `×${k}`;
  const line = {
    off: html`Model searched <b>${times(searches)}</b>`,
    waiting: html`Waiting for the model…`,
    used: html`Used prefetched hits · <b>0</b> own searches`,
    searched: html`Model searched again <b>${times(searches)}</b>`,
    skipped: html`Prefetch skipped${part && part.decision ? html` · <code>${String(part.decision)}</code>` : ""}`,
  }[state];
  return html`<p class=${"verdict is-" + state}>
    <span>${line}</span>
    ${state !== "off" && state !== "waiting" && !confirmed && html`<span class="verdict-src" title=${INFERRED_TIP}>inferred</span>`}
    <${PrefetchPart} part=${part} />
  </p>`;
}

/**
 * The backend's own account of the prefetch, from a `data-search_prefetch`
 * part: { decision, nbHits, latencyMs, injectionFormat, injected, toolName, index }.
 * Draws nothing until that part exists.
 */
function PrefetchPart({ part }) {
  if (!part) return null;
  const bits = [
    Number.isFinite(part.nbHits) && `${part.nbHits}\u00a0hits`,
    Number.isFinite(part.latencyMs) && ms(part.latencyMs),
    part.injectionFormat && String(part.injectionFormat),
  ].filter(Boolean);
  return html`<span class="verdict-src is-confirmed"
    title=${[part.toolName, part.index].filter(Boolean).join(" · ")}>${bits.join(" · ") || "reported"}</span>`;
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
  if (!view || !view.hitsTool) return null;
  if (!hits.length) return html`<p class="hits-h"><b>0</b> hits from <code>${view.hitsTool}</code></p>`;
  return html`<details class="hits">
    <summary class="hits-h"><b>${hits.length}</b> hits from <code>${view.hitsTool}</code></summary>
    <div class="hits-row">${hits.slice(0, 12).map((h) => html`<${Card} key=${h.objectID} item=${h} />`)}</div>
  </details>`;
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

function LaneApp({ controller, label, cfg, variants, searchClient, initialToggles, fixture, onView }) {
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
      if (!res.ok) {
        // an HTTP error is JSON, not SSE: keep its body for the wire drawer
        const body = await res.clone().text().catch(() => "");
        tr.observe(now(), { type: "http-error", status: res.status, body: body.slice(0, 500) });
        tr.finish(now(), { error: `HTTP ${res.status}` });
        redraw();
        return res;
      }
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
  const prefetchOn = toggles.prefetch !== "off";
  const verdict = prefetchVerdict(prefetchOn, view);
  const evidence = view && view.prefetch;
  useEffect(() => { if (onView) onView({ label, view, verdict, prefetchOn }); });

  return html`<div class=${"lane-inner" + (prefetchOn ? " has-prefetch" : "")}>
    <header class="lane-h">
      <div class="lane-id">
        <p class="lane-label">${label}</p>
        <span class=${"pf-pill" + (prefetchOn ? " is-on" : "")}
          title=${evidence ? `${evidence.source}: ${String(evidence.detail || "")}` : ""}>
          ${prefetchOn ? html`Prefetch on <code>${toggles.prefetch}</code>` : "Prefetch off"}</span>
        ${resolution.status === "query" && html`<span class="badge is-query">off per request</span>`}
      </div>
      <${Verdict} verdict=${verdict} view=${view} />
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
 * `onView({ label, view, verdict, prefetchOn })` runs after every redraw.
 */
export function mountLane(el, { label, cfg, variants, searchClient, initialToggles, fixture, onView }) {
  const controller = { send: () => false, ready: () => false };
  const root = createRoot(el);
  root.render(html`<${LaneApp} controller=${controller} label=${label} cfg=${cfg} variants=${variants}
    searchClient=${searchClient} initialToggles=${initialToggles} fixture=${fixture} onView=${onView} />`);
  controller.unmount = () => root.unmount();
  return controller;
}

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
  TOGGLES, BLOCKS, normalize, resolveVariant, completionQuery, agentName,
  blockValues, blockFrom, validateBlock, toggleBlocks, effectiveBlocks, isCustom, canonical,
  resolveCustom, customKey, customName,
} from "./configs.mjs";
import { apiClient, ensureCustomAgent, loadLocal, saveLocal } from "./agents.mjs";
import { createSseParser, createTurn, decisionLabel, ms, searchCounts } from "./stream.mjs";
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
  const kind = (x) => (x.error ? " is-error" : x.passive ? " is-prefetch" : x.search ? " is-search" : " is-other");
  let n = 0;
  const numbered = view.tools.map((x) => ({ ...x, nth: x.search ? ++n : 0 }));
  return html`<div class=${"tl is-" + view.status}>
    <div class="tl-track" role="img"
      aria-label=${`first byte ${ms(view.ttfb)}, first token ${ms(view.ttft)}, ${view.modelCalls} model calls, full paint ${ms(view.total)}`}>
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
      <li class="is-count"><b>${view.modelCalls}</b> model calls</li>
      <li class="is-count"><b>${view.toolCalls}</b> tool calls</li>
      ${view.toolErrors > 0 && html`<li class="is-count is-error"><b>${view.toolErrors}</b> tool errors</li>`}
      ${numbered.map((x) => html`<li key=${x.id} class=${"is-tool" + kind(x)}>
        <b>${x.duration === null ? "…" : ms(x.duration)}</b> <code>${x.name}</code></li>`)}
    </ul>
  </div>`;
}

/* ── Prefetch: which lane has it, and what it did ─────────────── */

/* check-copy: off */
const NO_PART_TIP = "This lane's agent has prefetch on, but the backend streamed no data-search_prefetch part.";
const ANYWAY_TIP = "agentSearchedAnyway, from the prefetch part the backend sends again at the end of the turn.";
/* check-copy: on */

/** who searched this turn: the platform before the model (passive), or the model itself (active) */
function Searches({ counts, view, prefetchOn }) {
  if (!view) {
    return html`<p class="searches is-idle">${prefetchOn
      ? "Searches once before the model's first call, then lets the model search more"
      : "The model runs every search itself"}</p>`;
  }
  const { passive, active, part, searchedAnyway, reported } = counts;
  const done = view.status === "done" || view.status === "error";
  return html`<p class="searches">
    <span class="sc-g"><span class=${"sc is-passive" + (passive ? " is-on" : "")}>Passive search <b>×${passive}</b></span>
    ${part && html`<${PrefetchPart} part=${part} />`}
    ${prefetchOn && !reported && done && html`<span class="sc-src is-missing" title=${NO_PART_TIP}>no part</span>`}</span>
    <span class="sc-g"><span class="sc is-active">Active searches <b>×${active}</b></span>
    ${searchedAnyway !== null && html`<span class=${"sc-src" + (searchedAnyway ? " is-anyway" : " is-confirmed")}
      title=${ANYWAY_TIP}>${searchedAnyway ? "searched anyway" : "used the prefetch"}</span>`}</span>
  </p>`;
}

/** the backend's own account of the prefetch, from its `data-search_prefetch` part */
function PrefetchPart({ part }) {
  const injected = Boolean(part.toolCallId);
  const bits = [
    decisionLabel(part.decision),
    injected && Number.isFinite(part.nbHits) && `${part.nbHits}\u00a0hits`,
    Number.isFinite(part.latencyMs) && ms(part.latencyMs),
  ].filter(Boolean);
  return html`<span class=${"sc-src" + (injected ? " is-confirmed" : " is-skipped")}
    title=${[part.decision, part.toolName, part.index, part.toolCallId].filter(Boolean).join(" · ")}>${bits.join(" · ")}</span>`;
}

/* ── The config panel ─────────────────────────────────────────── */

const BLOCK_OF = { prefetch: "searchPrefetch", memory: "memory", guardrails: "guardrail", suggestions: "suggestions" };

function Field({ f, value, error, onValue, disabled }) {
  const id = useMemo(() => `f-${Math.random().toString(36).slice(2, 9)}`, []);
  let input;
  if (f.type === "bool") {
    input = html`<input id=${id} type="checkbox" checked=${Boolean(value)} disabled=${disabled}
      onChange=${(e) => onValue(e.target.checked)} />`;
  } else if (f.type === "int") {
    input = html`<input id=${id} type="number" min=${f.min} max=${f.max} step="1" value=${value ?? ""} disabled=${disabled}
      onChange=${(e) => onValue(e.target.value === "" ? null : Number(e.target.value))} />`;
  } else if (f.type === "enum") {
    // options may mix null, booleans and strings: the select carries their index
    input = html`<select id=${id} value=${String(f.options.indexOf(value))} disabled=${disabled}
      onChange=${(e) => onValue(f.options[Number(e.target.value)])}>
      ${f.options.map((o, i) => html`<option key=${i} value=${String(i)}>${o === null ? "unset" : String(o)}</option>`)}</select>`;
  } else if (f.type === "json") {
    input = html`<${JsonField} id=${id} value=${value} disabled=${disabled} onValue=${onValue} />`;
  } else {
    input = html`<input id=${id} type="text" value=${value ?? ""} placeholder=${f.hint || ""} disabled=${disabled}
      onChange=${(e) => onValue(e.target.value === "" ? null : e.target.value)} />`;
  }
  const hinted = f.hint && f.type !== "text";
  return html`<div class=${"fld" + (error ? " is-bad" : "")}>
    <label for=${id}>${f.label}</label>${input}
    ${(error || hinted) && html`<span class="fld-hint">${error || f.hint}</span>`}
  </div>`;
}

/** a JSON list typed as text; only a list that parses reaches the block */
function JsonField({ id, value, onValue, disabled }) {
  const [text, setText] = useState(() => JSON.stringify(value ?? [], null, 1));
  return html`<textarea id=${id} rows="3" value=${text} disabled=${disabled} spellcheck="false"
    onChange=${(e) => {
      setText(e.target.value);
      try { onValue(JSON.parse(e.target.value)); } catch (_) { onValue(undefined); }
    }}></textarea>`;
}

/** every field of one block; Apply hands back the block in its stored form */
function BlockEditor({ blockId, stored, edited, onApply, onReset, onClose, disabled }) {
  const block = BLOCKS.find((b) => b.id === blockId);
  const [values, setValues] = useState(() => blockValues(blockId, stored));
  const errors = validateBlock(blockId, values);
  const bad = Object.keys(errors).length > 0;
  return html`<fieldset class="editor">
    <legend>${block.label}</legend>
    <div class="editor-grid">
      ${block.fields.map((f) => html`<${React.Fragment} key=${f.path || "v"}>
        ${f.group && html`<p class="editor-sub">${f.group}</p>`}
        <${Field} f=${f} value=${values[f.path]} error=${errors[f.path]}
          disabled=${disabled} onValue=${(v) => setValues({ ...values, [f.path]: v })} /></${React.Fragment}>`)}
    </div>
    <div class="editor-actions">
      <button type="button" class="btn-quiet is-primary" disabled=${disabled || bad}
        onClick=${() => onApply(blockFrom(blockId, values))}>Apply</button>
      ${edited && html`<button type="button" class="btn-quiet" disabled=${disabled} onClick=${onReset}>Reset to toggle</button>`}
      <button type="button" class="btn-quiet" onClick=${onClose}>Close</button>
    </div>
  </fieldset>`;
}

function ConfigPanel({ toggles, edits, onToggles, onEdits, resolution, disabled, open, setOpen, editing, setEditing }) {
  const blocks = effectiveBlocks(toggles, edits);
  const enabledOf = (id) => (id === "sendUsage" ? Boolean(blocks.sendUsage) : Boolean(blocks[id] && blocks[id].enabled));
  const flip = (tgId, id, on) => {
    if (id === "sendUsage") return onEdits({ ...(edits || {}), sendUsage: on });
    if (edits && edits[id]) return onEdits({ ...edits, [id]: { ...edits[id], enabled: on } });
    return onToggles(normalize({ ...toggles, [tgId]: on }));
  };
  const entry = resolution.entry || {};
  const custom = Boolean(resolution.custom || resolution.status === "custom");
  const how = resolution.status === "agent" ? html`agent <code>${entry.name || agentName(toggles)}</code>`
    : resolution.status === "custom" ? html`<code>${resolution.name}</code> not created yet`
        : html`no agent yet`;
  const rows = [...TOGGLES.map((tg) => ({ tg, id: BLOCK_OF[tg.id], label: tg.label })),
    { tg: null, id: "sendUsage", label: "Stream token usage" }];
  return html`<details class="cfg" open=${open} onToggle=${(e) => setOpen(e.target.open)}>
    <summary><span class="cfg-h">Config</span>${custom && html` <span class="badge is-custom">edited</span>`}
      <span class="cfg-how">${how}</span></summary>
    <div class="cfg-body">
      ${rows.map(({ tg, id, label }) => html`<div class="cfg-block" key=${id}>
        <div class="cfg-row">
          <label class="sw"><input type="checkbox" disabled=${disabled} checked=${enabledOf(id)}
            onChange=${(e) => flip(tg && tg.id, id, e.target.checked)} /><span>${label}</span></label>
          ${edits && edits[id] !== undefined && id !== "sendUsage" && html`<span class="badge is-custom">edited</span>`}
          ${id !== "sendUsage" && html`<button type="button" class="btn-link" aria-expanded=${editing === id}
            onClick=${() => setEditing(editing === id ? null : id)}>${editing === id ? "Close" : "Edit"}</button>`}
        </div>
        ${editing === id && html`<${BlockEditor} key=${id + canonical(blocks[id] ?? null)} blockId=${id}
          stored=${blocks[id]} edited=${Boolean(edits && edits[id])} disabled=${disabled}
          onApply=${(b) => { onEdits({ ...(edits || {}), [id]: b }); setEditing(null); }}
          onReset=${() => { const n = { ...edits }; delete n[id]; onEdits(n); setEditing(null); }}
          onClose=${() => setEditing(null)} />`}
      </div>`)}
      <p class="cfg-model">${entry.model
        ? html`<code>${entry.model}</code>${entry.provider ? html` · ${entry.provider}` : ""}`
        : custom ? "model, tools and instructions copied from main-demo-base" : "model unknown"}</p>
    </div>
  </details>`;
}

/** an edited config with no agent yet: make it here, or copy the command */
function CreateAgent({ resolution, state, onCreate }) {
  return html`<div class="missing">
    <p><b>No agent for this config yet.</b> The page creates <code>${resolution.name}</code> from
      main-demo-base with these blocks, and never changes an agent a lane already runs.</p>
    <button type="button" class="btn" disabled=${state.busy} onClick=${onCreate}>
      ${state.busy ? "Creating…" : `Create ${resolution.name}`}</button>
    ${state.error && html`<p class="missing-err" role="alert">${state.error}</p>`}
    <details class="missing-cmd"><summary>Or from a shell</summary><pre><code>${resolution.command}</code></pre></details>
  </div>`;
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

/** the chat before its first question: where to start, not a blank panel */
function EmptyChat() {
  return html`<div class="lane-empty"><p>No question yet. Pick one below, or type your own.</p></div>`;
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
  const [edits, setEdits] = useState(null);          // edited config blocks over the toggles, or null
  const [local, setLocal] = useState(() => loadLocal());
  const [cfgOpen, setCfgOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState({ busy: false, error: "" });
  const [turn, setTurn] = useState(null);
  const [epoch, setEpoch] = useState(0);   // bumped by clear(): a fresh chat, a fresh conversation
  const seq = useRef(0);                    // turns started in this lane, for the page's race runner
  const [, setTick] = useState(0);
  const chatRef = useRef(null);
  const fields = useMemo(() => fieldsFrom(cfg), [cfg]);
  const Card = useMemo(() => makeCard(fields), [fields]);
  const custom = isCustom(toggles, edits);
  const blocks = useMemo(() => effectiveBlocks(toggles, edits), [toggles, edits]);
  const resolution = useMemo(() => {
    if (!custom) return resolveVariant(toggles, variants);
    if (fixture) return { status: "agent", key: customKey(blocks), agentId: "fixture", entry: { name: customName(blocks) }, custom: true };
    return resolveCustom(blocks, variants, local);
  }, [custom, toggles, variants, blocks, local, fixture]);
  const prefetchOn = Boolean(blocks.searchPrefetch && blocks.searchPrefetch.enabled);

  // one redraw per frame, however fast the events come
  const frame = useRef(0);
  const redraw = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => { frame.current = 0; setTick((n) => n + 1); });
  }, []);

  const transport = useMemo(() => {
    if (resolution.status === "missing" || resolution.status === "custom") return null;
    const q = new URLSearchParams(completionQuery()).toString();
    const api = `${cfg.host}/1/agents/${resolution.agentId}/completions?${q}`;
    const upstream = fixture ? createFixtureFetch({ prefetch: prefetchOn }) : window.fetch.bind(window);
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
      seq.current += 1;
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
  }, [resolution.status, resolution.agentId, cfg, fixture, prefetchOn, redraw]);

  // the page drives the lane through this object, never through React
  useEffect(() => {
    controller.send = (text) => {
      if (!chatRef.current) return false;
      chatRef.current.sendMessage({ text });
      return true;
    };
    controller.ready = () => Boolean(chatRef.current);
    controller.clear = () => { chatRef.current = null; setTurn(null); setEpoch((n) => n + 1); };
    return () => { controller.send = () => false; controller.ready = () => false; controller.clear = () => {}; };
  });

  const view = turn ? turn.view() : null;
  const onToggles = (next) => {
    setToggles(next);
    setTurn(null);
  };
  const onEdits = (next) => {
    // an edit equal to what the toggles already write is no edit
    const plain = toggleBlocks(toggles);
    const kept = {};
    for (const [k, v] of Object.entries(next || {})) {
      if (k === "sendUsage" ? v : canonical(v) !== canonical(plain[k])) kept[k] = v;
    }
    setEdits(Object.keys(kept).length ? kept : null);
    setCreating({ busy: false, error: "" });
    setTurn(null);
  };
  const create = async () => {
    setCreating({ busy: true, error: "" });
    try {
      const call = apiClient({ host: cfg.host, appId: cfg.appId, apiKey: cfg.agentStudioApiKey });
      const made = await ensureCustomAgent(call, blocks);
      setLocal(saveLocal(resolution.key, { agentId: made.agentId, name: made.name, createdAt: new Date().toISOString() }));
      setCreating({ busy: false, error: "" });
    } catch (e) {
      const why = e.status === 401 || e.status === 403 ? "This key cannot create agents: run the command below." : e.message;
      setCreating({ busy: false, error: why });
    }
  };
  const openEditor = (id) => { setCfgOpen(true); setEditing(id); };
  const busy = view && (view.status === "sending" || view.status === "streaming");
  const chatKey = `${resolution.status}:${resolution.agentId || resolution.key}:${fixture ? "fx" : "live"}:${epoch}`;
  const counts = searchCounts(prefetchOn, view);
  useEffect(() => { if (onView) onView({ label, view, counts, prefetchOn, seq: seq.current }); });

  return html`<div class=${"lane-inner" + (prefetchOn ? " has-prefetch" : "")}>
    <header class="lane-h">
      <div class="lane-id">
        <p class="lane-label">${label}</p>
        <button type="button" class=${"pf-pill" + (prefetchOn ? " is-on" : "")} aria-haspopup="true"
          title=${counts.part ? decisionLabel(counts.part.decision) : "Edit the prefetch block"}
          onClick=${() => openEditor("searchPrefetch")}>
          ${prefetchOn ? "Prefetch on" : "Prefetch off"}
          ${edits && edits.searchPrefetch && html`<span class="pf-edited">edited</span>`}</button>
      </div>
      <${Searches} counts=${counts} view=${view} prefetchOn=${prefetchOn} />
    </header>
    <${ConfigPanel} toggles=${toggles} edits=${edits} onToggles=${onToggles} onEdits=${onEdits}
      resolution=${resolution} disabled=${busy} open=${cfgOpen} setOpen=${setCfgOpen}
      editing=${editing} setEditing=${setEditing} />
    <${Timeline} view=${view} fixture=${fixture} />
    <div class="lane-chat">
      ${transport
        ? html`<${InstantSearch} key=${chatKey} searchClient=${searchClient || STUB_CLIENT}
              indexName=${cfg.indexName || "products"} future=${{ preserveSharedStateOnUnmount: true }}>
            <${Chat} ref=${chatRef} transport=${transport} layoutComponent=${ChatInlineLayout}
              persistence=${false} itemComponent=${Card} emptyComponent=${EmptyChat}
              translations=${{
                header: { title: (resolution.entry && resolution.entry.name) || label },
                prompt: { textareaPlaceholder: "Ask about a product" },
              }} />
          </${InstantSearch}>`
        : resolution.status === "custom"
          ? html`<${CreateAgent} resolution=${resolution} state=${creating} onCreate=${create} />`
          : html`<${Missing} resolution=${resolution} />`}
    </div>
    <${HitsPanel} view=${view} Card=${Card} />
    <${Wire} turn=${turn} />
  </div>`;
}

/**
 * Mount one lane. Returns the controller the page drives:
 *   { send(text) → boolean, ready() → boolean, clear(), unmount() }
 * `onView({ label, view, counts, prefetchOn, seq })` runs after every redraw;
 * `seq` counts the turns this lane has started.
 */
export function mountLane(el, { label, cfg, variants, searchClient, initialToggles, fixture, onView }) {
  const controller = { send: () => false, ready: () => false, clear: () => {} };
  const root = createRoot(el);
  root.render(html`<${LaneApp} controller=${controller} label=${label} cfg=${cfg} variants=${variants}
    searchClient=${searchClient} initialToggles=${initialToggles} fixture=${fixture} onView=${onView} />`);
  controller.unmount = () => root.unmount();
  return controller;
}

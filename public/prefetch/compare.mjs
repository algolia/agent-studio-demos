/* ───────────────────────────────────────────────────────────────
   compare.mjs: the prefetch page's numbers, before and after.

   Pure: no DOM. The page mounts two main-demo lanes, the race's two arms
   from configs.mjs MANIFEST, and reads each lane's report (`onView`) into
   the rows below. Every number comes from the lane's own stream reader;
   nothing here estimates.
   ─────────────────────────────────────────────────────────────── */

import { MANIFEST, configKey, configVariants } from "../main-demo/configs.mjs";
import { ms } from "../main-demo/stream.mjs";

/** the two lanes: the base agent, and the same agent with prefetch on */
export const LANES = [
  { key: "a", label: "Without prefetch", toggles: MANIFEST[0].toggles },
  { key: "b", label: "With prefetch", toggles: MANIFEST[1].toggles },
];

/* check-copy: off */
/**
 * Starter questions, each checked against esci_products_us (a product catalog
 * with no price field) with the agent's own search settings, words dropped
 * when nothing matches. `fit: "good"`: the raw sentence, which is what
 * prefetch searches, finds relevant hits. `fit: "poor"`: it finds the wrong
 * ones (a greeting matches junk; "not Nike" matches only Nike), so the
 * prefetched search is wasted and the model has to search on its own.
 */
export const STARTERS = [
  { text: "A portable bluetooth speaker for the beach", fit: "good" },
  { text: "Noise cancelling headphones for long flights", fit: "good" },
  { text: "Waterproof hiking boots for women", fit: "good" },
  { text: "Hi! What can you help me with?", fit: "poor" },
  { text: "Running shoes, but not Nike", fit: "poor" },
];
/* check-copy: on */

/** a question as both lanes get it: trimmed, one line, or "" when there is nothing to ask */
export function questionOf(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 300);
}

const count = (n) => String(n);
const tokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
const settled = (r) => Boolean(r && r.view) && (r.view.status === "done" || r.view.status === "error");

/**
 * each row: what it reads off a lane report, and how it prints. Labels are
 * plain words for a reader who has never seen a tool call. `lead` is the
 * headline row. Who searched is on each lane's own badges, and the times
 * are drawn on the timeline.
 */
export const ROWS = [
  { id: "modelCalls", label: "Model calls", fmt: count, lead: true, read: (r) => r.view.modelCalls },
  { id: "ttft", label: "First words", fmt: ms, time: true, read: (r) => r.view.ttft },
  { id: "total", label: "Full answer", fmt: ms, time: true,
    read: (r) => (r.view.status === "done" ? r.view.total : null) },
  { id: "inputTokens", label: "Tokens read", fmt: tokens, usage: true,
    read: (r) => (r.view.usage && Number.isFinite(r.view.usage.inputTokens) ? r.view.usage.inputTokens : null) },
];

/** a lane whose turn failed: its counts are not measurements, whatever they read */
const failed = (r) => Boolean(r && r.view) && settled(r) && (r.view.status === "error" || Boolean(r.view.errors && r.view.errors.length));

/** "HTTP 404", or "failed" when the error came without a status */
export function failureText(view) {
  return view && view.httpStatus >= 400 ? `HTTP ${view.httpStatus}` : "failed";
}

/** one lane's value for one row: a number, or null while it is not known */
export function valueOf(row, report) {
  if (!report || !report.view || !report.counts || failed(report)) return null;
  const v = row.read(report);
  return Number.isFinite(v) ? v : null;
}

/** B − A, signed, in the row's own unit; "" until both lanes have the number */
export function diffText(row, a, b) {
  if (a === null || b === null) return "";
  const d = b - a;
  if (d === 0) return "0";
  const sign = d < 0 ? "−" : "+";
  return sign + row.fmt(Math.abs(d));
}

/** what a cell shows when the number is missing: pending, or why it never came */
function blank(row, report) {
  if (!report || !report.view) return "–";
  if (!settled(report)) return "…";
  if (failed(report)) return failureText(report.view);
  if (row.usage) return "not streamed";
  return "–";
}

/**
 * The table: one row per metric, both lanes' values as text, and B − A.
 *   [{ id, label, lead, a, b, diff, known: { a, b } }]; known is false where the text is not a number
 */
export function rows(reports) {
  const ra = reports && reports.a;
  const rb = reports && reports.b;
  return ROWS.map((row) => {
    const a = valueOf(row, ra);
    const b = valueOf(row, rb);
    return {
      id: row.id,
      label: row.label,
      lead: Boolean(row.lead),
      a: a === null ? blank(row, ra) : row.fmt(a),
      b: b === null ? blank(row, rb) : row.fmt(b),
      diff: settled(ra) && settled(rb) ? diffText(row, a, b) : "",
      known: { a: a !== null, b: b !== null },
    };
  });
}

/**
 * The config block this page reads: `prefetchDemo` when the deploy gives the
 * page its own agent pair, else main-demo's `mainDemo`. Same shape either way.
 *   { block, name }: block is null when neither is set
 */
export function pageConfig(root) {
  const r = root && typeof root === "object" ? root : {};
  const usable = (b) => Boolean(b) && typeof b === "object" && !Array.isArray(b);
  if (usable(r.prefetchDemo)) return { block: r.prefetchDemo, name: "prefetchDemo" };
  if (usable(r.mainDemo)) return { block: r.mainDemo, name: "mainDemo" };
  return { block: null, name: null };
}

/**
 * Whether "Run live" can run, from the same mainDemo block main-demo reads.
 *   { ok: true, variants } or { ok: false, why }
 * `fallback` is variants.json's map, for a local run without mainDemo.variants.
 */
export function liveReadiness(mainDemo, fallback) {
  if (!mainDemo || typeof mainDemo !== "object") {
    return { ok: false, why: "Live unavailable: this build has no Agent Studio config." };
  }
  if (!mainDemo.agentStudioApiKey || !mainDemo.appId) {
    return { ok: false, why: "Live unavailable: the config has no app id or key." };
  }
  const variants = configVariants(mainDemo) || fallback || {};
  const missing = LANES.filter((l) => !(variants[configKey(l.toggles)] && variants[configKey(l.toggles)].agentId));
  if (missing.length) {
    return { ok: false, why: `Live unavailable: no agent for ${missing.map((l) => l.label.toLowerCase()).join(" or ")}.` };
  }
  return { ok: true, variants };
}

/* ── The timeline: where each lane's time went, on one axis ────── */

/* check-copy: off */
/** the phases a turn's time splits into, in legend order; `short` labels the segment */
export const PHASES = [
  { id: "wait", short: "wait", label: "Waiting for the server" },
  { id: "prefetch", short: "prefetch", label: "Prefetch search" },
  { id: "search", short: "search", label: "Model's search" },
  { id: "model", short: "model", label: "Model thinking" },
  { id: "tool", short: "tool", label: "Other tool call" },
  { id: "answer", short: "answer", label: "Answer streaming" },
];
/* check-copy: on */

/**
 * One lane's time, cut into back-to-back phases from 0 to the turn's end.
 * Read off the stream, nothing estimated: before the first byte the lane
 * waits; a tool call's span is its own (the prefetch, the model's searches,
 * any other tool); the answer runs from each text's first token to its last;
 * whatever is left between is the model working. The stream's close after
 * the last text counts as the answer.
 *   [{ kind, start, end, name }]; name is the tool's, for a tool phase
 */
export function phases(view) {
  if (!view) return [];
  const end = Number.isFinite(view.total) ? view.total : view.span;
  if (!(end > 0)) return [];
  const clamp = (t) => Math.min(end, Math.max(0, t));
  const firstByte = Number.isFinite(view.ttfb) ? clamp(view.ttfb) : end;
  const rank = { prefetch: 0, search: 1, tool: 2 };
  const tools = (view.tools || [])
    .map((x) => ({ kind: x.passive ? "prefetch" : x.search ? "search" : "tool", name: x.name,
      start: clamp(x.start), end: clamp(Number.isFinite(x.end) ? x.end : end) }))
    .filter((x) => x.end > x.start);
  const texts = (view.texts || []).map((x) => ({ start: clamp(x.start), end: clamp(x.end) })).filter((x) => x.end >= x.start);
  const lastText = texts.length ? Math.max(...texts.map((x) => x.end)) : null;
  const closed = view.status === "done";
  const cuts = [...new Set([0, end, firstByte, ...tools.flatMap((x) => [x.start, x.end]), ...texts.flatMap((x) => [x.start, x.end])])]
    .sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const [p, q] = [cuts[i], cuts[i + 1]];
    if (q <= p) continue;
    const mid = (p + q) / 2;
    const tool = tools.filter((x) => x.start <= mid && mid < x.end).sort((a, b) => rank[a.kind] - rank[b.kind])[0];
    const kind = tool ? tool.kind
      : texts.some((x) => x.start <= mid && mid < x.end) ? "answer"
        : mid < firstByte ? "wait"
          : closed && lastText !== null && mid >= lastText && !tools.some((x) => x.start >= lastText) ? "answer"
            : "model";
    const prev = out[out.length - 1];
    if (prev && prev.kind === kind && (prev.name || null) === (tool ? tool.name : null)) prev.end = q;
    else out.push({ kind, start: p, end: q, ...(tool ? { name: tool.name } : {}) });
  }
  return out;
}

/**
 * The shared axis: one scale for both lanes, so the shorter turn draws
 * shorter. Ticks every 0.25, 0.5, 1, 2, 5, 10, 20, 30 or 60 seconds, at most 8 steps.
 *   { max, ticks: [ms] }; max is 0 until a lane has time on it
 */
export function axis(...ends) {
  const top = Math.max(0, ...ends.filter((v) => Number.isFinite(v)));
  if (top <= 0) return { max: 0, ticks: [] };
  const step = [250, 500, 1000, 2000, 5000, 10000, 20000, 30000, 60000].find((s) => top / s <= 8) || 60000;
  const max = Math.ceil(top / step) * step;
  const ticks = [];
  for (let t = 0; t <= max + 1e-6; t += step) ticks.push(t);
  return { max, ticks };
}

/** "0 s", "0.5 s", "1.25 s", "12 s": a tick's label, never rounded off its tick */
export function tickText(t) {
  return `${Number((t / 1000).toFixed(2))}\u00a0s`;
}

/** a lane's end on the axis: the turn's total, or its running span */
export function laneEnd(report) {
  const v = report && report.view;
  if (!v) return null;
  return Number.isFinite(v.total) ? v.total : v.span;
}

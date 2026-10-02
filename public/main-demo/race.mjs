/* ───────────────────────────────────────────────────────────────
   race.mjs — what repeated races add up to.

   Pure: no DOM. Each run is one question sent to both lanes at the same
   moment, in a fresh conversation. A run keeps each lane's summary; the
   scoreboard reads medians, paired deltas and a win tally out of the list.
   Lower is better for every metric here: fewer model calls, fewer tool
   calls, fewer errors, sooner tokens, sooner paint.
   ─────────────────────────────────────────────────────────────── */

import { ms } from "./stream.mjs";

/** the repeat control's choices: 1 to 10 runs of one question */
export const REPEATS = [1, 2, 3, 5, 10];
export const MAX_REPEAT = 10;

/** a repeat count the race bar accepts, whatever was asked for */
export function clampRepeat(n) {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.min(MAX_REPEAT, Math.max(1, v)) : 1;
}

/** the numbers of one lane's finished turn that a race compares */
export function summarize(view) {
  if (!view) return null;
  const u = view.usage || {};
  return {
    ok: view.status === "done",
    modelCalls: view.modelCalls,
    toolCalls: view.toolCalls,
    toolErrors: view.toolErrors,
    ttft: view.ttft,
    total: view.status === "done" ? view.total : null,
    inputTokens: Number.isFinite(u.inputTokens) ? u.inputTokens : null,
    outputTokens: Number.isFinite(u.outputTokens) ? u.outputTokens : null,
  };
}

const count = (n) => String(n);
const tokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));

/* check-copy: off */
export const METRICS = [
  { id: "modelCalls", label: "Model calls", kind: "count", fmt: count, unit: ["call", "calls"],
    tip: "LLM steps in the turn. Prefetch saves the step where the model would have written its search." },
  { id: "toolCalls", label: "Model tool calls", kind: "count", fmt: count, unit: ["call", "calls"],
    tip: "Tool calls the model wrote itself. The passive search is not one of them." },
  { id: "toolErrors", label: "Tool-input errors", kind: "count", fmt: count, unit: ["error", "errors"],
    tip: "Tool calls the model wrote wrong. Each one is a model call spent for nothing." },
  { id: "ttft", label: "First token", kind: "time", fmt: ms },
  { id: "total", label: "Full paint", kind: "time", fmt: ms,
    tip: "Stream end: the answer and its carousels are on screen." },
  { id: "inputTokens", label: "Input tokens", kind: "count", fmt: tokens, unit: ["token", "tokens"], usage: true },
  { id: "outputTokens", label: "Output tokens", kind: "count", fmt: tokens, unit: ["token", "tokens"], usage: true },
];
/* check-copy: on */

export function median(xs) {
  const v = xs.filter((x) => Number.isFinite(x)).sort((p, q) => p - q);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** who won one run on one metric: "a", "b" or "even"; null when a lane lacks the number */
export function winner(metric, a, b) {
  const x = a && a[metric.id];
  const y = b && b[metric.id];
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const d = y - x;
  const slack = metric.kind === "time" ? Math.max(50, 0.05 * Math.max(x, y)) : 0;
  if (Math.abs(d) <= slack) return "even";
  return d < 0 ? "b" : "a";
}

/**
 * One metric across the runs: each lane's median, the median paired delta
 * (B − A, negative means B did better), the tally and the per-run results.
 */
export function compare(metric, runs) {
  const paired = runs.map((r) => {
    const x = r.a && r.a[metric.id];
    const y = r.b && r.b[metric.id];
    const both = Number.isFinite(x) && Number.isFinite(y);
    return { d: both ? y - x : null, win: winner(metric, r.a, r.b) };
  });
  const tally = { a: 0, b: 0, even: 0 };
  for (const p of paired) if (p.win) tally[p.win] += 1;
  return {
    a: median(runs.map((r) => r.a && r.a[metric.id])),
    b: median(runs.map((r) => r.b && r.b[metric.id])),
    delta: median(paired.map((p) => p.d)),
    n: paired.filter((p) => p.d !== null).length,
    tally,
    runs: paired,
  };
}

/** "B 1.28 s sooner", "B 1 call fewer", "even", or "" when nothing is paired yet */
export function deltaText(metric, c) {
  if (c.delta === null) return "";
  const w = c.delta < 0 ? "B" : "A";
  const size = Math.abs(c.delta);
  if (metric.kind === "time") {
    if (size < Math.max(50, 0.05 * Math.max(c.a || 0, c.b || 0))) return "even";
    return `${w} ${ms(size)} sooner`;
  }
  if (size === 0) return "even";
  const n = Number.isInteger(size) ? size : Math.round(size * 10) / 10;
  return `${w} ${metric.fmt(n)} ${n === 1 ? metric.unit[0] : metric.unit[1]} fewer`;
}

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
 * headline row; `bar` rows draw both lanes' values as bars from zero.
 */
export const ROWS = [
  { id: "modelCalls", label: "Model calls", fmt: count, lead: true, bar: true, read: (r) => r.view.modelCalls },
  { id: "ttft", label: "First words", fmt: ms, time: true, bar: true, read: (r) => r.view.ttft },
  { id: "total", label: "Full answer", fmt: ms, time: true, bar: true,
    read: (r) => (r.view.status === "done" ? r.view.total : null) },
  { id: "prefetchSearches", label: "Search before the model", fmt: count, read: (r) => r.counts.passive },
  { id: "modelSearches", label: "Searches the model asked for", fmt: count, read: (r) => r.counts.active },
  { id: "inputTokens", label: "Tokens the model read", fmt: tokens, usage: true,
    read: (r) => (r.view.usage && Number.isFinite(r.view.usage.inputTokens) ? r.view.usage.inputTokens : null) },
];

/**
 * Bar lengths for one row, in percent of the larger value: both bars start
 * at zero on one shared scale, so their ratio is the values' ratio.
 *   { a, b }: null for a value that is not known yet
 */
export function barWidths(a, b) {
  const ok = (v) => Number.isFinite(v) && v >= 0;
  const max = Math.max(ok(a) ? a : 0, ok(b) ? b : 0);
  const pct = (v) => (!ok(v) ? null : max === 0 ? 0 : Math.round((v / max) * 1000) / 10);
  return { a: pct(a), b: pct(b) };
}

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
 * The table: one row per metric, both lanes' values as text, bar lengths, and B − A.
 *   [{ id, label, lead, bars, a, b, diff, known: { a, b } }]; known is false where the text is not a number
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
      bars: row.bar ? barWidths(a, b) : null,
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

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
// the replay's script answers with running shoes whatever is asked, and a
// budget in the question makes it play the miss; this one plays the hit
export const REPLAY_QUESTION = "Running shoes for trail and road";
// checked against the products index by main-demo: its keywords find relevant hits
export const LIVE_QUESTION = "A portable bluetooth speaker for the beach";
/* check-copy: on */

/**
 * What the replay is. fixture.mjs writes its events by hand with made-up
 * timings: it is not a recorded run, so the page says so.
 */
export const REPLAY = Object.freeze({ recorded: false, label: "Illustrative replay" });

const count = (n) => String(n);
const tokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
const settled = (r) => Boolean(r && r.view) && (r.view.status === "done" || r.view.status === "error");

/** each row: what it reads off a lane report, and how it prints */
export const ROWS = [
  { id: "modelCalls", label: "Model calls", fmt: count, read: (r) => r.view.modelCalls },
  { id: "modelSearches", label: "Searches by the model", fmt: count, read: (r) => r.counts.active },
  { id: "prefetchSearches", label: "Search before the model", fmt: count, read: (r) => r.counts.passive },
  { id: "inputTokens", label: "Input tokens", fmt: tokens, usage: true,
    read: (r) => (r.view.usage && Number.isFinite(r.view.usage.inputTokens) ? r.view.usage.inputTokens : null) },
  { id: "ttft", label: "First text", fmt: ms, time: true, read: (r) => r.view.ttft },
  { id: "total", label: "Full answer", fmt: ms, time: true,
    read: (r) => (r.view.status === "done" ? r.view.total : null) },
];

/** one lane's value for one row: a number, or null while it is not known */
export function valueOf(row, report) {
  if (!report || !report.view || !report.counts) return null;
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
function blank(row, report, { replay }) {
  if (!report || !report.view) return "–";
  if (!settled(report)) return "…";
  if (row.usage) return replay ? "not in replay" : "not streamed";
  return "–";
}

/**
 * The table: one row per metric, both lanes' values as text, and B − A.
 *   [{ id, label, a, b, diff, known: { a, b } }]; known is false where the text is not a number
 */
export function rows(reports, { replay = false } = {}) {
  const ra = reports && reports.a;
  const rb = reports && reports.b;
  return ROWS.map((row) => {
    const a = valueOf(row, ra);
    const b = valueOf(row, rb);
    return {
      id: row.id,
      label: row.label,
      a: a === null ? blank(row, ra, { replay }) : row.fmt(a),
      b: b === null ? blank(row, rb, { replay }) : row.fmt(b),
      diff: settled(ra) && settled(rb) ? diffText(row, a, b) : "",
      known: { a: a !== null, b: b !== null },
    };
  });
}

/**
 * Whether "Run live" can run, from the same mainDemo block main-demo reads.
 *   { ok: true, variants } or { ok: false, why }
 * `fallback` is variants.json's map, for a local run without mainDemo.variants.
 */
export function liveReadiness(mainDemo, fallback) {
  if (!mainDemo || typeof mainDemo !== "object") {
    return { ok: false, why: "Live runs are off on this build: it has no Agent Studio config." };
  }
  if (!mainDemo.agentStudioApiKey || !mainDemo.appId) {
    return { ok: false, why: "Live runs are off on this build: the config has no app id or key." };
  }
  const variants = configVariants(mainDemo) || fallback || {};
  const missing = LANES.filter((l) => !(variants[configKey(l.toggles)] && variants[configKey(l.toggles)].agentId));
  if (missing.length) {
    return { ok: false, why: `Live runs are off on this build: no agent for ${missing.map((l) => l.label.toLowerCase()).join(" or ")}.` };
  }
  return { ok: true, variants };
}

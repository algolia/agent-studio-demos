/* ───────────────────────────────────────────────────────────────
   outcome.mjs: did each lane answer, and what the page says after a run.

   No check runs before Run: a lane that cannot answer says so itself, in
   its alert line, the moment its call fails. Pure: no DOM, no storage.
   ─────────────────────────────────────────────────────────────── */

import { emptyTurn } from "../main-demo/stream.mjs";

/** a failed call, said in a few words */
export function reasonFor(status, message) {
  if (status === 404) return "agent not found on this backend";
  if (status === 401 || status === 403) return "the key was refused";
  if (status === 429) return "rate limited";
  if (status >= 500) return `backend error (HTTP ${status})`;
  if (message) return String(message).slice(0, 80);
  return status ? `HTTP ${status}` : "no answer";
}

/** why a lane's turn produced no answer, or null when it did */
export function laneFailure(view) {
  if (!view || view.status === "sending" || view.status === "streaming") return null;
  if (view.httpStatus >= 400) return reasonFor(view.httpStatus);
  if (view.status === "error" || (view.errors && view.errors.length)) {
    return String((view.errors && view.errors[0]) || "the call failed").slice(0, 80);
  }
  // a clean close with no text: the Chat widget draws nothing, so the lane says it
  if (emptyTurn(view)) return view.toolCalls > 0 ? "the model stopped after its search, with no text" : "the model sent back an empty reply";
  return null;
}

/** the state after a run: Run stays on, but a lane with no answer is said, not "Ready" */
export function afterRun(reports, lanes) {
  const r = reports || {};
  const failed = lanes.filter((l) => laneFailure(r[l.key] && r[l.key].view));
  if (!failed.length) return { phase: "ready", text: "Ready" };
  const who = failed.map((l) => l.label).join(" and ");
  return { phase: "retry", text: `Last run: no answer from ${who}. Run to try again.` };
}

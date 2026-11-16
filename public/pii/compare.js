/* ───────────────────────────────────────────────────────────────
   compare.js — the strip under the two sides, computed from the run.

   Every number is a count of raw identifiers detect.js finds in what each
   side actually sent or stored: the message to the model, then the chat log
   (customer line and agent reply). Masks are not identifiers, so they count
   zero. Pure: tests/pii.test.js runs the same function.
   ─────────────────────────────────────────────────────────────── */

import { detect, maskFindings } from "./detect.js";

const count = (texts, opts) => texts.filter((t) => typeof t === "string").reduce((n, t) => n + detect(t, opts).length, 0);

/** what an agent was given to read: the numbers, only their masks, nothing, or a clean message */
export function sawOf(sent, opts) {
  if (sent == null) return "nothing, refused before the model";
  if (detect(sent, opts).length) return "the numbers themselves, so it warns about them";
  if (maskFindings(sent).length) return "only that details were filtered";
  return "a message with no identifier";
}

/**
 * sides = { raw: { sent, log: [texts] }, filtered: { sent, log: [texts] } }
 * → rows of [label, left, right]
 */
export function compareSides(sides, opts = {}) {
  const sentN = (s) => (s.sent == null ? null : count([s.sent], opts));
  const model = [sentN(sides.raw), sentN(sides.filtered)];
  const shown = (n) => (n == null ? "0, nothing sent" : `${n} raw`);
  return [
    ["Identifiers the model received", shown(model[0]), shown(model[1])],
    ["Identifiers in the stored log", `${count(sides.raw.log, opts)} raw`, `${count(sides.filtered.log, opts)} raw`],
    ["What the agent saw", sawOf(sides.raw.sent, opts), sawOf(sides.filtered.sent, opts)],
  ];
}

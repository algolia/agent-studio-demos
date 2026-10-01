/* ───────────────────────────────────────────────────────────────
   format.mjs — how a duration and a token count are written, once.

   Pure. The strip, the scoreboard and every lane read their numbers through
   these, so the same figure never prints two ways on one page.
   ─────────────────────────────────────────────────────────────── */

/** "412 ms", "1.9 s" — one rule, so the strip and the report agree */
export function ms(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  if (v < 1000) return `${Math.round(v)}\u00a0ms`;
  return `${(v / 1000).toFixed(v < 10000 ? 2 : 1)}\u00a0s`;
}

/** "12.3k" past a thousand, the integer below it */
export const tokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));

/** "12,345": every digit, grouped, for the numbers a reader compares */
export const grouped = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "—");

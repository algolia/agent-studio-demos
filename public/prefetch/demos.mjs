/* ───────────────────────────────────────────────────────────────
   demos.mjs: one race page, several use cases.

   Each page under prefetch/ names its demo on <html data-demo="…">, and
   app.js reads that demo's entry here: which config.js blocks hold its
   agents, the starters, what the input says, and which record attributes
   its result cards read. Pure: no DOM.
   ─────────────────────────────────────────────────────────────── */

import { STARTERS } from "./compare.mjs";

/* check-copy: off */
/**
 * Every demo's starters were checked against its index with the raw
 * sentence, which is what prefetch searches. `fit: "good"`: the right
 * records come back. `fit: "poor"`: the hits are off topic, so the
 * prefetched search is wasted and the model has to search on its own.
 */
export const DEMOS = {
  // the product catalog, on main-demo's agents unless the deploy gives this page its own
  catalog: {
    blocks: ["prefetchDemo", "mainDemo"],
    placeholder: "Ask anything about the product catalog",
    starters: STARTERS,
    fields: null,
  },
};
/* check-copy: on */

/** a page's demo by name; an unknown or missing name is the catalog page */
export function demoOf(name) {
  return Object.prototype.hasOwnProperty.call(DEMOS, name) ? DEMOS[name] : DEMOS.catalog;
}

/** the demo's block with its card fields laid under the block's own */
export function demoConfig(demo, block) {
  const b = block || {};
  return { indexName: "products", ...b, ...(demo.fields && !b.fields ? { fields: demo.fields } : {}) };
}

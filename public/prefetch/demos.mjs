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
  // the race page: a record-store clerk on 1001 albums, with cover art on every card
  albums: {
    blocks: ["prefetchAlbums"],
    placeholder: "Ask the record shop",
    starters: [
      { text: "Psychedelic rock albums from the 60s", fit: "good" },
      { text: "Punk records from 1977", fit: "good" },
      { text: "Brazilian bossa nova classics", fit: "good" },
      { text: "Surprise me, what should I play tonight?", fit: "poor" },
    ],
    fields: { title: ["title"], byline: ["artist", "year"], line: ["genres"], image: ["image"] },
  },
  // the product catalog, on main-demo's agents unless the deploy gives this page its own
  catalog: {
    blocks: ["prefetchDemo", "mainDemo"],
    placeholder: "Ask anything about the product catalog",
    starters: STARTERS,
    fields: null,
  },
  // DocSearch Ask AI: questions about a docs site, on its DocSearch crawler records
  askai: {
    blocks: ["prefetchAskai"],
    placeholder: "Ask a question about the Algolia docs",
    starters: [
      { text: "How do I install the JavaScript API client?", fit: "good" },
      { text: "How do I stream agent completions?", fit: "good" },
      { text: "Set up Algolia with Ruby on Rails", fit: "good" },
      { text: "Which plan should I pick for my startup?", fit: "poor" },
    ],
    fields: { title: ["hierarchy.lvl1", "hierarchy.lvl0"], line: ["hierarchy.lvl2", "content"] },
  },
  // AI Assist: a site assistant, here on the support center's articles
  assist: {
    blocks: ["prefetchAssist"],
    placeholder: "Ask the support site",
    starters: [
      { text: "How do I remove the Search by Algolia logo?", fit: "good" },
      { text: "Why is my record count higher than expected?", fit: "good" },
      { text: "Why are typos not applying to my synonyms?", fit: "good" },
      { text: "Do you have a phone number I can call?", fit: "poor" },
    ],
    fields: { title: ["title"], line: ["text"] },
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

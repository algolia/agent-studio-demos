/* ───────────────────────────────────────────────────────────────
   engines.mjs — five ways to decide which sections a question needs.

   Pure: no DOM, no fetch. Each engine's network or model call lives in
   run.mjs; what is decided from its answer lives here, so the page, the
   study and the tests share one rule per engine.

     jev      TypeSafe System One, outside vendor      P(yes) per section
     laya     the same API shape, on Enablers           P(yes) per section
     embed    a small embedding model, in the browser   cosine similarity
     keyword  BM25 over section names and descriptions  BM25 score
     llm      a small Enablers LLM, asked for JSON      kept or not
   ─────────────────────────────────────────────────────────────── */

import { SECTIONS, splitKey } from "./attrs.mjs";

export const ENGINES = [
  { id: "jev", label: "Jev", where: "vendor", needs: "jev", scale: "P(yes)" },
  { id: "laya", label: "Laya", where: "enablers", needs: "enablers", scale: "P(yes)" },
  { id: "embed", label: "Embeddings", where: "browser", needs: null, scale: "cosine" },
  { id: "keyword", label: "Keywords", where: "browser", needs: null, scale: "BM25" },
  { id: "llm", label: "LLM picker", where: "enablers", needs: "enablers", scale: "kept" },
];

export const engine = (id) => ENGINES.find((e) => e.id === id);

/* ── text ─────────────────────────────────────────────────────── */

/* word lists, not copy: one array per line so no line reads as a sentence */
const STOP = new Set([
  ..."a about an and any are as at be by can compare country countries did do does for from get give".split(" "),
  ..."has have how i in into is it its me most much my of on or over per than that the their them there these".split(" "),
  ..."this to under up use used versus vs was what when where which who whose why will with would you".split(" "),
]);

const stem = (w) => {
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
};

/** lowercase words, accents folded, stop words out, a light plural strip */
export function terms(text) {
  return String(text || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/'s\b/g, "")
    .split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w)).map(stem);
}

/** the question minus the words of the countries it names: what is left is what it asks */
export function askTerms(question, hits = []) {
  const names = new Set(hits.flatMap((h) => terms(`${h.name || ""} ${(h.aliases || []).join(" ")}`)));
  return terms(question).filter((t) => !names.has(t));
}

/* ── keyword: BM25 ────────────────────────────────────────────── */

/** BM25 of each document against the query terms; k1 1.2, b 0.75 */
export function bm25(queryTerms, docs, { k1 = 1.2, b = 0.75 } = {}) {
  const toks = docs.map((d) => terms(d));
  const N = toks.length;
  const avg = toks.reduce((s, t) => s + t.length, 0) / Math.max(1, N);
  const df = new Map();
  for (const t of toks) for (const w of new Set(t)) df.set(w, (df.get(w) || 0) + 1);
  const q = [...new Set(queryTerms)];
  return toks.map((t) => {
    let score = 0;
    for (const w of q) {
      const tf = t.filter((x) => x === w).length;
      if (!tf) continue;
      const idf = Math.log(1 + (N - df.get(w) + 0.5) / (df.get(w) + 0.5));
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * t.length) / (avg || 1))));
    }
    return score;
  });
}

/**
 * Keep the documents scoring at least `ratio` of the best, at most `maxK`.
 * With no score above zero nothing is kept, and the caller decides.
 */
export function topByRatio(scores, { ratio = 0.5, maxK = 3 } = {}) {
  const best = Math.max(0, ...scores);
  if (best <= 0) return new Set();
  const order = scores.map((s, i) => [s, i]).filter(([s]) => s >= best * ratio).sort((x, y) => y[0] - x[0]);
  return new Set(order.slice(0, maxK).map(([, i]) => i));
}

/** keep the scores within `margin` of the best, at most `maxK`, always the best one */
export function topByMargin(scores, { margin = 0.05, maxK = 3 } = {}) {
  if (!scores.length) return new Set();
  const best = Math.max(...scores);
  const order = scores.map((s, i) => [s, i]).filter(([s]) => s >= best - margin).sort((x, y) => y[0] - x[0]);
  return new Set(order.slice(0, maxK).map(([, i]) => i));
}

/** the text an engine without typed questions reads for each section */
export const sectionDocs = () => SECTIONS.map((s) => `${s.name}: ${s.what}`);
/** and for each field: its section and its name */
export const fieldDocs = (fields) => fields.map((f) => splitKey(f).join(": "));

/**
 * Rows in the shape every engine reports: { name, score, picked, fallback }.
 * With nothing kept, every section stays and each row says `fallback`: the
 * engine had no opinion, so the LLM gets the full record rather than nothing.
 */
export function sectionRows(scores, keep) {
  const none = keep.size === 0;
  return SECTIONS.map((s, i) => ({ name: s.name, id: s.id, score: scores[i], picked: none || keep.has(i), fallback: none }));
}

export function fieldRows(fields, scores, keep) {
  const none = keep.size === 0;
  return fields.map((key, i) => ({ key, score: scores[i], picked: none || keep.has(i), fallback: none }));
}

/** keyword picks over sections, then over fields */
export const KEYWORD = { sections: { ratio: 0.5, maxK: 3 }, fields: { ratio: 0.5, maxK: 6 } };
export function keywordSections(question, hits) {
  const scores = bm25(askTerms(question, hits), sectionDocs());
  return sectionRows(scores, topByRatio(scores, KEYWORD.sections));
}
export function keywordFields(question, hits, fields) {
  const scores = bm25(askTerms(question, hits), fields.map((f) => splitKey(f)[1]));
  return fieldRows(fields, scores, topByRatio(scores, KEYWORD.fields));
}

/* ── embeddings: cosine over unit vectors ──────────────────────── */

export const cosine = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

export const EMBED_RULE = { sections: { margin: 0.06, maxK: 3 }, fields: { margin: 0.08, maxK: 6 } };
export function embedSections(qVec, docVecs) {
  const scores = docVecs.map((v) => cosine(qVec, v));
  return sectionRows(scores, topByMargin(scores, EMBED_RULE.sections));
}
export function embedFields(qVec, fields, docVecs) {
  const scores = docVecs.map((v) => cosine(qVec, v));
  return fieldRows(fields, scores, topByMargin(scores, EMBED_RULE.fields));
}

/* ── LLM picker: a JSON list ───────────────────────────────────── */

/* check-copy: off */
const PICK_SYSTEM = [
  "You decide which parts of a CIA World Factbook country profile are needed to answer a question.",
  'Reply with JSON only, in the form {"keep": ["name", ...]}, using names exactly as listed.',
  "Keep as few as answer the question, and at least one.",
].join(" ");

export function pickerSectionMessages(question) {
  const list = SECTIONS.map((s) => `- ${s.name}: ${s.what}. Not for: ${s.notFor}.`).join("\n");
  const names = SECTIONS.map((s) => JSON.stringify(s.name)).join(", ");
  return [
    { role: "system", content: PICK_SYSTEM },
    { role: "user", content: `Sections:\n${list}\n\nAllowed names: ${names}.\n\nQuestion: ${question}` },
  ];
}

export function pickerFieldMessages(question, fields) {
  const list = fields.map((f) => `- ${f}`).join("\n");
  return [
    { role: "system", content: PICK_SYSTEM },
    { role: "user", content: `Fields:\n${list}\n\nQuestion: ${question}` },
  ];
}
/* check-copy: on */

/** the names an LLM reply keeps, matched case-insensitively against what was offered (`null`: every string, as written) */
export function parseKeep(text, allowed) {
  const t = String(text || "");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  let list = [];
  if (start >= 0 && end > start) {
    try {
      const j = JSON.parse(t.slice(start, end + 1));
      list = Array.isArray(j.keep) ? j.keep : [];
    } catch (_) { list = []; }
  }
  if (allowed === null) return list.map((x) => String(x).trim()).filter(Boolean);
  const byLower = new Map(allowed.map((a) => [a.toLowerCase(), a]));
  const out = [];
  for (const x of list) {
    const hit = byLower.get(String(x).trim().toLowerCase());
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}

/**
 * A small model sometimes answers with a phrase from a description instead
 * of the name ("land boundaries and border countries"): such a phrase counts
 * for the one section whose description holds it.
 */
export function pickerSectionRows(text) {
  const kept = new Set(parseKeep(text, SECTIONS.map((s) => s.name)));
  for (const phrase of parseKeep(text, null)) {
    const owners = SECTIONS.filter((s) => s.what.toLowerCase().includes(phrase.toLowerCase()));
    if (owners.length === 1) kept.add(owners[0].name);
  }
  const keep = new Set(SECTIONS.map((s, i) => (kept.has(s.name) ? i : -1)).filter((i) => i >= 0));
  return sectionRows(SECTIONS.map((s) => (kept.has(s.name) ? 1 : 0)), keep);
}

export function pickerFieldRows(text, fields) {
  const kept = new Set(parseKeep(text, fields));
  const keep = new Set(fields.map((f, i) => (kept.has(f) ? i : -1)).filter((i) => i >= 0));
  return fieldRows(fields, fields.map((f) => (kept.has(f) ? 1 : 0)), keep);
}

/* ── language ─────────────────────────────────────────────────── */

const EN = new Set("the is are what which how many much does do of in and who where when has have".split(" "));
const OTHER = new Set([
  ..."le la les des du est quel quelle quels combien pays de".split(" "),
  ..."el los las del es cual cuales cuantos qué cuál".split(" "),
  ..."der die das und ist welche wie viele il gli che sono quanti quale o os qual quais".split(" "),
]);
/** a question that reads as not English: another script, or another language's function words and none of English's */
export function looksNonEnglish(question) {
  const q = String(question || "");
  if (/[^\s\x20-\u024f\u2000-\u206f]/u.test(q)) return true;
  const words = q.toLowerCase().split(/[^a-z\u00c0-\u024f]+/).filter(Boolean);
  return words.some((w) => OTHER.has(w)) && !words.some((w) => EN.has(w));
}

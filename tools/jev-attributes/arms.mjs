/* ───────────────────────────────────────────────────────────────
   arms.mjs — the study's other arms, the ones the page no longer runs.

   study.mjs compares Jev with Laya, keyword BM25 and a small LLM picker.
   The page asks Jev only, so everything else the study needs lives here,
   next to it: the Laya target and its compact request, the routes and the
   direct transport to every vendor, the picker's one-shot completion, and
   the keyword and picker decisions. The deciding parts are pure (no DOM,
   no fetch); `directTransport` and `chatOnce` are the only network code.
   ─────────────────────────────────────────────────────────────── */

import { SECTIONS } from "../../public/jev-attributes/attrs.mjs";
import { ROUTES as PAGE_ROUTES } from "../../public/jev-attributes/client.mjs";

/** every upstream the study reaches: the page's one route, plus Laya and the Enablers chat */
export const ROUTES = {
  ...PAGE_ROUTES,
  "laya/systemone": "https://inference-staging.api.enablers.algolia.net/v1/systemone",
  "enablers/chat/completions": "https://inference-eu.api.enablers.algolia.net/v1/chat/completions",
};

/** Laya: the System One request shape, on Enablers. CPU-served: never a read timeout under 120 s */
export const LAYA = { name: "laya", route: "laya/systemone", model: "laya-auto", key: "enablers", timeoutMs: 180000, attempts: 2 };

export const PICKER_MODEL = "small";
const MAX_TOKENS = 16384;

/** the study's transport: straight to the vendor, the caller's key in the header */
export function directTransport(fetchImpl = (...a) => fetch(...a)) {
  return (route, body, { auth, timeoutMs, signal } = {}) => fetchImpl(ROUTES[route], {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth}` },
    body: JSON.stringify(body),
    signal: combine(signal, timeoutMs),
  });
}

function combine(signal, timeoutMs) {
  const list = [signal, timeoutMs ? AbortSignal.timeout(timeoutMs) : null].filter(Boolean);
  if (!list.length) return undefined;
  return list.length === 1 ? list[0] : AbortSignal.any(list);
}

/** one completion, not streamed: { text, usage, model, ms } */
export async function chatOnce(post, messages, { model = PICKER_MODEL, keys = {}, signal } = {}) {
  const t0 = performance.now();
  const res = await post("enablers/chat/completions", {
    model, messages, max_tokens: MAX_TOKENS, temperature: 0, response_format: { type: "json_object" },
  }, { auth: keys.enablers, timeoutMs: 120000, signal });
  const text = await res.text();
  if (res.status !== 200) throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 160)}`);
  const json = JSON.parse(text);
  const msg = json.choices && json.choices[0] && json.choices[0].message;
  const u = json.usage;
  return {
    text: (msg && msg.content) || "", model: json.model || model, ms: performance.now() - t0,
    usage: u ? { inputTokens: u.prompt_tokens ?? null, outputTokens: u.completion_tokens ?? null } : null,
  };
}

/* check-copy: off */
/**
 * Jev's judgment in Laya's budget. Laya reads state and question together
 * per question and keeps about 512 tokens of them, so the shape that suits
 * Jev arrives cut short. Here the state is the question alone and each
 * question names its one section; `main` lists each section's `what` only.
 */
export function compactSectionQuestions() {
  const qs = {};
  for (const s of SECTIONS) {
    qs[s.id] = {
      type: "noul",
      instructions: `Does answering \`question\` need the ${s.name} section of a country profile (${s.what})?`,
    };
  }
  qs.main = {
    type: "choice",
    instructions: "Which section of a country profile holds the facts `question` asks for first?",
    criteria: Object.fromEntries(SECTIONS.map((s) => [s.id, s.what])),
  };
  return qs;
}
/* check-copy: on */

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
  return String(text || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/'s\b/g, "")
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

/** the text an arm without typed questions reads for each section */
export const sectionDocs = () => SECTIONS.map((s) => `${s.name}: ${s.what}`);

/**
 * Rows { name, id, score, picked, fallback }. With nothing kept, every
 * section stays and each row says `fallback`: the arm had no opinion.
 */
export function sectionRows(scores, keep) {
  const none = keep.size === 0;
  return SECTIONS.map((s, i) => ({ name: s.name, id: s.id, score: scores[i], picked: none || keep.has(i), fallback: none }));
}

export const KEYWORD = { ratio: 0.5, maxK: 3 };
export function keywordSections(question, hits) {
  const scores = bm25(askTerms(question, hits), sectionDocs());
  return sectionRows(scores, topByRatio(scores, KEYWORD));
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

/* ───────────────────────────────────────────────────────────────
   records.mjs: which hits a question needs, then which sections of them.

   Pure: no DOM, no fetch. The records stage asks Jev one yes/no question per
   hit ("does this record help answer the question?"), in one request, from a
   short text per record; the fields stage (attrs.mjs) then trims the
   records that stayed. Here: what Jev reads of each record, the request,
   the rule that reads the answer, the order of the two stages, the sizes
   the page shows, and the split of a record into what Jev saw and did not.
   ─────────────────────────────────────────────────────────────── */

import { SECTIONS, sectionState, sectionQuestions, pickSections, sectionSizes, trimTotals, splitKey, CHARS_PER_TOKEN } from "./attrs.mjs";
import { TOPICAL } from "./search.mjs";

/** what Jev reads of a record: its name only, its name and the start of its background, or its name and the matched snippets */
export const VIEWS = ["name", "intro", "snippet"];
export const INTRO_CHARS = 300;
/** P(yes) is at least this: the record is kept */
export const RECORD_THRESHOLD = 0.5;
/** the fields stage trims at most this many of the kept records */
export const MAX_FIELDED = 3;

export const estTokens = (chars) => Math.round(chars / CHARS_PER_TOKEN);

/** `text` cut to at most `max` characters, on a word boundary, with an ellipsis when cut */
export function cutWords(text, max) {
  const t = String(text || "").trim();
  if (t.length <= max) return t;
  const head = t.slice(0, max);
  const at = head.search(/\s\S*$/);
  return `${(at > 0 ? head.slice(0, at) : head).replace(/[\s,;:.-]+$/, "")}…`;
}

const decode = (s) => String(s).replace(/<\/?em>/g, "").replace(/&quot;/g, "\"").replace(/&#39;/g, "'")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/**
 * The snippets Algolia matched on a hit, tags out and the ellipses trimmed:
 * those that show a matched word first, most matched words first, then
 * TOPICAL order. A snippet that matched outside its window shows none and
 * counts only when no other does. With no match at all, the background's
 * own snippet.
 */
export function snippetPieces(hit) {
  const sr = (hit && hit._snippetResult) || {};
  const piece = (attr) => ({ attr, text: decode(sr[attr].value).replace(/^…\s*|\s*…$/g, "").trim() });
  const ems = (attr) => (String(sr[attr].value).match(/<em>/g) || []).length;
  const matched = TOPICAL.filter((a) => sr[a] && sr[a].matchLevel && sr[a].matchLevel !== "none");
  const shown = matched.filter((a) => ems(a) > 0).sort((x, y) => ems(y) - ems(x));
  if (shown.length) return shown.map(piece);
  if (matched.length) return matched.map(piece);
  return sr["Introduction.Background"] ? [piece("Introduction.Background")] : [];
}

/** the text Jev reads for one record besides its name, under `view` */
export function seenText(hit, view) {
  if (view === "name") return "";
  if (view === "intro") return cutWords(hit["Introduction.Background"], INTRO_CHARS);
  const pieces = snippetPieces(hit);
  return pieces.length ? pieces.map((p) => p.text).join(" … ") : cutWords(hit["Introduction.Background"], INTRO_CHARS);
}

/* check-copy: off */
/** the state: the question, and each record as Jev reads it, keyed by objectID */
export function recordsState(question, hits, view) {
  const records = {};
  for (const h of hits) {
    const text = seenText(h, view);
    records[h.objectID] = text ? { name: h.name, text } : { name: h.name };
  }
  return { question, records };
}

/** one atomic noul per record, pointing into the state by backtick path, with a contrastive criterion */
export function recordsQuestions(hits) {
  const qs = {};
  for (const h of hits) {
    qs[h.objectID] = {
      type: "noul",
      instructions: { question: `Does \`records.${h.objectID}\` help answer \`question\`?` },
      criteria: {
        true: "the record's text answers the question or bears directly on it: the country is one the question asks about",
        false: "the record only shares a region, a word or a topic with the question; a country merely in the same region does not help",
      },
    };
  }
  return qs;
}
/* check-copy: on */

/** the characters of a request body as sent, and so what Jev reads */
export const requestChars = (state, questions) => JSON.stringify({ state, questions }).length;

/**
 * A System One answer → every hit with its P(yes), in Algolia order. Kept
 * at RECORD_THRESHOLD or more; the most likely one is always kept (`top`),
 * so the stage never ends empty. With no P at all, the first hit stays.
 */
export function pickRecords(answers, hits, threshold = RECORD_THRESHOLD) {
  const a = answers || {};
  const rows = hits.map((h, rank) => {
    const x = a[h.objectID];
    const p = x && Number.isFinite(x.noul) ? x.noul : null;
    return { id: h.objectID, name: h.name, rank, p, kept: p !== null && p >= threshold, top: false };
  });
  if (!rows.length) return rows;
  const scored = rows.filter((r) => r.p !== null);
  const best = scored.length ? scored.reduce((b, r) => (r.p > b.p ? r : b)) : rows[0];
  best.top = true;
  best.kept = true;
  return rows;
}

/** the kept records the fields stage trims: the likeliest MAX_FIELDED, shown in Algolia order */
export function fieldTargets(rows, max = MAX_FIELDED) {
  return rows.filter((r) => r.kept)
    .sort((x, y) => (y.p ?? -1) - (x.p ?? -1) || x.rank - y.rank)
    .slice(0, max)
    .sort((x, y) => x.rank - y.rank);
}

/** a record's size: the characters of its 13 sections as JSON, as attrs.mjs counts them */
export const recordChars = (record) => trimTotals(sectionSizes(record), SECTIONS.map((s) => s.id)).total.chars;

const size = (records, chars) => ({ records, chars, tokens: estTokens(chars) });

/**
 * The readout: the hits in full, then the records Jev kept, then those the
 * fields stage trimmed to their kept sections. Characters counted, tokens
 * estimated. `keptIds` and `fielded` ([{ id, sectionIds }]) are null when
 * that stage did not run.
 */
export function readouts(hits, keptIds, fielded) {
  const byId = new Map(hits.map((h) => [h.objectID, h]));
  const out = { all: size(hits.length, hits.reduce((n, h) => n + recordChars(h), 0)), afterRecords: null, afterFields: null };
  if (keptIds) out.afterRecords = size(keptIds.length, keptIds.reduce((n, id) => n + recordChars(byId.get(id)), 0));
  if (fielded) {
    out.afterFields = size(fielded.length, fielded.reduce((n, f) => n + trimTotals(sectionSizes(byId.get(f.id)), f.sectionIds).kept.chars, 0));
  }
  return out;
}

/**
 * One question through the stages its mode runs, in order: search, then Jev
 * on the records (records, both), then Jev on the sections (fields, both)
 * of what stayed. `search(question, kind)` and `jev(stage, state, questions)`
 * are injected; `on(stage, result)` hears each stage as it lands. A stage
 * that fails is recorded as { error } and ends the run.
 */
export async function runPipeline({ mode, question, view = "snippet", search, jev, on = () => {} }) {
  const out = { mode, search: null, records: null, fields: null };
  out.search = await search(question, mode === "fields" ? "fields" : "records");
  on("search", out.search);
  let targets = out.search.hits;
  if (!targets.length) return out;
  if (mode !== "fields") {
    const state = recordsState(question, targets, view);
    const questions = recordsQuestions(targets);
    try {
      const a = await jev("records", state, questions);
      out.records = { ...a, rows: pickRecords(a.answers, targets), chars: requestChars(state, questions) };
    } catch (err) {
      out.records = { error: err.message, chars: requestChars(state, questions) };
    }
    on("records", out.records);
    if (out.records.error || mode === "records") return out;
    const keep = new Set(fieldTargets(out.records.rows).map((r) => r.id));
    targets = targets.filter((h) => keep.has(h.objectID));
  }
  // the fields request carries the question and the section descriptions, never a record: one call serves every target
  const state = sectionState(question);
  const questions = sectionQuestions();
  try {
    const a = await jev("fields", state, questions);
    out.fields = { ...a, rows: pickSections(a.answers), targets: targets.map((h) => h.objectID), chars: requestChars(state, questions) };
  } catch (err) {
    out.fields = { error: err.message, targets: targets.map((h) => h.objectID), chars: requestChars(state, questions) };
  }
  on("fields", out.fields);
  return out;
}

/**
 * A whole record split into what Jev saw and what it did not, for the modal.
 *   records stage: the name, and the text `seenText` gave under `view`
 *   fields stage:  nothing of the record; Jev read the section descriptions
 * Every field is a list of parts { text, seen }. `kept` (a Set of section
 * ids, after the fields stage) marks each section kept or dropped. Counts:
 * characters Jev read, and the rest of the record's JSON characters.
 */
export function partitionRecord(record, { stage, view = "snippet", hit = record, kept = null }) {
  const spans = new Map(); // field key → [start, end) pairs Jev read
  let seenChars = 0;
  let extra = [];
  if (stage === "records") {
    seenChars += String(record.name || "").length;
    const text = seenText(hit, view);
    seenChars += text.length;
    const mark = (key, piece) => {
      const v = String(record[key] || "");
      const at = v.indexOf(piece);
      if (at >= 0 && piece) spans.set(key, [...(spans.get(key) || []), [at, at + piece.length]]);
    };
    if (view === "intro" && text) mark("Introduction.Background", text.replace(/…$/, ""));
    if (view === "snippet") {
      const pieces = snippetPieces(hit);
      if (pieces.length) for (const p of pieces) mark(p.attr, p.text);
      else if (text) mark("Introduction.Background", text.replace(/…$/, ""));
    }
  } else {
    extra = Object.values(sectionState("").sections);
    seenChars = extra.reduce((n, s) => n + s.length, 0);
  }
  const sections = SECTIONS.map((s) => ({ id: s.id, name: s.name, kept: kept ? kept.has(s.id) : null, fields: [] }));
  const byName = new Map(sections.map((s) => [s.name, s]));
  for (const [key, value] of Object.entries(record)) {
    const [sec, field] = splitKey(key);
    const row = byName.get(sec);
    if (!row) continue;
    const v = typeof value === "string" ? value : JSON.stringify(value);
    row.fields.push({ key, field, parts: split(v, spans.get(key) || []) });
  }
  const total = recordChars(record);
  const recordSeen = stage === "records" ? seenChars : 0;
  return {
    name: { text: record.name, seen: stage === "records" },
    descriptions: extra,
    sections,
    counts: {
      seen: { chars: seenChars, tokens: estTokens(seenChars) },
      unseen: { chars: Math.max(0, total - recordSeen), tokens: estTokens(Math.max(0, total - recordSeen)) },
    },
  };
}

/** a value cut into seen and unseen parts at the given spans */
function split(value, spans) {
  const parts = [];
  let at = 0;
  for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0])) {
    if (a < at) continue;
    if (a > at) parts.push({ text: value.slice(at, a), seen: false });
    parts.push({ text: value.slice(a, b), seen: true });
    at = b;
  }
  if (at < value.length || !parts.length) parts.push({ text: value.slice(at), seen: false });
  return parts;
}

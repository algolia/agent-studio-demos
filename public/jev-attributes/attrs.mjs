/* ───────────────────────────────────────────────────────────────
   attrs.mjs — which parts of a heavy record a question needs.

   Pure: no DOM, no fetch. The page and the proxy import the same bytes, so
   the questions Jev is asked, the way a record is stripped and the prompt
   both lanes send are one definition, not two that can drift.

   A Factbook record is ~260 flat keys named `Section.Field`. Jev answers one
   yes/no question per section, all in one request; the sections it says yes
   to are kept, everything else is dropped before the LLM sees the record.
   An optional second stage asks the same of each field inside the kept
   sections.
   ─────────────────────────────────────────────────────────────── */

/* check-copy: off */
/** the 13 sections every profile shares, with a few of their fields as a hint for Jev */
export const SECTIONS = [
  { name: "Introduction", hint: "historical background of the country" },
  { name: "Geography", hint: "location, area, land boundaries and border countries, coastline, terrain, elevation, natural resources, rivers" },
  { name: "People and Society", hint: "population, age structure, languages, religions, ethnic groups, life expectancy, birth and death rates, health, education, literacy" },
  { name: "Environment", hint: "climate, land use, urbanization, environmental issues, emissions, water resources" },
  { name: "Government", hint: "country name, government type, capital, constitution, executive, legislative and judicial branches, political parties, flag, anthem, independence" },
  { name: "Economy", hint: "GDP, GDP growth, GDP per capita, inflation, exports and imports with commodities and partners, industries, budget, debt, unemployment, exchange rates" },
  { name: "Energy", hint: "electricity, oil, natural gas, coal, nuclear energy, energy consumption" },
  { name: "Communications", hint: "telephones, internet users, broadband, broadcast media" },
  { name: "Transportation", hint: "airports, railways, ports, merchant marine" },
  { name: "Military and Security", hint: "military and security forces, military expenditures, personnel strengths, equipment, service age, deployments" },
  { name: "Space", hint: "space agency, launch sites, space program" },
  { name: "Terrorism", hint: "terrorist groups active in the country" },
  { name: "Transnational Issues", hint: "refugees, trafficking in persons, illicit drugs, international disputes" },
];

const FRAME = "The body is a question about one or more countries. It will be answered from CIA World Factbook country profiles.";

/** stage 1: one noul question per section, ids s0…s12 */
export function sectionQuestions() {
  const qs = {};
  SECTIONS.forEach((s, i) => {
    qs[`s${i}`] = {
      type: "noul",
      instructions: `${FRAME} Does answering it need the "${s.name}" section of the profile (${s.hint})?`,
    };
  });
  return qs;
}

/** stage 2: one noul question per field inside the kept sections, ids f0…fn */
export function fieldQuestions(fields) {
  const qs = {};
  fields.forEach((f, i) => {
    const [section, field] = splitKey(f);
    qs[`f${i}`] = {
      type: "noul",
      instructions: `${FRAME} Does answering it need the field "${field}" from the "${section}" section of the profile?`,
    };
  });
  return qs;
}
/* check-copy: on */

/** keys that are not attributes: always kept, never counted as a section */
export const ALWAYS = ["objectID", "name"];
const META = new Set([...ALWAYS, "aliases", "region"]);

export const splitKey = (k) => {
  const i = k.indexOf(".");
  return i < 0 ? [k, ""] : [k.slice(0, i), k.slice(i + 1)];
};

/** P(yes) is at least this: the attribute is kept */
export const THRESHOLD = 0.5;

/**
 * Jev's answers → every section with its P(yes), in schema order, `picked`
 * when at or over the threshold. If nothing clears it, the single most likely
 * section is kept, and marked `fallback`, so the LLM never gets an empty record.
 */
export function pickSections(answers, threshold = THRESHOLD) {
  const rows = SECTIONS.map((s, i) => {
    const a = answers && answers[`s${i}`];
    const p = a && Number.isFinite(a.noul) ? a.noul : null;
    return { name: s.name, p, picked: p !== null && p >= threshold, fallback: false };
  });
  if (!rows.some((r) => r.picked)) {
    const best = rows.filter((r) => r.p !== null).sort((a, b) => b.p - a.p)[0];
    if (best) { best.picked = true; best.fallback = true; }
  }
  return rows;
}

/** the same rule for fields: [{ key, p, picked }], at least one kept */
export function pickFields(fields, answers, threshold = THRESHOLD) {
  const rows = fields.map((key, i) => {
    const a = answers && answers[`f${i}`];
    const p = a && Number.isFinite(a.noul) ? a.noul : null;
    return { key, p, picked: p !== null && p >= threshold, fallback: false };
  });
  if (rows.length && !rows.some((r) => r.picked)) {
    const best = rows.filter((r) => r.p !== null).sort((a, b) => b.p - a.p)[0];
    if (best) { best.picked = true; best.fallback = true; }
  }
  return rows;
}

/** every attribute key the records carry inside the given sections, in record order */
export function fieldsIn(records, sections) {
  const want = new Set(sections);
  const seen = new Set();
  for (const r of records) for (const k of Object.keys(r)) {
    if (!META.has(k) && want.has(splitKey(k)[0])) seen.add(k);
  }
  return [...seen];
}

/**
 * A record with only the kept attributes. `keep` is a set of section names,
 * or of full `Section.Field` keys when the field stage ran.
 */
export function strip(record, keep) {
  const set = keep instanceof Set ? keep : new Set(keep);
  const out = {};
  for (const [k, v] of Object.entries(record)) {
    if (ALWAYS.includes(k)) { out[k] = v; continue; }
    if (META.has(k)) continue;
    if (set.has(k) || set.has(splitKey(k)[0])) out[k] = v;
  }
  return out;
}

/** the full lane drops the search-only keys too, so the two lanes differ by attributes and nothing else */
export const full = (record) => strip(record, new Set(SECTIONS.map((s) => s.name)));

/** attribute count and characters, for the record bar */
export function weigh(records) {
  let keys = 0;
  let chars = 0;
  for (const r of records) {
    for (const k of Object.keys(r)) if (!META.has(k)) keys += 1;
    chars += JSON.stringify(r).length;
  }
  return { keys, chars };
}

/* check-copy: off */
const SYSTEM = [
  "You answer questions about countries using only the CIA World Factbook records given to you.",
  "Each record is one JSON object; its keys are `Section.Field`.",
  "Answer in at most 120 words. Lead with the figures or names the question asks for, with their year when the record gives one.",
  "If the records do not contain the answer, say so in one sentence rather than guessing.",
].join(" ");

/** the chat messages one lane sends: same system, same question, its own records */
export function messages(question, records) {
  const body = records.map((r) => JSON.stringify(r)).join("\n");
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: `Records:\n${body}\n\nQuestion: ${question}` },
  ];
}
/* check-copy: on */

/** −83 for 83% fewer; null when either side is missing; negative savings stay negative */
export function savingPct(fullTokens, filteredTokens) {
  if (!Number.isFinite(fullTokens) || !Number.isFinite(filteredTokens) || fullTokens <= 0) return null;
  return ((filteredTokens - fullTokens) / fullTokens) * 100;
}

/* ── the quality cue ─────────────────────────────────────────────
   Not a correctness check. It lists the figures and proper names the FULL
   answer states and says which of them the FILTERED answer states too. A
   figure in one answer only is the place a reader should look. */

const NUMBER = /[-−]?\$?\d[\d,]*(?:\.\d+)?\s?(?:%|trillion|billion|million)?/g;
const NAME = /\b[A-Z][a-zà-ÿ]+(?:[ -][A-Z][a-zà-ÿ]+)*\b/g;
const SKIP = new Set(["The", "A", "An", "In", "It", "Its", "This", "These", "According", "Both", "However", "Yes", "No",
  "Factbook", "CIA", "World", "Record", "Records", "Economy", "Geography", "Government", "People", "Society",
  "Military", "Security", "Energy", "Environment", "Introduction", "Space", "Communications", "Transportation", "Note"]);

const normNumber = (s) => s.replace(/[−]/g, "-").replace(/[$,\s]/g, "").replace(/\.0+(?=\D|$)/, "").toLowerCase();

/** the checkable facts of an answer: figures (normalized) and capitalized names */
export function facts(text) {
  const t = String(text || "");
  const nums = new Set();
  for (const m of t.match(NUMBER) || []) {
    const n = normNumber(m.trim());
    // a bare year or a lone digit is context, not a fact
    if (/^\d{4}$/.test(n) || /^\d$/.test(n)) continue;
    nums.add(n);
  }
  const names = new Set();
  for (const m of t.match(NAME) || []) if (!SKIP.has(m)) names.add(m);
  return { nums, names };
}

/** the full answer's facts, each marked shared or not by the filtered answer */
export function overlap(fullText, filteredText) {
  const a = facts(fullText);
  const b = facts(filteredText);
  const rows = [
    ...[...a.nums].map((v) => ({ kind: "number", value: v, shared: b.nums.has(v) })),
    ...[...a.names].map((v) => ({ kind: "name", value: v, shared: b.names.has(v) })),
  ];
  return { rows, shared: rows.filter((r) => r.shared).length, total: rows.length };
}

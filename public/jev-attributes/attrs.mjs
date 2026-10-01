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
/**
 * The 13 sections every profile shares. `what` is the one-line description
 * every engine reads; `notFor` and `examples` are the contrast a typed
 * question carries (levers L3), written for the pairs that get confused:
 * Economy, Energy and Transnational Issues; Geography and Environment.
 * The examples are not the demo's scenarios, so a pick is never a lookup.
 */
export const SECTIONS = [
  { id: "introduction", name: "Introduction", what: "historical background of the country",
    notFor: "current figures of any kind", examples: ["How did the country come to be?"] },
  { id: "geography", name: "Geography", what: "location, area, land boundaries and border countries, coastline, terrain, elevation, climate, natural resources, rivers and lakes, natural hazards",
    notFor: "pollution and emissions (Environment); population counts (People and Society)", examples: ["How long is the coastline?", "Which countries share a border with it?"] },
  { id: "people_and_society", name: "People and Society", what: "population, age structure, languages, religions, ethnic groups, life expectancy, birth and death rates, health, education, literacy, urbanization",
    notFor: "jobs and unemployment (Economy); refugees (Transnational Issues)", examples: ["What share of people are over 65?", "Which religions are practiced?"] },
  { id: "environment", name: "Environment", what: "environmental issues, pollution, carbon dioxide and methane emissions, waste and recycling, water resources, climate, land use, environmental agreements",
    notFor: "terrain and borders (Geography); energy production (Energy)", examples: ["What are the main environmental problems?"] },
  { id: "government", name: "Government", what: "country name, government type, capital, constitution, executive, legislative and judicial branches, political parties, suffrage, flag, anthem, independence, national holiday",
    notFor: "the country's history before independence (Introduction); the armed forces (Military and Security)", examples: ["Who is the chief of state?", "What does the flag look like?"] },
  { id: "economy", name: "Economy", what: "GDP and its growth, GDP per capita, inflation, exports and imports with their commodities and partners, industries, agriculture, budget, public debt, unemployment, poverty, exchange rates",
    notFor: "oil, gas, coal and electricity production or use (Energy); drug trade and trafficking (Transnational Issues)", examples: ["How big is the economy?", "Who are its main trading partners?"] },
  { id: "energy", name: "Energy", what: "electricity access, production and sources, crude oil, refined petroleum, natural gas and coal production, reserves, exports and imports, nuclear energy, energy use per person",
    notFor: "GDP, trade totals and commodities in general (Economy); emissions as pollution (Environment)", examples: ["How much natural gas does it produce?"] },
  { id: "communications", name: "Communications", what: "telephones, mobile subscriptions, internet users, broadband, broadcast media, internet country code",
    notFor: "roads, airports and ports (Transportation)", examples: ["How many people use the internet?"] },
  { id: "transportation", name: "Transportation", what: "airports and runways, heliports, railways, ports, merchant marine, aircraft registration prefix",
    notFor: "telephones and internet (Communications)", examples: ["How long is the rail network?"] },
  { id: "military_and_security", name: "Military and Security", what: "military and security forces, military spending, personnel strengths, equipment, service age and obligation, deployments",
    notFor: "terrorist groups (Terrorism); border disputes (Transnational Issues)", examples: ["How large is the army?"] },
  { id: "space", name: "Space", what: "space agency, launch sites, space program and its milestones",
    notFor: "airports and aviation (Transportation)", examples: ["Does it have a space agency?"] },
  { id: "terrorism", name: "Terrorism", what: "terrorist groups active in the country",
    notFor: "the armed forces (Military and Security)", examples: ["Which terrorist groups operate there?"] },
  { id: "transnational_issues", name: "Transnational Issues", what: "refugees and displaced persons, trafficking in persons, illicit drugs, international disputes",
    notFor: "trade and exports (Economy); the armed forces (Military and Security)", examples: ["Does it have border disputes?"] },
];

/**
 * Stage 1, levers L1, L2, L3, L6. The state holds the facts (the question
 * and what each section covers); each question carries only the judgment and
 * points into the state by backtick path. One atomic noul per section, plus
 * one choice for the section that matters most, which is the only answer
 * type that reports a confidence (L7).
 */
export function sectionState(question) {
  return { question, sections: Object.fromEntries(SECTIONS.map((s) => [s.id, `${s.name}: ${s.what}`])) };
}

export function sectionQuestions() {
  const qs = {};
  for (const s of SECTIONS) {
    qs[s.id] = {
      type: "noul",
      instructions: {
        question: `Does answering \`question\` need facts that \`sections.${s.id}\` covers?`,
        note: "A country's name alone needs no section. Several sections may be needed at once.",
      },
      criteria: {
        true: `the question asks for ${s.what}. For example: ${s.examples.join(" ")}`,
        false: `the question asks only for other facts, such as ${s.notFor}`,
      },
    };
  }
  qs.main = {
    type: "choice",
    instructions: { question: "Which one section of `sections` holds the facts `question` asks for first?" },
    criteria: Object.fromEntries(SECTIONS.map((s) => [s.id, { what: s.what, not_for: s.notFor, examples: s.examples }])),
  };
  return qs;
}

/**
 * The same judgment in Laya's budget. Laya reads state and question together
 * per question and keeps about 512 tokens of them (its usage is ~512 per
 * question whatever the state holds), so the shape that suits Jev arrives
 * cut short. Here the state is the question alone and each question names
 * its one section; `main` lists each section's `what` only.
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

/** stage 2: the fields of the kept sections, as `fields.f0`…, one noul each */
export function fieldState(question, fields) {
  return { question, fields: Object.fromEntries(fields.map((f, i) => [`f${i}`, splitKey(f).join(": ")])) };
}

export function fieldQuestions(fields) {
  const qs = {};
  fields.forEach((_, i) => {
    qs[`f${i}`] = {
      type: "noul",
      instructions: { question: `Does answering \`question\` need the value of \`fields.f${i}\`?` },
    };
  });
  return qs;
}

/** Laya's field stage: the state is the question, each question names its field */
export function compactFieldQuestions(fields) {
  const qs = {};
  fields.forEach((f, i) => {
    const [section, field] = splitKey(f);
    qs[`f${i}`] = { type: "noul", instructions: `Does answering \`question\` need the field "${field}" from the ${section} section of a country profile?` };
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
 * A System One answer → every section with its P(yes), in schema order,
 * `picked` at or over the threshold. The `main` choice is always kept, so the
 * LLM never gets an empty record; when it is the only reason a section stays,
 * the row says `byMain`. With no `main` and nothing over the line, the most
 * likely section stays and says `fallback`.
 */
export function pickSections(answers, threshold = THRESHOLD) {
  const a = answers || {};
  const main = a.main && typeof a.main.choice === "string" ? a.main.choice : null;
  const rows = SECTIONS.map((s) => {
    const x = a[s.id];
    const p = x && Number.isFinite(x.noul) ? x.noul : null;
    const over = p !== null && p >= threshold;
    return { name: s.name, id: s.id, p, picked: over || s.id === main, fallback: false, byMain: !over && s.id === main };
  });
  if (!rows.some((r) => r.picked)) {
    const best = rows.filter((r) => r.p !== null).sort((x, y) => y.p - x.p)[0];
    if (best) { best.picked = true; best.fallback = true; }
  }
  return rows;
}

/** the confidence of the `main` choice, null when it did not come back */
export const mainConfidence = (answers) =>
  (answers && answers.main && Number.isFinite(answers.main.confidence) ? answers.main.confidence : null);

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
  // a name counts as shared wherever the other answer says it, capitalized or not
  const said = String(filteredText || "").toLowerCase();
  const rows = [
    ...[...a.nums].map((v) => ({ kind: "number", value: v, shared: b.nums.has(v) })),
    ...[...a.names].map((v) => ({ kind: "name", value: v, shared: said.includes(v.toLowerCase()) })),
  ];
  return { rows, shared: rows.filter((r) => r.shared).length, total: rows.length };
}

/* ───────────────────────────────────────────────────────────────
   attrs.mjs — which parts of a heavy record a question needs.

   Pure: no DOM, no fetch. The page and the study import the same bytes, so
   the questions Jev is asked and the rule that reads its answers are one
   definition, not two that can drift.

   A Factbook record is ~130 flat keys named `Section.Field`. Jev answers one
   yes/no question per section, all in one request; the sections it says yes
   to are kept, everything else is dropped. The page draws each section as
   tall as its characters, so the drop is visible.
   ─────────────────────────────────────────────────────────────── */

/* check-copy: off */
/**
 * The 13 sections every profile shares. `what` is the one-line description
 * Jev reads in the state; `notFor` and `examples` are the contrast a typed
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
/* check-copy: on */

/** keys that are not attributes: they count for no section */
const META = new Set(["objectID", "name", "aliases", "region"]);

export const splitKey = (k) => {
  const i = k.indexOf(".");
  return i < 0 ? [k, ""] : [k.slice(0, i), k.slice(i + 1)];
};

/** P(yes) is at least this: the section is kept */
export const THRESHOLD = 0.5;

/**
 * A System One answer → every section with its P(yes), in schema order,
 * `picked` at or over the threshold. The `main` choice is always kept, so a
 * trimmed record is never empty; when it is the only reason a section stays,
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

/**
 * One record, section by section: its fields and the characters they take
 * as JSON (`"key":value,`). Search-only keys count for no section. A section
 * the record lacks is a row of zeros, so every record has 13 rows.
 */
export function sectionSizes(record) {
  const rows = SECTIONS.map((s) => ({ id: s.id, name: s.name, fields: 0, chars: 0 }));
  const byName = new Map(rows.map((r) => [r.name, r]));
  for (const [k, v] of Object.entries(record || {})) {
    if (META.has(k)) continue;
    const row = byName.get(splitKey(k)[0]);
    if (!row) continue;
    row.fields += 1;
    row.chars += JSON.stringify(k).length + JSON.stringify(v).length + 2;
  }
  return rows;
}

/** the rough rule for English and JSON. A token count from it is an estimate, and says so */
export const CHARS_PER_TOKEN = 4;

/**
 * What a record keeps of itself when only `keptIds` stay: sections, fields,
 * characters and estimated tokens, kept and in total, and the kept share of
 * the characters (null for an empty record).
 */
export function trimTotals(sizes, keptIds) {
  const keep = new Set(keptIds);
  const sum = (rows) => ({
    sections: rows.length,
    fields: rows.reduce((a, r) => a + r.fields, 0),
    chars: rows.reduce((a, r) => a + r.chars, 0),
  });
  const total = sum(sizes);
  const kept = sum(sizes.filter((r) => keep.has(r.id)));
  total.tokens = Math.round(total.chars / CHARS_PER_TOKEN);
  kept.tokens = Math.round(kept.chars / CHARS_PER_TOKEN);
  return { kept, total, share: total.chars > 0 ? kept.chars / total.chars : null };
}

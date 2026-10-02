#!/usr/bin/env node
/* ───────────────────────────────────────────────────────────────
   study.mjs — which engine keeps the sections a question needs?

     node tools/jev-attributes/study.mjs                    # every arm
     node tools/jev-attributes/study.mjs --arms jev-levers,keyword --out /tmp/s.json

   Section stage only, on study-questions.json (synthetic questions about
   public Factbook data, labelled by hand). A question is covered when each of
   its needs has at least one acceptable section kept. Arms:

     jev-plain     the v1 request: the question as a string state, one
                   instruction string per section
     jev-levers    levers L1 L2 L3 L6 L7: object state, backtick paths,
                   contrastive criteria, one noul per section plus a `main` choice
     laya-*        the same two shapes on Laya, plus laya-compact (state is the
                   question only; Laya keeps ~512 tokens per question)
     keyword       BM25 over section descriptions
     llm           the Enablers `small` model, asked for JSON

   Keys: the maintainer's, read as in the proxy (JEV_API_KEY, Vault). Data
   rule: Jev receives the synthetic questions and the section descriptions,
   nothing else. Prints aggregates only; --out writes every row.
   ─────────────────────────────────────────────────────────────── */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { load } from "./keys.mjs";
import { searchLocal } from "./algolia.mjs";
import { SECTIONS, sectionState, sectionQuestions, pickSections, mainConfidence } from "../../public/jev-attributes/attrs.mjs";
import { systemOne } from "../../public/jev-attributes/client.mjs";
import {
  LAYA, directTransport, chatOnce, compactSectionQuestions, keywordSections, pickerSectionMessages, pickerSectionRows,
} from "./arms.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const ARMS = ["jev-plain", "jev-levers", "laya-plain", "laya-levers", "laya-compact", "keyword", "llm"];
const arms = opt("arms", ARMS.join(",")).split(",");
const out = opt("out", null);
const set = JSON.parse(fs.readFileSync(path.join(here, "study-questions.json"), "utf8")).questions;

const keys = {
  jev: load("jev").JEV_API_KEY,
  get enablers() {
    if (!this._e) this._e = execFileSync("vault", ["read", "-field=token", "identity/oidc/token/enablers"]).toString().trim();
    return this._e;
  },
};
const post = directTransport();

/* the v1 request, kept here as the baseline arm */
const FRAME = "The body is a question about one or more countries. It will be answered from CIA World Factbook country profiles.";
const V1_HINT = {
  introduction: "historical background of the country",
  geography: "location, area, land boundaries and border countries, coastline, terrain, elevation, natural resources, rivers",
  people_and_society: "population, age structure, languages, religions, ethnic groups, life expectancy, birth and death rates, health, education, literacy",
  environment: "climate, land use, urbanization, environmental issues, emissions, water resources",
  government: "country name, government type, capital, constitution, executive, legislative and judicial branches, political parties, flag, anthem, independence",
  economy: "GDP, GDP growth, GDP per capita, inflation, exports and imports with commodities and partners, industries, budget, debt, unemployment, exchange rates",
  energy: "electricity, oil, natural gas, coal, nuclear energy, energy consumption",
  communications: "telephones, internet users, broadband, broadcast media",
  transportation: "airports, railways, ports, merchant marine",
  military_and_security: "military and security forces, military expenditures, personnel strengths, equipment, service age, deployments",
  space: "space agency, launch sites, space program",
  terrorism: "terrorist groups active in the country",
  transnational_issues: "refugees, trafficking in persons, illicit drugs, international disputes",
};
function plainRequest(question) {
  const qs = {};
  for (const s of SECTIONS) {
    qs[s.id] = { type: "noul", instructions: `${FRAME} Does answering it need the "${s.name}" section of the profile (${V1_HINT[s.id]})?` };
  }
  return { state: { body: question }, questions: qs };
}

async function arm(name, item) {
  const [kind, shape] = name.split("-");
  if (kind === "jev" || kind === "laya") {
    const req = shape === "plain" ? plainRequest(item.q)
      : shape === "compact" ? { state: { question: item.q }, questions: compactSectionQuestions() }
        : { state: sectionState(item.q), questions: sectionQuestions() };
    const r = await systemOne(post, kind === "laya" ? LAYA : "jev", req.state, req.questions, { keys });
    const rows = pickSections(r.answers);
    return { kept: rows.filter((x) => x.picked).map((x) => x.name), ms: r.ms, inputTokens: r.usage.inputTokens,
      confidence: mainConfidence(r.answers), main: r.answers.main ? r.answers.main.choice : null,
      p: Object.fromEntries(rows.map((x) => [x.id, x.p])) };
  }
  if (kind === "keyword") {
    const t0 = performance.now();
    const rows = keywordSections(item.q, searchLocal(item.q));
    return { kept: rows.filter((x) => x.picked).map((x) => x.name), ms: performance.now() - t0, fallback: rows[0].fallback };
  }
  if (kind === "llm") {
    const r = await chatOnce(post, pickerSectionMessages(item.q), { keys });
    const rows = pickerSectionRows(r.text);
    return { kept: rows.filter((x) => x.picked).map((x) => x.name), ms: r.ms, inputTokens: r.usage && r.usage.inputTokens,
      outputTokens: r.usage && r.usage.outputTokens, fallback: rows[0].fallback, model: r.model };
  }
  throw new Error(`unknown arm ${name}`);
}

const covered = (needs, kept) => needs.every((alts) => alts.some((s) => kept.includes(s)));

/* ── stats: bootstrap (10k, seeded), exact McNemar ─────────────── */

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
function bootMean(xs, n = 10000, seed = 20261001) {
  const r = rng(seed);
  const means = [];
  for (let b = 0; b < n; b++) {
    let s = 0;
    for (let i = 0; i < xs.length; i++) s += xs[Math.floor(r() * xs.length)];
    means.push(s / xs.length);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(0.025 * n)], means[Math.floor(0.975 * n)]];
}
function mcnemar(a, b) {
  let x = 0; let y = 0;
  a.forEach((v, i) => { if (v && !b[i]) x++; if (!v && b[i]) y++; });
  const n = x + y; const k = Math.min(x, y);
  let p = 0;
  for (let i = 0; i <= k; i++) p += comb(n, i) / 2 ** n;
  return { aOnly: x, bOnly: y, p: Math.min(1, 2 * p) };
}
function comb(n, k) { let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return r; }
const pct = (q, xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

/* ── run ──────────────────────────────────────────────────────── */

const results = {};
for (const name of arms) {
  const rows = [];
  const pool = name.startsWith("laya") ? 1 : 4; // Laya is CPU-served: one at a time
  let next = 0;
  await Promise.all(Array.from({ length: pool }, async () => {
    while (next < set.length) {
      const i = next++;
      const item = set[i];
      try {
        const r = await arm(name, item);
        rows[i] = { q: item.q, needs: item.needs, ...r, covered: covered(item.needs, r.kept) };
      } catch (err) {
        rows[i] = { q: item.q, needs: item.needs, error: err.message, kept: [], covered: false };
      }
    }
  }));
  results[name] = rows;
  const cov = rows.map((r) => (r.covered ? 1 : 0));
  const kept = rows.map((r) => r.kept.length);
  const ms = rows.filter((r) => !r.error).map((r) => r.ms);
  const errs = rows.filter((r) => r.error).length;
  const tok = rows.filter((r) => Number.isFinite(r.inputTokens)).map((r) => r.inputTokens);
  const [lo, hi] = bootMean(cov);
  const [klo, khi] = bootMean(kept);
  console.log(`${name.padEnd(13)} covered ${(100 * cov.reduce((a, b) => a + b, 0) / cov.length).toFixed(1)}% [${(100 * lo).toFixed(1)}, ${(100 * hi).toFixed(1)}]`
    + `  kept ${(kept.reduce((a, b) => a + b, 0) / kept.length).toFixed(2)} [${klo.toFixed(2)}, ${khi.toFixed(2)}]`
    + `  p50 ${Math.round(pct(0.5, ms))} ms p95 ${Math.round(pct(0.95, ms))} ms`
    + (tok.length ? `  in-tokens p50 ${pct(0.5, tok)}` : "") + `  errors ${errs}  n ${rows.length}`);
}

const pairs = [["jev-levers", "jev-plain"], ["laya-levers", "laya-plain"], ["laya-compact", "laya-plain"], ["jev-levers", "keyword"], ["jev-levers", "llm"], ["jev-levers", "laya-compact"]];
for (const [a, b] of pairs) {
  if (!results[a] || !results[b]) continue;
  const ca = results[a].map((r) => (r.covered ? 1 : 0));
  const cb = results[b].map((r) => (r.covered ? 1 : 0));
  const diff = ca.map((v, i) => v - cb[i]);
  const [lo, hi] = bootMean(diff);
  const m = mcnemar(ca, cb);
  const kd = results[a].map((r, i) => r.kept.length - results[b][i].kept.length);
  const [klo, khi] = bootMean(kd);
  console.log(`${a} − ${b}: covered ${(100 * diff.reduce((x, y) => x + y, 0) / diff.length).toFixed(1)} pp [${(100 * lo).toFixed(1)}, ${(100 * hi).toFixed(1)}]`
    + ` McNemar ${m.aOnly}/${m.bOnly} p=${m.p.toFixed(3)}; kept ${(kd.reduce((x, y) => x + y, 0) / kd.length).toFixed(2)} [${klo.toFixed(2)}, ${khi.toFixed(2)}]`);
}

if (out) fs.writeFileSync(out, JSON.stringify({ when: new Date().toISOString(), arms: results }, null, 1));

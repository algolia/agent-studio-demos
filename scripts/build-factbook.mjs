#!/usr/bin/env node
/* ───────────────────────────────────────────────────────────────
   build-factbook.mjs — the CIA World Factbook, one flat record per country.

   Input: a checkout of github.com/factbook/factbook.json (CC0, US-government
   public domain text). Output: factbook.jsonl, one record per entity:

     { objectID: "gm", name: "Germany", region: "europe",
       "Economy.Real GDP growth rate": "2024: -0.2% (2024 est.); …", … }

   Every profile shares one schema of 13 sections, so a section name is a
   prefix every record has, and stripping a record to the sections a question
   needs is a key filter, nothing cleverer.

   A field's sub-entries are joined into one string ("total: 357,022 sq km;
   land: …"), HTML is stripped, and any field longer than MAX_FIELD_CHARS is cut
   with an ellipsis. The summary says how many fields were cut, so the trim is
   a reported number, not a silent one. Oceans and the World entry are left
   out: they do not follow the country schema.

     git clone --depth 1 https://github.com/factbook/factbook.json.git /tmp/fb
     node scripts/build-factbook.mjs /tmp/fb          # writes factbook.jsonl

   factbook.jsonl is gitignored: it is derived, and a fresh clone rebuilds it.
   ─────────────────────────────────────────────────────────────── */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "factbook.jsonl");

/** a single field longer than this is cut; most fields are a line */
export const MAX_FIELD_CHARS = 1500;
/** Algolia's record ceiling on this plan is 100 KB; stay well under it */
export const MAX_RECORD_BYTES = 90 * 1024;
const SKIP_DIRS = new Set(["oceans", "world", "meta"]);

const ENTITIES = {
  "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'",
  "&rsquo;": "\u2019", "&lsquo;": "\u2018", "&ldquo;": "\u201c", "&rdquo;": "\u201d",
  "&ndash;": "\u2013", "&mdash;": "\u2014", "&oslash;": "\u00f8", "&Oslash;": "\u00d8", "&szlig;": "\u00df",
};
/** &eacute; and its kin: the letter plus a combining mark, recomposed by NFC */
const MARKS = { acute: "\u0301", grave: "\u0300", circ: "\u0302", tilde: "\u0303", uml: "\u0308",
  ring: "\u030a", cedil: "\u0327", caron: "\u030c" };

/** HTML out, entities decoded, whitespace collapsed */
export function clean(s) {
  return String(s)
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/p>\s*<p>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&([A-Za-z])(acute|grave|circ|tilde|uml|ring|cedil|caron);/g, (_, c, m) => c + MARKS[m])
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&[a-z0-9]+;/gi, (m) => ENTITIES[m] ?? m)
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim();
}

/** one Factbook field, however deep, as one line of text */
export function flatten(value, parent = "") {
  if (value === null || value === undefined) return "";
  if (typeof value !== "object") return clean(value);
  const parts = [];
  for (const [k, v] of Object.entries(value)) {
    const key = k.trim();
    if (key === "text") { parts.push(clean(v)); continue; }
    if (key === "note") { parts.push(clean(v).replace(/^note:\s*/i, "note: ")); continue; }
    // "Real GDP growth rate 2024" under "Real GDP growth rate" reads as "2024"
    const label = parent && key.startsWith(parent) ? key.slice(parent.length).trim() || key : key;
    const inner = flatten(v, key);
    if (inner) parts.push(`${label}: ${inner}`);
  }
  return parts.filter(Boolean).join("; ");
}

function nameOf(profile, code) {
  const cn = (profile.Government && profile.Government["Country name"]) || {};
  for (const k of ["conventional short form", "local short form", "conventional long form", "local long form"]) {
    const t = cn[k] && clean(cn[k].text || "");
    if (t && t.toLowerCase() !== "none") return t;
  }
  return code.toUpperCase();
}

/** every name form the profile gives, minus etymology and notes: what a search may match */
function aliasesOf(profile, name) {
  const cn = (profile.Government && profile.Government["Country name"]) || {};
  const forms = ["conventional short form", "conventional long form", "local short form", "local long form", "abbreviation", "former"]
    .map((k) => cn[k] && clean(cn[k].text || "")).filter((t) => t && t.toLowerCase() !== "none" && t !== name);
  return [...new Set(forms)];
}

/** one profile → one flat record, plus what had to be cut */
export function toRecord(profile, code, region) {
  const name = nameOf(profile, code);
  const rec = { objectID: code, name, aliases: aliasesOf(profile, name), region };
  const trimmed = [];
  for (const [section, fields] of Object.entries(profile)) {
    if (!fields || typeof fields !== "object") continue;
    for (const [field, value] of Object.entries(fields)) {
      let text = flatten(value, field.trim());
      if (!text) continue;
      if (text.length > MAX_FIELD_CHARS) {
        trimmed.push(`${section}.${field.trim()}`);
        text = `${text.slice(0, MAX_FIELD_CHARS - 1).trimEnd()}…`;
      }
      rec[`${section}.${field.trim()}`] = text;
    }
  }
  return { rec, trimmed };
}

function main() {
  const src = process.argv[2];
  if (!src || !fs.existsSync(src)) {
    console.error("usage: node scripts/build-factbook.mjs <factbook.json checkout>");
    process.exit(2);
  }
  const out = [];
  const cut = new Map();
  let biggest = { bytes: 0, name: "" };
  for (const region of fs.readdirSync(src).sort()) {
    const dir = path.join(src, region);
    if (SKIP_DIRS.has(region) || !fs.statSync(dir).isDirectory() || region.startsWith(".")) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
      const profile = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      const { rec, trimmed } = toRecord(profile, f.replace(/\.json$/, ""), region);
      for (const t of trimmed) cut.set(t.split(".")[0], (cut.get(t.split(".")[0]) || 0) + 1);
      const bytes = Buffer.byteLength(JSON.stringify(rec));
      if (bytes > MAX_RECORD_BYTES) throw new Error(`${rec.name}: ${bytes} bytes, over ${MAX_RECORD_BYTES}`);
      if (bytes > biggest.bytes) biggest = { bytes, name: rec.name };
      out.push(rec);
    }
  }
  fs.writeFileSync(OUT, out.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const keys = out.reduce((n, r) => n + Object.keys(r).length - 4, 0);
  const total = out.reduce((n, r) => n + Buffer.byteLength(JSON.stringify(r)), 0);
  console.log(`${out.length} records, ${keys} fields, ${(total / 1e6).toFixed(1)} MB → ${path.relative(ROOT, OUT)}`);
  console.log(`biggest: ${biggest.name}, ${(biggest.bytes / 1024).toFixed(1)} KB`);
  const cutTotal = [...cut.values()].reduce((a, b) => a + b, 0);
  console.log(`fields cut at ${MAX_FIELD_CHARS} chars: ${cutTotal}` +
    (cutTotal ? ` (${[...cut].sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s} ${n}`).join(", ")})` : ""));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

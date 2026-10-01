/* ───────────────────────────────────────────────────────────────
   keys.mjs — read named variables out of an env file, print none of them.

   The demo's three credentials live in two files the maintainer owns, outside
   this repo. Only the names asked for are read; the rest of each file is never
   held in memory. Callers get values, logs get names.
   ─────────────────────────────────────────────────────────────── */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = (p) => p.replace(/^~(?=\/)/, os.homedir());

/** where each credential comes from, overridable per variable */
export const SOURCES = {
  algolia: { file: process.env.FACTBOOK_KEYS_FILE || "~/.local/state/prefetch.env", names: ["ESCI_APP", "ESCI_WRITE", "ESCI_READ"] },
  jev: { file: process.env.JEV_KEYS_FILE || "~/Work/Conversational/agentic-evals/.env", names: ["JEV_API_KEY"] },
};

/** { NAME: value } for the names found; a missing file or name is just absent */
export function readVars(file, names) {
  const want = new Set(names);
  const out = {};
  const p = path.resolve(home(file));
  if (!fs.existsSync(p)) return out;
  for (const raw of fs.readFileSync(p, "utf8").split("\n")) {
    const m = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m || !want.has(m[1])) continue;
    let v = m[2].trim();
    if (v.length >= 2 && /^(".*"|'.*')$/.test(v)) v = v.slice(1, -1);
    if (v) out[m[1]] = v;
  }
  return out;
}

/** the environment wins over the file, as a one-off export should */
export function load(source) {
  const { file, names } = SOURCES[source];
  const fromFile = readVars(file, names);
  const out = {};
  for (const n of names) out[n] = process.env[n] || fromFile[n] || null;
  return out;
}

/** "ESCI_APP ✓, ESCI_WRITE ✗" — proof of reading, no value in it */
export function describe(vars) {
  return Object.entries(vars).map(([k, v]) => `${k} ${v ? "set" : "missing"}`).join(", ");
}

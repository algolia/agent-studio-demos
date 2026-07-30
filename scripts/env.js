/* ───────────────────────────────────────────────────────────────
   env.js — load scripts/../.env into process.env, if it is there.

   Six lines of parsing instead of a dependency, in a repo whose whole premise is
   that it has no package.json. It handles what a .env in this project actually
   contains: KEY=value, comments, blank lines, and quotes around a value.

   Deliberately does NOT overwrite an existing environment variable. A value
   exported in the shell for one command should win over a file — that is the
   whole reason someone exports it.

   Nothing here is ever printed. The loader returns the NAMES it set, never the
   values, so a script can say "read 2 variables from .env" without a key ever
   reaching a terminal, a log, or a transcript.
   ─────────────────────────────────────────────────────────────── */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ENV_PATH = path.join(__dirname, "..", ".env");

/**
 * Load .env into process.env. Returns { path, loaded, names } — `names` are the
 * variables this call actually set, for a message that proves the file was read
 * without disclosing what it held.
 */
function loadEnv(file = ENV_PATH) {
  if (!fs.existsSync(file)) return { path: file, loaded: false, names: [] };
  const names = [];
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (process.env[key] !== undefined && process.env[key] !== "") continue;
    let value = line.slice(eq + 1).trim();
    // a quoted value keeps its inner spaces and loses only the quotes
    if (value.length >= 2 && /^(".*"|'.*')$/.test(value)) value = value.slice(1, -1);
    if (!value) continue;
    process.env[key] = value;
    names.push(key);
  }
  return { path: file, loaded: true, names };
}

/**
 * One line saying where credentials came from, with no credential in it. Prints
 * nothing when there was no file and nothing to say.
 */
function describeEnv(result) {
  if (!result.loaded) return null;
  if (!result.names.length) return "read .env — every variable in it was already set in the environment";
  return `read ${result.names.length} variable${result.names.length === 1 ? "" : "s"} ` +
    `from .env (${result.names.join(", ")}) — values are never printed`;
}

module.exports = { loadEnv, describeEnv, ENV_PATH };

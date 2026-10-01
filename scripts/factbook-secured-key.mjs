#!/usr/bin/env node
/* ───────────────────────────────────────────────────────────────
   factbook-secured-key.mjs — the search key the public page may hold.

     node scripts/factbook-secured-key.mjs                       # → public/shared/config.js
     node scripts/factbook-secured-key.mjs --config path/to/config.js

   A secured API key is derived, not created: an HMAC-SHA256 of a few query
   parameters, keyed with a parent key, base64'd with the parameters. No API
   call makes it and the parent never leaves this machine. Algolia enforces
   the parameters on every search made with it:

     restrictIndices   the Factbook index names, and nothing else
     analytics=false   no search analytics, whatever the page sends
     clickAnalytics=false

   The parent is ESCI_READ (search-only, from ~/.local/state/prefetch.env).
   The script checks the key on one search of the Factbook index and on one
   index outside it (which must be refused), then appends a `jevAttributes`
   block to the gitignored config, or creates the file with only that block.
   It refuses to write twice: delete the old block by hand to re-derive.
   Prints statuses only, never a key.
   ─────────────────────────────────────────────────────────────── */

import fs from "node:fs";
import path from "node:path";
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { load, describe } from "../tools/jev-attributes/keys.mjs";
import { INDEX_NAMES } from "../public/jev-attributes/search.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const at = args.indexOf("--config");
const configPath = at >= 0 ? path.resolve(args[at + 1]) : path.join(root, "public", "shared", "config.js");

/** the parameters, serialized the way the v5 clients do: arrays comma-joined */
export function securedParams(indexes = INDEX_NAMES) {
  return new URLSearchParams({ restrictIndices: indexes.join(","), analytics: "false", clickAnalytics: "false" }).toString();
}

/** base64(hex(HMAC-SHA256(parent, params)) + params) */
export function securedKey(parent, params) {
  const mac = createHmac("sha256", parent).update(params).digest("hex");
  return Buffer.from(mac + params).toString("base64");
}

async function status(app, key, index) {
  const res = await fetch(`https://${app}-dsn.algolia.net/1/indexes/${encodeURIComponent(index)}/query`, {
    method: "POST",
    headers: { "X-Algolia-Application-Id": app, "X-Algolia-API-Key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ query: "Peru", hitsPerPage: 1, attributesToRetrieve: ["name"] }),
    signal: AbortSignal.timeout(10000),
  });
  return res.status;
}

async function main() {
  const vars = load("algolia");
  if (!vars.ESCI_APP || !vars.ESCI_READ) throw new Error(`need ESCI_APP and ESCI_READ (${describe(vars)})`);
  const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : null;
  if (existing && /\bjevAttributes\b/.test(existing)) {
    console.log(`${path.relative(root, configPath)} already has a jevAttributes block: nothing written.`);
    return;
  }

  const key = securedKey(vars.ESCI_READ, securedParams());
  const statuses = {};
  for (const index of [...INDEX_NAMES, "esci_demo_not_the_factbook"]) statuses[index] = await status(vars.ESCI_APP, key, index);
  console.log("search with the secured key:", Object.entries(statuses).map(([k, v]) => `${k} ${v}`).join(", "));
  const allowed = INDEX_NAMES.some((i) => statuses[i] === 200);
  if (!allowed) throw new Error("no Factbook index answered 200: not writing a key that cannot search");
  if (statuses.esci_demo_not_the_factbook !== 403) throw new Error("an index outside restrictIndices was not refused: not writing");

  const block = [
    "",
    "// Jev picks the attributes, public mode: a SECURED key, derived by",
    "// scripts/factbook-secured-key.mjs from a search-only parent. It can search",
    `// ${INDEX_NAMES.join(" and ")} only, with analytics off.`,
    "(window.DEMO_CONFIG = window.DEMO_CONFIG || {}).jevAttributes = {",
    `  appId: ${JSON.stringify(vars.ESCI_APP)},`,
    `  searchKey: ${JSON.stringify(key)},`,
    `  indexes: ${JSON.stringify(INDEX_NAMES)},`,
    "};",
    "",
  ].join("\n");
  if (existing === null) fs.writeFileSync(configPath, block.trimStart(), { mode: 0o600 });
  else fs.appendFileSync(configPath, block);
  console.log(`${existing === null ? "created" : "appended to"} ${path.relative(root, configPath)} (gitignored)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}

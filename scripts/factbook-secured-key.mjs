#!/usr/bin/env node
/* ───────────────────────────────────────────────────────────────
   factbook-secured-key.mjs — the search key the public page may hold.

     node scripts/factbook-secured-key.mjs                       # → public/shared/config.js
     node scripts/factbook-secured-key.mjs --days 30             # expires sooner (default 90)
     node scripts/factbook-secured-key.mjs --config path/to/config.js

   A secured API key is derived, not created: an HMAC-SHA256 of a few query
   parameters, keyed with a parent key, base64'd with the parameters. No API
   call makes it and the parent never leaves this machine. Algolia enforces
   the parameters on every search made with it:

     restrictIndices   the Factbook index names, and nothing else
     analytics=false   no search analytics, whatever the page sends
     clickAnalytics=false
     validUntil        a Unix time, --days from now (default 90): after it,
                       Algolia refuses the key and a new one must be derived

   The parent is ESCI_READ (from ~/.local/state/prefetch.env). Before deriving
   anything the script reads the parent's own ACL (GET /1/keys/<parent>, with
   the parent as its credential) and refuses unless it is search-only: a
   secured key inherits every right of its parent. It then checks the key on
   one search of the Factbook index and on one index outside it (which must be
   refused), and appends a `jevAttributes` block to the gitignored config, or
   creates the file with only that block. It refuses to write twice: delete
   the old block by hand to re-derive. Prints statuses and the expiry date
   only, never a key.
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
const dayAt = args.indexOf("--days");
const DAYS = dayAt >= 0 ? Number(args[dayAt + 1]) : 90;

/** the parameters, serialized the way the v5 clients do: arrays comma-joined */
export function securedParams({ indexes = INDEX_NAMES, validUntil } = {}) {
  const p = { restrictIndices: indexes.join(","), analytics: "false", clickAnalytics: "false" };
  if (validUntil !== undefined) p.validUntil = String(validUntil);
  return new URLSearchParams(p).toString();
}

/** Unix seconds, `days` from `now` (ms) */
export function validUntilIn(days, now = Date.now()) {
  if (!Number.isFinite(days) || days <= 0 || days > 365) throw new Error("--days must be between 1 and 365");
  return Math.floor(now / 1000) + Math.round(days * 86400);
}

/** a parent may only hand down search: any other right would ride along in the secured key */
export function searchOnly(acl) {
  return Array.isArray(acl) && acl.length > 0 && acl.every((a) => a === "search");
}

/** the parent's ACL, read with the parent itself; the response also holds the key, so only `acl` is kept */
async function parentAcl(app, parent) {
  const res = await fetch(`https://${app}.algolia.net/1/keys/${encodeURIComponent(parent)}`, {
    headers: { "X-Algolia-Application-Id": app, "X-Algolia-API-Key": parent },
    signal: AbortSignal.timeout(10000),
  }).catch(() => null);
  if (!res) throw new Error("could not reach Algolia to read the parent key's ACL: not deriving");
  if (res.status !== 200) throw new Error(`reading the parent key's ACL answered HTTP ${res.status}: not deriving`);
  const { acl } = await res.json();
  return acl;
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
    const exp = existing.match(/secured key expires (\S+)/);
    console.log(`${path.relative(root, configPath)} already has a jevAttributes block${exp ? ` (expires ${exp[1]})` : ""}: nothing written.`);
    return;
  }

  const acl = await parentAcl(vars.ESCI_APP, vars.ESCI_READ);
  if (!searchOnly(acl)) throw new Error(`the parent key's ACL is ${JSON.stringify(acl)}, not search-only: not deriving`);
  console.log("parent key ACL: search only");

  const validUntil = validUntilIn(DAYS);
  const expires = new Date(validUntil * 1000).toISOString();
  const key = securedKey(vars.ESCI_READ, securedParams({ validUntil }));
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
    `// The secured key expires ${expires}: re-derive before then (README, "a secured key").`,
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
  console.log(`the secured key expires ${expires} (${DAYS} days)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}

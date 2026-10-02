#!/usr/bin/env node
/* ───────────────────────────────────────────────────────────────
   index-factbook.mjs — push factbook.jsonl to the demo index.

     node scripts/index-factbook.mjs          # dry run: counts, calls nothing
     node scripts/index-factbook.mjs --push   # settings, then records
     node scripts/index-factbook.mjs --push --settings-only   # settings, no record sent

   Tries `demo_factbook` first and falls back to `esci_demo_factbook` when the
   key is refused (the keys on this app are scoped to esci_*). Prints which
   name took the records. Keys come from tools/jev-attributes/keys.mjs and are
   never printed.
   ─────────────────────────────────────────────────────────────── */

import fs from "node:fs";
import { INDEX_NAMES, RECORDS_FILE, setSettings, batch, waitTask } from "../tools/jev-attributes/algolia.mjs";
import { load, describe } from "../tools/jev-attributes/keys.mjs";

const PUSH = process.argv.includes("--push");
const SETTINGS_ONLY = process.argv.includes("--settings-only");
const CHUNK = 40;

const records = fs.readFileSync(RECORDS_FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const bytes = records.reduce((n, r) => n + Buffer.byteLength(JSON.stringify(r)), 0);
console.log(`${records.length} records, ${(bytes / 1e6).toFixed(1)} MB`);

const keys = load("algolia");
console.log(`keys: ${describe(keys)}`);
if (!PUSH) {
  console.log(`dry run: would try ${INDEX_NAMES.join(", then ")}. Pass --push to write.`);
  process.exit(0);
}

const app = keys.ESCI_APP;
const key = keys.ESCI_WRITE;
let index = null;
for (const name of INDEX_NAMES) {
  const r = await setSettings(app, key, name);
  if (r.status === 200) { index = name; await waitTask(app, key, name, r.json.taskID); break; }
  console.log(`${name}: HTTP ${r.status} — ${r.message}`);
}
if (!index) {
  console.log("no index accepted the key: the server will search factbook.jsonl locally");
  process.exit(1);
}
console.log(`settings applied to ${index}`);
if (SETTINGS_ONLY) {
  console.log("--settings-only: no record sent");
  process.exit(0);
}
let last = null;
for (let i = 0; i < records.length; i += CHUNK) {
  const r = await batch(app, key, index, records.slice(i, i + CHUNK));
  if (r.status !== 200) throw new Error(`batch at ${i}: HTTP ${r.status} — ${r.message}`);
  last = r.json.taskID;
}
await waitTask(app, key, index, last);
console.log(`${records.length} records in ${index}`);

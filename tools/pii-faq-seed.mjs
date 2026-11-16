#!/usr/bin/env node
/* ───────────────────────────────────────────────────────────────
   pii-faq-seed.mjs: the bank_faq index the pii demo's agent searches.

     APP_ID=… INDEX_KEY=… node tools/pii-faq-seed.mjs [--dry-run] [--host URL]

   Writes public/pii/data/bank_faq.json (EN + FR) to the index bank_faq, with
   a marker record (_demo-marker), and sets its search settings. Run again,
   it replaces the records and settings of the bank_faq it wrote before.

   The fence: this script writes one index, bank_faq, and nothing else; every
   other route is refused before the network. An existing bank_faq without
   the marker is someone else's: the script refuses to touch it.

   --dry-run reads the index state and says what it would write; no write.
   --host overrides the write host, https://APP_ID.algolia.net. The search
   API is per app, not per region, so there is no --region.

   Environment, never printed: APP_ID, INDEX_KEY (a key with addObject,
   deleteIndex and editSettings on bank_faq; never the admin key).
   Node 20+, no dependencies.
   ─────────────────────────────────────────────────────────────── */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FAQ_FILE = path.join(HERE, "..", "public", "pii", "data", "bank_faq.json");
export const INDEX = "bank_faq";
export const MARKER_ID = "_demo-marker";

/** the marker: no searchable text, a category the agent's tool filters out */
export const MARKER = Object.freeze({
  objectID: MARKER_ID, question: "", answer: "", category: "_marker", lang: "", tags: [],
  seededBy: "agent-studio-demos tools/pii-faq-seed.mjs",
});

/** FAQ ranking: words in the question beat tags beat the answer, wherever they sit */
export const SETTINGS = Object.freeze({
  searchableAttributes: ["unordered(question)", "unordered(tags)", "unordered(answer)"],
  attributesForFaceting: ["lang", "category"],
  indexLanguages: ["en", "fr"],
  queryLanguages: ["en", "fr"],
  ignorePlurals: true,
  removeStopWords: true,
  typoTolerance: "min",
  ranking: ["typo", "words", "proximity", "attribute", "exact", "custom"],
});

const FIELDS = ["objectID", "question", "answer", "category", "lang", "tags"];

/** why the records cannot be seeded; empty when they can */
export function validateRecords(records) {
  const out = [];
  if (!Array.isArray(records) || !records.length) return ["no records"];
  const ids = new Set();
  for (const r of records) {
    const missing = FIELDS.filter((f) => !(f in (r || {})));
    if (missing.length) out.push(`${r && r.objectID}: missing ${missing.join(", ")}`);
    if (r && r.objectID === MARKER_ID) out.push(`${MARKER_ID} is the script's own record`);
    if (r && ids.has(r.objectID)) out.push(`${r.objectID} twice`);
    if (r) ids.add(r.objectID);
  }
  return out;
}

/** a Search API client on fetch; errors carry the status, never a body that may echo the key */
export function client({ host, appId, key, fetchImpl = fetch }) {
  const headers = { "content-type": "application/json", "x-algolia-application-id": appId, "x-algolia-api-key": key };
  return async function call(method, p, body) {
    const res = await fetchImpl(host + p, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`${method} ${p.split("?")[0]} → ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return text ? JSON.parse(text) : null;
  };
}

/** every call goes through here: only /1/indexes/bank_faq and its sub-routes */
export function indexFence(call, index = INDEX) {
  if (index !== INDEX) throw new Error(`refused: this script writes ${INDEX} only, not ${index}`);
  const base = `/1/indexes/${INDEX}`;
  return (method, p, body) => {
    const route = p.split("?")[0];
    if (route !== base && !route.startsWith(`${base}/`)) return Promise.reject(new Error(`refused: ${method} ${route} is not ${base}`));
    return call(method, p, body);
  };
}

const absent = (e) => e && e.status === 404;

/** "absent" (no index), "ours" (it holds the marker) or "foreign" */
export async function indexState(call) {
  try {
    await call("GET", `/1/indexes/${INDEX}/settings`);
  } catch (e) {
    if (absent(e)) return "absent";
    throw e;
  }
  try {
    const m = await call("GET", `/1/indexes/${INDEX}/${encodeURIComponent(MARKER_ID)}`);
    return m && m.objectID === MARKER_ID ? "ours" : "foreign";
  } catch (e) {
    if (absent(e)) return "foreign";
    throw e;
  }
}

/** wait for a task to publish, a bounded number of polls */
async function waitTask(call, res, sleep, tries = 60) {
  const id = res && res.taskID;
  if (id === undefined) return;
  for (let i = 0; i < tries; i++) {
    const t = await call("GET", `/1/indexes/${INDEX}/task/${id}`);
    if (t && t.status === "published") return;
    await sleep(500);
  }
  throw new Error(`task ${id} not published after ${tries} polls`);
}

/** the run against an injected call; returns what it did */
export async function run({ args, call: rawCall, records, log, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const why = validateRecords(records);
  if (why.length) throw new Error(`refused before any write: ${why.join("; ")}`);
  const call = indexFence(rawCall, args.index || INDEX);
  const state = await indexState(call);
  const counts = `${records.length} records (${records.filter((r) => r.lang === "en").length} en, ${records.filter((r) => r.lang === "fr").length} fr) + marker`;
  if (state === "foreign") throw new Error(`refused: ${INDEX} exists and has no ${MARKER_ID} record; it is not this demo's`);
  if (args.dryRun) {
    log(`would ${state === "ours" ? "replace" : "create"} ${INDEX}: ${counts}, settings ${Object.keys(SETTINGS).join(", ")}`);
    return { state, wrote: false };
  }
  if (state === "ours") await waitTask(call, await call("POST", `/1/indexes/${INDEX}/clear`), sleep);
  await waitTask(call, await call("PUT", `/1/indexes/${INDEX}/settings`, SETTINGS), sleep);
  const requests = [...records, MARKER].map((body) => ({ action: "addObject", body }));
  await waitTask(call, await call("POST", `/1/indexes/${INDEX}/batch`, { requests }), sleep);
  log(`${state === "ours" ? "replaced" : "created"} ${INDEX}: ${counts}`);
  return { state, wrote: true };
}

export function parseArgs(argv) {
  const out = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--host") out.host = argv[++i];
    else if (a === "--index") out.index = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  if (out.index && out.index !== INDEX) throw new Error(`refused: this script writes ${INDEX} only, not ${out.index}`);
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const log = (...a) => console.error(...a);
  const appId = process.env.APP_ID || "";
  const key = process.env.INDEX_KEY || "";
  if (!appId || !key) throw new Error("set APP_ID and INDEX_KEY in the environment");
  const host = args.host || `https://${appId}.algolia.net`;
  log(`app ${appId.slice(0, 3)}… · writes only ${INDEX}${args.dryRun ? " · dry run" : ""}`);
  const records = JSON.parse(await readFile(FAQ_FILE, "utf8"));
  await run({ args, call: client({ host, appId, key }), records, log });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((err) => {
  console.error(`pii-faq-seed: ${err.message}`);
  process.exitCode = 1;
});

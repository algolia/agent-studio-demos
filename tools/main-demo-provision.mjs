#!/usr/bin/env node
/* ───────────────────────────────────────────────────────────────
   main-demo-provision.mjs — one agent per toggle set, created once.

     MAIN_DEMO_HOST=http://127.0.0.1:8000 APP_ID=… ADMIN_KEY=… \
       node tools/main-demo-provision.mjs [--add 'prefetch=user_fold,memory=1,…'] [--dry-run]

   Reads the variant manifest from public/main-demo/configs.mjs (the same
   module the page uses), lists the agents on HOST, and for each variant:

     - an agent with the variant's name exists → adopt it, untouched;
     - none does → copy main-demo-base (model, provider, tools, prompt),
       layer the variant's config on top, create it and publish it.

   Then writes public/main-demo/variants.json (gitignored): config key →
   agent id. Idempotent: a second run creates nothing.

   Environment, never printed: MAIN_DEMO_HOST (or HOST when it is a URL —
   zsh sets HOST to the machine name), APP_ID, ADMIN_KEY.
   Node 20+, no dependencies.
   ─────────────────────────────────────────────────────────────── */

import { readFile, writeFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  MANIFEST, configKey, parseKey, agentName, agentConfigPatch, togglesFromAgentConfig,
} from "../public/main-demo/configs.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = path.join(HERE, "..", "public", "main-demo", "variants.json");
const BASE_NAME = "main-demo-base";

function parseArgs(argv) {
  const out = { add: [], dryRun: false, out: DEFAULT_OUT, base: BASE_NAME };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--add") out.add.push(argv[++i]);
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--out") out.out = path.resolve(argv[++i]);
    else if (a === "--base") out.base = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

function env() {
  const hostVar = process.env.MAIN_DEMO_HOST || (/^https?:\/\//.test(process.env.HOST || "") ? process.env.HOST : "");
  const host = (hostVar || "http://127.0.0.1:8000").replace(/\/+$/, "");
  const appId = process.env.APP_ID || "";
  const key = process.env.ADMIN_KEY || "";
  const missing = [!appId && "APP_ID", !key && "ADMIN_KEY"].filter(Boolean);
  if (missing.length) throw new Error(`set ${missing.join(" and ")} in the environment`);
  return { host, appId, key };
}

function client({ host, appId, key }) {
  const headers = {
    "content-type": "application/json",
    "x-algolia-application-id": appId,
    "x-algolia-api-key": key,
  };
  return async function call(method, p, body) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 30000);
    let res;
    try {
      res = await fetch(host + p, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { /* not JSON */ }
    if (!res.ok) {
      const detail = json ? JSON.stringify(json.detail || json.message || json).slice(0, 400) : text.slice(0, 200);
      const err = new Error(`${method} ${p} → ${res.status} ${detail}`);
      err.status = res.status;
      throw err;
    }
    return json;
  };
}

async function listAgents(call) {
  const all = [];
  for (let page = 1; page < 100; page++) {
    const j = await call("GET", `/1/agents?page=${page}&limit=100`);
    const items = (j && (j.data || j.agents || j.items)) || [];
    all.push(...items);
    const pg = j && j.pagination;
    if (!items.length || !pg || page >= (pg.totalPages || pg.nbPages || 1)) break;
  }
  return all;
}

async function providerLabels(call) {
  try {
    const j = await call("GET", "/1/providers?limit=100");
    const items = (j && (j.data || j.providers || j.items)) || [];
    return new Map(items.map((p) => [p.id, p.providerName || p.name || null]));
  } catch (_) {
    return new Map();
  }
}

/** the parts of the base agent a variant copies */
function template(base) {
  const keep = ["instructions", "systemPrompt", "providerId", "model", "tools", "description"];
  const t = {};
  for (const k of keep) if (base[k] !== undefined && base[k] !== null) t[k] = base[k];
  return t;
}

function variantBody(base, toggles) {
  const config = { ...(base.config || {}) };
  delete config.searchPrefetch;
  delete config.search_prefetch;
  return { ...template(base), name: agentName(toggles), config: { ...config, ...agentConfigPatch(toggles) } };
}

async function existingFormat(file) {
  try { await access(file); } catch (_) { return "absent"; }
  try {
    const j = JSON.parse(await readFile(file, "utf8"));
    return j && typeof j.variants === "object" ? "ours" : "foreign";
  } catch (_) {
    return "foreign";
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("usage: MAIN_DEMO_HOST=… APP_ID=… ADMIN_KEY=… node tools/main-demo-provision.mjs [--add KEY]… [--dry-run] [--out FILE]");
    return;
  }
  const e = env();
  const call = client(e);
  console.log(`host ${e.host} · app ${e.appId.slice(0, 3)}… · key from env`);

  const wanted = new Map();
  for (const m of MANIFEST) wanted.set(configKey(m.toggles), m.toggles);
  for (const k of args.add) wanted.set(k, parseKey(k));

  const agents = await listAgents(call);
  const byName = new Map(agents.map((a) => [a.name, a]));
  const baseRow = byName.get(args.base);
  if (!baseRow) throw new Error(`no agent named ${args.base} on ${e.host}; create it first`);
  const base = await call("GET", `/1/agents/${baseRow.id}`);
  const providers = await providerLabels(call);

  const variants = {};
  const record = (agent, status) => {
    const key = configKey(togglesFromAgentConfig(agent.config));
    variants[key] = {
      agentId: agent.id, name: agent.name, model: agent.model || null,
      provider: providers.get(agent.providerId) || null, status,
    };
    return key;
  };

  for (const [key, toggles] of wanted) {
    const name = agentName(toggles);
    const found = byName.get(name);
    if (found) {
      const full = found.config ? found : await call("GET", `/1/agents/${found.id}`);
      const actual = record(full, "adopted");
      console.log(`adopt  ${name}${actual === key ? "" : `  (its config reads as ${actual}, keyed by that)`}`);
      continue;
    }
    if (args.dryRun) { console.log(`create ${name}  (dry run: skipped)`); continue; }
    const created = await call("POST", "/1/agents", variantBody(base, toggles));
    try {
      await call("POST", `/1/agents/${created.id}/publish`);
    } catch (err) {
      if (err.status !== 409) console.log(`       publish: ${err.message}`);
    }
    const full = await call("GET", `/1/agents/${created.id}`);
    record(full, "created");
    console.log(`create ${name}`);
  }

  const doc = { generatedAt: new Date().toISOString(), host: e.host, variants };
  if (args.dryRun) { console.log(JSON.stringify(doc, null, 2)); return; }
  let out = args.out;
  const fmt = await existingFormat(out);
  if (fmt === "foreign") {
    out = out.replace(/\.json$/, "") + `.${Date.now()}.json`;
    console.log(`${args.out} holds something else; writing ${out} instead`);
  }
  await writeFile(out, JSON.stringify(doc, null, 2) + "\n");
  console.log(`wrote ${path.relative(process.cwd(), out)} · ${Object.keys(variants).length} variants`);
}

main().catch((err) => {
  console.error(`main-demo-provision: ${err.message}`);
  process.exitCode = 1;
});

#!/usr/bin/env node
/* ───────────────────────────────────────────────────────────────
   main-demo-provision.mjs — one agent per toggle set, created once.

     MAIN_DEMO_HOST=http://127.0.0.1:8000 APP_ID=… ADMIN_KEY=… \
       node tools/main-demo-provision.mjs [--add 'prefetch=1,memory=1,…']
         [--config '{"searchPrefetch":{…},…}'] [--sync-instructions] [--dry-run]
         [--base NAME] [--out FILE] [--print-config]

   Reads the variant manifest from public/main-demo/configs.mjs (the same
   module the page uses), lists the agents on HOST, and for each variant:

     - an agent with the variant's name exists → adopt it, untouched;
     - none does → copy main-demo-base (model, provider, tools, prompt),
       layer the variant's config on top, create it and publish it.

   --config takes the blocks of an edited config (what the page's Create
   button would send) and creates or adopts main-demo-<hash>. Every agent
   already named main-demo-<hash> is adopted and keyed by its config.

   --sync-instructions copies main-demo-base's instructions and system
   prompt to every other main-demo-* agent that differs, then republishes
   it. It never writes main-demo-base, and it is the only write this script
   makes to an existing agent.

   Then writes public/main-demo/variants.json (gitignored): config key →
   agent id, plus the prefetch block's capturedIndexSettings when the server
   has written them. The server captures them after a save returns, so a
   freshly created agent shows them from the next run on. Idempotent: a
   second run creates nothing.

   --print-config also prints the variants map to stdout, as JSON, for
   mainDemo.variants in a deploy's config.js (variants.json is gitignored).
   The progress lines move to stderr, so stdout is only the map.

   Environment, never printed: MAIN_DEMO_HOST (or HOST when it is a URL —
   zsh sets HOST to the machine name), APP_ID, ADMIN_KEY.
   Node 20+, no dependencies.
   ─────────────────────────────────────────────────────────────── */

import { readFile, writeFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  MANIFEST, configKey, parseKey, agentName, agentConfigPatch, togglesFromAgentConfig,
  baseTemplate, customAgentBody, customKey, customName, blocksFromConfig, capturedSettings, shareableVariants,
} from "../public/main-demo/configs.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = path.join(HERE, "..", "public", "main-demo", "variants.json");
const BASE_NAME = "main-demo-base";

function parseArgs(argv) {
  const out = { add: [], configs: [], sync: false, dryRun: false, printConfig: false, out: DEFAULT_OUT, base: BASE_NAME };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--add") out.add.push(argv[++i]);
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--print-config") out.printConfig = true;
    else if (a === "--config") out.configs.push(JSON.parse(argv[++i]));
    else if (a === "--sync-instructions") out.sync = true;
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
    // review environments refuse a request without one
    "user-agent": "main-demo-provision",
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

function variantBody(base, toggles) {
  const config = { ...(base.config || {}) };
  delete config.searchPrefetch;
  delete config.search_prefetch;
  return { ...baseTemplate(base), name: agentName(toggles), config: { ...config, ...agentConfigPatch(toggles) } };
}

/** the server-written prefetch settings, as a variants.json field the page shows read-only */
function withCaptured(config) {
  const cap = capturedSettings(config);
  return cap ? { capturedIndexSettings: cap } : {};
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
  // with --print-config, stdout carries only the map, so it pipes straight into a file
  const log = args.printConfig ? (...a) => console.error(...a) : (...a) => console.log(...a);
  if (args.help) {
    log("usage: MAIN_DEMO_HOST=… APP_ID=… ADMIN_KEY=… node tools/main-demo-provision.mjs"
      + " [--add KEY]… [--config JSON]… [--sync-instructions] [--dry-run] [--out FILE] [--base NAME]"
      + " [--print-config]");
    return;
  }
  const e = env();
  const call = client(e);
  log(`host ${e.host} · app ${e.appId.slice(0, 3)}… · key from env`);

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
      ...withCaptured(agent.config),
    };
    return key;
  };

  for (const [key, toggles] of wanted) {
    const name = agentName(toggles);
    const found = byName.get(name);
    if (found) {
      const full = found.config ? found : await call("GET", `/1/agents/${found.id}`);
      const actual = record(full, "adopted");
      log(`adopt  ${name}${actual === key ? "" : `  (its config reads as ${actual}, keyed by that)`}`);
      continue;
    }
    if (args.dryRun) { log(`create ${name}  (dry run: skipped)`); continue; }
    const created = await call("POST", "/1/agents", variantBody(base, toggles));
    try {
      await call("POST", `/1/agents/${created.id}/publish`);
    } catch (err) {
      if (err.status !== 409) log(`       publish: ${err.message}`);
    }
    const full = await call("GET", `/1/agents/${created.id}`);
    record(full, "created");
    log(`create ${name}`);
  }

  const publish = async (id) => {
    try {
      await call("POST", `/1/agents/${id}/publish`);
    } catch (err) {
      if (err.status !== 409) log(`       publish: ${err.message}`);
    }
  };

  // edited configs: the ones asked for, and every main-demo-<hash> already there
  const customs = new Map(args.configs.map((b) => [customKey(b), b]));
  for (const a of agents) {
    if (!/^main-demo-[0-9a-f]{8}$/.test(a.name)) continue;
    const full = a.config ? a : await call("GET", `/1/agents/${a.id}`);
    const blocks = blocksFromConfig(full.config);
    if (customName(blocks) !== a.name) { log(`skip   ${a.name}  (its config hashes to ${customName(blocks)})`); continue; }
    variants[customKey(blocks)] = { agentId: a.id, name: a.name, model: a.model || null, status: "adopted", ...withCaptured(full.config) };
    customs.delete(customKey(blocks));
    log(`adopt  ${a.name}`);
  }
  for (const [key, blocks] of customs) {
    const name = customName(blocks);
    if (args.dryRun) { log(`create ${name}  (dry run: skipped)`); continue; }
    const created = await call("POST", "/1/agents", customAgentBody(base, blocks, name));
    await publish(created.id);
    variants[key] = { agentId: created.id, name, model: created.model || null, status: "created" };
    log(`create ${name}`);
  }

  if (args.sync) {
    for (const a of agents) {
      if (!a.name.startsWith("main-demo-") || a.name === args.base || a.id === base.id) continue;
      const full = await call("GET", `/1/agents/${a.id}`);
      if (full.instructions === base.instructions && full.systemPrompt === base.systemPrompt) {
        log(`same   ${a.name}`);
        continue;
      }
      if (args.dryRun) { log(`sync   ${a.name}  (dry run: skipped)`); continue; }
      await call("PATCH", `/1/agents/${a.id}`, { instructions: base.instructions, systemPrompt: base.systemPrompt });
      await publish(a.id);
      log(`sync   ${a.name}  (instructions from ${args.base})`);
    }
  }

  const doc = { generatedAt: new Date().toISOString(), host: e.host, variants };
  // the map a deploy pastes into mainDemo.variants: agent ids and names, never a key
  if (args.printConfig) console.log(JSON.stringify(shareableVariants(variants), null, 2));
  if (args.dryRun) { log(JSON.stringify(doc, null, 2)); return; }
  let out = args.out;
  const fmt = await existingFormat(out);
  if (fmt === "foreign") {
    out = out.replace(/\.json$/, "") + `.${Date.now()}.json`;
    log(`${args.out} holds something else; writing ${out} instead`);
  }
  await writeFile(out, JSON.stringify(doc, null, 2) + "\n");
  log(`wrote ${path.relative(process.cwd(), out)} · ${Object.keys(variants).length} variants`);
}

main().catch((err) => {
  console.error(`main-demo-provision: ${err.message}`);
  process.exitCode = 1;
});

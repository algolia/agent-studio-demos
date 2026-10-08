#!/usr/bin/env node
/* ───────────────────────────────────────────────────────────────
   main-demo-provision.mjs — one agent per toggle set, created once.

     APP_ID=… ADMIN_KEY=… node tools/main-demo-provision.mjs --region eu|us|auto
     MAIN_DEMO_HOST=http://127.0.0.1:8000 APP_ID=… ADMIN_KEY=… \
       node tools/main-demo-provision.mjs [--add 'prefetch=1,memory=1,…']
         [--config '{"searchPrefetch":{…},…}'] [--sync-instructions] [--dry-run]
         [--base NAME] [--out FILE] [--print-config]
         [--seed --provider NAME --model ID [--index NAME]]

   --seed creates the base agent when the host has none: a shopping
   assistant on --index (products by default) with the Algolia search and
   grouped-results tools, on --provider NAME with --model ID, Algolia MCP
   on (search prefetch only runs through it) and prefetch off. Run without
   --provider, it lists the providers named TEST_… to pick from.

   --region targets Agent Studio production in that region; auto asks both
   hosts and keeps the one where the app has providers. On any host that is
   not this machine, a write fence holds: a new agent must be named DEMO_…
   or EVAL_…, only such agents are ever written, and the base agent's
   provider must be one named TEST_…, which every variant then inherits.

   Reads the variant manifest from public/main-demo/configs.mjs (the same
   module the page uses), lists the agents on HOST, and for each variant:

     - an agent with the variant's name exists → adopt it, untouched;
     - none does → copy DEMO_main-demo-base (model, provider, tools, prompt),
       layer the variant's config on top, create it and publish it.

   --config takes the blocks of an edited config (what the page's Create
   button would send) and creates or adopts DEMO_main-demo-<hash>. Every agent
   already named DEMO_main-demo-<hash> is adopted and keyed by its config.

   --sync-instructions copies DEMO_main-demo-base's instructions and system
   prompt to every other DEMO_main-demo-* agent that differs, then republishes
   it. It never writes the base, and it is the only write this script
   makes to an existing agent.

   Then writes public/main-demo/variants.json (gitignored): config key →
   agent id. Idempotent: a second run creates nothing.

   --print-config also prints the variants map to stdout, as JSON, for
   mainDemo.variants in a deploy's config.js (variants.json is gitignored).
   The progress lines move to stderr, so stdout is only the map.

   Environment, never printed: MAIN_DEMO_HOST (or HOST when it is a URL —
   zsh sets HOST to the machine name; --region wins over both), APP_ID,
   ADMIN_KEY.
   Node 20+, no dependencies.
   ─────────────────────────────────────────────────────────────── */

import { readFile, writeFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  MANIFEST, NAME_PREFIX, BASE_AGENT, BASE_TOGGLES, HOSTS, isLocalHost, configKey, parseKey, agentName, agentConfigPatch, togglesFromAgentConfig,
  baseTemplate, customAgentBody, customKey, customName, blocksFromConfig, shareableVariants,
} from "../public/main-demo/configs.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = path.join(HERE, "..", "public", "main-demo", "variants.json");

function parseArgs(argv) {
  const out = { add: [], configs: [], sync: false, dryRun: false, printConfig: false, out: DEFAULT_OUT, base: BASE_AGENT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--add") out.add.push(argv[++i]);
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--print-config") out.printConfig = true;
    else if (a === "--config") out.configs.push(JSON.parse(argv[++i]));
    else if (a === "--sync-instructions") out.sync = true;
    else if (a === "--out") out.out = path.resolve(argv[++i]);
    else if (a === "--base") out.base = argv[++i];
    else if (a === "--region") out.region = String(argv[++i] || "").toLowerCase();
    else if (a === "--seed") out.seed = true;
    else if (a === "--provider") out.provider = argv[++i];
    else if (a === "--model") out.model = argv[++i];
    else if (a === "--index") out.index = argv[++i];
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

const itemsOf = (j) => (j && (j.data || j.agents || j.providers || j.items)) || [];

/**
 * The regions whose production host lists providers for this app. Another
 * region answers too, with an empty list, so an answer alone proves nothing.
 */
export async function probeRegions(callFor, hosts = HOSTS) {
  const found = [];
  for (const [region, host] of Object.entries(hosts)) {
    try {
      if (itemsOf(await callFor(host)("GET", "/1/providers?limit=100")).length) found.push(region);
    } catch (_) { /* not this region */ }
  }
  return found;
}

/** --region to a host: eu and us name one, auto takes the only region that knows the app */
export async function hostForRegion(region, callFor, hosts = HOSTS) {
  if (hosts[region]) return { region, host: hosts[region] };
  if (region !== "auto") throw new Error(`--region takes ${Object.keys(hosts).join(", ")} or auto, not ${region || "nothing"}`);
  const found = await probeRegions(callFor, hosts);
  if (found.length !== 1) {
    throw new Error(`--region auto found the app's providers in ${found.length ? found.join(" and ") : "no region"}; pass --region ${Object.keys(hosts).join(" or ")}`);
  }
  return { region: found[0], host: hosts[found[0]] };
}

export const isDemoName = (name) => /^(DEMO|EVAL)_/.test(String(name || ""));
export const isTestProvider = (provider) => Boolean(provider) && /^TEST_/.test(String(provider.name || ""));

/**
 * Off this machine, every write goes through here: a new agent must carry a
 * demo name, and an existing one is written only when its listed name is
 * this demo's (DEMO_main-demo-…) or this run made it.
 */
export function fenced(call, { local }) {
  const owned = new Set();
  const guarded = async (method, p, body) => {
    if (!local && method !== "GET") {
      const route = p.split("?")[0];
      if (method === "POST" && route === "/1/agents") {
        if (!isDemoName(body && body.name)) throw new Error(`refused: a new agent here must be named DEMO_… or EVAL_…, not ${body && body.name}`);
      } else {
        const id = (route.match(/^\/1\/agents\/([^/]+)/) || [])[1];
        if (!id || !owned.has(id)) throw new Error(`refused: ${method} ${route} writes an agent that is not ${NAME_PREFIX}…`);
      }
    }
    const j = await call(method, p, body);
    if (method === "POST" && p === "/1/agents" && j && j.id) owned.add(j.id);
    return j;
  };
  guarded.own = (agent) => { if (agent && String(agent.name || "").startsWith(NAME_PREFIX)) owned.add(agent.id); };
  return guarded;
}

/** off this machine the base must run on a TEST_ provider; the variants copy its providerId */
export function checkProvider(base, providers, { local }) {
  if (local) return;
  const p = providers.get(base.providerId);
  if (!isTestProvider(p)) {
    throw new Error(`refused: ${base.name} runs on provider ${p ? p.name : base.providerId || "none"}; use one named TEST_…`);
  }
}

/* ── The seeded base agent ──────────────────────────────────────
   The frozen review env's base, ported from the earlier local provisioner:
   the same prompt, tools and search parameters, so the race on production
   compares the same two agents. */

const PRODUCTS = {
  description: "General product catalog (electronics, sports, home, toys, fashion, books): title, brand, "
    + "price, categories, product group, color, features and image.",
  attributes: ["title", "brand", "manufacturer", "price", "priceDisplay", "largeImage", "categories",
    "productGroup", "color", "features", "url"],
};

const SEED_INSTRUCTIONS = "You are a shopping assistant for an online store. Help shoppers find products from the "
  + "catalog. Search the catalog before recommending anything, and only recommend products "
  + "that appear in the search results. Keep answers short: a sentence of context, then the "
  + "products. Mention price and brand when they help the shopper choose. When you show "
  + "several products, present them with the grouped results tool. When a search returns no "
  + "hits, or hits that don't fit the request, search again once with broader or related terms "
  + "(the product category, a synonym, fewer words, no filters). Never answer with nothing: "
  + "recommend the closest products you found and say in a few words how they differ from the request.";

/** the base agent --seed creates: prefetch off, Algolia MCP on, so both arms search the same way */
export function seedBody({ name = BASE_AGENT, providerId, model, index = "products" }) {
  const known = index === "products";
  const searchParameters = {
    ...(known ? { attributesToRetrieve: PRODUCTS.attributes } : {}),
    hitsPerPage: 7,
    // a chat query with one word the catalog lacks finds nothing under strict settings
    removeWordsIfNoResults: "allOptional", ignorePlurals: true, typoTolerance: "min",
  };
  return {
    name,
    description: "Search prefetch race: the base arm, and the template every variant copies",
    providerId, model,
    instructions: SEED_INSTRUCTIONS,
    config: { enableAlgoliaMcp: true, ...agentConfigPatch(BASE_TOGGLES) },
    tools: [
      { type: "algolia_search_index", name: "algolia_search_index",
        indices: [{ index, description: known ? PRODUCTS.description : `The ${index} catalog.`, searchParameters }] },
      { type: "algolia_grouped_results", name: "algolia_grouped_results" },
    ],
  };
}

/** the provider --seed names, refused off this machine unless it is a TEST_ one */
export function seedProvider(providers, name, { local }) {
  const tests = [...providers.values()].filter(isTestProvider).map((p) => p.name).sort();
  const hint = tests.length ? `providers named TEST_… here: ${tests.join(", ")}` : "no provider here is named TEST_…";
  if (!name) throw new Error(`--seed needs --provider NAME; ${hint}`);
  const found = [...providers.entries()].find(([, p]) => p.name === name);
  if (!found) throw new Error(`no provider named ${name}; ${hint}`);
  if (!local && !isTestProvider(found[1])) throw new Error(`refused: ${name} is not a TEST_ provider; ${hint}`);
  return found[0];
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

/** id → { name, label }: the name the app gave it, and its vendor as the page shows it */
async function listProviders(call) {
  try {
    const items = itemsOf(await call("GET", "/1/providers?limit=100"));
    return new Map(items.map((p) => [p.id, { name: p.name || null, label: p.providerName || p.name || null }]));
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
      + " [--print-config] [--region eu|us|auto] [--seed --provider NAME --model ID [--index NAME]]");
    return;
  }
  const e = env();
  if (args.region !== undefined) {
    const picked = await hostForRegion(args.region, (host) => client({ ...e, host }));
    e.host = picked.host;
    log(`region ${picked.region}: set mainDemo.region to "${picked.region}" in the deploy's config`);
  }
  const local = isLocalHost(e.host);
  const call = fenced(client(e), { local });
  log(`host ${e.host} · app ${e.appId.slice(0, 3)}… · key from env${local ? "" : " · DEMO_ names and TEST_ providers only"}`);

  const wanted = new Map();
  for (const m of MANIFEST) wanted.set(configKey(m.toggles), m.toggles);
  for (const k of args.add) wanted.set(k, parseKey(k));

  const agents = await listAgents(call);
  for (const a of agents) call.own(a);
  const byName = new Map(agents.map((a) => [a.name, a]));
  const providers = await listProviders(call);
  let base;
  let seeded = null;
  const baseRow = byName.get(args.base);
  if (baseRow) {
    base = await call("GET", `/1/agents/${baseRow.id}`);
    if (args.seed) log(`adopt  ${args.base}  (it exists: --seed changes nothing)`);
  } else if (!args.seed) {
    throw new Error(`no agent named ${args.base} on ${e.host}; pass --seed --provider NAME --model ID to create it`);
  } else {
    const providerId = seedProvider(providers, args.provider, { local });
    if (!args.model) throw new Error("--seed needs --model ID, a model the provider serves");
    const body = seedBody({ name: args.base, providerId, model: args.model, index: args.index });
    if (args.dryRun) {
      log(`seed   ${args.base}  (dry run: skipped)`);
      base = { ...body, id: "dry-run" };
      byName.set(base.name, base);
    } else {
      const created = await call("POST", "/1/agents", body);
      try {
        await call("POST", `/1/agents/${created.id}/publish`);
      } catch (err) {
        if (err.status !== 409) log(`       publish: ${err.message}`);
      }
      base = await call("GET", `/1/agents/${created.id}`);
      byName.set(base.name, base);
      seeded = base.id;
      log(`seed   ${args.base}  (on ${args.provider}, ${args.model}, index ${args.index || "products"})`);
    }
  }
  checkProvider(base, providers, { local });

  const variants = {};
  const record = (agent, status) => {
    const key = configKey(togglesFromAgentConfig(agent.config));
    variants[key] = {
      agentId: agent.id, name: agent.name, model: agent.model || null,
      provider: (providers.get(agent.providerId) || {}).label || null, status,
    };
    return key;
  };

  for (const [key, toggles] of wanted) {
    const name = agentName(toggles);
    const found = byName.get(name);
    if (found) {
      const full = found.config ? found : await call("GET", `/1/agents/${found.id}`);
      const actual = record(full, found.id === seeded ? "created" : "adopted");
      if (found.id !== seeded) log(`adopt  ${name}${actual === key ? "" : `  (its config reads as ${actual}, keyed by that)`}`);
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

  // edited configs: the ones asked for, and every DEMO_main-demo-<hash> already there
  const customs = new Map(args.configs.map((b) => [customKey(b), b]));
  for (const a of agents) {
    if (!(a.name.startsWith(NAME_PREFIX) && /^[0-9a-f]{8}$/.test(a.name.slice(NAME_PREFIX.length)))) continue;
    const full = a.config ? a : await call("GET", `/1/agents/${a.id}`);
    const blocks = blocksFromConfig(full.config);
    if (customName(blocks) !== a.name) { log(`skip   ${a.name}  (its config hashes to ${customName(blocks)})`); continue; }
    variants[customKey(blocks)] = { agentId: a.id, name: a.name, model: a.model || null, status: "adopted" };
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
      if (!a.name.startsWith(NAME_PREFIX) || a.name === args.base || a.id === base.id) continue;
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

// run as a script; imported, it only hands its helpers to the tests
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((err) => {
  console.error(`main-demo-provision: ${err.message}`);
  process.exitCode = 1;
});

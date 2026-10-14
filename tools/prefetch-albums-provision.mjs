#!/usr/bin/env node
/* ───────────────────────────────────────────────────────────────
   prefetch-albums-provision.mjs: the albums race's agents, made once.

     APP_ID=… ADMIN_KEY=… node tools/prefetch-albums-provision.mjs --region eu --providers
     APP_ID=… ADMIN_KEY=… node tools/prefetch-albums-provision.mjs --region eu \
       --provider NAME --model ID [--converge] [--dry-run]
       [--keys-from public/shared/config.js] [--write-config FILE]
       [--measure N] [--measure-out FILE]

   --providers lists the providers the fence allows (TEST_… or the
   Algolia-managed one) and, for each, the candidate models it serves, in
   the order this demo prefers them. Names and model ids only.

   With --provider and --model, every agent of public/prefetch/tune.mjs
   ALBUM_AGENTS is adopted by name or created: the same model, the same
   record-shop instructions, the same search tool on thousand_albums; only
   the search prefetch block differs. --converge rewrites an adopted agent
   whose model, instructions, tools or config differ, then republishes it.

   The fence: off this machine, only agents named DEMO_albums-… are ever
   written, and the provider must be TEST_… or Algolia-managed.

   --write-config FILE replaces the prefetchAlbums block of a config.js (or
   appends it): the agent map, plus the browser keys of the config.js named
   by --keys-from, read from its mainDemo block for the same app. Nothing
   is printed: the block holds a key.

   --measure N runs each race question N times on the base and the race
   partner, and each scripted pair once on every tune agent, through the
   completions API with the browser key, and writes timings, prefetch
   decisions, queries and hit counts to --measure-out (JSON). Its `typical`
   is the run whose totals sit at the medians, in the shape intro.mjs reads.

   Environment, never printed: APP_ID, ADMIN_KEY. Node 20+, no dependencies.
   ─────────────────────────────────────────────────────────────── */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import path from "node:path";
import { client, listAgents, listProviders, hostForRegion, isAllowedProvider } from "./main-demo-provision.mjs";
import { agentConfigPatch, BASE_TOGGLES, configKey, completionQuery } from "../public/main-demo/configs.mjs";
import { createSseParser, createTurn } from "../public/main-demo/stream.mjs";
import { phases } from "../public/prefetch/compare.mjs";
import { fromPhases } from "../public/prefetch/intro.mjs";
import { DEMOS } from "../public/prefetch/demos.mjs";
import {
  AGENT_PREFIX, ALBUM_AGENTS, INDEX, PAIRS, comboKey, prefetchBlock, messagesFor, onTopic,
} from "../public/prefetch/tune.mjs";

/** the models this demo would run, best first: a broad flagship, then a known fallback */
export const CANDIDATES = ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "claude-sonnet-5-5", "gpt-4.1"];

/* check-copy: off */
export const INSTRUCTIONS = "You work the counter of a cramped record shop down a vinyl alley, and you love every "
  + "record in the racks. You always talk a little too much: each answer slips in one fascinating, unprompted "
  + "anecdote about the album, its genre or the band (a studio story, an influence, a strange fact). "
  + "Search the catalog before you recommend anything. Recommend only albums that appear in the search results, "
  + "and name each pick with its title, artist and year exactly as the record gives them. Never invent an album, "
  + "a track or a year. When the results do not fit, search once more with broader words; if nothing fits, say "
  + "so with charm and offer the closest records you found. Keep it readable at the counter: one short "
  + "paragraph, then up to 3 picks, one line each.";

const TOOL_DESCRIPTION = "1001 albums to hear before you die: title, artist, year, country, genres, label and cover image.";
/* check-copy: on */

export const ATTRIBUTES = ["title", "artist", "year", "country", "genres", "label.name", "image"];

/** the tools every agent carries: one search tool on the albums index */
export function albumTools() {
  return [{
    type: "algolia_search_index", name: "algolia_search_index",
    indices: [{
      index: INDEX, description: TOOL_DESCRIPTION,
      searchParameters: { attributesToRetrieve: ATTRIBUTES, hitsPerPage: 5, removeWordsIfNoResults: "allOptional", ignorePlurals: true },
    }],
  }];
}

/** one agent's config: Algolia MCP on (prefetch runs only through it), usage streamed, its prefetch block */
export function albumConfig(prefetch) {
  return { ...agentConfigPatch(BASE_TOGGLES), enableAlgoliaMcp: true, sendUsage: true, searchPrefetch: prefetchBlock(prefetch) };
}

/** the create body of one ALBUM_AGENTS entry */
export function albumBody(agent, { providerId, model }) {
  return {
    name: agent.name,
    description: "Search prefetch albums race: same model and prompt on every agent, only prefetch differs",
    providerId, model, instructions: INSTRUCTIONS, tools: albumTools(), config: albumConfig(agent.prefetch),
  };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const storedPrefetch = (c) => (c && (c.search_prefetch !== undefined ? c.search_prefetch : c.searchPrefetch));
const camelBlock = (b) => (b && typeof b === "object"
  ? Object.fromEntries(Object.entries(b).filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => [k.replace(/_([a-z])/g, (_, x) => x.toUpperCase()), v]))
  : b);

/** why a stored agent is not the one the body asks for; empty when it is */
export function albumDrift(stored, body) {
  const out = [];
  if (stored.model !== body.model) out.push(`model ${stored.model}`);
  if (stored.providerId !== body.providerId) out.push("another provider");
  if (stored.instructions !== body.instructions) out.push("other instructions");
  const want = body.config.searchPrefetch;
  const have = camelBlock(storedPrefetch(stored.config));
  const pick = (b) => (b && typeof b === "object" ? { enabled: b.enabled !== false, conversationWindow: b.conversationWindow, hitsPerPage: b.hitsPerPage } : Boolean(b));
  if (!same(pick(have), pick(want))) out.push("another prefetch block");
  if (!stored.config || stored.config.enableAlgoliaMcp !== true) out.push("Algolia MCP off");
  if (!stored.config || stored.config.sendUsage !== true) out.push("no usage streamed");
  return out;
}

/** off this machine: a new agent must be DEMO_albums-…, an existing one is written only if listed as such */
export function albumFence(call) {
  const owned = new Set();
  const guarded = async (method, p, body) => {
    if (method !== "GET") {
      const route = p.split("?")[0];
      if (method === "POST" && route === "/1/agents") {
        if (!String((body && body.name) || "").startsWith(AGENT_PREFIX)) throw new Error(`refused: a new agent must be named ${AGENT_PREFIX}…`);
      } else {
        const id = (route.match(/^\/1\/agents\/([^/]+)/) || [])[1];
        if (!id || !owned.has(id)) throw new Error(`refused: ${method} ${route} is not a ${AGENT_PREFIX}… agent`);
      }
    }
    const j = await call(method, p, body);
    if (method === "POST" && p === "/1/agents" && j && j.id) owned.add(j.id);
    return j;
  };
  guarded.own = (agent) => { if (agent && String(agent.name || "").startsWith(AGENT_PREFIX)) owned.add(agent.id); };
  return guarded;
}

/* ── config.js: the prefetchAlbums block ───────────────────────── */

const BEGIN = "// prefetchAlbums: begin (tools/prefetch-albums-provision.mjs)";
const END = "// prefetchAlbums: end";

/** the block the page reads: race variants keyed as main-demo keys them, and one tune entry per combo */
export function albumsBlock({ appId, region, agentStudioApiKey, searchApiKey, agents }) {
  const entry = (a) => ({ agentId: a.agentId, name: a.name, model: a.model || null });
  const byName = new Map((agents || []).map((a) => [a.name, a]));
  const base = byName.get(ALBUM_AGENTS[0].name);
  const race = byName.get(ALBUM_AGENTS[1].name);
  const variants = {};
  if (base) variants[configKey({ ...BASE_TOGGLES })] = entry(base);
  if (race) variants[configKey({ ...BASE_TOGGLES, prefetch: true })] = entry(race);
  const tune = {};
  for (const a of ALBUM_AGENTS) {
    if (a.prefetch && byName.has(a.name)) tune[comboKey(a.prefetch)] = entry(byName.get(a.name));
  }
  return {
    region, appId, agentStudioApiKey, ...(searchApiKey ? { searchApiKey } : {}), indexName: INDEX,
    fields: DEMOS.albums.fields, variants, tune,
  };
}

/** a config.js source with its prefetchAlbums block replaced, or appended; every other block untouched */
export function withAlbumsBlock(src, block) {
  const body = `${BEGIN}\nwindow.DEMO_CONFIG = window.DEMO_CONFIG || {};\nwindow.DEMO_CONFIG.prefetchAlbums = ${JSON.stringify(block, null, 2)};\n${END}\n`;
  const s = String(src || "");
  const at = s.indexOf(BEGIN);
  if (at >= 0) {
    const end = s.indexOf(END, at);
    if (end < 0) throw new Error("config.js has a prefetchAlbums begin marker and no end marker");
    return s.slice(0, at) + body + s.slice(end + END.length).replace(/^\n/, "");
  }
  return s.replace(/\s*$/, "\n\n") + body;
}

/** a config.js evaluated in a sandbox, as the browser would: its DEMO_CONFIG */
export function readConfig(src) {
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(String(src), ctx, { timeout: 1000 });
  return ctx.window.DEMO_CONFIG || null;
}

/** the browser keys for this app: the first block of the config that names it */
export function browserKeys(config, appId) {
  for (const b of Object.values(config || {})) {
    if (b && typeof b === "object" && b.appId === appId && b.agentStudioApiKey) {
      return { agentStudioApiKey: b.agentStudioApiKey, searchApiKey: b.searchApiKey || null };
    }
  }
  return null;
}

/* ── Measuring: the same calls the page makes ──────────────────── */

async function oneTurn({ host, appId, key, agentId, turns, answers }) {
  const q = new URLSearchParams(completionQuery()).toString();
  const t0 = performance.now();
  const now = () => performance.now() - t0;
  const tr = createTurn({ text: turns[turns.length - 1] });
  const res = await fetch(`${host}/1/agents/${agentId}/completions?${q}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-algolia-application-id": appId, "x-algolia-api-key": key, "user-agent": "prefetch-albums-measure" },
    body: JSON.stringify({ messages: messagesFor(turns, answers) }),
    signal: AbortSignal.timeout(120000),
  });
  tr.headers(now(), { status: res.status, get: (h) => res.headers.get(h) });
  if (!res.ok || !res.body) { tr.finish(now(), { error: `HTTP ${res.status}` }); return tr.view(); }
  const parser = createSseParser((evt) => { if (evt.type !== "[DONE]") tr.observe(now(), evt); });
  for await (const chunk of res.body) parser.push(chunk);
  parser.end();
  tr.finish(now());
  return tr.view();
}

const pickHit = (h) => ({ title: h.title, artist: h.artist, year: h.year, country: h.country, genres: h.genres });

function summary(view) {
  const part = view.prefetchPart || {};
  return {
    status: view.status, ttft: view.ttft, total: view.total, modelCalls: view.modelCalls, searches: view.searches,
    inputTokens: view.usage ? view.usage.inputTokens : null,
    decision: part.decision || null, nbHits: Number.isFinite(part.nbHits) ? part.nbHits : null,
    prefetchQuery: view.prefetchQuery, prefetchHits: view.prefetchHits.map(pickHit),
    phases: fromPhases(phases(view)), words: view.answer.split(/\s+/).filter(Boolean).length,
  };
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };

/** the base run and the prefetch run closest to their medians: the title screen's typical run */
export function typicalRun(baseRuns, raceRuns) {
  const done = (r) => r.status === "done" && Number.isFinite(r.total);
  const closest = (runs, kind) => {
    const ok = runs.filter(done).filter((r) => r.phases.some((p) => p.kind === kind));
    const m = median(ok.map((r) => r.total));
    return ok.sort((a, b) => Math.abs(a.total - m) - Math.abs(b.total - m))[0] || null;
  };
  const b = closest(baseRuns, "search");
  const a = closest(raceRuns, "prefetch");
  if (!a || !b) return null;
  return { measured: new Date().toISOString().slice(0, 10), before: b.phases, after: a.phases, medians: {
    before: median(baseRuns.filter(done).map((r) => r.total)), after: median(raceRuns.filter(done).map((r) => r.total)) } };
}

async function measure({ host, appId, key, agents, n, log }) {
  const id = (name) => (agents.find((a) => a.name === name) || {}).agentId;
  const out = { race: [], tune: [] };
  const questions = DEMOS.albums.starters;
  for (let i = 0; i < n; i++) {
    for (const s of questions) {
      for (const a of ALBUM_AGENTS.slice(0, 2)) {
        const v = summary(await oneTurn({ host, appId, key, agentId: id(a.name), turns: [s.text] }));
        out.race.push({ agent: a.name, question: s.text, fit: s.fit, ...v });
        log(`race   ${a.name}  ${s.fit}  ${v.status} ttft ${Math.round(v.ttft)} total ${Math.round(v.total)} calls ${v.modelCalls} ${v.decision || ""}`);
      }
    }
  }
  for (const pair of PAIRS) {
    for (const a of ALBUM_AGENTS.slice(1)) {
      const first = await oneTurn({ host, appId, key, agentId: id(a.name), turns: pair.turns.slice(0, 1) });
      const v = summary(await oneTurn({ host, appId, key, agentId: id(a.name), turns: pair.turns, answers: [first.answer] }));
      const topical = onTopic(v.prefetchHits, pair.topic);
      out.tune.push({ agent: a.name, prefetch: a.prefetch, turns: pair.turns, onTopic: topical, ...v });
      log(`tune   ${a.name}  "${pair.turns[1]}"  query "${v.prefetchQuery}"  hits ${v.prefetchHits.length} on topic ${topical}`);
    }
  }
  const race = (name) => out.race.filter((r) => r.agent === name && r.fit === "good");
  out.typical = typicalRun(race(ALBUM_AGENTS[0].name), race(ALBUM_AGENTS[1].name));
  return out;
}

/* ── The run ───────────────────────────────────────────────────── */

function parseArgs(argv) {
  const out = { converge: false, dryRun: false, providers: false, measure: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--region") out.region = String(argv[++i] || "").toLowerCase();
    else if (a === "--provider") out.provider = argv[++i];
    else if (a === "--model") out.model = argv[++i];
    else if (a === "--providers") out.providers = true;
    else if (a === "--converge") out.converge = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--keys-from") out.keysFrom = path.resolve(argv[++i]);
    else if (a === "--write-config") out.writeConfig = path.resolve(argv[++i]);
    else if (a === "--measure") out.measure = Number(argv[++i]);
    else if (a === "--measure-out") out.measureOut = path.resolve(argv[++i]);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!out.region) throw new Error("pass --region eu or us");
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const log = (...a) => console.error(...a);
  const appId = process.env.APP_ID || "";
  const key = process.env.ADMIN_KEY || "";
  if (!appId || !key) throw new Error("set APP_ID and ADMIN_KEY in the environment");
  const { host } = await hostForRegion(args.region, (h) => client({ host: h, appId, key }));
  const call = albumFence(client({ host, appId, key }));
  log(`host ${host} · app ${appId.slice(0, 3)}… · writes only ${AGENT_PREFIX}…`);

  const providers = await listProviders(call);
  if (args.providers || !args.provider) {
    for (const [id, p] of providers) {
      if (!isAllowedProvider(p)) { log(`provider ${p.name} [${p.label}]  (not TEST_ or managed: refused)`); continue; }
      let models = [];
      try { models = await call("GET", `/1/providers/${id}/models`); } catch (e) { log(`  models: ${e.status || e.message}`); }
      log(`provider ${p.name} [${p.label}]  candidates: ${CANDIDATES.filter((m) => (models || []).includes(m)).join(", ") || "none"}`);
    }
    if (!args.provider) return;
  }
  const found = [...providers.entries()].find(([, p]) => p.name === args.provider);
  if (!found) throw new Error(`no provider named ${args.provider}`);
  if (!isAllowedProvider(found[1])) throw new Error(`refused: ${args.provider} is neither TEST_ nor Algolia-managed`);
  const served = await call("GET", `/1/providers/${found[0]}/models`).catch(() => []);
  if (!args.model || !(served || []).includes(args.model)) throw new Error(`--model must be one ${args.provider} serves`);

  const listed = await listAgents(call);
  for (const a of listed) call.own(a);
  const byName = new Map(listed.map((a) => [a.name, a]));
  const agents = [];
  for (const agent of ALBUM_AGENTS) {
    const body = albumBody(agent, { providerId: found[0], model: args.model });
    const row = byName.get(agent.name);
    if (row) {
      const stored = await call("GET", `/1/agents/${row.id}`);
      const drift = albumDrift(stored, body);
      if (drift.length && args.converge && !args.dryRun) {
        await call("PATCH", `/1/agents/${row.id}`, { model: body.model, providerId: body.providerId, instructions: body.instructions, tools: body.tools, config: { ...(stored.config || {}), ...body.config, search_prefetch: undefined } });
        await call("POST", `/1/agents/${row.id}/publish`).catch((e) => { if (e.status !== 409) log(`  publish: ${e.message}`); });
        log(`fix    ${agent.name}  (${drift.join("; ")})`);
      } else {
        log(`adopt  ${agent.name}${drift.length ? `  (differs: ${drift.join("; ")})` : ""}`);
      }
      agents.push({ name: agent.name, agentId: row.id, model: args.model });
      continue;
    }
    if (args.dryRun) { log(`create ${agent.name}  (dry run: skipped)`); continue; }
    const made = await call("POST", "/1/agents", body);
    await call("POST", `/1/agents/${made.id}/publish`).catch((e) => { if (e.status !== 409) log(`  publish: ${e.message}`); });
    agents.push({ name: agent.name, agentId: made.id, model: args.model });
    log(`create ${agent.name}  ${made.id}`);
  }
  for (const a of agents) console.log(`${a.name}\t${a.agentId}`);

  if (args.writeConfig || args.measure) {
    if (!args.keysFrom) throw new Error("--write-config and --measure need --keys-from, the config.js holding the browser keys");
    const keys = browserKeys(readConfig(await readFile(args.keysFrom, "utf8")), appId);
    if (!keys) throw new Error(`no block of ${path.basename(args.keysFrom)} holds a browser key for this app`);
    if (args.writeConfig && !args.dryRun) {
      const src = await readFile(args.writeConfig, "utf8").catch(() => "");
      const next = withAlbumsBlock(src, albumsBlock({ appId, region: args.region, ...keys, agents }));
      readConfig(next);
      await writeFile(args.writeConfig, next, { mode: 0o600 });
      log(`wrote the prefetchAlbums block into ${path.basename(args.writeConfig)} (${agents.length} agents)`);
    }
    if (args.measure > 0) {
      const out = await measure({ host, appId, key: keys.agentStudioApiKey, agents, n: args.measure, log });
      if (args.measureOut) await writeFile(args.measureOut, JSON.stringify(out, null, 2) + "\n");
      log(`measured ${out.race.length} race runs, ${out.tune.length} tune runs${args.measureOut ? ` → ${path.basename(args.measureOut)}` : ""}`);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((err) => {
  console.error(`prefetch-albums-provision: ${err.message}`);
  process.exitCode = 1;
});

#!/usr/bin/env node
/* ───────────────────────────────────────────────────────────────
   pii-provision.mjs: the identifier-filtering page's live agent, made once.

     APP_ID=… ADMIN_KEY=… node tools/pii-provision.mjs --region eu --providers
     APP_ID=… ADMIN_KEY=… node tools/pii-provision.mjs --region eu \
       [--provider NAME] [--model ID] [--converge] [--dry-run]
       [--keys-from public/shared/config.js] [--write-config FILE]

   One agent, DEMO_pii-banking: a financial-advisor help assistant for a
   fictional bank, with one search tool on bank_faq (seeded by
   tools/pii-faq-seed.mjs). It has no account access, so it never claims
   any. Its instructions hold three flows: a clean message, a message whose
   identifiers arrive masked, and one whose identifiers arrive raw.
   Adopted by name, else created and published. --converge rewrites an
   adopted one whose model, provider, instructions, tools or config differ.
   --dry-run reads and reports, and writes nothing: no agent, no file.

   Provider: the Algolia-managed one (providerName algolia_managed_llm) unless
   --provider names another the fence allows (TEST_…). Model: --model, else
   the adopted agent's own when the provider still serves it, else the first
   of CANDIDATES the provider serves. --providers lists provider
   names and candidate model ids, and nothing else.

   The fence: only agents named DEMO_pii-… are ever written.

   --write-config FILE replaces the pii block of a config.js (or appends it):
   region, host, appId, agentId, and the browser key of the config.js named by
   --keys-from, taken from a block for the same app. Only a browser key ever
   goes there, never ADMIN_KEY: the page sends it from the visitor's browser.
   Nothing is printed: the block holds a key.

   Environment, never printed: APP_ID, ADMIN_KEY. Node 20+, no dependencies.
   ─────────────────────────────────────────────────────────────── */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import path from "node:path";
import { client, listAgents, listProviders, hostForRegion, isAllowedProvider, isManagedProvider } from "./main-demo-provision.mjs";
import { agentConfigPatch, BASE_TOGGLES } from "../public/main-demo/configs.mjs";

export const AGENT_PREFIX = "DEMO_pii-";
export const AGENT_NAME = `${AGENT_PREFIX}banking`;

/** the models this agent would run, best first; the provider decides which exist */
export const CANDIDATES = ["medium", "gpt-6-luna", "gpt-6-sol", "gpt-5.6-sol", "gpt-4.1-mini", "gpt-4.1", "claude-sonnet-5-5"];

/* check-copy: off */
export const INSTRUCTIONS = [
  "You are the financial-advisor assistant of Example Bank, a fictional retail bank, in its help centre chat.",
  "Be warm, brief and plain: two to five sentences. Answer in the customer's language, English or French.",
  "Answer only from the search results of the bank_faq index: search it for every question, in the customer's",
  "language, and never invent a fee, a rate, a limit or a delay. If nothing fits, say so and send the customer to",
  "the app or an adviser. Give general information only, never personal financial advice.",
  "You have no access to any account: never claim to see a balance, a transaction or a customer's details.",
  "For anything about the customer's own account, point to the mobile app, online banking, or a call to the bank.",
  "Messages may hold identifiers (card, account or social security numbers, IBANs, tax ids, emails, phones).",
  "There are three cases.",
  "1. The message holds none: search bank_faq and answer from the hits.",
  "2. It holds masks in square brackets such as [CREDIT_CARD], [IBAN], [US_SSN], [FR_NIR], [ACCOUNT_NUMBER],",
  "[EMAIL] or [PHONE]: a filter removed those details before they reached you. In one or two kind sentences, say",
  "that you can see some details were filtered out, naming their kinds in words (a card number, a social security",
  "number), thank the customer, and ask them please not to share such details in chat at all. Never treat a mask",
  "as data and never write the bracketed token itself. Then answer the rest of the question from the FAQ.",
  "3. It holds a real identifier you can read: say politely that you can see a number you should never receive,",
  "that you will not use it, and ask the customer not to post it in chat; if it was a real number, they should",
  "contact the bank through a secure channel (the app or the number on their card). Never repeat, confirm or",
  "reformat any of its digits. Then answer the rest of the question from the FAQ.",
  "Never ask for an identifier, a PIN, a password or a code.",
].join(" ");

const TOOL_DESCRIPTION = "Example Bank help-centre FAQ in English and French: question, answer, category, language.";
/* check-copy: on */

export const FAQ_INDEX = "bank_faq";
export const ATTRIBUTES = ["question", "answer", "category", "lang"];

/** the one tool: search on bank_faq, built as the albums agents build theirs */
export function piiTools() {
  return [{
    type: "algolia_search_index", name: "algolia_search_index",
    indices: [{
      index: FAQ_INDEX, description: TOOL_DESCRIPTION,
      searchParameters: { attributesToRetrieve: ATTRIBUTES, hitsPerPage: 3, removeWordsIfNoResults: "allOptional", ignorePlurals: true },
    }],
  }];
}

/** memory, guardrails, suggestions and prefetch off, as on every demo agent; cache and analytics are off per call */
export function piiConfig() {
  return { ...agentConfigPatch(BASE_TOGGLES) };
}

/** the create body */
export function piiBody({ providerId, model }) {
  return {
    name: AGENT_NAME,
    description: "Identifier filtering demo: a financial-advisor assistant answering from the bank_faq index",
    providerId, model, instructions: INSTRUCTIONS, tools: piiTools(), config: piiConfig(),
  };
}

const enabled = (v) => Boolean(v && typeof v === "object" ? v.enabled : v);

/** why a stored agent is not the one the body asks for; empty when it is */
export function piiDrift(stored, body) {
  const out = [];
  const s = stored || {};
  if (s.model !== body.model) out.push(`model ${s.model}`);
  if (s.providerId !== body.providerId) out.push("another provider");
  if (s.instructions !== body.instructions) out.push("other instructions");
  const shape = (tools) => JSON.stringify((tools || []).map((t) => [t.type, ((t.indices || []).map((i) => i.index))]));
  if (shape(s.tools) !== shape(body.tools)) {
    out.push((s.tools || []).length ? `tools ${shape(s.tools)}` : `no search tool on ${FAQ_INDEX}`);
  }
  const c = s.config || {};
  for (const k of ["memory", "guardrail", "suggestions"]) if (enabled(c[k])) out.push(`${k} on`);
  if (enabled(c.search_prefetch !== undefined ? c.search_prefetch : c.searchPrefetch)) out.push("prefetch on");
  return out;
}

/** every write goes through here: a new agent must be DEMO_pii-…, an existing one is written only if listed as such */
export function piiFence(call) {
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

/** the provider to run on: --provider when the fence allows it, else the one Algolia-managed provider */
export function pickProvider(providers, name) {
  const entries = [...providers.entries()];
  if (name) {
    const found = entries.find(([, p]) => p.name === name);
    if (!found) throw new Error(`no provider named ${name}`);
    if (!isAllowedProvider(found[1])) throw new Error(`refused: ${name} is neither TEST_ nor Algolia-managed`);
    return found;
  }
  const managed = entries.filter(([, p]) => isManagedProvider(p));
  if (managed.length !== 1) throw new Error(`found ${managed.length} Algolia-managed providers; pass --provider NAME`);
  return managed[0];
}

/** the model to run: --model when served, else the first candidate served */
export function pickModel(served, wanted) {
  const list = Array.isArray(served) ? served : [];
  if (wanted) {
    if (!list.includes(wanted)) throw new Error(`--model ${wanted} is not one this provider serves`);
    return wanted;
  }
  const m = CANDIDATES.find((c) => list.includes(c));
  if (!m) throw new Error("the provider serves none of the candidate models; pass --model ID");
  return m;
}

/* ── config.js: the pii block ──────────────────────────────────── */

const BEGIN = "// pii: begin (tools/pii-provision.mjs)";
const END = "// pii: end";

/** the block public/pii/ reads. agentStudioApiKey is a browser key: it ships to every visitor */
export function piiBlock({ region, host, appId, agentStudioApiKey, agentId, model }) {
  return { region, host, appId, agentStudioApiKey, agentId, name: AGENT_NAME, model: model || null };
}

/** a config.js source with its pii block replaced, or appended; every other block untouched */
export function withPiiBlock(src, block) {
  const body = `${BEGIN}\nwindow.DEMO_CONFIG = window.DEMO_CONFIG || {};\nwindow.DEMO_CONFIG.pii = ${JSON.stringify(block, null, 2)};\n${END}\n`;
  const s = String(src || "");
  const at = s.indexOf(BEGIN);
  if (at >= 0) {
    const end = s.indexOf(END, at);
    if (end < 0) throw new Error("config.js has a pii begin marker and no end marker");
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

/** the browser key for this app: the pii block's own when it has one, else the first block that names the app */
export function browserKey(config, appId) {
  const own = config && config.pii;
  for (const b of [...(own ? [own] : []), ...Object.values(config || {})]) {
    if (b && typeof b === "object" && b.appId === appId && b.agentStudioApiKey) return b.agentStudioApiKey;
  }
  return null;
}

/* ── The run ───────────────────────────────────────────────────── */

export function parseArgs(argv) {
  const out = { converge: false, dryRun: false, providers: false };
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
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!out.region) throw new Error("pass --region eu, us or auto");
  if (out.writeConfig && !out.keysFrom) throw new Error("--write-config needs --keys-from, the config.js holding the browser key");
  return out;
}

const publish = (call, id, log) => call("POST", `/1/agents/${id}/publish`).catch((e) => { if (e.status !== 409) log(`  publish: ${e.message}`); });

/**
 * The whole run against an injected client: `call` is unfenced, `files`
 * reads and writes config.js. Returns the agent it adopted or made, or null.
 */
export async function run({ args, appId, region, host, call: rawCall, log, files }) {
  const call = piiFence(rawCall);
  const providers = await listProviders(call);
  if (args.providers) {
    for (const [id, p] of providers) {
      if (!isAllowedProvider(p)) { log(`provider ${p.name} [${p.label}]  (not TEST_ or managed: refused)`); continue; }
      const models = await call("GET", `/1/providers/${id}/models`).catch(() => []);
      log(`provider ${p.name} [${p.label}]  candidates: ${CANDIDATES.filter((m) => (models || []).includes(m)).join(", ") || "none"}`);
    }
    return null;
  }
  const [providerId, provider] = pickProvider(providers, args.provider);
  const served = await call("GET", `/1/providers/${providerId}/models`).catch(() => []);
  const listed = await listAgents(call);
  for (const a of listed) call.own(a);
  const row = listed.find((a) => a.name === AGENT_NAME);
  const stored = row ? await call("GET", `/1/agents/${row.id}`) : null;
  const keep = !args.model && stored && (served || []).includes(stored.model) ? stored.model : null;
  const model = keep || pickModel(served, args.model);
  const body = piiBody({ providerId, model });
  log(`provider ${provider.name} [${provider.label}] · model ${model}`);

  let agent = null;
  if (row) {
    const drift = piiDrift(stored, body);
    if (drift.length && args.converge && !args.dryRun) {
      await call("PATCH", `/1/agents/${row.id}`, {
        model, providerId, instructions: body.instructions, tools: body.tools,
        config: { ...(stored.config || {}), ...body.config, search_prefetch: undefined },
      });
      await publish(call, row.id, log);
      log(`fix    ${AGENT_NAME}  ${row.id}  (${drift.join("; ")})`);
    } else {
      const verb = drift.length && args.converge ? "would fix" : "adopt ";
      log(`${verb}  ${AGENT_NAME}  ${row.id}${drift.length ? `  (differs: ${drift.join("; ")})` : ""}`);
    }
    agent = { agentId: row.id, model };
  } else if (args.dryRun) {
    log(`create ${AGENT_NAME}  (dry run: skipped)`);
  } else {
    const made = await call("POST", "/1/agents", body);
    await publish(call, made.id, log);
    log(`create ${AGENT_NAME}  ${made.id}`);
    agent = { agentId: made.id, model };
  }

  if (args.writeConfig) {
    const key = browserKey(readConfig(await files.read(args.keysFrom)), appId);
    if (!key) throw new Error(`no block of ${path.basename(args.keysFrom)} holds a browser key for this app`);
    if (args.dryRun || !agent) {
      log(`would write the pii block into ${path.basename(args.writeConfig)}${agent ? "" : " once the agent exists"}`);
    } else {
      const src = await files.read(args.writeConfig).catch(() => "");
      const next = withPiiBlock(src, piiBlock({ region, host, appId, agentStudioApiKey: key, ...agent }));
      readConfig(next);
      await files.write(args.writeConfig, next);
      log(`wrote the pii block into ${path.basename(args.writeConfig)}`);
    }
  }
  return agent;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const log = (...a) => console.error(...a);
  const appId = process.env.APP_ID || "";
  const key = process.env.ADMIN_KEY || "";
  if (!appId || !key) throw new Error("set APP_ID and ADMIN_KEY in the environment");
  const { region, host } = await hostForRegion(args.region, (h) => client({ host: h, appId, key }));
  log(`host ${host} · app ${appId.slice(0, 3)}… · writes only ${AGENT_PREFIX}…${args.dryRun ? " · dry run" : ""}`);
  const files = {
    read: (f) => readFile(f, "utf8"),
    write: (f, s) => writeFile(f, s, { mode: 0o600 }),
  };
  const agent = await run({ args, appId, region, host, call: client({ host, appId, key }), log, files });
  if (agent) console.log(`${AGENT_NAME}\t${agent.agentId}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((err) => {
  console.error(`pii-provision: ${err.message}`);
  process.exitCode = 1;
});

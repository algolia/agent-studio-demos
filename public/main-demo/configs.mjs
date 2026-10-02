/* ───────────────────────────────────────────────────────────────
   configs.mjs — which agent a set of toggles means.

   One module, two readers: the page imports it to turn a lane's toggles into
   an agent id, and tools/main-demo-provision.mjs imports the same bytes to
   turn a key back into an agent config. `.mjs` so Node 20 loads it as ESM
   without a package.json.

   A toggle set never PATCHes a live agent. It names a variant, and each
   variant is its own agent, created once by the provisioning script.
   Prefetch off is one of them: an agent whose `searchPrefetch` is false.
   The completions call takes no per-request override.
   ─────────────────────────────────────────────────────────────── */

/** every toggle a lane shows, in display order */
export const TOGGLES = [
  { id: "prefetch", label: "Search prefetch", kind: "bool" },
  { id: "memory", label: "Memory", kind: "bool" },
  { id: "guardrails", label: "Guardrails", kind: "bool" },
  { id: "suggestions", label: "Suggestions", kind: "bool" },
];

export const BASE_TOGGLES = Object.freeze({
  prefetch: false, memory: false, guardrails: false, suggestions: false,
});

/** the toggles' ids, in key order */
const FLAGS = TOGGLES.map((tg) => tg.id);

/** the variants the script creates without being asked */
export const MANIFEST = [
  { name: "main-demo-base", toggles: { ...BASE_TOGGLES } },
  { name: "main-demo-prefetch", toggles: { ...BASE_TOGGLES, prefetch: true } },
  { name: "main-demo-memory", toggles: { ...BASE_TOGGLES, memory: true } },
  { name: "main-demo-guardrails", toggles: { ...BASE_TOGGLES, guardrails: true } },
  { name: "main-demo-suggestions", toggles: { ...BASE_TOGGLES, suggestions: true } },
];

/** toggles with every field present and every value legal */
export function normalize(toggles) {
  const t = { ...BASE_TOGGLES, ...(toggles || {}) };
  const out = {};
  for (const k of FLAGS) out[k] = t[k] === true || t[k] === 1;
  return out;
}

/**
 * The config hash: a canonical, readable key. Readable on purpose, because
 * it is also what a visitor pastes into the provisioning command.
 */
export function configKey(toggles) {
  const t = normalize(toggles);
  return FLAGS.map((k) => `${k}=${t[k] ? 1 : 0}`).join(",");
}

/** the inverse of configKey; throws on anything configKey would not write */
export function parseKey(key) {
  const out = {};
  for (const pair of String(key).split(",")) {
    const [k, v] = pair.split("=");
    if (FLAGS.includes(k) && (v === "0" || v === "1")) out[k] = v === "1";
    else throw new Error(`unknown toggle in key: ${pair}`);
  }
  const t = normalize(out);
  if (configKey(t) !== key) throw new Error(`not a canonical key: ${key}`);
  return t;
}

/** a stable agent name for any toggle set, so the script can adopt by name */
export function agentName(toggles) {
  const key = configKey(toggles);
  const known = MANIFEST.find((m) => configKey(m.toggles) === key);
  if (known) return known.name;
  const t = normalize(toggles);
  const bits = [];
  for (const k of FLAGS) if (t[k]) bits.push(k);
  return `main-demo-${bits.join("-")}`;
}

/* check-copy: off */
const GUARDRAIL = {
  enabled: true,
  scope: "A shopping assistant for the products in this store's catalog.",
  categories: [
    {
      name: "off_topic",
      scope: "input",
      description: "Requests unrelated to shopping, products, orders or the store.",
      fallbackResponse: "I can only help with questions about our products.",
    },
  ],
};
/* check-copy: on */

/**
 * The `config` block a variant's agent carries, layered over the base
 * agent's own config. Only the toggled features are written; everything
 * else (model, tools, instructions) is copied from the base agent by the
 * script, so the variants differ in exactly one place.
 */
export function agentConfigPatch(toggles) {
  const t = normalize(toggles);
  return {
    // snake_case on purpose: the backend normalizes `searchPrefetch` only when
    // `search_prefetch` is absent, so a copied base config would otherwise win
    search_prefetch: t.prefetch ? { enabled: true } : false,
    memory: { enabled: t.memory },
    guardrail: t.guardrails ? GUARDRAIL : { enabled: false },
    suggestions: { enabled: t.suggestions },
  };
}

/** read a stored agent config back into toggles, whatever spelling it used */
export function togglesFromAgentConfig(config) {
  const c = config || {};
  const sp = c.search_prefetch !== undefined ? c.search_prefetch : c.searchPrefetch;
  const prefetch = sp === true || Boolean(sp && typeof sp === "object" && sp.enabled !== false);
  const on = (v) => Boolean(v && typeof v === "object" && v.enabled === true);
  return normalize({ prefetch, memory: on(c.memory), guardrails: on(c.guardrail), suggestions: on(c.suggestions) });
}

/**
 * What a lane should call for a toggle set.
 *
 *   { status: "agent", agentId, entry, key }         the exact variant exists
 *   { status: "missing", key, command }               nothing serves it yet
 *
 * `variants` is the `variants` map of variants.json: key → { agentId, ... }.
 */
export function resolveVariant(toggles, variants, { commandPrefix } = {}) {
  const t = normalize(toggles);
  const key = configKey(t);
  const table = variants || {};
  if (table[key] && table[key].agentId) {
    return { status: "agent", key, agentId: table[key].agentId, entry: table[key] };
  }
  // a manifest variant needs no --add: the plain run creates every one of them
  const inManifest = MANIFEST.some((m) => configKey(m.toggles) === key);
  return { status: "missing", key, command: provisionCommand(inManifest ? [] : [key], commandPrefix) };
}

/** the exact shell line that creates a missing variant */
export function provisionCommand(keys, prefix) {
  const env = prefix || "MAIN_DEMO_HOST=http://127.0.0.1:8000 APP_ID=$APP_ID ADMIN_KEY=$ADMIN_KEY";
  const adds = (keys || []).map((k) => ` --add '${k}'`).join("");
  return `${env} node tools/main-demo-provision.mjs${adds}`;
}

/** query parameters the completions URL carries */
export function completionQuery() {
  // cache=false: a race against a stored answer measures the cache, not the agent
  return { compatibilityMode: "ai-sdk-5", stream: "true", cache: "false" };
}

/* ── Edited configs: one agent per content hash ─────────────────
   A lane may edit the blocks a toggle set writes. The edited config names
   its own agent, main-demo-<hash of the config>, created once from
   main-demo-base and never PATCHed: two lanes with the same config share
   it, and no edit can change an agent another lane is running. */

/* check-copy: off */
/** the editable fields of each config block, with the backend's defaults and bounds */
export const BLOCKS = [
  { id: "search_prefetch", label: "Search prefetch", fields: [
    { path: "enabled", label: "Enabled", type: "bool", def: true },
    { path: "indexName", label: "Index", type: "text", def: null, hint: "empty: the agent's first search tool" },
    { path: "conversationWindow", label: "Conversation window", type: "int", min: 1, max: 5, def: 1,
      hint: "latest user turns in the query" },
    { path: "minInformativeTokens", label: "Min informative tokens", type: "int", min: 0, max: 10, def: 2,
      hint: "shorter queries skip prefetch" },
    { path: "requireHits", label: "Require hits", type: "bool", def: true },
    { path: "instruction", label: "Instruction", type: "instruction", def: false },
  ] },
  { id: "memory", label: "Memory", fields: [
    { path: "enabled", label: "Enabled", type: "bool", def: false },
    { path: "model", label: "Model", type: "text", def: null, hint: "empty: the agent's model" },
    { path: "tools", label: "Memory tools", type: "bool", def: true },
    { path: "preload", label: "Preload", type: "bool", def: true },
    { path: "preflight", label: "Preflight", type: "bool", def: true },
  ] },
  { id: "guardrail", label: "Guardrails", fields: [
    { path: "enabled", label: "Enabled", type: "bool", def: false },
    { path: "required", label: "Required", type: "bool", def: false },
    { path: "model", label: "Model", type: "text", def: null, hint: "empty: the agent's model" },
    { path: "scope", label: "Scope", type: "text", def: null },
    { path: "noViolationExamples", label: "No-violation examples", type: "text", def: null },
    { path: "categories", label: "Categories", type: "json", def: [] },
  ] },
  { id: "suggestions", label: "Suggestions", fields: [
    { path: "enabled", label: "Enabled", type: "bool", def: false },
    { path: "model", label: "Model", type: "text", def: null, hint: "empty: the agent's model" },
    { path: "systemPrompt", label: "System prompt", type: "text", def: null },
    { path: "generation.maxCount", label: "Max count", type: "int", min: 1, max: 5, def: 3 },
    { path: "generation.maxWords", label: "Max words", type: "int", min: 5, max: 15, def: 8 },
    { path: "generation.timeoutSeconds", label: "Timeout (s)", type: "int", min: 1, max: 30, def: 10 },
    { path: "generation.retryAttempts", label: "Retries", type: "int", min: 0, max: 3, def: 1 },
    { path: "context.maxMessages", label: "Context messages", type: "int", min: 1, max: 50, def: 10 },
    { path: "context.includeToolOutputs", label: "Include tool outputs", type: "bool", def: false },
  ] },
  { id: "sendUsage", label: "Stream token usage", scalar: true, fields: [
    { path: "", label: "sendUsage", type: "bool", def: false },
  ] },
];
/* check-copy: on */

const getPath = (o, p) => (p ? p.split(".").reduce((x, k) => (x && typeof x === "object" ? x[k] : undefined), o) : o);

function setPath(o, p, v) {
  const keys = p.split(".");
  let x = o;
  for (const k of keys.slice(0, -1)) x = x[k] && typeof x[k] === "object" ? x[k] : (x[k] = {});
  x[keys[keys.length - 1]] = v;
  return o;
}

/** a block as the editor shows it: every field present, stored values over defaults */
export function blockValues(blockId, stored) {
  const b = BLOCKS.find((x) => x.id === blockId);
  if (b.scalar) return { "": stored === undefined ? b.fields[0].def : Boolean(stored) };
  const src = stored === true ? { enabled: true } : stored === false || !stored ? { enabled: false } : stored;
  const out = {};
  for (const f of b.fields) {
    const v = getPath(src, f.path);
    out[f.path] = v === undefined ? f.def : v;
  }
  return out;
}

/** the problems with a block's values, by field path; empty when the backend would accept it */
export function validateBlock(blockId, values) {
  const b = BLOCKS.find((x) => x.id === blockId);
  const errors = {};
  for (const f of b.fields) {
    const v = values[f.path];
    if (f.type === "int" && (!Number.isInteger(v) || v < f.min || v > f.max)) errors[f.path] = `${f.min} to ${f.max}`;
    if (f.type === "enum" && !f.options.includes(v)) errors[f.path] = "not an option";
    if (f.type === "json" && !Array.isArray(v)) errors[f.path] = "a JSON list";
  }
  return errors;
}

/** editor values back to the stored block, fields equal to their default left out */
export function blockFrom(blockId, values) {
  const b = BLOCKS.find((x) => x.id === blockId);
  if (b.scalar) return Boolean(values[""]);
  const out = {};
  for (const f of b.fields) {
    const v = values[f.path];
    const empty = v === null || v === undefined || v === "";
    if (f.path === "enabled") { setPath(out, f.path, Boolean(v)); continue; }
    if (empty || JSON.stringify(v) === JSON.stringify(f.def)) continue;
    setPath(out, f.path, v);
  }
  return out;
}

/** JSON with sorted keys: the same config always hashes the same */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** FNV-1a, 32 bits, as 8 hex digits: short enough for an agent name, stable across runtimes */
export function hashConfig(blocks) {
  let h = 0x811c9dc5;
  const s = canonical(blocks);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** what a toggle set writes, each block in its stored (default-pruned) form */
export function toggleBlocks(toggles) {
  const p = agentConfigPatch(toggles);
  const out = {};
  for (const b of BLOCKS) {
    if (b.scalar) continue;
    const raw = p[b.id];
    out[b.id] = blockFrom(b.id, blockValues(b.id, raw === false ? { enabled: false } : raw));
  }
  return out;
}

/** the whole config a lane asks for: its toggles' blocks, with its edits laid over them */
export function effectiveBlocks(toggles, edits) {
  const out = toggleBlocks(toggles);
  for (const [k, v] of Object.entries(edits || {})) out[k] = v;
  if (out.sendUsage === false) delete out.sendUsage;
  return out;
}

/** edits that change nothing are no edits: the lane stays on its manifest variant */
export function isCustom(toggles, edits) {
  return canonical(effectiveBlocks(toggles, edits)) !== canonical(effectiveBlocks(toggles, null));
}

export const customKey = (blocks) => `custom=${hashConfig(blocks)}`;
export const customName = (blocks) => `main-demo-${hashConfig(blocks)}`;

/**
 * Resolve an edited config: an agent the page or the script already made
 * for this hash, or `{ status: "custom" }` with the name to create and the
 * command that creates it.
 */
export function resolveCustom(blocks, variants, local, { commandPrefix } = {}) {
  const key = customKey(blocks);
  const hit = (variants && variants[key]) || (local && local[key]);
  if (hit && hit.agentId) return { status: "agent", key, agentId: hit.agentId, entry: hit, custom: true };
  const env = commandPrefix || "MAIN_DEMO_HOST=http://127.0.0.1:8000 APP_ID=$APP_ID ADMIN_KEY=$ADMIN_KEY";
  return {
    status: "custom", key, name: customName(blocks), blocks,
    command: `${env} node tools/main-demo-provision.mjs --config '${canonical(blocks)}'`,
  };
}

/** the parts of the base agent a variant copies, instructions included, at creation time */
export function baseTemplate(base) {
  const keep = ["instructions", "systemPrompt", "providerId", "model", "tools", "description"];
  const t = {};
  for (const k of keep) if (base[k] !== undefined && base[k] !== null) t[k] = base[k];
  return t;
}

/** the create body for an agent with these config blocks over main-demo-base */
export function customAgentBody(base, blocks, name = customName(blocks)) {
  const config = { ...(base.config || {}) };
  delete config.searchPrefetch;
  delete config.search_prefetch;
  const own = { ...blocks };
  if (own.search_prefetch && own.search_prefetch.enabled === false) own.search_prefetch = false;
  return { ...baseTemplate(base), name, config: { ...config, ...own } };
}

/** a stored agent config read back as the blocks it was hashed from (the inverse of customAgentBody) */
export function blocksFromConfig(config) {
  const c = config || {};
  const out = {};
  for (const b of BLOCKS) {
    if (b.scalar) { if (c[b.id] === true) out[b.id] = true; continue; }
    const raw = b.id === "search_prefetch" ? (c.search_prefetch !== undefined ? c.search_prefetch : c.searchPrefetch) : c[b.id];
    out[b.id] = blockFrom(b.id, blockValues(b.id, raw === false || raw === undefined ? { enabled: false } : raw === true ? { enabled: true } : raw));
  }
  return out;
}

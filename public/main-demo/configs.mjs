/* ───────────────────────────────────────────────────────────────
   configs.mjs — which agent a set of toggles means.

   One module, two readers: the page imports it to turn a lane's toggles into
   an agent id, and tools/main-demo-provision.mjs imports the same bytes to
   turn a key back into an agent config. `.mjs` so Node 20 loads it as ESM
   without a package.json.

   A toggle set never PATCHes a live agent. It names a variant, and each
   variant is its own agent, created once by the provisioning script. The
   one exception is prefetch off: the backend takes `?searchPrefetch=false`
   on the completions URL, so a prefetch agent can stand in for its
   prefetch-off twin, and the lane says which of the two happened.
   ─────────────────────────────────────────────────────────────── */

export const PREFETCH_FORMATS = ["tool_pair", "user_fold", "persisted_tool_pair"];

/** every toggle a lane shows, in display order */
export const TOGGLES = [
  { id: "prefetch", label: "Search prefetch", kind: "prefetch" },
  { id: "memory", label: "Memory", kind: "bool" },
  { id: "guardrails", label: "Guardrails", kind: "bool" },
  { id: "suggestions", label: "Suggestions", kind: "bool" },
];

export const BASE_TOGGLES = Object.freeze({
  prefetch: "off", memory: false, guardrails: false, suggestions: false,
});

/** the variants the script creates without being asked */
export const MANIFEST = [
  { name: "main-demo-base", toggles: { ...BASE_TOGGLES } },
  { name: "main-demo-prefetch", toggles: { ...BASE_TOGGLES, prefetch: "tool_pair" } },
  { name: "main-demo-prefetch-user-fold", toggles: { ...BASE_TOGGLES, prefetch: "user_fold" } },
  { name: "main-demo-prefetch-persisted", toggles: { ...BASE_TOGGLES, prefetch: "persisted_tool_pair" } },
  { name: "main-demo-memory", toggles: { ...BASE_TOGGLES, memory: true } },
  { name: "main-demo-guardrails", toggles: { ...BASE_TOGGLES, guardrails: true } },
  { name: "main-demo-suggestions", toggles: { ...BASE_TOGGLES, suggestions: true } },
];

/** toggles with every field present and every value legal */
export function normalize(toggles) {
  const t = { ...BASE_TOGGLES, ...(toggles || {}) };
  if (t.prefetch === true) t.prefetch = "tool_pair";
  if (!PREFETCH_FORMATS.includes(t.prefetch)) t.prefetch = "off";
  for (const k of ["memory", "guardrails", "suggestions"]) t[k] = Boolean(t[k]);
  return t;
}

/**
 * The config hash: a canonical, readable key. Readable on purpose, because
 * it is also what a visitor pastes into the provisioning command.
 */
export function configKey(toggles) {
  const t = normalize(toggles);
  return [
    `prefetch=${t.prefetch}`,
    `memory=${t.memory ? 1 : 0}`,
    `guardrails=${t.guardrails ? 1 : 0}`,
    `suggestions=${t.suggestions ? 1 : 0}`,
  ].join(",");
}

/** the inverse of configKey; throws on anything configKey would not write */
export function parseKey(key) {
  const out = {};
  for (const pair of String(key).split(",")) {
    const [k, v] = pair.split("=");
    if (k === "prefetch") out.prefetch = v;
    else if (["memory", "guardrails", "suggestions"].includes(k)) out[k] = v === "1";
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
  if (t.prefetch !== "off") bits.push(`prefetch-${t.prefetch.replace(/_/g, "-")}`);
  for (const k of ["memory", "guardrails", "suggestions"]) if (t[k]) bits.push(k);
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
    search_prefetch: t.prefetch === "off" ? false : { enabled: true, injectionFormat: t.prefetch },
    memory: { enabled: t.memory },
    guardrail: t.guardrails ? GUARDRAIL : { enabled: false },
    suggestions: { enabled: t.suggestions },
  };
}

/** read a stored agent config back into toggles, whatever spelling it used */
export function togglesFromAgentConfig(config) {
  const c = config || {};
  const sp = c.search_prefetch !== undefined ? c.search_prefetch : c.searchPrefetch;
  let prefetch = "off";
  if (sp === true) prefetch = "tool_pair";
  else if (sp && typeof sp === "object" && sp.enabled !== false) {
    const fmt = String(sp.injectionFormat || sp.injection_format || "tool_pair").trim().toLowerCase().replace(/-/g, "_");
    prefetch = PREFETCH_FORMATS.includes(fmt) ? fmt : "tool_pair";
  }
  const on = (v) => Boolean(v && typeof v === "object" && v.enabled === true);
  return normalize({ prefetch, memory: on(c.memory), guardrails: on(c.guardrail), suggestions: on(c.suggestions) });
}

/**
 * What a lane should call for a toggle set.
 *
 *   { status: "agent", agentId, entry, key }         the exact variant exists
 *   { status: "query", agentId, entry, key, via }     prefetch off applied per request
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
  if (t.prefetch === "off") {
    // any prefetch twin works: the query parameter turns the whole block off
    for (const fmt of PREFETCH_FORMATS) {
      const twin = configKey({ ...t, prefetch: fmt });
      if (table[twin] && table[twin].agentId) {
        return { status: "query", key, via: twin, agentId: table[twin].agentId, entry: table[twin] };
      }
    }
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

/** query parameters the completions URL carries for a resolution */
export function completionQuery(resolution) {
  // cache=false: a race against a stored answer measures the cache, not the agent
  const q = { compatibilityMode: "ai-sdk-5", stream: "true", cache: "false" };
  if (resolution && resolution.status === "query") q.searchPrefetch = "false";
  return q;
}

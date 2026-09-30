/* ───────────────────────────────────────────────────────────────
   agents.mjs — the page makes the agent an edited config names.

   Create or adopt, never PATCH: an edited config is main-demo-<hash>,
   copied from main-demo-base at creation (model, provider, tools and the
   base's current instructions) with the edited blocks on top, then
   published. An agent that already carries the name is adopted as is.
   What the page made is remembered in this browser, next to what
   variants.json knows; tools/main-demo-provision.mjs --config does the same
   from a shell, for a key without write rights.
   ─────────────────────────────────────────────────────────────── */

import { customName, customAgentBody } from "./configs.mjs";

const STORE = "main-demo:custom-variants";

/** config key → { agentId, name, createdAt }, for the agents this browser made or adopted */
export function loadLocal() {
  try {
    const j = JSON.parse(localStorage.getItem(STORE) || "{}");
    return j && typeof j === "object" ? j : {};
  } catch (_) {
    return {};
  }
}

export function saveLocal(key, entry) {
  const all = { ...loadLocal(), [key]: entry };
  try { localStorage.setItem(STORE, JSON.stringify(all)); } catch (_) { /* private mode: this page only */ }
  return all;
}

/** a JSON client for the Agent Studio API; the key rides in headers and nowhere else */
export function apiClient({ host, appId, apiKey }) {
  const headers = {
    "content-type": "application/json",
    "x-algolia-application-id": appId || "",
    "x-algolia-api-key": apiKey || "",
  };
  return async function call(method, path, body) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 30000);
    let res;
    try {
      res = await fetch(host + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { /* not JSON */ }
    if (!res.ok) {
      const detail = json ? JSON.stringify(json.detail || json.message || json).slice(0, 240) : "";
      const err = new Error(`${method} ${path.split("?")[0]} → ${res.status} ${detail}`.trim());
      err.status = res.status;
      throw err;
    }
    return json;
  };
}

export async function listAgents(call) {
  const all = [];
  for (let page = 1; page < 50; page++) {
    const j = await call("GET", `/1/agents?page=${page}&limit=100`);
    const items = (j && (j.data || j.agents || j.items)) || [];
    all.push(...items);
    const pg = j && j.pagination;
    if (!items.length || !pg || page >= (pg.totalPages || pg.nbPages || 1)) break;
  }
  return all;
}

/**
 * The agent for these blocks: adopted by name when it exists, otherwise
 * created from main-demo-base and published. Returns { agentId, name, status }.
 */
export async function ensureCustomAgent(call, blocks, { baseName = "main-demo-base" } = {}) {
  const name = customName(blocks);
  const agents = await listAgents(call);
  const found = agents.find((a) => a.name === name);
  if (found) return { agentId: found.id, name, status: "adopted" };
  const baseRow = agents.find((a) => a.name === baseName);
  if (!baseRow) throw new Error(`no agent named ${baseName} to copy`);
  const base = await call("GET", `/1/agents/${baseRow.id}`);
  const created = await call("POST", "/1/agents", customAgentBody(base, blocks, name));
  try {
    await call("POST", `/1/agents/${created.id}/publish`);
  } catch (err) {
    if (err.status !== 409) throw err;
  }
  return { agentId: created.id, name, status: "created" };
}

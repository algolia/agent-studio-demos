/* ───────────────────────────────────────────────────────────────
   demo-config.mjs: one place that turns window.DEMO_CONFIG into the block
   a page reads.

   DEMO_CONFIG.default holds what every demo shares: {host, appId, apiKey
   (search-only), agentId, index}. A demo's own block (tasks, mainDemo,
   prefetchAlbums…) overrides only what differs. Older files carry host,
   appId and apiKey at the top level; they still work, below `default`.

     merged = top-level legacy keys < default < first named block present

   Also published as window.DemoConfig, for the pages whose scripts are not
   modules. Pure: no DOM.
   ─────────────────────────────────────────────────────────────── */

const usable = (b) => Boolean(b) && typeof b === "object" && !Array.isArray(b);
const LEGACY = ["host", "appId", "apiKey"];

/**
 * The block for a demo: `names` are its candidate blocks in order.
 *   { block, name }; name is null when only default and legacy keys answered,
 *   block is null when nothing did.
 * A demo's variants without an agentId take the merged block's agentId, and
 * a block with only apiKey is also readable as agentStudioApiKey (main-demo's name for it).
 */
export function blockFor(names, root = globalThis.DEMO_CONFIG) {
  const r = usable(root) ? root : {};
  const name = names.find((n) => usable(r[n])) || null;
  const legacy = Object.fromEntries(LEGACY.filter((k) => r[k]).map((k) => [k, r[k]]));
  const merged = { ...legacy, ...(usable(r.default) ? r.default : {}), ...(name ? r[name] : {}) };
  if (!Object.keys(merged).length) return { block: null, name };
  if (!merged.agentStudioApiKey && merged.apiKey) merged.agentStudioApiKey = merged.apiKey;
  if (usable(merged.variants) && merged.agentId) {
    merged.variants = Object.fromEntries(
      Object.entries(merged.variants).map(([k, v]) => [k, usable(v) && !v.agentId ? { ...v, agentId: merged.agentId } : v]),
    );
  }
  return { block: merged, name };
}

if (typeof window !== "undefined") window.DemoConfig = { blockFor };

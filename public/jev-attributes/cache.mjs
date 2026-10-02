/* ───────────────────────────────────────────────────────────────
   cache.mjs: Jev's answers, kept in this browser, so asking the same thing
   twice costs nothing.

   The key is a SHA-256 of the request as sent ({ model, state, questions }),
   so a different question, mode or view of the records is a different key.
   The value is Jev's answer with the ms and usage it first came with. Held
   in memory, mirrored to localStorage under one slot, capped: the oldest
   entry goes first. Every storage call is wrapped, because private windows
   and blocked site data throw. The Answer step is never cached.
   ─────────────────────────────────────────────────────────────── */

export const CACHE_SLOT = "jev-attributes.cache";
export const CACHE_CAP = 200;

function safe(fn, fallback = null) {
  try { return fn(); } catch (_) { return fallback; }
}

/** hex SHA-256 of the request body as JSON */
export async function cacheKey(body) {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** `storage` is localStorage, a fake in a test, or null for memory only */
export function createJevCache({ storage = safe(() => globalThis.localStorage), cap = CACHE_CAP } = {}) {
  const mem = new Map();
  const raw = safe(() => storage && storage.getItem(CACHE_SLOT));
  const saved = raw ? safe(() => JSON.parse(raw)) : null;
  if (Array.isArray(saved)) for (const [k, v] of saved.slice(-cap)) if (typeof k === "string" && v && typeof v === "object") mem.set(k, v);

  const persist = () => safe(() => storage && storage.setItem(CACHE_SLOT, JSON.stringify([...mem])));

  return {
    get: (key) => mem.get(key) || null,
    put(key, entry) {
      mem.delete(key);
      mem.set(key, entry);
      while (mem.size > cap) mem.delete(mem.keys().next().value);
      persist();
    },
    clear() {
      mem.clear();
      safe(() => storage && storage.removeItem(CACHE_SLOT));
    },
    size: () => mem.size,
  };
}

/**
 * A Jev call through the cache: `call()` runs only on a miss. A hit returns
 * the first answer marked `cached`, its ms as first measured.
 */
export async function cachedCall(cache, body, call) {
  const key = await cacheKey(body);
  const hit = cache.get(key);
  if (hit) return { ...hit, cached: true };
  const a = await call();
  cache.put(key, { answers: a.answers, model: a.model, usage: a.usage, ms: a.ms });
  return { ...a, cached: false };
}

/* ───────────────────────────────────────────────────────────────
   byok.mjs — the visitor's own Jev key, held in this browser only.

   By default a key lives in memory and is gone on reload. The visitor may
   opt in to keeping it for the tab (sessionStorage) or on this device
   (localStorage); every storage call is wrapped, because private windows
   and blocked site data throw. Nothing here sends, logs or prints a key.
   ─────────────────────────────────────────────────────────────── */

export const NAMES = ["jev"];
export const KEEP = ["memory", "tab", "device"];
const SLOT = "jev-attributes.keys";

function safe(fn, fallback = null) {
  try { return fn(); } catch (_) { return fallback; }
}

/** `stores` is { tab, device }: sessionStorage and localStorage, or fakes in a test */
export function createKeyStore(stores = { tab: safe(() => globalThis.sessionStorage), device: safe(() => globalThis.localStorage) }) {
  const mem = { jev: "" };
  let keep = "memory";

  for (const where of ["device", "tab"]) {
    const raw = safe(() => stores[where] && stores[where].getItem(SLOT));
    const saved = raw ? safe(() => JSON.parse(raw)) : null;
    if (saved && typeof saved === "object") {
      for (const n of NAMES) if (typeof saved[n] === "string") mem[n] = saved[n];
      keep = where;
      break;
    }
  }

  const persist = () => {
    for (const where of ["tab", "device"]) safe(() => stores[where] && stores[where].removeItem(SLOT));
    if (keep !== "memory" && stores[keep]) safe(() => stores[keep].setItem(SLOT, JSON.stringify(mem)));
  };

  return {
    get: (n) => mem[n] || "",
    all: () => ({ jev: mem.jev || null }),
    set(n, v) { if (NAMES.includes(n)) { mem[n] = String(v || "").trim(); persist(); } },
    keep: () => keep,
    setKeep(where) { if (KEEP.includes(where)) { keep = where; persist(); } },
    forget() { for (const n of NAMES) mem[n] = ""; keep = "memory"; persist(); },
  };
}

/** a JWT's expiry as epoch ms, read locally from its payload; null when it is not a JWT */
export function jwtExpiry(token) {
  const part = String(token || "").split(".")[1];
  if (!part) return null;
  const json = safe(() => {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    return JSON.parse(globalThis.atob ? globalThis.atob(b64) : Buffer.from(b64, "base64").toString("utf8"));
  });
  return json && Number.isFinite(json.exp) ? json.exp * 1000 : null;
}

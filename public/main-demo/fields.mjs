/* ───────────────────────────────────────────────────────────────
   fields.mjs — which attribute of a record a product card shows.

   Pure, so the rules are testable without React: a card asks for a title,
   images, a price and one line, and each is a list of dotted paths tried in
   order (`image_urls.0`, `price.value`). Records are messy — arrays with empty
   tail entries, a first image that is an empty string — so an empty value
   never wins while a later candidate has something.
   ─────────────────────────────────────────────────────────────── */

export const FIELD_DEFAULTS = {
  title: ["name", "title", "product_name", "label"],
  image: ["image", "image_url", "imageUrl", "image_urls", "images", "thumbnail", "picture"],
  price: ["price.value", "price", "salePrice", "sale_price", "price_usd"],
  line: ["description", "short_description", "brand", "category", "categories.0"],
  currency: ["price.currency", "currency", "currency_code"],
  // a BlurHash string: the record's own preview, drawn when no image loads
  blurhash: ["image_blurred", "blurhash"],
};

const empty = (v) => v === undefined || v === null || v === "" || (Array.isArray(v) && !v.some((x) => !empty(x)));

/** every non-empty value one dotted path reaches, in order */
export function resolve(item, pathStr) {
  const parts = String(pathStr).split(".");
  let cur = item;
  for (let i = 0; i < parts.length; i++) {
    if (cur == null) return [];
    const k = parts[i];
    if (Array.isArray(cur) && /^\d+$/.test(k)) {
      // `list.0` means "the first usable entry from index 0 on"
      const rest = parts.slice(i + 1).join(".");
      const out = [];
      for (const entry of cur.slice(Number(k))) {
        out.push(...(rest ? resolve(entry, rest) : empty(entry) ? [] : [entry]));
      }
      return out;
    }
    cur = cur[k];
  }
  if (Array.isArray(cur)) return cur.filter((x) => !empty(x) && typeof x !== "object");
  return empty(cur) ? [] : [cur];
}

/** the first usable value across the candidate paths */
export function pick(item, paths) {
  for (const p of paths) {
    const vals = resolve(item, p);
    if (vals.length) return vals[0];
  }
  return undefined;
}

/** every distinct image URL a record offers, best first */
export function imageCandidates(item, paths) {
  const seen = new Set();
  for (const p of paths) {
    for (const v of resolve(item, p)) if (typeof v === "string") seen.add(v);
  }
  return [...seen];
}

/** the configured paths first, then the defaults */
export function fieldsFrom(cfg) {
  const f = (cfg && cfg.fields) || {};
  const out = {};
  for (const k of Object.keys(FIELD_DEFAULTS)) {
    out[k] = f[k] ? [].concat(f[k], FIELD_DEFAULTS[k]) : FIELD_DEFAULTS[k];
  }
  return out;
}

export function priceText(p, currency) {
  if (p === undefined) return "";
  if (typeof p !== "number") return String(p);
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currency || "USD" }).format(p);
  } catch (_) {
    return `${p} ${currency || ""}`.trim();
  }
}

export function lineText(v) {
  const s = Array.isArray(v) ? v.join(", ") : String(v || "");
  return s.length > 90 ? s.slice(0, 88).trimEnd() + "…" : s;
}

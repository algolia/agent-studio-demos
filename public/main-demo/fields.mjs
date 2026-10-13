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

/* check-copy: off */
/** product types a title may name, as the tile prints them; `|stem` when a title may spell it singular */
const TYPES = [
  "Headphones|headphone", "Headset", "Earbuds|earbud", "Earphones|earphone", "Speaker", "Soundbar", "Microphone", "Radio",
  "Boots|boot", "Shoes|shoe", "Sneakers|sneaker", "Sandals|sandal", "Slippers|slipper", "Socks|sock", "Jacket", "Coat",
  "Vest", "Hoodie", "Sweater", "Shirt", "Dress", "Skirt", "Pants", "Jeans", "Shorts", "Leggings", "Hat", "Cap",
  "Gloves|glove", "Backpack", "Bag", "Wallet", "Watch", "Sunglasses", "Glasses", "Ring", "Necklace", "Bracelet",
  "Earrings|earring", "Phone", "Tablet", "Laptop", "Keyboard", "Mouse", "Monitor", "Camera", "Drone", "Charger",
  "Cable", "Adapter", "Battery", "Case", "Cover", "Stand", "Mount", "Lamp", "Light", "Fan", "Heater",
  "Chair", "Table", "Desk", "Shelf", "Mattress", "Pillow", "Blanket", "Towel", "Rug", "Curtain",
  "Mug", "Cup", "Bottle", "Pan", "Pot", "Knife", "Blender", "Kettle", "Toaster", "Tent", "Sleeping bag",
  "Toy", "Puzzle", "Game", "Book", "Pen", "Notebook", "Brush", "Razor", "Shampoo", "Soap", "Lotion",
];
/* check-copy: on */

const TYPE_RE = TYPES.map((e) => {
  const [label, stem] = e.split("|");
  const root = (stem || label).toLowerCase().replace(/ /g, "\\s+");
  return [label, new RegExp(`\\b${root}(e?s)?\\b`, "i")];
});

/**
 * A card with no image: a tile named after the product's type, read from
 * its title, tinted by that type so alike products look alike. When
 * the title names no known type, its first word (often the brand) stands in.
 *   { word, hue } with hue in 0..359, or null for an empty title
 */
export function tileOf(title) {
  const t = String(title || "").trim();
  if (!t) return null;
  let best = null;
  for (const [w, re] of TYPE_RE) {
    const m = re.exec(t);
    if (m && (best === null || m.index < best.at)) best = { at: m.index, word: w };
  }
  const word = best ? best.word : t.split(/[\s,.:;/()-]+/).filter(Boolean)[0] || t.slice(0, 1);
  let h = 0;
  for (const c of word.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) % 360;
  return { word: word.charAt(0).toUpperCase() + word.slice(1), hue: h };
}

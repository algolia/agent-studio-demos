/* page.js builds every product card on the task pages, and the interesting half
   of that is pure string work: entities in catalog text have to be decoded
   before escaping (or the card paints "Cr&#232;me"), and catalog text has to be
   escaped (or a product name that looks like markup becomes markup). Both are
   testable in bare Node once `document` is the few lines page.js actually
   touches — the house pattern, same as theme.test.js.

   The textarea shim models the one browser behaviour that matters here, because
   it is the one page.js got wrong: writing .value sets the textarea's dirty
   flag, and from then on the element stops following innerHTML writes. So the
   first entity-bearing card decoded and every later one came back blank — the
   shape of bug a first-card screenshot cannot see. Reading the parsed text
   avoids the trap; the shim keeps the trap live so it cannot come back. */

const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

/* The shipped decoder is the browser's. This stand-in exists so the card logic
   runs at all; the real decode of the real catalog was checked in the page. */
const NAMED = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  eacute: "é",
  egrave: "è",
  agrave: "à",
  ccedil: "ç",
  rsquo: "’",
};

/* Decimal references in 128–159 are the awkward corner: a browser remaps them
   through windows-1252 instead of taking them literally, so a catalog's &#153;
   is a trademark sign and not U+0099. Sephora's names carry those, so the shim
   that pretends to be the decoder has to carry the table too — verified row by
   row against Chromium below, not from memory. Index 0 is code 128; "\0" is a
   code the table leaves undefined, which the browser passes through literally. */
const C1 = "€\0‚ƒ„…†‡ˆ‰Š‹Œ\0Ž\0\0‘’“”•–—˜™š›œ\0žŸ";

const decodeRefs = (s) =>
  String(s).replace(/&(#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z]\w*);/g, (whole, body) => {
    if (body[0] !== "#") return body in NAMED ? NAMED[body] : whole;
    const num = /^#[xX]/.test(body) ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    if (!Number.isFinite(num) || num > 0x10ffff) return whole;
    if (num === 0) return "�"; // what a browser puts in a text node for &#0;
    if (num >= 0x80 && num <= 0x9f && C1[num - 0x80] !== "\0") return C1[num - 0x80];
    return String.fromCodePoint(num);
  });

function textarea() {
  let content = "";
  let api = null; // null while clean: .value still follows the content
  return {
    // RCDATA: inside a textarea a reference decodes and a tag does not become a tag.
    set innerHTML(v) {
      content = decodeRefs(v);
    },
    get textContent() {
      return content;
    },
    get value() {
      return api === null ? content : api;
    },
    set value(v) {
      api = String(v);
    },
  };
}

globalThis.window = globalThis;
globalThis.document = {
  createElement: (tag) => (tag === "textarea" ? textarea() : { style: {} }),
  addEventListener: () => {},
};
require(path.join(__dirname, "..", "public", "tasks", "page.js"));
const Rush = globalThis.Rush;

const field = (html, cls) => {
  const m = html.match(new RegExp(`class="${cls}"[^>]*>([\\s\\S]*?)</`));
  return m ? m[1] : null;
};

test("the shim models the dirty-value trap the page has to avoid", () => {
  const t = textarea();
  t.innerHTML = "Cr&#232;me";
  assert.equal(t.value, "Crème");
  t.value = ""; // what page.js used to do after each read
  t.innerHTML = "S&#233;rum";
  assert.equal(t.value, "", "a dirty textarea stops following innerHTML");
  assert.equal(t.textContent, "Sérum", "the parsed text always follows");
});

test("the shim's decoder agrees with the browser it stands in for", () => {
  assert.equal(C1.length, 32, "one slot for each code in 128–159");
  /* Every pair here is what headless Chromium returned for that reference, read
     off the real textarea — the table is transcribed from the browser, so the
     shim cannot quietly disagree with the decoder the demo actually ships. */
  const rows = [
    ["&#153;", "™"],
    ["&#146;", "’"],
    ["&#147;", "“"],
    ["&#150;", "–"],
    ["&#151;", "—"],
    ["&#137;", "‰"],
    ["&#174;", "®"],
    ["&#8482;", "™"],
    ["&#0;", "�"],
  ];
  for (const [ref, want] of rows) assert.equal(decodeRefs(ref), want, `${ref} decodes as the browser does`);
});

test("a card is image tile, title, leaf category, then brand · price", () => {
  const html = Rush.hit({
    objectID: "7",
    name: "Ultra Glow Serum",
    categories_as_list: ["Beauty", "Skincare", "Face Serums"],
    brand: "SEPHORA COLLECTION",
    price: 20,
    currency: "USD",
    image: "https://cdn.example/a.jpg",
  });
  const at = ["hit-visual", "hit-title", "hit-cat", "hit-meta"].map((c) => html.indexOf(`class="${c}"`));
  assert.deepEqual(at.filter((n) => n < 0), [], "every part of the card is there");
  assert.ok(at.every((n, i) => i === 0 || n > at[i - 1]), "visual first, then the words: " + at.join(","));
  assert.match(html, /^<li data-id="7">/, "the row carries its id so a reorder can animate");
  assert.equal(field(html, "hit-cat"), "Face Serums", "the leaf of the path, not its root");
  assert.equal(field(html, "hit-meta"), "SEPHORA COLLECTION · 20 USD");
  assert.match(html, /<img src="https:\/\/cdn\.example\/a\.jpg"/, "the image sits over the tile");
});

test("entities in catalog text are decoded, not painted on the card", () => {
  const html = Rush.hit({
    objectID: "1",
    name: "Cr&#232;me Ancienne&#153; Elixir",
    categories_as_list: ["Beaut&#233;"],
    brand: "L&#8217;Or&#233;al",
    price: 12,
    currency: "USD",
  });
  assert.match(field(html, "hit-title"), /^Crème Ancienne™ Elixir$/);
  assert.equal(field(html, "hit-cat"), "Beauté");
  assert.equal(field(html, "hit-meta"), "L’Oréal · 12 USD");
  assert.doesNotMatch(html, /&(#\d+|amp|nbsp);/, "no entity survives to be read by a customer");
});

test("every card decodes, not only the first one to touch the scratch element", () => {
  const cards = [1, 2, 3].map((i) =>
    Rush.hit({
      objectID: String(i),
      name: `Cr&#232;me ${i}`,
      categories_as_list: ["S&#233;rum"],
      brand: "L&#8217;Or&#233;al",
      price: i,
      currency: "USD",
    }),
  );
  const joined = cards.join("");
  assert.equal((joined.match(/L’Oréal/g) || []).length, 3, "brand decoded on all three");
  cards.forEach((html, i) => {
    assert.equal(field(html, "hit-title"), `Crème ${i + 1}`);
    assert.equal(field(html, "hit-cat"), "Sérum");
  });
});

test("catalog text is text: a name shaped like markup stays a name", () => {
  const html = Rush.hit({
    objectID: '"><script>alert(1)</script>',
    name: '<img src=x onerror="alert(1)"> Cr&#232;me',
    categories_as_list: ["<b>Not bold</b>"],
  });
  assert.ok(!html.includes("<img"), "a product name cannot load an image");
  assert.ok(!html.includes("<script"), "nor run a script");
  assert.match(html, /&lt;img src=x onerror=&quot;alert/, "it renders as the text it is");
  assert.equal(field(html, "hit-cat"), "&lt;b&gt;Not bold&lt;/b&gt;");
  const attr = html.match(/data-id="([^"]*)"/)[1];
  assert.ok(!attr.includes("<") && !attr.includes(">"), "an objectID cannot break out of its attribute");
});

test("a refused image leaves a monogram, not a grey box", () => {
  const html = Rush.hit({ objectID: "9", name: "gentle cleanser" });
  assert.match(html, /class="hit-monogram"[^>]*>G</, "the initial stands behind the image");
  assert.ok(!html.includes("<img"), "no image field, no img tag");
  assert.equal(field(html, "hit-meta"), null, "no brand and no price, no meta line");
});

test("a page can pass a badge and a state class through", () => {
  const html = Rush.hit({ objectID: "3", name: "A" }, { badge: '<span class="badge up">kw #4</span>', cls: "below-cut" });
  assert.match(html, /^<li data-id="3" class="below-cut">/);
  assert.match(html, /<span class="badge up">kw #4<\/span>\s*<\/li>$/, "the badge lands last, as markup");
});

/* Eight languages is eight chances for a label to go missing, and the failure is
   quiet by design: `t(key, english)` falls back to English, so a typo in a key
   shows a reader the English string and shows a developer nothing at all. That is
   the right behaviour on a live page and the wrong one in a test suite, so the
   checks here are the ones the fallback hides.

   Three of them, and the third is the one that would have bitten:

     parity     every language defines the same keys. A key present in six tables
                and missing from the seventh is a page that is French except for
                one button.
     use        every key the page asks for exists, and every key defined is asked
                for. The first catches a typo, the second catches a translation
                nobody deleted when its label went away.
     entities   no `&nbsp;` in any value. Most of these strings are handed to
                `textContent`, where an entity is six visible characters — the one
                mistake that looks fine in the source and broken on screen. */

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const ROOT = path.join(__dirname, "..");
globalThis.window = globalThis;
require(path.join(ROOT, "public", "shared", "i18n.js"));

const I18N = globalThis.DEMO_I18N;
const TABLES = I18N.I18N;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const APP = read("public/chat-with-book/app.js");
const PAGE = read("public/chat-with-book/index.html");

/**
 * Every key app.js asks for. Not just `t("key", …)`: two call sites choose a key
 * before they call — the regime headings build theirs from the regime name, and the
 * plan line picks singular or plural — so the scan is for anything SHAPED like a
 * key, which catches `cond ? "plan.call1" : "plan.calls"` as well as a direct call.
 * A false positive here would have to be a dotted lower-case string that is also a
 * defined translation key, which is the same thing.
 */
const KEYISH = /"([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9-]+)+)"/g;
const usedInJs = () => [...APP.matchAll(KEYISH)].map((m) => m[1])
  .filter((k) => !/\.(js|css|html|json)$/.test(k));

/** every `data-i18n…="key"` in the markup */
const usedInHtml = () =>
  [...PAGE.matchAll(/data-i18n(?:-html|-ph|-label)?="([^"]+)"/g)].map((m) => m[1]);

const REGIME_KEYS = ["fits-budget", "budget-compact", "oversize-fold", "cost-gated"]
  .map((r) => `regime.${r}.heading`);

const used = () => [...new Set(usedInJs().concat(usedInHtml(), REGIME_KEYS))];

test("eight languages, English out of the table", () => {
  assert.equal(I18N.CODES.length, 8);
  assert.deepEqual(I18N.CODES, ["en", "de", "es", "fr", "it", "ja", "ru", "zh"]);
  assert.equal(I18N.DEFAULT, "en");
  // English is the markup and app.js, not a table — a table for it would be a
  // second copy of the copy the gate measures
  assert.equal(TABLES.en, undefined);
  assert.deepEqual(Object.keys(TABLES).sort(), ["de", "es", "fr", "it", "ja", "ru", "zh"]);
  for (const l of I18N.LANGS) {
    assert.match(l.code, /^[a-z]{2}$/);
    assert.ok(l.flag && l.native && l.english, `${l.code} is missing a name`);
    assert.equal(I18N.langOf(l.code), l);
  }
  // an unknown code is English, never a blank page
  assert.equal(I18N.known("kl"), false);
  assert.equal(I18N.setLang("kl"), "en");
  assert.equal(I18N.langOf("kl").code, "en");
});

test("every language defines exactly the same keys", () => {
  const langs = Object.keys(TABLES);
  const reference = Object.keys(TABLES.fr).sort();
  assert.ok(reference.length > 50, "the chrome is more than fifty keys");
  for (const lang of langs) {
    const keys = Object.keys(TABLES[lang]).sort();
    const missing = reference.filter((k) => !keys.includes(k));
    const extra = keys.filter((k) => !reference.includes(k));
    assert.deepEqual(missing, [], `${lang} is missing: ${missing.join(", ")}`);
    assert.deepEqual(extra, [], `${lang} has keys nobody else has: ${extra.join(", ")}`);
    for (const k of keys) {
      assert.equal(typeof TABLES[lang][k], "string", `${lang}.${k} is not a string`);
      assert.ok(TABLES[lang][k].trim(), `${lang}.${k} is empty`);
    }
  }
});

test("the page and the tables ask for the same keys", () => {
  const asked = used();
  const defined = Object.keys(TABLES.fr);
  const undefinedKeys = asked.filter((k) => !defined.includes(k));
  assert.deepEqual(undefinedKeys, [],
    `the page asks for keys no language defines: ${undefinedKeys.join(", ")}`);
  const dead = defined.filter((k) => !asked.includes(k));
  assert.deepEqual(dead, [], `translated but never used: ${dead.join(", ")}`);
});

test("no HTML entity ever reaches textContent", () => {
  for (const [lang, table] of Object.entries(TABLES)) {
    for (const [key, value] of Object.entries(table)) {
      assert.doesNotMatch(value, /&nbsp;|&mdash;|&amp;/,
        `${lang}.${key} carries an entity — use a \\u00a0 escape`);
    }
  }
});

test("only the keys the markup renders as HTML carry markup", () => {
  // `data-i18n-html` is the one path that sets innerHTML, so it is the one path
  // where a translation may carry a code span or the fold mark. Anywhere else,
  // a tag would be printed at the reader as text.
  const htmlKeys = [...PAGE.matchAll(/data-i18n-html="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(htmlKeys.length >= 3, "the lede, the title and the CTA at least");
  for (const [lang, table] of Object.entries(TABLES)) {
    for (const [key, value] of Object.entries(table)) {
      if (htmlKeys.includes(key)) continue;
      assert.doesNotMatch(value, /[<>]/, `${lang}.${key} carries markup but is set as text`);
    }
  }
  // and the ones that do carry markup carry the SAME markup as the English, or
  // the fold mark loses its class and the code spans lose their font
  for (const key of htmlKeys) {
    for (const [lang, table] of Object.entries(TABLES)) {
      const tags = (table[key].match(/<[a-z]+/g) || []).sort();
      const en = (readEnglishHtml(key).match(/<[a-z]+/g) || []).sort();
      assert.deepEqual(tags, en, `${lang}.${key} does not carry the English's tags`);
    }
  }
});

/** the English for an html key, straight out of the element that carries it */
function readEnglishHtml(key) {
  const re = new RegExp(`data-i18n-html="${key}"[^>]*>([\\s\\S]*?)</(?:p|h1|a)>`);
  const m = PAGE.match(re);
  assert.ok(m, `no element in the page carries data-i18n-html="${key}"`);
  return m[1];
}

test("t() falls back to the English, and fills what it is given", () => {
  I18N.setLang("en");
  assert.equal(I18N.t("btn.send", "Send"), "Send", "English never looks anything up");
  assert.equal(I18N.t("no.such.key", "Fallback"), "Fallback");
  // no fallback at all: the key, which is ugly and visible — never a blank
  assert.equal(I18N.t("no.such.key"), "no.such.key");

  I18N.setLang("fr");
  assert.equal(I18N.t("btn.send", "Send"), "Envoyer");
  assert.equal(I18N.t("no.such.key", "Send"), "Send", "a missing key is English, not empty");
  assert.equal(I18N.t("shelf.books.many", "9 books", { n: 9 }), "9 livres");
  // a placeholder with no value is left visible rather than rendered as undefined
  assert.equal(I18N.t("shelf.books.many", "9 books"), "{n} livres");
  assert.equal(I18N.fill("{a} and {b}", { a: "x", b: "y" }), "x and y");
  assert.equal(I18N.fill("{a}", null), "{a}");
  I18N.setLang("en");
});

test("every language's placeholders match the English call's", () => {
  // {n} in one language and {count} in another is a label that renders a brace at
  // a reader. The reference is French, and parity above makes that safe.
  for (const key of Object.keys(TABLES.fr)) {
    const want = [...TABLES.fr[key].matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const [lang, table] of Object.entries(TABLES)) {
      const got = [...table[key].matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      assert.deepEqual(got, want, `${lang}.${key} interpolates ${got} not ${want}`);
    }
  }
});

test("the head script and the module agree on which languages exist", () => {
  // The inline script in <head> resolves the stored language before first paint,
  // and it cannot read i18n.js — the module has not loaded yet. So it carries its
  // own list, and a list in two places is a list that drifts.
  const inline = PAGE.match(/\[("[a-z]{2}",?\s*)+\]\.indexOf\(saved\)/);
  assert.ok(inline, "the head script no longer carries a language list");
  const codes = [...inline[0].matchAll(/"([a-z]{2})"/g)].map((m) => m[1]);
  assert.deepEqual(codes.slice().sort(), I18N.CODES.slice().sort(),
    "the pre-paint list and DEMO_I18N.CODES have drifted apart");
});

test("a translation is not longer than the English it stands in for", () => {
  // Not a style rule — a layout one. These strings sit in buttons and in a
  // masthead, and a label that is half again as long as the English is a label
  // that wraps where the English did not. The ceiling is generous (French and
  // Russian genuinely run longer than English) and it is a ceiling, not a target.
  const LIMIT = 2.3;
  const over = [];
  for (const [key, en] of Object.entries(englishFor())) {
    for (const [lang, table] of Object.entries(TABLES)) {
      const ratio = table[key].length / Math.max(en.length, 1);
      if (ratio > LIMIT) over.push(`${lang}.${key} ${ratio.toFixed(1)}× (${table[key]})`);
    }
  }
  assert.deepEqual(over, [], `too long beside the English:\n  ${over.join("\n  ")}`);
});

/**
 * The English for every key the MARKUP carries, read out of the markup. The keys
 * that live only in app.js are not covered — their English is a template literal
 * with interpolation in it, and its length says nothing about the rendered
 * string's.
 */
function englishFor() {
  const out = {};
  for (const m of PAGE.matchAll(/data-i18n="([^"]+)"[^>]*>([^<]*)</g)) {
    const text = m[2].replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
    if (text) out[m[1]] = text;
  }
  assert.ok(Object.keys(out).length > 20, "the markup carries more than twenty labels");
  return out;
}

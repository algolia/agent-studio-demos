/* tests/theme.test.js — shared/theme.js, the kit's single owner of theme.

   The module is written to survive a bare Node load: storage and
   matchMedia are best-effort, so the test stubs the DOM surface it
   touches (document, one toggle button) and exercises the same bytes
   the browser loads. What the pins protect: auto is the default and
   resolves from the OS, the stored choice wins, toggling cycles
   auto → light → dark → auto, and a data-theme-toggle button gets
   wired and painted without the page writing any of that itself. */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const SHARED = path.join(__dirname, "..", "public", "shared");

function freshDom({ systemDark = false, stored = null } = {}) {
  const listeners = {};
  const store = new Map();
  if (stored) store.set("ic-theme", stored);
  const button = {
    dataset: {},
    attrs: {},
    children: {
      glyph: { textContent: "" },
      label: { textContent: "" },
    },
    setAttribute(name, value) { this.attrs[name] = value; },
    addEventListener(type, fn) { (listeners[`${type}:${this.attrs["data-theme"]}`] ||= []).push(fn); },
    querySelector(sel) {
      if (sel === "[data-theme-glyph]") return this.children.glyph;
      if (sel === "[data-theme-label]") return this.children.label;
      return null;
    },
  };
  globalThis.window = globalThis;
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  globalThis.matchMedia = () => ({
    matches: systemDark,
    addEventListener() { /* no OS-change events in the test */ },
  });
  globalThis.document = {
    documentElement: { dataset: {} },
    readyState: "complete",
    querySelectorAll(sel) {
      if (sel === "[data-theme-toggle]") return [button];
      return [];
    },
    addEventListener() { /* DOMContentLoaded already passed */ },
  };
  globalThis.addEventListener = (type, fn) => { (listeners[type] ||= []).push(fn); };
  return { button, store, listeners };
}

function loadTheme() {
  delete require.cache[require.resolve(path.join(SHARED, "theme.js"))];
  require(path.join(SHARED, "theme.js"));
  const theme = globalThis.DemoTheme;
  assert.ok(theme, "theme.js did not publish window.DemoTheme");
  return theme;
}

test("auto is the default and follows the OS preference", () => {
  freshDom({ systemDark: true });
  const theme = loadTheme();
  assert.equal(theme.mode(), "auto");
  assert.equal(theme.resolved(), "dark");
  assert.equal(globalThis.document.documentElement.dataset.theme, "dark");
});

test("a stored choice beats the OS preference, in both directions", () => {
  freshDom({ systemDark: true, stored: "light" });
  const theme = loadTheme();
  assert.equal(theme.resolved(), "light");
  assert.equal(globalThis.document.documentElement.dataset.theme, "light");
});

test("toggle cycles auto → light → dark → auto and persists only pins", () => {
  const { store } = freshDom({});
  const theme = loadTheme();
  theme.toggle();
  assert.equal(theme.mode(), "light");
  assert.equal(store.get("ic-theme"), "light");
  theme.toggle();
  assert.equal(theme.mode(), "dark");
  assert.equal(store.get("ic-theme"), "dark");
  theme.toggle();
  assert.equal(theme.mode(), "auto");
  assert.equal(store.has("ic-theme"), false, "auto means no stored choice");
});

test("set() applies to the document and notifies onChange subscribers", () => {
  const seen = [];
  freshDom({});
  const theme = loadTheme();
  const off = theme.onChange((m) => seen.push(m));
  theme.set("dark");
  assert.equal(globalThis.document.documentElement.dataset.theme, "dark");
  assert.deepEqual(seen, ["dark"]);
  off();
  theme.set("light");
  assert.deepEqual(seen, ["dark"], "unsubscribed listeners stop firing");
});

test("a data-theme-toggle button is wired and painted by the module itself", () => {
  const { button, listeners } = freshDom({ systemDark: false });
  const theme = loadTheme();
  assert.equal(button.children.label.textContent, "Auto (light)");
  assert.equal(button.children.glyph.textContent, "◐");
  assert.equal(button.dataset.themeWired, "1", "wired exactly once");

  const click = listeners["click:undefined"];
  assert.ok(click && click.length === 1, "one click handler attached");
  click[0]();
  assert.equal(theme.mode(), "light");
  assert.equal(button.children.label.textContent, "light");
  assert.equal(button.children.glyph.textContent, "☀");
});

test("the module boots with no DOM and no storage (bare Node must not throw)", () => {
  delete require.cache[require.resolve(path.join(SHARED, "theme.js"))];
  globalThis.window = globalThis;
  delete globalThis.localStorage;
  delete globalThis.matchMedia;
  globalThis.document = {
    documentElement: { dataset: {} },
    readyState: "loading",
    querySelectorAll: () => [],
    addEventListener() {},
  };
  globalThis.addEventListener = () => {};
  require(path.join(SHARED, "theme.js"));
  assert.equal(globalThis.DemoTheme.mode(), "auto");
  assert.equal(globalThis.DemoTheme.resolved(), "light");
});

/* ───────────────────────────────────────────────────────────────
   load.js — the whole test harness, such as it is.

   The shared modules are browser scripts: md.js is an IIFE that ends with
   `})(window)` and publishes `global.renderMarkdown`; config.example.js just
   assigns `window.DEMO_CONFIG`. Neither exports anything, so there is nothing
   to `require` in the usual sense.

   Pointing `window` at `globalThis` before the require is enough to run both
   under Node unchanged — which is the point: the tests exercise the same bytes
   the browser loads, with no shim, no build, and no test framework beyond
   node:test.
   ─────────────────────────────────────────────────────────────── */

const path = require("path");

const SHARED = path.join(__dirname, "..", "public", "shared");

globalThis.window = globalThis;

/** the vendored markdown renderer, as the browser sees it */
function loadRenderMarkdown() {
  require(path.join(SHARED, "md.js"));
  if (typeof globalThis.renderMarkdown !== "function") {
    throw new Error("md.js did not publish window.renderMarkdown");
  }
  return globalThis.renderMarkdown;
}

/**
 * The committed config template — never config.js, which holds real
 * credentials, is gitignored, and does not exist in CI.
 */
function loadExampleConfig() {
  require(path.join(SHARED, "config.example.js"));
  if (!globalThis.DEMO_CONFIG) {
    throw new Error("config.example.js did not publish window.DEMO_CONFIG");
  }
  return globalThis.DEMO_CONFIG;
}

module.exports = { loadRenderMarkdown, loadExampleConfig };

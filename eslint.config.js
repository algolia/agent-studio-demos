/* ───────────────────────────────────────────────────────────────
   eslint.config.js — flat config, CommonJS, zero dependencies.

   Two deliberate constraints shape this file:

   1. This repo has no package.json and no node_modules — no build step, no
      bundler, nothing to install. Lint runs as `npx eslint public/`, straight
      from a clean checkout. That rules out `require("@eslint/js")`: the package
      lives inside npx's own temp prefix, not next to this file, so
      `js.configs.recommended` is simply not reachable. The rules below are
      therefore the useful half of eslint:recommended, written out by name —
      core rules need no plugin. `module.exports` rather than `export default`
      for the same reason: with no package.json there is no `"type": "module"`.

   2. The demos are classic browser scripts loaded with <script src>, not ES
      modules — md.js closes with `})(window)`, app.js reads globals that
      config.js declared. Hence sourceType "script" and a hand-written globals
      list.
   ─────────────────────────────────────────────────────────────── */

const browserGlobals = {
  window: "writable",
  document: "readonly",
  localStorage: "readonly",
  sessionStorage: "readonly",
  fetch: "readonly",
  console: "readonly",
  navigator: "readonly",
  location: "readonly",
  history: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  requestAnimationFrame: "readonly",
  cancelAnimationFrame: "readonly",
  DOMParser: "readonly",
  queueMicrotask: "readonly",
  structuredClone: "readonly",
  AbortController: "readonly",
  TextDecoder: "readonly",
  TextEncoder: "readonly",
  FileReader: "readonly",
  Blob: "readonly",
  File: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  performance: "readonly",
  matchMedia: "readonly",
  getComputedStyle: "readonly",
  IntersectionObserver: "readonly",
  ResizeObserver: "readonly",
  MutationObserver: "readonly",
  crypto: "readonly",
  alert: "readonly",
  Intl: "readonly",
  Event: "readonly",
  CustomEvent: "readonly",
  // cross-file globals the demos publish to each other
  DEMO_CONFIG: "readonly",
  DEMO_BOOKS: "readonly",
  DemoMeter: "readonly",
  DemoCompactor: "readonly",
  renderMarkdown: "readonly",
};

/* Node, for the conversation generator under tools/. It is not a browser
   script, but it does reach for fetch and the stream decoder a browser also
   has — so the two lists overlap on purpose rather than by accident. */
const nodeGlobals = {
  require: "readonly",
  module: "writable",
  exports: "writable",
  __dirname: "readonly",
  __filename: "readonly",
  process: "readonly",
  console: "readonly",
  globalThis: "writable",
  Buffer: "readonly",
  fetch: "readonly",
  TextDecoder: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
};

/* The part of eslint:recommended that catches real mistakes: things that are
   almost always a bug rather than a style opinion. */
const recommended = {
  "constructor-super": "error",
  "for-direction": "error",
  "getter-return": "error",
  "no-async-promise-executor": "error",
  "no-case-declarations": "error",
  "no-class-assign": "error",
  "no-compare-neg-zero": "error",
  "no-cond-assign": "error",
  "no-const-assign": "error",
  "no-constant-condition": ["error", { checkLoops: false }],
  "no-control-regex": "error",
  "no-debugger": "error",
  "no-dupe-args": "error",
  "no-dupe-class-members": "error",
  "no-dupe-else-if": "error",
  "no-dupe-keys": "error",
  "no-duplicate-case": "error",
  "no-empty-character-class": "error",
  "no-empty-pattern": "error",
  "no-ex-assign": "error",
  "no-fallthrough": "error",
  "no-func-assign": "error",
  "no-global-assign": "error",
  "no-import-assign": "error",
  "no-invalid-regexp": "error",
  "no-irregular-whitespace": "error",
  "no-loss-of-precision": "error",
  "no-misleading-character-class": "error",
  "no-new-native-nonconstructor": "error",
  "no-obj-calls": "error",
  "no-octal": "error",
  "no-prototype-builtins": "error",
  "no-redeclare": "error",
  "no-regex-spaces": "error",
  "no-self-assign": "error",
  "no-setter-return": "error",
  "no-shadow-restricted-names": "error",
  "no-sparse-arrays": "error",
  "no-this-before-super": "error",
  "no-undef": "error",
  "no-unexpected-multiline": "error",
  "no-unreachable": "error",
  "no-unsafe-finally": "error",
  "no-unsafe-negation": "error",
  "no-unsafe-optional-chaining": "error",
  "no-useless-backreference": "error",
  "no-useless-catch": "error",
  "no-useless-escape": "error",
  "no-with": "error",
  "require-yield": "error",
  "use-isnan": "error",
  "valid-typeof": "error",

  // Two adjustments to fit patterns this codebase uses on purpose:
  // an unused name is worth seeing, not worth blocking a demo tweak on,
  // and an empty catch is how a page survives private-mode localStorage.
  "no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }],
  "no-empty": ["error", { allowEmptyCatch: true }],
};

module.exports = [
  {
    // Local credentials. Untracked, so CI never sees this file — ignoring it
    // keeps a local `npx eslint public/` over the exact same set as the CI run.
    ignores: ["public/shared/config.js"],
  },
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: browserGlobals,
    },
    rules: recommended,
  },
  {
    // md.js lifts code spans out of the text behind NUL-delimited placeholders,
    // precisely because no answer text contains a NUL — so the control character
    // in that regex is the mechanism, not an accident. See the comment at its
    // `inline()`.
    files: ["public/shared/md.js"],
    rules: { "no-control-regex": "off" },
  },
  {
    // Tests and the shelf/index scripts are Node, not a browser. `fetch` and
    // `URL` are there because the scripts talk to Gutenberg and to the Algolia
    // REST API with nothing installed — Node's own globals, no dependency.
    files: ["tests/**/*.js", "scripts/**/*.js", "eslint.config.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        require: "readonly",
        module: "writable",
        exports: "writable",
        __dirname: "readonly",
        __filename: "readonly",
        process: "readonly",
        console: "readonly",
        globalThis: "writable",
        Buffer: "readonly",
        fetch: "readonly",
        URL: "readonly",
        TextEncoder: "readonly",
        Request: "readonly",
        Response: "readonly",
      },
    },
    rules: recommended,
  },
  {
    // jev-attributes is built on ES modules: it imports rather
    // than read globals. Its .mjs modules, and shared/*.mjs, are also imported
    // by Node (tools/, scripts/*.mjs), which is why they may touch both lists.
    files: [
      "public/shared/**/*.mjs",
      "public/jev-attributes/**/*.js", "public/jev-attributes/**/*.mjs", "tools/**/*.mjs", "scripts/**/*.mjs",
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...browserGlobals,
        ...nodeGlobals,
        ReadableStream: "readonly",
        Response: "readonly",
        Headers: "readonly",
        URL: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
        Request: "readonly",
        atob: "readonly",
      },
    },
    rules: recommended,
  },
  {
    // The relay is a Cloudflare Pages Function: an ES module on the Workers
    // runtime, which has fetch, Request and Response but no DOM.
    // No `console` here: an accidental log in the relay fails lint.
    files: ["functions/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        fetch: "readonly", Request: "readonly", Response: "readonly", Headers: "readonly", URL: "readonly",
        AbortSignal: "readonly",
      },
    },
    rules: recommended,
  },
  {
    // main-demo is the one page built on ES modules: React and the Chat widget
    // arrive through an import map, so its files import rather than read
    // globals. The .mjs modules are shared with tools/main-demo-provision.mjs,
    // which is why they may touch both lists.
    files: ["public/main-demo/**/*.js", "public/main-demo/**/*.mjs", "tools/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...browserGlobals,
        ...nodeGlobals,
        ReadableStream: "readonly",
        Response: "readonly",
        Headers: "readonly",
        URL: "readonly",
        AbortController: "readonly",
      },
    },
    rules: recommended,
  },
  {
    // The conversation generator: Node, CommonJS, and never loaded by a page.
    files: ["tools/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: nodeGlobals,
    },
    rules: recommended,
  },
];

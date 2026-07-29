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
  renderMarkdown: "readonly",
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
    // Tests are Node, not a browser.
    files: ["tests/**/*.js", "eslint.config.js"],
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
      },
    },
    rules: recommended,
  },
];

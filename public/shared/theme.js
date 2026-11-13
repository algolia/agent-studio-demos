/* ───────────────────────────────────────────────────────────────
   theme.js — the kit's single owner of light / auto / dark.

   Before this module the same eight-line boot script was pasted into every
   demo's <head> and each demo grew its own toggle wiring — eight copies of
   one decision. This file is the one copy:

     * loads as a blocking head script, so data-theme is right before the
       first paint and no page flashes the wrong palette;
     * auto is the default: the stored choice wins, otherwise the OS
       preference decides, and a live OS change re-resolves while in auto;
     * every page gets a working toggle for free: any
       <button data-theme-toggle> cycles auto → light → dark; give it
       [data-theme-glyph] and [data-theme-label] children and they are
       painted too. Positioning is the demo's business (style .theme-toggle
       from its own stylesheet).

   Pages with a bespoke toggle (the landing page predates this module, and
   jev-attributes must keep its boot inline for its CSP hash) keep working:
   the storage key `ic-theme` and the data-theme attribute stay the contract,
   and mode() re-reads storage on every call rather than caching it.
   ─────────────────────────────────────────────────────────────── */

(function (global) {
  "use strict";

  const KEY = "ic-theme";
  const ORDER = ["auto", "light", "dark"];
  const GLYPHS = { auto: "◐", light: "☀", dark: "☾" };
  const doc = global.document;
  const mql = global.matchMedia ? global.matchMedia("(prefers-color-scheme: dark)") : null;

  /* Storage is best-effort everywhere: private mode throws, and a demo
     without a stored choice is the normal case, not an error. */
  function stored() {
    try { return global.localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function store(value) {
    try { global.localStorage.setItem(KEY, value); } catch (e) { /* private mode */ }
  }
  function unstore() {
    try { global.localStorage.removeItem(KEY); } catch (e) { /* private mode */ }
  }

  function mode() {
    const s = stored();
    return s === "light" || s === "dark" ? s : "auto";
  }
  function systemDark() {
    return mql ? mql.matches : false;
  }
  function resolved() {
    const m = mode();
    return m === "auto" ? (systemDark() ? "dark" : "light") : m;
  }

  const listeners = [];
  function notify(m) {
    for (const fn of listeners) {
      try { fn(m); } catch (e) { /* a broken listener must not break the rest */ }
    }
  }

  function paint() {
    const m = mode();
    const buttons = doc.querySelectorAll("[data-theme-toggle]");
    for (const btn of buttons) {
      btn.setAttribute("aria-label", `Color theme: ${m}; click for the next one`);
      btn.setAttribute("aria-pressed", String(m !== "auto"));
      const glyph = btn.querySelector("[data-theme-glyph]");
      if (glyph) glyph.textContent = GLYPHS[m];
      const label = btn.querySelector("[data-theme-label]");
      if (label) label.textContent = m === "auto" ? `Auto (${resolved()})` : m;
    }
  }

  function apply() {
    doc.documentElement.dataset.theme = resolved();
  }

  function set(next) {
    if (next === "auto") unstore(); else store(next);
    apply();
    paint();
    notify(mode());
  }

  function toggle() {
    set(ORDER[(ORDER.indexOf(mode()) + 1) % ORDER.length]);
  }

  /* Boot: runs at script load, i.e. in <head>, before any body pixel. */
  apply();

  /* While in auto, follow the OS live. */
  if (mql && mql.addEventListener) {
    mql.addEventListener("change", () => {
      if (mode() === "auto") {
        apply();
        paint();
        notify("auto");
      }
    });
  }

  /* Another tab — or a demo's own bespoke toggle — moved the key. */
  global.addEventListener("storage", (e) => {
    if (e.key === KEY || e.key === null) {
      apply();
      paint();
      notify(mode());
    }
  });

  function wireButtons() {
    paint();
    for (const btn of doc.querySelectorAll("[data-theme-toggle]")) {
      if (btn.dataset.themeWired) continue;
      btn.dataset.themeWired = "1";
      btn.addEventListener("click", () => toggle());
    }
  }
  if (doc.readyState === "loading") {
    doc.addEventListener("DOMContentLoaded", wireButtons);
  } else {
    wireButtons();
  }

  global.DemoTheme = {
    mode,
    resolved,
    set,
    toggle,
    /** subscribe to mode changes; returns an unsubscribe function */
    onChange(fn) {
      listeners.push(fn);
      return () => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
  };
})(window);

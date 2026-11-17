/* ───────────────────────────────────────────────────────────────
   tasks/page.js — shared page scaffold for the task demos.

   The pieces every task page needs, so each page's app.js is only
   its own flow: the setup panel, example-chip wiring, and a FLIP
   reorder for lists whose order changes when a task lands. Header
   and footer markup stay per-page: they are two lines of HTML and
   pages read better with them inline. Branding is per-page too —
   nothing here knows which demo is using the kit.
   ─────────────────────────────────────────────────────────────── */

(function (global) {
  "use strict";

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  /* No usable config: show #setup, hide #demo. Returns false when fine. */
  function guard() {
    if (TasksCommon.ready()) return true;
    const el = document.getElementById("setup");
    const demo = document.getElementById("demo");
    if (el) {
      el.classList.remove("hidden");
      const p = el.querySelector("p");
      const missing = TasksCommon.missing();
      p.textContent = `Missing config: ${missing.join(", ")}.`;
      const code = document.createElement("code");
      code.textContent = "/shared/config.js";
      p.append(code);
      p.append(document.createTextNode(" needs a tasks block — a search-only key on your app, plus the agent id that owns the task."));
    }
    if (demo) demo.classList.add("hidden");
    return false;
  }

  /* Wire every [data-q] button in container to onPick(query, btn). */
  function chips(container, onPick) {
    container.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-q]");
      if (btn) onPick(btn.dataset.q, btn);
    });
  }

  /* Mark the active chip. */
  function activeChip(container, query) {
    for (const btn of container.querySelectorAll("button[data-q]")) {
      btn.classList.toggle("active", btn.dataset.q === query);
    }
  }

  /* FLIP reorder: measure, let apply() move the DOM, animate the delta.
     Rows carry data-id; rows appearing or vanishing just fade. */
  function flip(container, apply) {
    const before = new Map();
    for (const el of container.querySelectorAll("[data-id]")) {
      before.set(el.dataset.id, el.getBoundingClientRect().top);
    }
    apply();
    for (const el of container.querySelectorAll("[data-id]")) {
      const dy = before.has(el.dataset.id) ? before.get(el.dataset.id) - el.getBoundingClientRect().top : 0;
      el.style.transition = "none";
      el.style.transform = dy ? `translateY(${dy}px)` : "";
      el.style.opacity = before.has(el.dataset.id) ? "" : "0";
      requestAnimationFrame(() => {
        el.style.transition = "transform 0.55s cubic-bezier(.2,.7,.2,1), opacity 0.4s ease";
        el.style.transform = "";
        el.style.opacity = "";
      });
    }
  }

  global.Rush = { esc, guard, chips, activeChip, flip };
})(window);

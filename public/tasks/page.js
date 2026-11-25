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

  /* Catalog text arrives with entities in it (34 of 500 names on this index:
     Cr&#232;me, &#8482;), and escaping that paints the entity on the card.
     Decode first through a detached textarea — its content is parsed as text,
     never as markup, so nothing parses or runs — then escape on the way out.
     Read the parsed text, not .value: writing .value sets the textarea's dirty
     flag, and a dirty one stops following later innerHTML writes — which blanks
     every entity after the first, the shape of bug that hides in a first-card
     screenshot. */
  const scratch = document.createElement("textarea");
  function undent(s) {
    const raw = String(s ?? "");
    if (raw.indexOf("&") < 0) return raw;
    scratch.innerHTML = raw;
    return scratch.textContent;
  }

  /* One product card, shared by every task page: image full-height on the
     left, name, its leaf category, then brand · price. Data-only — a page
     that wants a badge or a state class passes them in. */
  function hit(h, opts) {
    const o = opts || {};
    const name = undent(h.name || h.title || h.objectID);
    const cats = Array.isArray(h.categories_as_list) ? h.categories_as_list : [];
    const leaf = undent(cats.length ? cats[cats.length - 1] : "");
    const meta = [undent(h.brand || ""), h.price != null ? `${h.price} ${h.currency || ""}`.trim() : null]
      .filter(Boolean)
      .join(" · ");
    const id = h.objectID != null ? ` data-id="${esc(h.objectID)}"` : "";
    // A catalog's image field is a URL on someone else's CDN, and CDNs refuse
    // cross-origin <img> (ORB blocks the response, ERR_BLOCKED_BY_ORB). So the
    // monogram sits behind the image: whichever the CDN allows is what shows,
    // and a refused image is dropped by watchImages rather than painted grey.
    const monogram = esc(String(name).trim().charAt(0).toUpperCase());
    return `<li${id}${o.cls ? ` class="${esc(o.cls)}"` : ""}>
      <span class="hit-visual">
        <span class="hit-monogram" aria-hidden="true">${monogram}</span>
        ${h.image ? `<img src="${esc(h.image)}" alt="" loading="lazy" />` : ""}
      </span>
      <span class="hit-body">
        <h3 class="hit-title">${esc(name)}</h3>
        ${leaf ? `<p class="hit-cat">${esc(leaf)}</p>` : ""}
        ${meta ? `<p class="hit-meta">${esc(meta)}</p>` : ""}
      </span>
      ${o.badge || ""}
    </li>`;
  }

  /* A refused cross-origin image is a grey box by default. Drop it and the
     monogram behind it stands. error does not bubble, so this listens on the
     capture phase — one listener for the page, and it survives re-renders. */
  function watchImages() {
    document.addEventListener(
      "error",
      (e) => {
        if (e.target && e.target.tagName === "IMG") e.target.remove();
      },
      true,
    );
  }

  /* Show whichever half applies. Pages ship #demo hidden so a page with no
     config never flashes an empty board, which means the ready path has to
     reveal it — hiding alone leaves a configured page with a header, a lede
     and nothing in between. Returns false when the setup message is showing. */
  function guard() {
    const el = document.getElementById("setup");
    const demo = document.getElementById("demo");
    watchImages();
    if (TasksCommon.ready()) {
      const kicker = document.querySelector(".kicker");
      if (kicker && TasksCommon.overridden()) {
        const tag = document.createElement("span");
        tag.className = "badge";
        tag.textContent = `api ${new URL(TasksCommon.apiBase()).host}`;
        kicker.append(" ", tag);
        for (const a of kicker.querySelectorAll("a")) a.search = global.location.search;
      }
      if (demo) demo.classList.remove("hidden");
      if (el) el.classList.add("hidden");
      return true;
    }
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

  /* Facet chips: the index's commonest values of one attribute, one filter
     at a time. Clicking a chip sets the filter and shows a pill with a clear
     button; the page's onChange re-runs its query. */
  let facetFilter = "";

  const quote = (v) => `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

  /** Search options carrying the active facet filter, AND-joined with a state's own. */
  function withFacet(extra) {
    if (!facetFilter) return extra;
    const own = extra && extra.filters ? `(${extra.filters}) AND ` : "";
    return { ...(extra || {}), filters: own + facetFilter };
  }

  async function facets(container, onChange, attr = "brand") {
    let values;
    try {
      values = (await TasksCommon.facets([attr]))[attr];
    } catch (e) {
      return;
    }
    if (!values.length) return;
    const pill = document.createElement("span");
    pill.className = "pill hidden";
    const label = document.createElement("span");
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "pill-clear";
    clear.setAttribute("aria-label", "Clear filter");
    clear.textContent = "×";
    pill.append(label, clear);
    container.append(pill);
    for (const { value } of values) {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.filters = `${attr}:${quote(value)}`;
      b.setAttribute("aria-pressed", "false");
      b.textContent = undent(value);
      container.append(b);
    }
    const set = (filter, text) => {
      facetFilter = filter;
      label.textContent = text;
      pill.classList.toggle("hidden", !filter);
      for (const b of container.querySelectorAll("button[data-filters]")) {
        const on = b.dataset.filters === filter;
        b.classList.toggle("active", on);
        b.setAttribute("aria-pressed", String(on));
      }
      onChange(filter);
    };
    container.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b === clear || b.dataset.filters === facetFilter) set("", "");
      else if (b.dataset.filters) set(b.dataset.filters, `${attr}: ${b.textContent}`);
    });
    container.classList.remove("hidden");
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

  global.Rush = { esc, undent, hit, guard, chips, activeChip, flip, facets, withFacet, facetFilter: () => facetFilter };
})(window);

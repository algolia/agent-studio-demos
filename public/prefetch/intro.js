/* ───────────────────────────────────────────────────────────────
   intro.js: the title screen's bar, without prefetch, then with it.

   One bar, two states from intro.mjs `morph()`: the segments carry the
   same ids from state to state, so CSS moves them. Plays while the bar is
   on screen; with reduced motion it shows both states, still, one above
   the other. Without a stored run the figure stays hidden.
   ─────────────────────────────────────────────────────────────── */

import { LABELS, TYPICAL, isMorphable, morph } from "./intro.mjs";
import { ms } from "../main-demo/stream.mjs";

const $ = (id) => document.getElementById(id);
const fig = $("morph");
const STATES = { before: "Without prefetch", after: "With prefetch" };
const HOLD = { before: 2200, after: 3200 };

function seg(s) {
  const n = document.createElement("span");
  n.className = `pf-seg is-${s.kind}`;
  n.dataset.id = s.id;
  const b = document.createElement("b");
  b.textContent = LABELS[s.kind] || s.kind;
  n.append(b);
  return n;
}

function place(bar, segs) {
  for (const s of segs) {
    let n = bar.querySelector(`[data-id="${s.id}"]`);
    if (!n) { n = seg(s); bar.append(n); }
    n.className = `pf-seg is-${s.kind}${s.width < 0.5 ? " is-gone" : ""}`;
    n.querySelector("b").textContent = LABELS[s.kind] || s.kind;
    n.style.left = `${s.left}%`;
    n.style.width = `${s.width}%`;
  }
}

function legend(m) {
  const kinds = [...new Set([...m.before, ...m.after].filter((s) => s.width > 0).map((s) => s.kind))];
  $("morph-key").replaceChildren(...kinds.map((k) => {
    const li = document.createElement("li");
    li.className = `is-${k}`;
    li.textContent = LABELS[k];
    return li;
  }));
}

function main() {
  if (!fig || !isMorphable(TYPICAL)) return;
  const m = morph(TYPICAL);
  const bar = $("morph-bar");
  fig.hidden = false;
  legend(m);
  bar.setAttribute("aria-label", `A typical run: ${ms(m.totals.before)} without prefetch, ${ms(m.totals.after)} with it.`);
  const show = (state) => {
    fig.dataset.state = state;
    place(bar, m[state]);
    $("morph-state").textContent = STATES[state];
    const end = $("morph-end");
    end.textContent = ms(m.totals[state]);
    end.style.left = `${(m.totals[state] / m.scale) * 100}%`;
    // with prefetch, the run without it stays as a mark where it ended
    const was = $("morph-was");
    was.textContent = state === "after" ? ms(m.totals.before) : "";
    was.style.left = `${(m.totals.before / m.scale) * 100}%`;
    bar.style.setProperty("--was", `${(m.totals.before / m.scale) * 100}%`);
  };
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    // still: both states, the bar with prefetch under the one without
    fig.classList.add("is-still");
    show("before");
    const after = bar.cloneNode(false);
    after.id = "morph-bar-after";
    after.setAttribute("aria-hidden", "true");
    place(after, m.after);
    bar.after(after);
    $("morph-state").textContent = "Without prefetch, then with it";
    $("morph-end").textContent = `${ms(m.totals.before)}, then ${ms(m.totals.after)}`;
    $("morph-end").style.left = "";
    $("morph-was").textContent = "";
    return;
  }
  show("before");
  let timer = 0;
  let state = "before";
  const step = () => {
    state = state === "before" ? "after" : "before";
    show(state);
    timer = setTimeout(step, HOLD[state]);
  };
  // plays while it is on screen, and starts over from "without" when it comes back
  new IntersectionObserver((entries) => {
    const on = entries.some((e) => e.isIntersecting);
    clearTimeout(timer);
    if (on) timer = setTimeout(step, 900);
    else { state = "before"; show(state); }
  }, { threshold: 0.4 }).observe(fig);
}

main();

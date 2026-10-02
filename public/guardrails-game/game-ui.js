/* ───────────────────────────────────────────────────────────────
   game-ui.js: the Guardrails Game, on top of the Arena's csv.js,
   stats.js and label-game.js (loaded from ../guardrails-arena/).

   A person in the guardrail's seat. No keys, no API: the only request is
   the exam, a static file next to the Arena. Two parts:
     round   ten exam messages, scored against the answers, misses shown
     label   the exam or your CSV, labeled in the same game, downloaded as
             the Arena's CSV or as judgement-store NDJSON

   What the page keeps: the theme, your best round (a number) and the
   labeler tag, in localStorage, each read and written under try/catch.
   Labels and files live only in this tab's memory.
   ─────────────────────────────────────────────────────────────── */

(function () {
  "use strict";

  const C = window.GuardrailCsv, Gm = window.GuardrailGame;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const secs = (x) => (x == null ? "–" : `${(x / 1000).toFixed(1)}\u00a0s`);
  const EXAM_LABEL = 40;
  const TAG_KEY = "gg-labeler-tag";

  /* ── theme toggle: same storage key as the rest of the site ───── */
  (function themeToggle() {
    const btn = $("#theme-toggle");
    const paint = () => {
      const dark = document.documentElement.dataset.theme === "dark";
      btn.setAttribute("aria-pressed", String(dark));
      $("#theme-label").textContent = dark ? "Light" : "Dark";
      $("#theme-glyph").textContent = dark ? "◑" : "◐";
    };
    btn.addEventListener("click", () => {
      const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem("ic-theme", next); } catch (e) { /* private mode */ }
      paint();
    });
    paint();
  })();

  /* ── the exam: one static file, fetched once ───────────────────── */

  let exam = null;
  async function examItems() {
    if (!exam) {
      const r = await fetch("../guardrails-arena/data/heldout.json");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      exam = Gm.examItems(await r.json());
    }
    return exam;
  }
  const freshSeed = () => {
    try { return crypto.getRandomValues(new Uint32Array(1))[0]; } catch (e) { return (Date.now() * 2654435761) >>> 0; }
  };

  /* ── round: ten messages against the answers ──────────────────── */

  let round = null;

  async function startRound() {
    let items;
    try {
      items = Gm.sampleRound(await examItems(), { k: Gm.ROUND, seed: freshSeed(), hard: 3 });
    } catch (e) { $("#gg-intro .meta").textContent = "Could not load the exam. Reload the page and try again."; return; }
    if (round) round.game.destroy();
    $("#gg-intro").hidden = true;
    const game = Gm.mount($("#gg-round"), { items, categories: Gm.EXAM_CATS, onFinish: () => roundEnd() });
    round = { game, items, best: Gm.best.read() };
    game.start();
    $("#gg-round").scrollIntoView({ block: "nearest" });
  }

  function roundEnd() {
    const { game, items } = round;
    const labels = game.labels(), st = game.stats();
    const right = items.filter((it) => { const l = labels.get(it.id); return l && l.verdict === it.gold; }).length;
    if (st.labeled === items.length) Gm.best.save(right);
    const best = Math.max(round.best, right);
    game.endEl.innerHTML =
      `<p class="gm-big"><b>${right}</b> of ${items.length} right</p>` +
      `<p class="note">Median ${secs(st.p50ms)} per message${st.unsure ? `, ${st.unsure} unsure` : ""}. ` +
      `Score ${st.points.toLocaleString("en-US")}. Best round: <b class="gg-best">${best}</b> of ${items.length}.</p>` +
      Gm.missedHtml(items, labels) +
      '<div class="toolbar"><button type="button" class="primary" data-act="again">Play again</button>' +
      '<button type="button" data-r="undo">Undo the last answer</button></div>';
  }

  $("#gg-start").addEventListener("click", startRound);
  $("#gg-round").addEventListener("click", (ev) => { if (ev.target.closest("[data-act=again]")) startRound(); });

  /* ── label: the exam or your CSV ──────────────────────────────── */

  let uploaded = null, lbItems = null, lbGame = null;
  const say = (t) => { $("#gl-status").textContent = t; };
  const fromCsv = () => $("#gl-src-csv").checked;
  const labels = () => (lbGame ? lbGame.labels() : new Map());

  /* the tag is the one thing typed here that the page remembers */
  try { $("#gl-tag").value = localStorage.getItem(TAG_KEY) || ""; } catch (e) { /* private mode */ }
  $("#gl-tag").addEventListener("change", () => {
    try { localStorage.setItem(TAG_KEY, Gm.cleanTag($("#gl-tag").value)); } catch (e) { /* private mode */ }
  });

  async function labelItems() {
    if (lbItems) return lbItems;
    if (fromCsv()) {
      if (!uploaded) return null;
      lbItems = uploaded.map((c, i) => ({ id: i, text: c.message, gold: c.expected || null, expected: c.expected, category: c.category, note: c.note }));
    } else {
      lbItems = Gm.sampleRound(await examItems(), { k: EXAM_LABEL, seed: 11, hard: 0 });
    }
    return lbItems;
  }

  function preview(cases, errors, total) {
    const head = cases.slice(0, 5).map((c) =>
      `<tr><td>${esc(c.message.slice(0, 160))}${c.message.length > 160 ? "…" : ""}</td>` +
      `<td>${c.expected ? `<span class="lab ${c.expected}">${c.expected}</span>` : '<span class="note">to label</span>'}</td></tr>`).join("");
    $("#gl-preview").innerHTML =
      `<p class="note">${cases.length} usable rows of ${total}, ${cases.filter((c) => c.expected).length} with a label. The first five:</p>` +
      (errors.length ? `<ul class="lv-errs">${errors.slice(0, 6).map((e) => `<li>${esc(e)}</li>`).join("")}</ul>` : "") +
      (head ? `<div class="scroll"><table><thead><tr><th>message</th><th>expected</th></tr></thead><tbody>${head}</tbody></table></div>` : "");
  }

  /** a new source drops the labels made on the old one, after a yes */
  function reset() {
    const n = lbGame ? lbGame.commits().length : 0;
    if (n && !window.confirm(`Drop your ${n} labels?`)) return false;
    if (lbGame) lbGame.destroy();
    lbGame = null;
    lbItems = null;
    say("");
    return true;
  }

  function count() {
    if (!lbGame || !lbItems) return;
    const st = lbGame.stats();
    say(`${st.labeled} of ${lbItems.length} labeled${st.unsure ? `, ${st.unsure} unsure` : ""}.`);
  }

  function labelEnd() {
    const items = lbItems, ls = lbGame.labels(), st = lbGame.stats();
    const sure = items.filter((it) => it.gold && ls.has(it.id) && ls.get(it.id).verdict !== "unsure");
    const agree = sure.filter((it) => ls.get(it.id).verdict === it.gold).length;
    const left = items.length - st.labeled;
    count();
    lbGame.endEl.innerHTML =
      `<p class="gm-big"><b>${st.labeled}</b> of ${items.length} labeled</p>` +
      `<p class="note">Median ${secs(st.p50ms)} per message, ${st.unsure} unsure.</p>` +
      (sure.length ? `<p>You agree with ${fromCsv() ? "the file" : "the exam"} on ${agree} of ${sure.length}.</p>` : "") +
      '<div class="toolbar">' +
      (left ? `<button type="button" class="primary" data-do="next">Label the other ${left}</button>` : "") +
      '<button type="button" data-act="csv">Labels (CSV)</button>' +
      '<button type="button" data-act="ndjson">Judgement store (NDJSON)</button>' +
      '<button type="button" data-r="undo">Undo the last label</button></div>' +
      '<p class="nudge"><a href="../guardrails-arena/#live">Race models on these labels in the Arena</a></p>';
  }

  $("#gl-file").addEventListener("change", (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    if (!reset()) { ev.target.value = ""; return; }
    $("#gl-src-csv").checked = true;
    if (file.size > 2 * 1024 * 1024) {
      uploaded = null;
      $("#gl-preview").innerHTML = '<p class="err">That file is over 2&nbsp;MB. Split it, or keep the first 200 rows.</p>';
      return;
    }
    const rd = new FileReader();
    rd.onload = () => {
      const v = C.validate(C.parse(rd.result), { expectedOptional: true });
      uploaded = v.cases.length ? v.cases : null;
      lbItems = null;
      preview(v.cases, v.errors, v.total);
    };
    rd.readAsText(file);
  });
  for (const id of ["#gl-src-ex", "#gl-src-csv"]) {
    $(id).addEventListener("change", () => {
      if (!reset()) { (fromCsv() ? $("#gl-src-ex") : $("#gl-src-csv")).checked = true; return; }
      $("#gl-preview").innerHTML = "";
      if (fromCsv() && uploaded) preview(uploaded, [], uploaded.length);
    });
  }

  async function startLabels() {
    let items;
    try { items = await labelItems(); } catch (e) { say("Could not load the exam. Reload the page and try again."); return; }
    if (!items || !items.length) { say("Load a CSV with a message column first."); return; }
    if (!lbGame) lbGame = Gm.mount($("#gl-game"), { items, categories: Gm.EXAM_CATS, onFinish: labelEnd, onChange: count });
    lbGame.start();
    $("#gl-game").scrollIntoView({ block: "nearest" });
  }

  async function ready() {
    let items;
    try { items = await labelItems(); } catch (e) { items = null; }
    if (!items) say("Load a CSV with a message column first.");
    return items;
  }

  async function downloadCsv() {
    const items = await ready();
    if (items) Gm.save("guardrail-labels.csv", Gm.labelsCsv(items, labels()));
  }

  /** effective labels only: an undone label leaves no line */
  async function downloadNdjson() {
    const items = await ready();
    if (!items) return;
    const ls = labels();
    if (!ls.size) { say("Label a message first."); return; }
    const text = await Gm.judgementsNdjson(items, ls, { tag: $("#gl-tag").value, source: fromCsv() ? "csv" : "exam" });
    Gm.save("guardrail-judgements.ndjson", text, "application/x-ndjson");
  }

  $("#gl-start").addEventListener("click", startLabels);
  $("#gl-csv").addEventListener("click", downloadCsv);
  $("#gl-ndjson").addEventListener("click", downloadNdjson);
  $("#gl-game").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-act]");
    if (b && b.dataset.act === "csv") downloadCsv();
    if (b && b.dataset.act === "ndjson") downloadNdjson();
  });
})();

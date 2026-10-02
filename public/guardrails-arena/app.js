/* ───────────────────────────────────────────────────────────────
   Guardrails Arena — the How-to tab: one frozen tuning run, told as the
   five steps a reader repeats on their own app in the Live demo tab.

   data/run.json   a held-out exam, four rounds of proposed rules

   A snapshot: nothing here polls, and nothing calls a model.
   ─────────────────────────────────────────────────────────────── */

(function () {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const p1 = (x) => (x == null ? "–" : (x * 100).toFixed(1) + "%");
  const ciText = (ci) => (ci ? `${p1(ci[0])}–${p1(ci[1])}` : "–");

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

  const fetched = {};
  const getJson = (url) => (fetched[url] = fetched[url] || fetch(url).then((r) => {
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return r.json();
  }).catch((e) => { delete fetched[url]; throw e; }));

  /* ── guardrail config views ────────────────────────────────────── */

  function splitExamples(x) {
    if (x == null) return [];
    if (Array.isArray(x)) return x.map(String).map((s) => s.trim()).filter(Boolean);
    let parts = String(x).split(/\r?\n/);
    if (parts.length < 2) parts = String(x).split(/\s*[;|]\s*/);
    return parts
      .map((s) => s.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").replace(/^["“']|["”']$/g, "").trim())
      .filter(Boolean);
  }
  const norm = (s) => String(s == null ? "" : s).trim().toLowerCase();

  function listHtml(items, other, cls) {
    if (!items.length) return '<div class="none">none</div>';
    const o = other ? new Set(other.map(norm)) : null;
    return "<ul>" + items.map((t) =>
      `<li${o && !o.has(norm(t)) ? ` class="${cls}"` : ""}>${esc(t)}</li>`).join("") + "</ul>";
  }

  /** cfg: the config to show; ref: the one to compare against; cls: "add" or "del" */
  function cfgView(cfg, ref, cls) {
    if (!cfg) return '<div class="none">no config</div>';
    const cats = cfg.categories || [];
    const rmap = ref ? Object.fromEntries((ref.categories || []).map((c) => [c.name, c])) : null;
    const scopeCls = ref && norm(cfg.scope) !== norm(ref.scope) ? cls : "";
    const catHtml = cats.map((c) => {
      const r = rmap ? rmap[c.name] : undefined;
      let k = "";
      if (rmap && !r) k = cls;
      else if (r && (norm(r.description) !== norm(c.description) || norm(r.examples) !== norm(c.examples))) k = "chg";
      const ex = splitExamples(c.examples);
      return `<div class="cat ${k}"><div class="cn">${esc(c.name)}${k === "chg" ? " · reworded" : ""}</div>` +
        `<div>${esc(c.description || "")}</div>` +
        (ex.length ? `<div class="ex">examples: ${ex.map(esc).join(" · ")}</div>` : "") + "</div>";
    }).join("") || '<div class="none">no categories</div>';
    const ex = splitExamples(cfg.no_violation_examples);
    const rex = ref ? splitExamples(ref.no_violation_examples) : null;
    return `<div class="gcfg"><div class="lbl">Scope</div>` +
      `<div class="${scopeCls}">${esc(cfg.scope || "") || '<span class="none">none</span>'}</div>` +
      `<div class="lbl">Categories · ${cats.length}</div>${catHtml}` +
      `<div class="lbl">Allowed examples · ${ex.length}</div>${listHtml(ex, rex, cls)}</div>`;
  }

  const gv = (cfg) => `<details class="gv"><summary>View guardrail</summary>${cfgView(cfg)}</details>`;

  function sideBySide(prev, cur, prevLabel, curLabel, open) {
    return `<details class="pair"${open ? " open" : ""}><summary>${esc(prevLabel)} → ${esc(curLabel)}</summary>` +
      `<div class="side"><div class="card"><h3>${esc(prevLabel)}</h3>${cfgView(prev, cur, "del")}</div>` +
      `<div class="card kept"><h3>${esc(curLabel)}</h3>${cfgView(cur, prev, "add")}</div></div></details>`;
  }

  const diffLegend = '<div class="legend">' +
    '<span style="--c:color-mix(in srgb, var(--ok) 30%, transparent)">added</span>' +
    '<span style="--c:color-mix(in srgb, var(--over) 30%, transparent)">removed</span>' +
    '<span style="--c:color-mix(in srgb, var(--warn) 30%, transparent)">reworded</span></div>';

  /** series: [{ name, color, dash, pts: [{ y, lo, hi }] }], values 0..1, axis always 0–100% */
  /* a phone gets a narrower, taller canvas, so the same 11px reads near 1:1 instead of half size */
  const narrowMq = window.matchMedia("(max-width: 600px)");
  function chart(series, xs, label) {
    const narrow = narrowMq.matches;
    const W = narrow ? 340 : 560, H = narrow ? 300 : 250, L = narrow ? 40 : 46;
    const R = 10, T = 12, B = 30, pw = W - L - R, ph = H - T - B;
    const X = (i) => L + (i + 0.5) * pw / xs.length;
    const Y = (v) => T + ph * (1 - v);
    let g = "";
    for (const v of [0, 0.25, 0.5, 0.75, 1]) {
      g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}"/>` +
        `<text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end">${v * 100}%</text>`;
    }
    xs.forEach((x, i) => { g += `<text x="${X(i)}" y="${H - 10}" text-anchor="middle">${esc(x)}</text>`; });
    const off = 9, k0 = (series.length - 1) / 2;
    series.forEach((s, si) => {
      const dx = (si - k0) * off;
      const pts = s.pts.map((p, i) => (p && p.y != null ? [X(i) + dx, p] : null)).filter(Boolean);
      const st = `stroke:${s.color};stroke-width:2`;
      if (pts.length > 1) {
        g += `<polyline style="fill:none;${st}${s.dash ? ";stroke-dasharray:5 4" : ""}" points="${pts.map(([x, p]) => `${x},${Y(p.y)}`).join(" ")}"/>`;
      }
      for (const [x, p] of pts) {
        if (p.lo != null && p.hi != null) {
          g += `<line style="${st}" x1="${x}" x2="${x}" y1="${Y(p.lo)}" y2="${Y(p.hi)}"/>` +
            `<line style="${st}" x1="${x - 4}" x2="${x + 4}" y1="${Y(p.lo)}" y2="${Y(p.lo)}"/>` +
            `<line style="${st}" x1="${x - 4}" x2="${x + 4}" y1="${Y(p.hi)}" y2="${Y(p.hi)}"/>`;
        }
        const ci = p.lo != null ? ` (95% CI ${p1(p.lo)}–${p1(p.hi)})` : "";
        g += `<circle style="fill:${s.color}" cx="${x}" cy="${Y(p.y)}" r="4"><title>${esc(s.name)}: ${p1(p.y)}${ci}</title></circle>`;
      }
    });
    const leg = series.map((s) => `<span style="--c:${s.color}">${esc(s.name)}</span>`).join("");
    return `<div class="legend">${leg}</div><svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">${g}</svg>`;
  }

  /* ── how-to: one run, five steps ───────────────────────────────── */

  const kpi = (big, small) => `<div class="kpi">${big}</div><p class="note">${small}</p>`;

  function renderHowto(d) {
    const R = d.rounds, H = R.map((r) => r.heldout), h0 = H[0], hN = H[H.length - 1], pair = d.paired;
    const all = R.flatMap((r) => r.candidates), byId = (id) => all.find((c) => c.id === id);
    const c0 = byId(R[0].kept_id), cN = byId(R[R.length - 1].kept_id);
    const fixed = d.heldout_hard.filter((x) => x.r0_pred !== x.gold && x.final_pred === x.gold).slice(0, 3);
    const lastR = R[R.length - 1].round;
    const steps = [
      ["Write the rules",
        `<p>A scope for the shop, plus ${(c0.config.categories || []).length} kinds of message to block.</p>${gv(c0.config)}`],
      ["Race them on an exam",
        `<p>${h0.n} synthetic messages: ${h0.n_allowed} should pass, ${h0.n_blocked} should be blocked.</p>` +
        kpi(p1(h0.balanced_accuracy), `balanced accuracy · 95% CI ${ciText(h0.ba_ci95)}`)],
      ["Read the misses",
        "<p>Round 0 got these wrong. The tag is the right answer.</p>" +
        '<div class="scroll"><table><tbody>' + fixed.map((x) =>
          `<tr><td>${esc(x.text)}<span class="lab ${x.gold}">${x.gold}</span></td><td class="c cell n" title="verdict: ${esc(x.r0_pred)}">✗</td></tr>`).join("") +
        "</tbody></table></div>"],
      ["Change the rules, race again",
        "<p>Each round, a model proposed new rules from the misses. The best one was kept.</p>" +
        '<div class="card">' + chart([
          { name: "held-out balanced accuracy", color: "var(--accent)", pts: H.map((x) => ({ y: x.balanced_accuracy, lo: x.ba_ci95[0], hi: x.ba_ci95[1] })) },
        ], R.map((r) => "round " + r.round), "balanced accuracy per round") + "</div>" +
        diffLegend + sideBySide(c0.config, cN.config, `Round 0 rules · ${c0.prompt_tokens}\u00a0tokens`, `Round ${lastR} rules · ${cN.prompt_tokens}\u00a0tokens`, false)],
      ["Keep it only if it wins on the same messages",
        kpi(`${p1(h0.balanced_accuracy)} → ${p1(hN.balanced_accuracy)}`,
          `+${(pair.ba_delta * 100).toFixed(1)}\u00a0pts (95% CI ${(pair.ba_delta_ci95[0] * 100).toFixed(1)} to ${(pair.ba_delta_ci95[1] * 100).toFixed(1)}) · ` +
          `${pair.r0_wrong_final_right} fixed, ${pair.r0_right_final_wrong} broken · McNemar p\u00a0=\u00a0${pair.mcnemar_exact_p}`) +
        `<p class="note">The price: the rules grew from ${d.prompt_tokens.r0} to ${d.prompt_tokens.final}\u00a0tokens, paid on every message.</p>`],
    ];
    $("#howto-steps").innerHTML = steps.map(([h, b]) => `<li><h2>${h}</h2>${b}</li>`).join("");
  }

  /* ── tabs ──────────────────────────────────────────────────────── */

  let loaded = false;
  function load() {
    if (loaded) return;
    loaded = true;
    getJson("data/run.json").then(renderHowto).catch((e) => {
      loaded = false;
      $("#howto-steps").innerHTML = `<li><p class="err">Could not load the run (${esc(e.message)}). Reload the page.</p></li>`;
    });
  }

  function setMode(mode) {
    document.querySelectorAll(".tab").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.mode === mode)));
    $("#howto").hidden = mode !== "howto";
    $("#live").hidden = mode !== "live";
    if (mode === "howto") load();
    if (location.hash !== "#" + mode) history.replaceState(null, "", "#" + mode);
  }
  const fromHash = () => (location.hash === "#live" ? "live" : "howto");
  document.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => {
    setMode(b.dataset.mode);
    if (!b.classList.contains("tab")) document.getElementById("tab-" + b.dataset.mode).focus();
  }));
  window.addEventListener("hashchange", () => setMode(fromHash()));
  /* crossing the phone breakpoint redraws the chart at the other canvas size */
  narrowMq.addEventListener("change", () => { if (loaded) getJson("data/run.json").then(renderHowto); });

  setMode(fromHash());
})();

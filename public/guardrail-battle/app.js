/* ───────────────────────────────────────────────────────────────
   Guardrail battle — renders two frozen runs of a guardrail tuning loop.

   data/toy.json   twelve messages, three rounds, two candidates a round
   data/run.json   the full run: a held-out exam, four adversary rounds

   Both files are snapshots: nothing here polls, and nothing calls a model.
   ─────────────────────────────────────────────────────────────── */

(function () {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const p1 = (x) => (x == null ? "–" : (x * 100).toFixed(1) + "%");
  const pct = (x) => Math.round(x * 100);
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

  const pros = (c) => {
    const p = (c.pros || []).map((x) => `<li>${esc(x)}</li>`).join("");
    const n = (c.cons || []).map((x) => `<li>${esc(x)}</li>`).join("");
    if (!p && !n) return "";
    return `<div class="pc"><div class="pros"><h4>Pros</h4><ul>${p}</ul></div>` +
      `<div class="cons"><h4>Cons</h4><ul>${n}</ul></div></div>`;
  };

  const bar = (x, label) =>
    `<div class="bar" role="img" aria-label="${esc(label)} ${p1(x)}"><div style="width:${Math.max(0, Math.min(100, (x || 0) * 100))}%"></div></div>` +
    '<div class="axis"><span>0%</span><span>50%</span><span>100%</span></div>';

  /* ── toy mode ──────────────────────────────────────────────────── */

  function toyCard(c, n) {
    return `<div class="card ${c.kept ? "kept" : ""}">` +
      `<div class="chead"><span class="cid">${esc(c.id)}</span>` +
      `<span class="badge ${c.kept ? "" : "no"}">${c.kept ? "kept" : "not kept"}</span></div>` +
      `<div class="acc">correct <b>${c.accuracy}/${n}</b> · judge score <b>${pct(c.judge_score)}%</b></div>` +
      bar(c.judge_score, "judge score") +
      (pros(c) || '<p class="note">Hand-written starting config.</p>') + gv(c.config) + "</div>";
  }

  function lineDiff(a, b) {
    const n = a.length, m = b.length;
    const L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
    const out = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { out.push([" ", a[i]]); i++; j++; }
      else if (L[i + 1][j] >= L[i][j + 1]) out.push(["-", a[i++]]);
      else out.push(["+", b[j++]]);
    }
    while (i < n) out.push(["-", a[i++]]);
    while (j < m) out.push(["+", b[j++]]);
    return out;
  }

  function renderToy(d) {
    const rounds = d.rounds, msgs = d.messages, n = msgs.length;
    $("#toy-meta").textContent = `${rounds.length - 1} rounds × 2 candidates · ${n}\u00a0messages · metric: ${d.metric}`;

    $("#toy-rounds").innerHTML = rounds.map((r) => {
      const keptPrev = r.round > 0 && !r.candidates.some((c) => c.kept);
      return `<div class="round" data-r="${r.round}"><div class="rlabel">round<b>${r.round}</b>` +
        (keptPrev ? '<p class="note">kept the previous best</p>' : "") + "</div>" +
        `<div class="cands">${r.candidates.map((c) => toyCard(c, n)).join("")}</div></div>`;
    }).join("");

    $("#toy-side").innerHTML = diffLegend + rounds.slice(1).map((r, k) =>
      sideBySide(rounds[k].kept_config, r.kept_config, `round ${k} · ${rounds[k].kept_id}`,
        `round ${r.round} · ${r.kept_id}${r.candidates.some((c) => c.kept) ? "" : " (unchanged)"}`, k === 0)).join("");

    const rows = msgs.map((m, i) => {
      const vals = rounds.map((r) => r.kept_verdicts[i].correct);
      const flip = !vals[0] && vals[vals.length - 1];
      return `<tr class="${flip ? "flip" : ""}"><td>${esc(m.text)}<span class="lab ${m.gold}">${m.gold}</span>` +
        (flip ? '<span class="fliptag">fixed by the loop</span>' : "") + "</td>" +
        rounds.map((r) => {
          const v = r.kept_verdicts[i];
          return `<td class="c cell ${v.correct ? "y" : "n"}" data-r="${r.round}" title="verdict: ${esc(v.verdict)}">${v.correct ? "✓" : "✗"}</td>`;
        }).join("") + "</tr>";
    }).join("");
    const foot = rounds.map((r) =>
      `<td class="c" data-r="${r.round}">${r.kept_verdicts.filter((x) => x.correct).length}/${n}</td>`).join("");
    $("#toy-grid").innerHTML = `<table><thead><tr><th>message · expected</th>` +
      rounds.map((r) => `<th class="c" data-r="${r.round}">r${r.round}<br>${esc(r.kept_id)}</th>`).join("") +
      `</tr></thead><tbody>${rows}</tbody><tfoot><tr><td>correct</td>${foot}</tr></tfoot></table>`;

    const A = JSON.stringify(d.round0, null, 1).split("\n");
    const B = JSON.stringify(d.final, null, 1).split("\n");
    $("#toy-diff").innerHTML = lineDiff(A, B).map(([s, l]) =>
      `<div class="${s === "+" ? "add" : s === "-" ? "del" : ""}"><span class="sig">${s}</span>${esc(l)}</div>`).join("");
  }

  function showToyRound(k) {
    document.querySelectorAll("#toy .round").forEach((el) => el.classList.toggle("hidden", +el.dataset.r > k));
    document.querySelectorAll("#toy-grid [data-r]").forEach((el) => el.classList.toggle("col-hidden", +el.dataset.r > k));
  }
  let timers = [];
  $("#replay").addEventListener("click", () => {
    timers.forEach(clearTimeout);
    timers = [];
    const max = document.querySelectorAll("#toy .round").length - 1;
    showToyRound(0);
    for (let k = 1; k <= max; k++) timers.push(setTimeout(() => showToyRound(k), k * 1400));
  });

  /* ── full run ──────────────────────────────────────────────────── */

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

  const hbars = (obj) => {
    const e = Object.entries(obj || {}).sort((a, b) => b[1] - a[1]);
    const t = e.reduce((s, [, v]) => s + v, 0) || 1;
    return e.map(([k, v]) => `<div class="hbar"><span>${esc(k)}</span><div class="t"><div style="width:${100 * v / t}%"></div></div><span class="v">${v}</span></div>`).join("");
  };
  const groupSources = (obj) => {
    const o = {};
    for (const [k, v] of Object.entries(obj || {})) {
      const g = /^adversarial/.test(k) ? "adversarial" : k;
      o[g] = (o[g] || 0) + v;
    }
    return o;
  };

  function runCard(c) {
    const t = c.train || {};
    return `<div class="card ${c.kept ? "kept" : ""}">` +
      `<div class="chead"><span class="cid">${esc(c.id)}</span>` +
      `<span class="badge ${c.kept ? "" : "no"}">${c.kept ? "kept" : "not kept"}</span></div>` +
      `<div class="acc">train balanced accuracy <b>${p1(t.balanced_accuracy)}</b> · n\u00a0=\u00a0${t.n}</div>` +
      bar(t.balanced_accuracy, "train balanced accuracy") +
      `<p class="note">over-refusal ${p1(t.over_refusal)} · leak ${p1(t.leak)} · ${c.prompt_tokens} prompt\u00a0tokens</p>` +
      (pros(c) || '<p class="note">Starting config, from the shipped taxonomy.</p>') + gv(c.config) + "</div>";
  }

  function renderRun(d) {
    const R = d.rounds, ds = d.dataset, la = d.label_agreement, pair = d.paired;
    const xs = R.map((r) => "r" + r.round);
    const H = R.map((r) => r.heldout);
    const h0 = H[0], last = H[H.length - 1], lastR = R[R.length - 1].round;
    const all = R.flatMap((r) => r.candidates);
    const byId = (id) => all.find((c) => c.id === id);
    const kc = R.map((r) => byId(r.kept_id));

    let html = "";

    /* headline: three numbers, each with its own n and interval */
    html += `<h2>Held-out score</h2><div class="grid3">` +
      `<div class="card"><p class="klabel">balanced accuracy · r0 → r${lastR}</p>` +
      `<div class="kpi">${p1(h0.balanced_accuracy)} → ${p1(last.balanced_accuracy)}</div>` +
      `<p class="note">95% CI r0 ${ciText(h0.ba_ci95)} · final ${ciText(last.ba_ci95)}</p>` +
      `<p class="note">Zero errors on n\u00a0=\u00a0${last.n} is not zero risk: ≈\u00a03/n puts each error rate under ${p1(3 / last.n_blocked)}.</p></div>` +
      `<div class="card"><p class="klabel">paired change · same ${pair.n}\u00a0messages</p>` +
      `<div class="kpi">+${(pair.ba_delta * 100).toFixed(1)} <small>pts</small></div>` +
      `<p class="note">95% CI ${(pair.ba_delta_ci95[0] * 100).toFixed(1)} to ${(pair.ba_delta_ci95[1] * 100).toFixed(1)} pts · McNemar p\u00a0=\u00a0${pair.mcnemar_exact_p}</p>` +
      `<p class="note">${pair.r0_wrong_final_right} fixed · ${pair.r0_right_final_wrong} broken</p></div>` +
      `<div class="card"><p class="klabel">prompt length of the kept guardrail</p>` +
      `<div class="kpi">${d.prompt_tokens.r0} → ${d.prompt_tokens.final} <small>tokens</small></div>` +
      `<p class="note">A longer guardrail costs time and money on every message.</p></div></div>`;

    html += `<div class="grid2" style="margin-top:12px">` +
      `<div class="card"><h3>Balanced accuracy</h3>` +
      chart([
        { name: `held-out, n\u00a0=\u00a0${h0.n}`, color: "var(--accent)", pts: H.map((x) => ({ y: x.balanced_accuracy, lo: x.ba_ci95[0], hi: x.ba_ci95[1] })) },
        { name: "train, kept config", color: "var(--crease)", dash: true, pts: kc.map((c) => ({ y: c.train.balanced_accuracy })) },
      ], xs, "balanced accuracy per round") +
      `<p class="note">Train grows every round with new attacks, so train points are not comparable across rounds.</p></div>` +
      `<div class="card"><h3>Error rates, lower is better</h3>` +
      chart([
        { name: `over-refusal, n\u00a0=\u00a0${h0.n_allowed}`, color: "var(--warn)", pts: H.map((x) => ({ y: x.over_refusal, lo: x.over_refusal_ci95[0], hi: x.over_refusal_ci95[1] })) },
        { name: `leak, n\u00a0=\u00a0${h0.n_blocked}`, color: "var(--over)", pts: H.map((x) => ({ y: x.leak, lo: x.leak_ci95[0], hi: x.leak_ci95[1] })) },
        { name: `NotInject leak, n\u00a0=\u00a0${R[0].notinject.n_blocked}`, color: "var(--ink-3)", dash: true, pts: R.map((r) => ({ y: r.notinject.leak })) },
      ], xs, "error rates per round") +
      `<p class="note">NotInject is a public set of harmless messages full of trigger words. Here they are off-topic, so letting one through counts as a leak. It rose from ${p1(R[0].notinject.leak)} to ${p1(R[R.length - 1].notinject.leak)}.</p></div></div>`;

    /* on a phone each row becomes a card: data-label carries the header */
    const cols = ["train n", "train acc.", "held-out acc. · 95% CI", "over-refusal", "leak", "NotInject leak", "tokens"];
    html += `<h2>Every round</h2><div class="scroll"><table class="reflow"><thead><tr><th>round · kept</th>` +
      cols.map((c) => `<th class="num">${c}</th>`).join("") + "</tr></thead><tbody>" +
      R.map((r, i) => {
        const vals = [r.train_n, p1(kc[i].train.balanced_accuracy),
          `${p1(H[i].balanced_accuracy)} <span class="note">${ciText(H[i].ba_ci95)}</span>`,
          p1(H[i].over_refusal), p1(H[i].leak), p1(r.notinject.leak), kc[i].prompt_tokens];
        return `<tr><td class="rhead"><span>r${r.round}</span> <span class="cid">${esc(r.kept_id)}</span>` +
          (i > 0 && !r.candidates.some((c) => c.kept) ? ' <span class="note">(kept previous)</span>' : "") + "</td>" +
          vals.map((v, k) => `<td class="num" data-label="${cols[k]}"><span>${v}</span></td>`).join("") + "</tr>";
      }).join("") +
      "</tbody></table></div>";

    /* the kept config, only where it changed */
    const changes = R.slice(1).filter((r, k) => r.kept_id !== R[k].kept_id);
    html += `<h2>What the loop changed</h2>${diffLegend}` + changes.map((r, k) => {
      const prev = k === 0 ? R[0] : changes[k - 1];
      const a = byId(prev.kept_id), b = byId(r.kept_id);
      return sideBySide(a.config, b.config, `${prev.kept_id} · ${a.prompt_tokens}\u00a0tok`, `${r.kept_id} · ${b.prompt_tokens}\u00a0tok`, k === 0);
    }).join("");

    html += `<h2>Candidates, round by round</h2><div class="timeline">` + R.map((r) => {
      const keptPrev = r.round > 0 && !r.candidates.some((c) => c.kept);
      return `<div class="round"><div class="rlabel">round<b>${r.round}</b>` +
        (keptPrev ? '<p class="note">kept the previous best</p>' : "") +
        `<p class="note">train n\u00a0=\u00a0${r.train_n}</p></div>` +
        `<div class="cands">${r.candidates.map(runCard).join("")}</div></div>`;
    }).join("") + "</div>";

    const hard = d.heldout_hard.map((x) => ({ ...x, c0: x.r0_pred === x.gold, c1: x.final_pred === x.gold }))
      .sort((a, b) => (a.c0 === a.c1) - (b.c0 === b.c1) || (b.c1 - a.c1));
    const cell = (ok, pred, cat) =>
      `<td class="c cell ${ok ? "y" : "n"}" title="verdict: ${esc(pred)}${cat ? " · " + esc(cat) : ""}">${ok ? "✓" : "✗"}</td>`;
    const hs = d.heldout_summary;
    html += `<h2>Where r0 and r${lastR} disagree</h2>` +
      `<p class="note">${hard.length} of ${hs.n} held-out messages. Synthetic text.</p>` +
      `<div class="scroll"><table><thead><tr><th>message · expected · slice</th><th class="c">r0</th><th class="c">r${lastR}</th></tr></thead><tbody>` +
      hard.map((x) => {
        const fx = !x.c0 && x.c1, br = x.c0 && !x.c1;
        return `<tr class="${fx ? "flip" : br ? "regr" : ""}"><td>${esc(x.text)}<span class="lab ${x.gold}">${x.gold}</span>` +
          `<span class="lab sl">${esc(x.slice)}</span>` +
          (fx ? '<span class="fliptag">fixed by the loop</span>' : br ? '<span class="fliptag">broken by the loop</span>' : "") +
          `</td>${cell(x.c0, x.r0_pred, x.r0_category)}${cell(x.c1, x.final_pred, x.final_category)}</tr>`;
      }).join("") +
      `</tbody><tfoot><tr><td>correct, all ${hs.n} held-out</td><td class="c">${hs.r0_correct}</td><td class="c">${hs.final_correct}</td></tr></tfoot></table></div>`;

    html += `<h2>Where the exam came from</h2><div class="grid3">` +
      `<div class="card"><h3>Train, by source</h3>${hbars(groupSources(ds.train_source))}` +
      `<p class="note">${ds.train_initial} at the start, ${ds.train_final} at the end.</p></div>` +
      `<div class="card"><h3>Held-out, by slice</h3>${hbars(ds.heldout_slice)}` +
      `<h3 style="margin-top:12px">Held-out, by expected label</h3>${hbars(ds.heldout_gold)}</div>` +
      `<div class="card"><h3>Labels kept</h3>` +
      `<p class="note">A message is kept only when the ${esc(d.models.generator)} and the ${esc(d.models.labeler)} agree on its label.</p>` +
      `<div class="hbar"><span>exam ${la.exam.agree}/${la.exam.n_labeled}</span><div class="t"><div style="width:${la.exam.agreement_rate * 100}%"></div></div><span class="v">${pct(la.exam.agreement_rate)}%</span></div>` +
      `<div class="hbar"><span>NotInject ${la.notinject.agree}/${la.notinject.n_labeled}</span><div class="t"><div style="width:${la.notinject.agreement_rate * 100}%"></div></div><span class="v">${pct(la.notinject.agreement_rate)}%</span></div>` +
      la.adversarial.map((s) => `<div class="hbar"><span>attack r${s.round} ${s.agree}/${s.n_labeled}</span><div class="t"><div style="width:${s.agreement_rate * 100}%"></div></div><span class="v">${pct(s.agreement_rate)}%</span></div>`).join("") +
      `</div></div><p class="note">${ds.raw_generated} generated, ${ds.dedup_dropped} near-duplicates dropped.</p>`;

    html += `<h2>Hardest training messages</h2><details class="pair"><summary>${d.hardest_train.length}\u00a0messages most candidates got wrong</summary>` +
      `<div class="scroll"><table><thead><tr><th>message · expected · source</th><th class="num">error rate</th><th class="num">tries</th></tr></thead><tbody>` +
      d.hardest_train.map((x) => `<tr><td>${esc(x.text)}<span class="lab ${x.gold}">${x.gold}</span><span class="lab sl">${esc(x.source)}</span></td>` +
        `<td class="num">${p1(x.error_rate)}</td><td class="num">${x.n_evals}</td></tr>`).join("") +
      "</tbody></table></div></details>";

    $("#p-body").innerHTML = html;
    lastRun = d;
  }
  let lastRun = null;
  /* crossing the phone breakpoint redraws the charts at the other canvas size */
  narrowMq.addEventListener("change", () => { if (lastRun) renderRun(lastRun); });

  /* ── tabs ──────────────────────────────────────────────────────── */

  const loaded = {};
  function load(mode) {
    if (loaded[mode]) return;
    loaded[mode] = true;
    const [url, render, target] = mode === "toy"
      ? ["data/toy.json", renderToy, "#toy-rounds"]
      : ["data/run.json", renderRun, "#p-body"];
    getJson(url).then(render).catch((e) => {
      loaded[mode] = false;
      $(target).innerHTML = `<p class="err">Could not load ${esc(url)}: ${esc(e.message)}</p>`;
    });
  }

  function setMode(mode) {
    document.querySelectorAll(".tab").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.mode === mode)));
    $("#toy").hidden = mode !== "toy";
    $("#proper").hidden = mode !== "proper";
    load(mode);
    if (location.hash !== "#" + mode) history.replaceState(null, "", "#" + mode);
  }
  document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
  window.addEventListener("hashchange", () => setMode(location.hash === "#proper" ? "proper" : "toy"));

  /* the held-out n in the header comes from the data, not from the markup */
  getJson("data/run.json").then((d) => {
    $("#h-n").textContent = `n\u00a0=\u00a0${d.rounds[0].heldout.n}`;
  }).catch(() => {});

  setMode(location.hash === "#proper" ? "proper" : "toy");
})();

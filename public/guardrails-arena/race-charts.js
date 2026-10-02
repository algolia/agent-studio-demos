/* ───────────────────────────────────────────────────────────────
   race-charts.js → window.GuardrailCharts

   The charts after a race, as SVG strings. Input is what
   GuardrailLive.summarize returns, best first. Rate axes always run
   0–100%; the time axis starts at 0 ms. Pure: no DOM, no fetch.
   ─────────────────────────────────────────────────────────────── */

(function (global) {
  "use strict";

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const p1 = (x) => (x == null ? "–" : (x * 100).toFixed(1) + "%");
  const color = (k) => `var(--f${k % 10})`;
  const short = (s, n = 24) => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));

  /* a phone gets a narrower canvas, so the same 11px text reads near full size */
  let W = 560, LBL = 170, NAME = 24, plotW = 0;
  const R = 30, ROW = 30, TOP = 8, AX = 26;
  const size = (narrow) => {
    [W, LBL, NAME] = narrow ? [360, 132, 13] : [560, 170, 24];
    plotW = W - LBL - R;
  };
  size(false);

  function frame(n, ticks, fmt, X) {
    const H = TOP + n * ROW + AX;
    let g = "";
    for (const t of ticks) {
      g += `<line class="grid" x1="${X(t)}" x2="${X(t)}" y1="${TOP}" y2="${TOP + n * ROW}"/>` +
        `<text x="${X(t)}" y="${H - 8}" text-anchor="middle">${fmt(t)}</text>`;
    }
    return { H, g };
  }

  function rowLabel(name, k, y) {
    return `<text x="${LBL - 10}" y="${y + 4}" text-anchor="end"><tspan class="rank">${k + 1}</tspan> ${esc(short(name, NAME))}</text>`;
  }

  /** balanced accuracy per fighter: bar, 95% interval, one dot per rerun */
  function accuracy(rows, nameOf) {
    const X = (v) => LBL + plotW * v;
    const { H, g: grid } = frame(rows.length, [0, 0.25, 0.5, 0.75, 1], (t) => `${t * 100}%`, X);
    let g = grid;
    rows.forEach((r, k) => {
      const y = TOP + k * ROW + ROW / 2, c = color(k), ba = r.ba.rate;
      g += rowLabel(nameOf(r), k, y);
      if (ba == null) { g += `<text x="${LBL + 6}" y="${y + 4}" class="muted">no score</text>`; return; }
      g += `<rect x="${LBL}" y="${y - 7}" width="${Math.max(1, X(ba) - LBL)}" height="14" rx="2" style="fill:${c};opacity:.35"/>`;
      if (r.ba.ci) {
        const [lo, hi] = r.ba.ci.map(X);
        g += `<line x1="${lo}" x2="${hi}" y1="${y}" y2="${y}" style="stroke:${c};stroke-width:2"/>` +
          `<line x1="${lo}" x2="${lo}" y1="${y - 5}" y2="${y + 5}" style="stroke:${c};stroke-width:2"/>` +
          `<line x1="${hi}" x2="${hi}" y1="${y - 5}" y2="${y + 5}" style="stroke:${c};stroke-width:2"/>`;
      }
      (r.perRepeat || []).forEach((v) => {
        if (v != null) g += `<circle cx="${X(v)}" cy="${y}" r="3" class="rep"><title>one rerun: ${p1(v)}</title></circle>`;
      });
      const ci = r.ba.ci ? ` (95% CI ${p1(r.ba.ci[0])}–${p1(r.ba.ci[1])})` : "";
      g += `<circle cx="${X(ba)}" cy="${y}" r="5" style="fill:${c}"><title>${esc(nameOf(r))}: ${p1(ba)}${ci}</title></circle>`;
    });
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Balanced accuracy per fighter, 0 to 100%">${g}</svg>`;
  }

  /** the trade-off: over-refusal across, leak up; the corner at 0, 0 is perfect */
  function tradeoff(rows, nameOf) {
    const S = 300, L = 46, B = 34, T = 10, Rr = 12, pw = S - L - Rr, ph = S - T - B;
    const X = (v) => L + pw * v, Y = (v) => T + ph * (1 - v);
    let g = "";
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      g += `<line class="grid" x1="${X(t)}" x2="${X(t)}" y1="${T}" y2="${T + ph}"/><line class="grid" x1="${L}" x2="${L + pw}" y1="${Y(t)}" y2="${Y(t)}"/>` +
        `<text x="${X(t)}" y="${S - 18}" text-anchor="middle">${t * 100}%</text><text x="${L - 6}" y="${Y(t) + 4}" text-anchor="end">${t * 100}%</text>`;
    }
    g += `<text x="${L + pw / 2}" y="${S - 2}" text-anchor="middle" class="muted">over-refusal: good messages blocked</text>` +
      `<text x="12" y="${T + ph / 2}" text-anchor="middle" class="muted" transform="rotate(-90 12 ${T + ph / 2})">leak: bad messages let through</text>`;
    rows.forEach((r, k) => {
      const o = r.overRefusal, l = r.leak;
      if (o.rate == null || l.rate == null) return;
      const c = color(k), x = X(o.rate), y = Y(l.rate);
      if (o.ci) g += `<line x1="${X(o.ci[0])}" x2="${X(o.ci[1])}" y1="${y}" y2="${y}" style="stroke:${c};stroke-width:1.5;opacity:.7"/>`;
      if (l.ci) g += `<line x1="${x}" x2="${x}" y1="${Y(l.ci[0])}" y2="${Y(l.ci[1])}" style="stroke:${c};stroke-width:1.5;opacity:.7"/>`;
      g += `<circle cx="${x}" cy="${y}" r="8" style="fill:${c}"><title>${esc(nameOf(r))}: over-refusal ${p1(o.rate)}, leak ${p1(l.rate)}</title></circle>` +
        `<text x="${x}" y="${y + 3.5}" text-anchor="middle" class="dotnum">${k + 1}</text>`;
    });
    return `<svg class="chart sq" viewBox="0 0 ${S} ${S}" role="img" aria-label="Over-refusal against leak per fighter, both 0 to 100%">${g}</svg>`;
  }

  const nice = (v) => {
    if (!(v > 0)) return 1000;
    const p = Math.pow(10, Math.floor(Math.log10(v))), m = v / p;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
  };

  /** time to a verdict: bar to the median, a tick at the 90th percentile */
  function speed(rows, nameOf) {
    const max = nice(Math.max(...rows.map((r) => r.p90ms || r.p50ms || 0)));
    const X = (v) => LBL + plotW * Math.min(1, v / max);
    const ticks = W < 500 ? [0, max / 2, max] : [0, max / 4, max / 2, (3 * max) / 4, max];
    const fmt = (t) => (max >= 4000 ? `${(t / 1000).toFixed(t % 1000 ? 1 : 0)}\u00a0s` : `${Math.round(t)}\u00a0ms`);
    const { H, g: grid } = frame(rows.length, ticks, fmt, X);
    let g = grid;
    rows.forEach((r, k) => {
      const y = TOP + k * ROW + ROW / 2, c = color(k);
      g += rowLabel(nameOf(r), k, y);
      if (r.p50ms == null) return;
      g += `<rect x="${LBL}" y="${y - 7}" width="${Math.max(1, X(r.p50ms) - LBL)}" height="14" rx="2" style="fill:${c};opacity:.8">` +
        `<title>${esc(nameOf(r))}: median ${Math.round(r.p50ms)}\u00a0ms, 90th percentile ${Math.round(r.p90ms)}\u00a0ms</title></rect>`;
      if (r.p90ms != null) g += `<line x1="${X(r.p90ms)}" x2="${X(r.p90ms)}" y1="${y - 8}" y2="${y + 8}" style="stroke:${c};stroke-width:2"/>`;
    });
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Median time to a verdict per fighter">${g}</svg>`;
  }

  global.GuardrailCharts = { accuracy, tradeoff, speed, color, size };
})(window);

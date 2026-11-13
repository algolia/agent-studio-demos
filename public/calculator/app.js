/* ───────────────────────────────────────────────────────────────
   app.js — DOM wiring for the cost calculator.

   The arithmetic lives in calc.js; this file only reads inputs, calls the
   view models, and renders. Three tabs share one state object and one
   render pass, so sweeping the adoption slider updates the funnel, the
   anatomy strip, the summary and every row of the model table together.

   The model table is the piece everything points at: clicking a row selects
   the model the summary prices, and the cost bars re-derive from whatever
   traffic the active tab implies.
   ─────────────────────────────────────────────────────────────── */

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const C = window.CALC_DATA;
  const Calc = window.Calc;

  const state = {
    selectedModel: "algolia-medium",
    measured: null, // { inputTokens, outputTokens, method, approximate }
  };

  /* ── Tabs ─────────────────────────────────────────────────────────── */

  const TABS = ["envelope", "traffic", "eval"];
  function selectTab(name) {
    for (const t of TABS) {
      $(`tab-${t}`).setAttribute("aria-selected", String(t === name));
      $(`pane-${t}`).hidden = t !== name;
    }
    history.replaceState(null, "", `#${name}`);
  }
  for (const t of TABS) $(`tab-${t}`).addEventListener("click", () => selectTab(t));

  /* ── Inputs ───────────────────────────────────────────────────────── */

  function num(id, fallback) {
    const v = parseFloat($(id).value);
    return Number.isFinite(v) ? v : fallback;
  }

  function trafficParams() {
    return {
      sessionsPerDay: num("in-sessions", 10000),
      adoptionPct: num("in-adoption", 12),
      turnsPerConversation: num("in-turns", 3),
      roundsPerTurn: num("in-rounds", 2),
      inputTokensPerRound: num("in-tokin", 3000),
      outputTokensPerTurnCall: num("in-tokout", 500),
      guardrails: $("in-guardrails").checked,
      responseCachePct: num("in-respcache", 50),
      providerCachePct: num("in-provcache", 40),
      pdp: $("in-pdp").checked,
      pdpCallsPerDay: num("in-pdpcalls", 3000),
      followups: $("in-followups").checked,
      daysPerMonth: num("in-days", 30),
    };
  }

  function evalParams() {
    const judge = $("e-judge").value.trim() || C.constants.EVAL_JUDGE_MODEL;
    return {
      numCases: num("e-cases", 500),
      iterations: num("e-iterations", 1),
      metricCount: num("e-metrics", 2),
      roundsMultiplier: num("e-rounds", 2),
      modelId: $("e-model").value,
      judgeModelId: judge,
      concurrency: num("e-concurrency", C.constants.EVAL_RUN_CONCURRENCY),
      guardrails: $("e-guardrails").checked,
    };
  }

  /* ── Rendering: envelope tab ──────────────────────────────────────── */

  function cachedCost(v) {
    const model = C.models.find((m) => m.id === state.selectedModel);
    return Calc.costBandCached(
      model, v.tokensInMonth, v.tokensOutMonth,
      v.providerCachePct, C.constants.PROVIDER_CACHE_DISCOUNT, C.constants.BAND_RATIO
    );
  }

  function renderFunnel(v, p) {
    const cost = cachedCost(v);
    const rows = [
      { label: "Sessions / day", value: Calc.fmtInt(p.sessionsPerDay), frac: 1 },
      { label: "Conversations / day", value: Calc.fmtInt(v.conversationsPerDay), frac: v.conversationsPerDay / p.sessionsPerDay },
      { label: "Turns / day", value: Calc.fmtInt(v.turnsPerDay), frac: v.turnsPerDay / p.sessionsPerDay },
      { label: "Turns billed / day", value: Calc.fmtInt(v.turnsBilledPerDay), frac: v.turnsBilledPerDay / p.sessionsPerDay },
      { label: "LLM calls / day", value: Calc.fmtInt(v.callsBilledPerDay), frac: v.callsBilledPerDay / p.sessionsPerDay },
      { label: "Tokens / month", value: Calc.shortTokens(v.tokensMonth), frac: 0.34 },
      { label: "Dollars / month", value: cost ? `${Calc.usd(cost.point)}/mo` : "no curated price", frac: 0.1 },
    ];
    const el = $("funnel");
    el.replaceChildren(
      ...rows.map((r) => {
        const row = document.createElement("div");
        row.className = "funnel-row";
        const label = document.createElement("span");
        label.className = "funnel-label";
        label.textContent = r.label;
        const bar = document.createElement("div");
        bar.className = "funnel-bar";
        const fill = document.createElement("i");
        fill.style.setProperty("--w", `${Math.max(2, r.frac * 100).toFixed(1)}%`);
        bar.append(fill);
        const value = document.createElement("span");
        value.className = "funnel-value";
        value.textContent = r.value;
        row.append(label, bar, value);
        return row;
      })
    );
  }

  function renderAnatomy(p) {
    const inputTokens = p.inputTokensPerRound;
    const parts = Calc.anatomy(inputTokens, p.outputTokensPerTurnCall, C.anatomyShares);
    const el = $("anatomy");
    el.replaceChildren(
      ...parts.map((part) => {
        const row = document.createElement("div");
        row.className = "anatomy-row";
        row.dataset.key = part.key;
        const label = document.createElement("span");
        label.className = "anatomy-label";
        label.textContent = part.label;
        const bar = document.createElement("div");
        bar.className = "anatomy-bar";
        const fill = document.createElement("i");
        fill.style.setProperty("--w", part.frac.toFixed(3));
        bar.append(fill);
        const value = document.createElement("span");
        value.className = "anatomy-value";
        value.textContent = Calc.shortTokens(part.tokens);
        row.append(label, bar, value);
        return row;
      }),
      answerRow(p.outputTokensPerTurnCall)
    );
    $("anatomy-total").textContent = `${Calc.fmtInt(inputTokens)} tok in · ${Calc.fmtInt(p.outputTokensPerTurnCall)} out`;
  }

  function answerRow(tokens) {
    const row = document.createElement("div");
    row.className = "anatomy-row";
    row.dataset.key = "answer";
    const label = document.createElement("span");
    label.className = "anatomy-label";
    label.textContent = "Answer (output)";
    const bar = document.createElement("div");
    bar.className = "anatomy-bar";
    const fill = document.createElement("i");
    fill.style.setProperty("--w", "1");
    bar.append(fill);
    const value = document.createElement("span");
    value.className = "anatomy-value";
    value.textContent = Calc.shortTokens(tokens);
    row.append(label, bar, value);
    return row;
  }

  function renderConversation(p) {
    const el = $("conversation");
    const QUOTES = [
      "“I need a gift for a 10-year-old”",
      "“something under $50”",
      "“how do those two compare?”",
    ];
    const rows = [];
    const turns = Math.min(p.turnsPerConversation, 3);
    for (let t = 1; t <= turns; t++) {
      rows.push({ cls: "user", label: `User turn ${t}`, note: QUOTES[(t - 1) % QUOTES.length] });
      for (let r = 1; r <= p.roundsPerTurn; r++) {
        const last = r === p.roundsPerTurn;
        rows.push({
          cls: last ? "answer" : "round",
          label: last ? `LLM call · answer` : `LLM call · round ${r}`,
          note: last
            ? (t === 1 ? "streams the first answer (+ follow-up chips)" : "streams the next answer")
            : "searches, reads records, plans",
        });
      }
    }
    if (turns < p.turnsPerConversation) {
      rows.push({ cls: "more", label: `… ${p.turnsPerConversation - turns} more turn(s)`, note: "" });
    }
    el.replaceChildren(
      ...rows.map((row) => {
        const div = document.createElement("div");
        div.className = `conv-row conv-${row.cls}`;
        const bar = document.createElement("span");
        bar.className = "conv-bar";
        if (row.cls === "user") bar.style.setProperty("--w", "0.45");
        if (row.cls === "answer") bar.style.setProperty("--w", "0.8");
        if (row.cls === "round") bar.style.setProperty("--w", "1");
        const label = document.createElement("span");
        label.className = "conv-label";
        label.textContent = row.label;
        const note = document.createElement("span");
        note.className = "conv-note";
        note.textContent = row.note;
        div.append(bar, label, note);
        return div;
      })
    );
    const callsPerConv = p.turnsPerConversation * p.roundsPerTurn + (p.followups ? p.turnsPerConversation : 0);
    $("conv-total").textContent =
      `${p.turnsPerConversation} turns × ${p.roundsPerTurn} rounds = ${callsPerConv} LLM call(s)` +
      (p.followups ? " + follow-up chips" : "");
  }

  /* The managed-LLM callout: our own model, beta terms, the first number
     a visitor sees — and the honest caveat that GA pricing will differ. */
  function renderManaged(v) {
    const model = C.models.find((m) => m.id === "algolia-medium");
    const cost = cachedCost(v);
    const fig = $("managed-figure");
    if (!cost) {
      fig.textContent = "—";
    } else if (cost.point === 0) {
      const pct = Math.min(100, Math.round((v.tokensMonth / model.managedBeta.freeTokensPerMonth) * 100));
      fig.textContent = `Free at this traffic — ${pct}% of the 500M free tokens/month`;
    } else {
      fig.textContent =
        `from ${Calc.usd(cost.low)} · est ${Calc.usd(cost.point)} · up to ${Calc.usd(cost.high)} / month`;
    }
    $("managed-terms").textContent =
      "First 500M tokens/month free, then $0.62 per 1M output tokens, invoiced monthly. " +
      "4-month beta; GA pricing will differ — talk to your AE or CSM to join.";
  }

  function renderSummary(v, p) {
    const model = C.models.find((m) => m.id === state.selectedModel);
    const cost = cachedCost(v);
    $("sum-model").textContent = model ? model.label : "—";
    $("sum-low").textContent = cost ? Calc.usd(cost.low) : "";
    $("sum-point").textContent = cost ? Calc.usd(cost.point) : "no curated price";
    $("sum-high").textContent = cost ? Calc.usd(cost.high) : "";
    const conversationsMonth = v.conversationsPerDay * p.daysPerMonth;
    $("sum-annual").textContent = cost
      ? `≈ ${Calc.usd(cost.point / conversationsMonth)} per assisted conversation`
      : "Token counts only — no price available for this model.";
    const measured = state.measured;
    $("sum-note").textContent = measured
      ? `Input/output tokens are ${measured.approximate ? "a local ≈4 chars/token approximation" : "measured on your real prompts"} — see the “Refine with real traffic” tab.`
      : "±50% band — click a row of the table to change models.";
  }

  /* ── Rendering: model table ───────────────────────────────────────── */

  function visibleModels(v) {
    const provider = $("f-provider").value;
    const maxIn = parseFloat($("f-maxin").value);
    const pricedOnly = $("f-priced").checked;
    const hideLegacy = $("f-hidelegacy").checked;

    let rows = C.models.filter((m) => {
      if (provider && m.provider !== provider) return false;
      if (Number.isFinite(maxIn) && (m.inPerMTok == null || m.inPerMTok > maxIn)) return false;
      if (pricedOnly && m.priceScope == null) return false;
      if (hideLegacy && (m.state === "legacy" || m.state === "deprecated")) return false;
      return true;
    });

    const cost = (m) => {
      const b = Calc.costBandCached(
        m, v.tokensInMonth, v.tokensOutMonth,
        v.providerCachePct, C.constants.PROVIDER_CACHE_DISCOUNT, C.constants.BAND_RATIO
      );
      return b ? b.point : Infinity;
    };
    const sort = $("f-sort").value;
    rows = rows.slice().sort((a, b) => {
      if (sort === "cost") return cost(a) - cost(b) || a.label.localeCompare(b.label);
      if (sort === "in") return (a.inPerMTok ?? Infinity) - (b.inPerMTok ?? Infinity);
      if (sort === "context") return (b.contextWindow ?? 0) - (a.contextWindow ?? 0);
      return a.label.localeCompare(b.label);
    });
    return rows;
  }

  function renderTable(v) {
    const rows = visibleModels(v);
    const body = $("cost-body");

    const points = rows
      .map((m) => Calc.costBand(m, v.tokensInMonth, v.tokensOutMonth, C.constants.BAND_RATIO))
      .filter(Boolean)
      .map((b) => b.point);
    const maxPoint = points.length ? Math.max(...points) : 0;
    const minPoint = points.length ? Math.min(...points) : 0;
    // Log scale: o1-pro at $150/$600 per Mtok would otherwise flatten every
    // realistic row into a hairline. The axis note says so, on the page.
    const width = (x) =>
      maxPoint <= 0 ? 0
        : minPoint <= 0 ? 50
        : 4 + 92 * (Math.log(x / minPoint) / Math.log(maxPoint / minPoint));

    $("bar-note").textContent = points.length > 1 && maxPoint / minPoint > 20
      ? "· bar on a log scale" : "";

    body.replaceChildren(
      ...rows.map((m) => {
        const bandCost = Calc.costBandCached(
          m, v.tokensInMonth, v.tokensOutMonth,
          v.providerCachePct, C.constants.PROVIDER_CACHE_DISCOUNT, C.constants.BAND_RATIO
        );
        const tr = document.createElement("tr");
        tr.dataset.id = m.id;
        if (m.priceScope == null) tr.dataset.unpriced = "1";
        if (m.id === state.selectedModel) tr.classList.add("selected");
        tr.title = m.source;

        const name = document.createElement("td");
        const nameWrap = document.createElement("span");
        nameWrap.className = "model-name";
        const dot = document.createElement("span");
        dot.className = "model-dot";
        dot.style.background = providerColor(m.provider);
        const nameText = document.createElement("span");
        nameText.textContent = m.label;
        nameWrap.append(dot, nameText);
        for (const tag of modelTags(m)) nameWrap.append(tag);
        name.append(nameWrap);

        const inCell = td("num", m.inPerMTok == null ? "—" : `$${m.inPerMTok}`);
        const outCell = td("num", m.outPerMTok == null ? "—" : `$${m.outPerMTok}`);
        const ctxCell = td("num", m.contextWindow ? Calc.shortTokens(m.contextWindow) : "—");
        if (m.quality) {
          // One scored model today — the score travels on the row's tooltip
          // rather than in a column that would be 32 dashes wide.
          tr.title += ` Quality (internal slice): ${m.quality.score.toFixed(3)} over ${m.quality.n} cases — ${m.quality.source}`;
        }

        const costCell = document.createElement("td");
        costCell.className = "num grow";
        const barWrap = document.createElement("div");
        barWrap.className = "cost-bar";
        if (bandCost) {
          const bandEl = document.createElement("span");
          bandEl.className = "band";
          bandEl.style.left = `${width(bandCost.low)}%`;
          bandEl.style.right = `${100 - width(bandCost.high)}%`;
          const pointEl = document.createElement("span");
          pointEl.className = "point";
          pointEl.style.left = `${width(bandCost.point)}%`;
          barWrap.append(bandEl, pointEl);
        }
        const figure = document.createElement("span");
        figure.className = "cost-figure";
        figure.textContent = bandCost
          ? Calc.usdRange(bandCost)
          : m.inPerMTok != null || m.outPerMTok != null ? "" : "no curated price";
        costCell.append(barWrap, figure);

        tr.append(name, inCell, outCell, ctxCell, costCell);
        tr.addEventListener("click", () => {
          state.selectedModel = m.id;
          renderAll();
        });
        return tr;
      })
    );

    $("table-price-note").textContent =
      "Bars show the ±50% band after your caching settings; the tick is its midpoint. Hover a row " +
      "for the price's source. “Platform” prices come from Agent Studio's billing table; “list” " +
      "from the provider's published prices; “auto-synced” from public registries (LiteLLM, then " +
      "OpenRouter), refreshed weekly; “illustrative” is a placeholder — read the ratio, not the figure.";
  }

  function td(className, text) {
    const cell = document.createElement("td");
    cell.className = className;
    cell.textContent = text;
    return cell;
  }

  const PROVIDER_COLORS = {
    openai: "#10a37f", anthropic: "#d97757", xai: "#8b8b8b",
    google: "#4285f4", deepseek: "#4d6bfe", mistral: "#fa520f",
    algolia: "var(--accent)",
  };
  function providerColor(p) {
    return PROVIDER_COLORS[p] || "var(--line-strong)";
  }

  function modelTags(m) {
    const tags = [];
    if (m.priceScope) {
      const tag = document.createElement("span");
      tag.className = `tag scope-${m.priceScope}`;
      tag.textContent = m.priceScope === "platform" ? "platform table"
        : m.priceScope === "list" ? "list price"
        : m.priceScope === "auto" ? "auto-synced"
        : m.priceScope === "beta" ? "private beta" : "illustrative";
      tags.push(tag);
    }
    if (m.state !== "available") {
      const tag = document.createElement("span");
      tag.className = `tag state-${m.state}`;
      tag.textContent = m.state;
      tags.push(tag);
    }
    return tags;
  }

  /* ── Rendering: eval tab ──────────────────────────────────────────── */

  function tile(label, value, range) {
    const wrap = document.createElement("div");
    wrap.className = "tile";
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.className = "mono";
    dd.textContent = value;
    if (range) {
      const sub = document.createElement("span");
      sub.className = "tile-range";
      sub.textContent = range;
      dd.append(sub);
    }
    wrap.append(dt, dd);
    return wrap;
  }

  function renderEval() {
    const p = evalParams();
    const v = Calc.evalView(p, C);
    const tiles = $("eval-tiles");
    tiles.replaceChildren(
      tile("Agent cost / run",
        v.agentCost ? Calc.usd(v.agentCost.point) : "unpriced",
        v.agentCost ? Calc.usdRange(v.agentCost) : "no curated price for this model"),
      tile("Judge cost / run",
        v.judgeCost ? Calc.usd(v.judgeCost.point) : "unpriced",
        v.judgeCost ? Calc.usdRange(v.judgeCost) : `the "${p.judgeModelId}" alias is unpriced by design`),
      tile("Wall time",
        `${Calc.shortTokens(v.wallSeconds.point / 60)} min`,
        `${Calc.fmtInt(v.wallSeconds.low / 60)}–${Calc.fmtInt(v.wallSeconds.high / 60)} min`),
      tile("Agent tokens", Calc.shortTokens(v.agentTokens.point), Calc.shortTokens(v.agentTokens.low) + "–" + Calc.shortTokens(v.agentTokens.high)),
      tile("Judge tokens", Calc.shortTokens(v.judgeTokens.point), Calc.shortTokens(v.judgeTokens.low) + "–" + Calc.shortTokens(v.judgeTokens.high)),
      tile("Calls", `${Calc.fmtInt(v.agentCalls)} + ${Calc.fmtInt(v.judgeCalls)}`, "agent + judge")
    );
    const list = $("eval-assumptions");
    list.replaceChildren(
      ...v.assumptions.map((line) => {
        const li = document.createElement("li");
        li.textContent = line;
        return li;
      })
    );
  }

  /* ── The one render pass ──────────────────────────────────────────── */

  function renderAll() {
    const p = trafficParams();
    const v = Calc.productionView(p, C);
    renderFunnel(v, p);
    renderConversation(p);
    renderAnatomy(p);
    renderSummary(v, p);
    renderManaged(v);
    renderTable(v);
    renderEval();
  }

  for (const id of ["in-sessions", "in-adoption", "in-turns", "in-rounds", "in-tokin", "in-tokout",
    "in-guardrails", "in-days", "in-respcache", "in-provcache", "in-pdp", "in-pdpcalls", "in-followups"]) {
    $(id).addEventListener("input", renderAll);
  }
  $("in-adoption").addEventListener("input", () => { $("out-adoption").value = $("in-adoption").value; });
  $("in-respcache").addEventListener("input", () => { $("out-respcache").value = $("in-respcache").value; });
  $("in-provcache").addEventListener("input", () => { $("out-provcache").value = $("in-provcache").value; });
  for (const id of ["e-cases", "e-iterations", "e-metrics", "e-rounds", "e-concurrency", "e-guardrails"]) {
    $(id).addEventListener("input", renderEval);
  }
  $("e-model").addEventListener("change", renderEval);
  $("e-judge").addEventListener("change", renderEval);
  for (const id of ["f-provider", "f-sort", "f-maxin", "f-priced", "f-hidelegacy"]) {
    $(id).addEventListener("change", renderAll);
  }

  /* ── Selects ──────────────────────────────────────────────────────── */

  for (const p of C.providers) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.label;
    $("f-provider").append(opt);
  }
  for (const m of C.models.filter((m) => m.priceScope === "platform")) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.label;
    $("e-model").append(opt);
  }
  $("e-model").value = "gpt-5.6-luna";

  /* ── Methodology constants ────────────────────────────────────────── */

  (function renderConstants() {
    const wrap = $("constants-list");
    const labels = {
      AGENT_INPUT_TOKENS_PER_CALL: "agent call, input tokens (prompt frame + records + history)",
      AGENT_OUTPUT_TOKENS_PER_CALL: "agent call, output tokens",
      JUDGE_INPUT_TOKENS_PER_CALL: "judge call, input tokens (rubric + answer key + completion)",
      JUDGE_OUTPUT_TOKENS_PER_CALL: "judge call, output tokens",
      GUARDRAIL_INPUT_TOKENS_PER_CALL: "guardrail classification, input tokens",
      GUARDRAIL_OUTPUT_TOKENS_PER_CALL: "guardrail classification, output tokens",
      SECONDS_PER_CASE: "wall seconds per eval case",
      GUARDRAIL_SECONDS_PER_CASE: "extra wall seconds per guarded case",
      BAND_RATIO: "half-width of every band, as a fraction",
      EVAL_RUN_CONCURRENCY: "concurrent completions per eval run (platform default)",
      EVAL_JUDGE_MODEL: "default judge alias (unpriced by design)",
    };
    wrap.replaceChildren(
      ...Object.entries(C.constants).map(([key, value]) => {
        const row = document.createElement("div");
        const name = document.createElement("code");
        name.textContent = key;
        const val = document.createElement("span");
        val.className = "mono";
        val.textContent = String(value);
        const label = document.createElement("span");
        label.className = "small muted";
        label.textContent = labels[key] || "";
        row.append(name, label, val);
        return row;
      })
    );
  })();

  /* ── Tab 2 · real traffic ─────────────────────────────────────────── */

  const SESSION_KEY = "calc-measure-credentials";

  function saveCredentials() {
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({
        host: $("m-host").value, appId: $("m-appid").value, key: $("m-key").value,
      }));
    } catch (e) { /* private mode: fields still hold them for this page life */ }
  }

  function loadCredentials() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
      if (saved) {
        $("m-host").value = saved.host || $("m-host").value;
        $("m-appid").value = saved.appId || "";
        $("m-key").value = saved.key || "";
        return;
      }
    } catch (e) { /* no stored credentials */ }
    // shared/config.js (gitignored, like every demo) prefills the form so a
    // configured machine goes zero-click; the fields stay editable and any
    // edit takes over via saveCredentials.
    const cfg = window.DEMO_CONFIG;
    if (cfg && cfg.appId && cfg.apiKey) {
      if (cfg.host) $("m-host").value = cfg.host;
      $("m-appid").value = cfg.appId;
      $("m-key").value = cfg.apiKey;
    }
  }

  function setStatus(text, cls) {
    const el = $("m-status");
    el.textContent = text;
    el.className = `notice${cls ? ` ${cls}` : ""}`;
  }

  async function countTokens(payload, creds, signal) {
    const res = await fetch(`${creds.host.replace(/\/+$/, "")}/1/estimate/tokens`, {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        "X-Algolia-Application-Id": creds.appId,
        "X-Algolia-API-Key": creds.key,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}${detail ? ` — ${detail.slice(0, 200)}` : ""}`);
    }
    return res.json();
  }

  async function measure(event) {
    event.preventDefault();
    saveCredentials();
    const creds = {
      host: $("m-host").value.trim(),
      appId: $("m-appid").value.trim(),
      key: $("m-key").value,
    };
    const system = $("m-system").value;
    const user = $("m-user").value;
    const answer = $("m-answer").value;
    if (!system && !user && !answer) {
      setStatus("Paste at least one of the three fields first.", "err");
      return;
    }
    if (!creds.host || !creds.appId || !creds.key) {
      setStatus("Host, application ID and API key are all needed for the platform count.", "err");
      return;
    }

    setStatus("Counting…");
    try {
      const inputCall = countTokens(
        { messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ].filter((m) => m.content) },
        creds
      );
      const outputCall = answer
        ? countTokens({ text: answer }, creds)
        : Promise.resolve(null);
      const [inRes, outRes] = await Promise.all([inputCall, outputCall]);
      applyMeasured(inRes.tokens, outRes ? outRes.tokens : null, `${inRes.method} via the platform`);
      setStatus("Measured. The envelope tab now uses these numbers.", "ok");
    } catch (err) {
      // Usually CORS: the demo ships no backend to relay through, and the
      // API decides which origins it answers. The approximation stays.
      setStatus(
        `Platform count failed (${err.message}). The API may not answer this origin from a ` +
          `browser, or the credentials are off — the ≈4 chars/token approximation below still works.`,
        "err"
      );
    }
  }

  function applyMeasured(inputTokens, outputTokens, method) {
    state.measured = {
      inputTokens, outputTokens, method,
      approximate: method.includes("approximation"),
    };
    $("in-tokin").value = Math.max(100, inputTokens);
    if (outputTokens != null) $("in-tokout").value = Math.max(20, outputTokens);

    $("measure-empty").hidden = true;
    $("measure-tiles").hidden = false;
    $("mr-in").textContent = Calc.fmtInt(inputTokens);
    $("mr-out").textContent = outputTokens == null ? "—" : Calc.fmtInt(outputTokens);
    $("mr-method").textContent = method;
    const caveat = $("measure-caveat");
    caveat.hidden = false;
    caveat.textContent = state.measured.approximate
      ? "Counts are a ≈4 characters/token approximation — honest to ±30% at best, and it knows " +
        "nothing about chat envelopes. Treat every downstream figure as directional."
      : "Counts are per turn: input = system + user turn, output = the answer. We charge the " +
        "full input on every LLM round, so totals run slightly high — the safe side, and the band covers it.";
    renderAll();
  }

  $("measure-form").addEventListener("submit", measure);

  $("m-approx").addEventListener("click", () => {    const system = $("m-system").value;
    const user = $("m-user").value;
    const answer = $("m-answer").value;
    if (!system && !user && !answer) {
      setStatus("Paste at least one of the three fields first.", "err");
      return;
    }
    applyMeasured(
      Calc.approximateTokens(system) + Calc.approximateTokens(user),
      Calc.approximateTokens(answer),
      "≈4 chars/token approximation (local)"
    );
    setStatus("Approximated locally — nothing left this page.", "ok");
  });

  /* Real traffic means real prompts: the app's own agents, listed and
     pulled with the credentials above, supply their actual system prompt.
     That is a template nobody had to invent. */
  async function fetchJson(path, creds) {
    const res = await fetch(`${creds.host.replace(/\/+$/, "")}${path}`, {
      headers: {
        "X-Algolia-Application-Id": creds.appId,
        "X-Algolia-API-Key": creds.key,
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  $("m-agents-btn").addEventListener("click", async () => {
    saveCredentials();
    const creds = {
      host: $("m-host").value.trim(),
      appId: $("m-appid").value.trim(),
      key: $("m-key").value,
    };
    if (!creds.host || !creds.appId || !creds.key) {
      setStatus("Fill in host, application ID and API key first — real agents need real credentials.", "err");
      return;
    }
    setStatus("Listing agents…");
    try {
      const data = await fetchJson("/1/agents?page=1&limit=50", creds);
      const items = data.items || data.agents || data.data || [];
      if (!items.length) {
        setStatus("This app has no agents yet — create one, or paste prompts by hand.", "err");
        return;
      }
      const select = $("m-agents");
      select.replaceChildren(
        ...items.map((a) => {
          const opt = document.createElement("option");
          opt.value = a.agentId || a.id;
          opt.textContent = a.name || a.agentId || a.id;
          return opt;
        })
      );
      $("m-agents-field").hidden = false;
      setStatus(`${items.length} agent(s) found. Pick one to pull its real system prompt.`, "ok");
    } catch (err) {
      setStatus(`Listing failed (${err.message}) — CORS or credentials; the approximation below still works.`, "err");
    }
  });

  $("m-agents").addEventListener("change", async () => {
    saveCredentials();
    const creds = {
      host: $("m-host").value.trim(),
      appId: $("m-appid").value.trim(),
      key: $("m-key").value,
    };
    const id = $("m-agents").value;
    if (!id) return;
    setStatus("Pulling the agent's system prompt…");
    try {
      const agent = await fetchJson(`/1/agents/${id}`, creds);
      const prompt = agent?.config?.systemPrompt ?? agent?.config?.system_prompt ?? agent?.systemPrompt;
      if (!prompt) {
        setStatus("That agent has no system prompt to pull.", "err");
        return;
      }
      $("m-system").value = prompt;
      if (!$("m-user").value) $("m-user").value = "I need a gift for a 10-year-old who loves science";
      if (!$("m-answer").value) $("m-answer").value = "Here are three picks under $50 — each one rated 4.5+ by buyers: …";
      $("measure-form").requestSubmit();
    } catch (err) {
      setStatus(`Pull failed (${err.message}).`, "err");
    }
  });

  /* ── Boot ─────────────────────────────────────────────────────────── */

  (function renderTemplates() {
    const wrap = $("templates");
    for (const t of C.templates) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chip";
      btn.textContent = t.label;
      btn.addEventListener("click", () => {
        const v = t.values;
        $("in-sessions").value = v.sessionsPerDay;
        $("in-adoption").value = v.adoptionPct;
        $("out-adoption").value = v.adoptionPct;
        $("in-turns").value = v.turnsPerConversation;
        $("in-rounds").value = v.roundsPerTurn;
        $("in-tokin").value = v.inputTokensPerRound;
        $("in-tokout").value = v.outputTokensPerTurnCall;
        $("in-pdp").checked = v.pdpCallsPerDay > 0;
        $("in-pdpcalls").value = v.pdpCallsPerDay;
        for (const b of wrap.querySelectorAll(".chip")) b.classList.toggle("active", b === btn);
        renderAll();
      });
      wrap.append(btn);
    }
  })();

  loadCredentials();
  const hash = (location.hash || "").replace("#", "");
  if (TABS.includes(hash)) selectTab(hash);
  renderAll();
})();

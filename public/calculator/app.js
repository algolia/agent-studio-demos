/* ───────────────────────────────────────────────────────────────
   app.js — DOM wiring for the cost calculator.

   The arithmetic lives in calc.js; this file only reads inputs, calls the
   view model, and renders. Visitors change three things — site sessions,
   adoption, and the model — and the summary and every row of the model
   table re-derive together. Everything else (turns, rounds, token sizes,
   caching) is the locked typical-deployment baseline from data.js.

   The model table is the piece everything points at: clicking a row selects
   the model the summary prices.
   ─────────────────────────────────────────────────────────────── */

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const C = window.CALC_DATA;
  const Calc = window.Calc;

  const state = {
    selectedModel: "gemma-4-31b-it",
  };

  /* ── Inputs ───────────────────────────────────────────────────────── */

  function num(id, fallback) {
    const v = parseFloat($(id).value);
    return Number.isFinite(v) ? v : fallback;
  }

  /* The visitor's two levers plus the locked baseline. The locked values
     are constants, not inputs: the assumptions panel shows them so the
     estimate stays auditable without inviting tuning. */
  function trafficParams() {
    const c = C.constants;
    return {
      sessionsPerDay: num("in-sessions", 10000),
      adoptionPct: num("in-adoption", 12),
      turnsPerConversation: c.TURNS_PER_CONVERSATION,
      roundsPerTurn: c.ROUNDS_PER_TURN,
      inputTokensPerRound: c.AGENT_INPUT_TOKENS_PER_CALL,
      outputTokensPerTurnCall: c.AGENT_OUTPUT_TOKENS_PER_CALL,
      guardrails: true,
      followups: true,
      responseCachePct: c.RESPONSE_CACHE_PCT,
      providerCachePct: c.PROVIDER_CACHE_PCT,
      daysPerMonth: 365 / 12,
    };
  }

  /* ── Rendering ────────────────────────────────────────────────────── */

  function cachedCost(v) {
    const model = C.models.find((m) => m.id === state.selectedModel);
    return Calc.costBandCached(
      model, v.tokensInMonth, v.tokensOutMonth,
      v.providerCachePct, C.constants.PROVIDER_CACHE_DISCOUNT, C.constants.BAND_RATIO
    );
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
  }

  /* ── The model table ──────────────────────────────────────────────── */

  function visibleModels(v) {
    const provider = $("f-provider").value;
    const sort = $("f-sort").value;

    let rows = C.models.filter((m) => {
      if (provider && m.provider !== provider) return false;
      // showcase view: the curated families a customer would name. The
      // managed rows stay in data.js ("included") until approved pricing
      // says what to promote — for now they are off the page.
      if (!m.showcase) return false;
      if (m.state !== "available") return false;
      return true;
    });

    const cost = (m) => {
      const b = Calc.costBandCached(
        m, v.tokensInMonth, v.tokensOutMonth,
        v.providerCachePct, C.constants.PROVIDER_CACHE_DISCOUNT, C.constants.BAND_RATIO
      );
      return b ? b.point : Infinity;
    };
    rows = rows.slice().sort((a, b) => {
      if (sort === "cost") return cost(a) - cost(b) || a.label.localeCompare(b.label);
      if (sort === "in") return (a.inPerMTok ?? Infinity) - (b.inPerMTok ?? Infinity);
      return a.label.localeCompare(b.label);
    });
    return rows;
  }

  function renderTable(v) {
    const rows = visibleModels(v);
    const body = $("cost-body");

    // The scale is fixed over EVERY priced model at the current traffic, so
    // filtering changes which rows show — never where the bars sit. (Bars
    // that reshuffle on every filter click read as random.)
    const priced = C.models
      .map((m) => ({ m, b: Calc.costBandCached(
        m, v.tokensInMonth, v.tokensOutMonth,
        v.providerCachePct, C.constants.PROVIDER_CACHE_DISCOUNT, C.constants.BAND_RATIO) }))
      .filter((x) => x.b && x.b.point > 0);
    const maxPoint = priced.length ? Math.max(...priced.map((x) => x.b.point)) : 0;
    const minPoint = priced.length ? Math.min(...priced.map((x) => x.b.point)) : 0;
    // Log scale: the spread across the board spans well over one order of
    // magnitude, which would otherwise flatten every cheap row into a
    // hairline. The header tooltip says so, on the page.
    const width = (x) =>
      maxPoint <= 0 ? 50
        : x <= 0 ? 2
        : 4 + 92 * (Math.log(x / minPoint) / Math.log(maxPoint / minPoint));

    $("bar-note").textContent = priced.length > 1 && maxPoint / minPoint > 20
      ? "· log scale, fixed across all priced models" : "";

    body.replaceChildren(
      ...rows.map((m) => {
        const bandCost = Calc.costBandCached(
          m, v.tokensInMonth, v.tokensOutMonth,
          v.providerCachePct, C.constants.PROVIDER_CACHE_DISCOUNT, C.constants.BAND_RATIO
        );
        const tr = document.createElement("tr");
        tr.dataset.id = m.id;
        if (m.id === state.selectedModel) tr.classList.add("selected");
        tr.title = m.priceScope === "platform" ? "Priced from Agent Studio's billing table."
          : m.priceScope === "list" ? "The provider's published list price."
          : "Estimated from public model registries.";

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

        const costCell = document.createElement("td");
        costCell.className = "num grow cost-cell";
        const barWrap = document.createElement("div");
        barWrap.className = "cost-bar";
        if (bandCost && bandCost.point > 0) {
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
        figure.textContent = bandCost ? Calc.usdRange(bandCost) : "no curated price";
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
      "Bars show the ±50% band at your traffic; the tick is its midpoint. Every price " +
      "is an estimate; hover a row for its exact source and date.";
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
    if (m.priceScope && m.priceScope !== "auto") {
      // auto-synced rows carry no badge: the price is the estimate, the
      // exact registry source stays on the row's hover tooltip
      const tag = document.createElement("span");
      tag.className = `tag scope-${m.priceScope}`;
      tag.textContent = m.priceScope === "platform" ? "platform table" : "list price";
      tags.push(tag);
    }
    return tags;
  }

  /* ── The one render pass ──────────────────────────────────────────── */

  function renderAll() {
    const p = trafficParams();
    const v = Calc.productionView(p, C);
    renderSummary(v, p);
    renderTable(v);
    syncUrl();
  }

  for (const id of ["in-sessions", "in-adoption"]) $(id).addEventListener("input", renderAll);
  $("in-adoption").addEventListener("input", () => { $("out-adoption").value = $("in-adoption").value; });
  for (const id of ["f-provider", "f-sort"]) $(id).addEventListener("change", renderAll);

  /* ── Selects ──────────────────────────────────────────────────────── */

  for (const p of C.providers) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.label;
    $("f-provider").append(opt);
  }

  /* ── Locked baseline, shown read-only ─────────────────────────────── */

  (function renderBaseline() {
    const c = C.constants;
    const wrap = $("baseline");
    const entries = [
      ["Turns per conversation", `${c.TURNS_PER_CONVERSATION} · typical`],
      ["LLM rounds per turn", `${c.ROUNDS_PER_TURN} · the tool-call loop`],
      ["Input tokens per round", `${Calc.fmtInt(c.AGENT_INPUT_TOKENS_PER_CALL)} · live accounts average ≈3k`],
      ["Output tokens per round", `${Calc.fmtInt(c.AGENT_OUTPUT_TOKENS_PER_CALL)} · a solid answer with three picks`],
      ["Response cache", `${c.RESPONSE_CACHE_PCT}% of turns · low end of the live 70–85% band`],
      ["Provider prompt cache", `${c.PROVIDER_CACHE_PCT}% of input at ≈10% of the input price`],
      ["Guardrails", "on · one classification per turn"],
      ["Follow-up suggestion chips", "on · one short call per billed turn"],
    ];
    wrap.replaceChildren(
      ...entries.map(([name, value]) => {
        const row = document.createElement("div");
        const dt = document.createElement("span");
        dt.textContent = name;
        const dd = document.createElement("span");
        dd.className = "mono";
        dd.textContent = value;
        row.append(dt, dd);
        return row;
      })
    );
  })();

  /* ── Methodology constants ────────────────────────────────────────── */

  (function renderConstants() {
    const wrap = $("constants-list");
    const labels = {
      AGENT_INPUT_TOKENS_PER_CALL: "agent call, input tokens (frame + records + history + user turn)",
      AGENT_OUTPUT_TOKENS_PER_CALL: "agent call, output tokens",
      GUARDRAIL_INPUT_TOKENS_PER_CALL: "guardrail classification, input tokens",
      GUARDRAIL_OUTPUT_TOKENS_PER_CALL: "guardrail classification, output tokens",
      TURNS_PER_CONVERSATION: "turns per conversation (locked typical average)",
      ROUNDS_PER_TURN: "LLM rounds per turn (locked typical average)",
      RESPONSE_CACHE_PCT: "response cache hit share (locked)",
      PROVIDER_CACHE_PCT: "provider prompt cache share of input (locked)",
      PROVIDER_CACHE_DISCOUNT: "cached input price, as a fraction of input price",
      EXTRA_FOLLOWUP_INPUT_TOKENS: "follow-up chip call, input tokens",
      EXTRA_FOLLOWUP_OUTPUT_TOKENS: "follow-up chip call, output tokens",
      BAND_RATIO: "half-width of every band, as a fraction",
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

  /* ── Shareable state ────────────────────────────────────────────────
     The inputs travel in the URL (?s=…), so a copied link carries the
     values, and the copy-summary text carries them in plain words too. */

  const STATE_FIELDS = [
    ["sessions", "in-sessions"], ["adoption", "in-adoption"],
  ];

  function currentState() {
    const s = { model: state.selectedModel };
    for (const [key, id] of STATE_FIELDS) {
      s[key] = $(id).value;
    }
    return s;
  }

  function applyState(s) {
    if (!s) return;
    if (s.model && C.models.some((m) => m.id === s.model)) state.selectedModel = s.model;
    for (const [key, id] of STATE_FIELDS) {
      if (s[key] === undefined) continue;
      $(id).value = s[key];
    }
    $("out-adoption").value = $("in-adoption").value;
  }

  function shareUrl() {
    return `${location.origin}${location.pathname}?s=${Calc.encodeState(currentState())}${location.hash}`;
  }

  function syncUrl() {
    try { history.replaceState(null, "", `?s=${Calc.encodeState(currentState())}${location.hash}`); }
    catch (e) { /* replaceState can throw on exotic origins; the page keeps working */ }
  }

  $("copy-summary").addEventListener("click", async () => {
    const p = trafficParams();
    const v = Calc.productionView(p, C);
    const cost = cachedCost(v);
    const model = C.models.find((m) => m.id === state.selectedModel);
    const costLine = cost
      ? `${Calc.usdRange(cost)} / month (±50%, midpoint ${Calc.usd(cost.point)})`
      : "no curated price for this model";
    const lines = [
      `Shopping Assistant cost estimate — ${model ? model.label : "?"}`,
      `Traffic: ${Calc.fmtInt(p.sessionsPerDay)} sessions/day · ${p.adoptionPct}% adoption · ${p.turnsPerConversation} turns · ${p.roundsPerTurn} rounds`,
      `Tokens: ${Calc.fmtInt(p.inputTokensPerRound)} in / ${Calc.fmtInt(p.outputTokensPerTurnCall)} out per round · guardrails on`,
      `Caching: ${p.responseCachePct}% response cache · ${p.providerCachePct}% provider prefix`,
      `→ ${costLine} · ≈ ${Calc.usd(cost.point / (v.conversationsPerDay * p.daysPerMonth))} per assisted conversation`,
      `Share (values included): ${shareUrl()}`,
      "Every figure is a ±50% band, not a quote. Constants and price sources are on the page.",
    ];
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      const btn = $("copy-summary");
      const prev = btn.textContent;
      btn.textContent = "Copied ✓ — values and link included";
      setTimeout(() => { btn.textContent = prev; }, 2500);
    } catch (e) {
      // clipboard can refuse without user permission; fall back to the URL itself
      prompt("Copy this share link:", shareUrl());
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
        $("in-sessions").value = t.values.sessionsPerDay;
        $("in-adoption").value = t.values.adoptionPct;
        $("out-adoption").value = t.values.adoptionPct;
        for (const b of wrap.querySelectorAll(".chip")) b.classList.toggle("active", b === btn);
        renderAll();
      });
      wrap.append(btn);
    }
  })();

  applyState(Calc.decodeState(new URLSearchParams(location.search).get("s")));
  renderAll();
  syncUrl();
})();

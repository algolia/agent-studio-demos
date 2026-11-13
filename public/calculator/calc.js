/* ───────────────────────────────────────────────────────────────
   calc.js — the arithmetic, as a pure module.

   Nothing here touches the DOM or the clock: functions in, view models out.
   That is what lets node:test exercise the same bytes the browser loads
   (tests/load.js), and what keeps the three tabs honest against each other —
   the envelope tab, the eval-run tab and the copyable summary all read the
   same view models, so they cannot disagree.

   The arithmetic mirrors the platform's estimation service
   (conversational-ai, common/services/estimation.py) figure for figure:

     * every figure is a ±BAND_RATIO band around a point estimate, never a
       point value — the band is the product, the point is just its middle;
     * the token constants and the eval-run shape are the service's own;
     * an unpriced model yields no cost at all rather than a fabricated one.
   ─────────────────────────────────────────────────────────────── */

(function (global) {
  "use strict";

  const nf = new Intl.NumberFormat("en-US");

  const fmtInt = (n) => nf.format(Math.round(Number.isFinite(n) ? n : 0));

  /* 363k, 5.4M — for copy where the order of magnitude is the point */
  function shortTokens(n) {
    const a = Math.round(Math.abs(Number.isFinite(n) ? n : 0));
    if (a < 1000) return fmtInt(a);
    if (a < 1000000) return `${(a / 1000).toFixed(a < 10000 ? 1 : 0)}k`;
    return `${(a / 1000000).toFixed(1)}M`;
  }

  /* 4 decimals under a dollar, 2 above — a turn costs fractions of a cent */
  function usd(v) {
    const n = Number.isFinite(v) ? v : 0;
    const a = Math.abs(n);
    return `${n < -1e-12 ? "−" : ""}$${a < 1 ? a.toFixed(4) : a.toFixed(2)}`;
  }

  /* A zero band is a fact (the managed beta's free tier), not a number to
     display: "$0.0000" reads as a bug, "free" reads as the good news it is. */
  function usdOrFree(cost) {
    return !cost ? "unpriced" : cost.point === 0 ? "free" : usd(cost.point);
  }

  function band(point, ratio) {
    const p = Math.max(0, Number(point) || 0);
    const r = Number.isFinite(ratio) ? ratio : 0.5;
    return { low: p * (1 - r), point: p, high: p * (1 + r) };
  }

  function usdRange(b) {
    if (!b) return "unpriced";
    return `${usd(b.low)} – ${usd(b.high)}`;
  }

  /* A model's blended monthly cost from billed tokens. Null when the model
     carries no price — mirroring find_pricing's "unpriced, not zero". The
     managed model is deliberately unpriced here: it is included in plans
     and this page estimates BYOK costs only. */
  function costBand(model, inputTokens, outputTokens, ratio) {
    if (!model) return null;
    if (model.inPerMTok == null || model.outPerMTok == null) return null;
    const point =
      (inputTokens / 1000000) * model.inPerMTok + (outputTokens / 1000000) * model.outPerMTok;
    return band(point, ratio);
  }

  /* Same, after provider prompt caching: the cached share of input tokens
     bills at the provider's cache-read rate (≈10% of input price on OpenAI
     and Anthropic). Output never caches. Managed-beta models bill by total
     tokens against their free allowance, so a provider-cache discount does
     not apply to them — the response cache still helps, because it removes
     tokens outright. */
  function costBandCached(model, inputTokens, outputTokens, providerCachePct, discount, ratio) {
    if (!model) return null;
    if (model.inPerMTok == null || model.outPerMTok == null) return null;
    const share = Math.min(Math.max(providerCachePct || 0, 0), 95) / 100;
    const inMultiplier = 1 - share + share * discount;
    const point =
      (inputTokens / 1000000) * model.inPerMTok * inMultiplier +
      (outputTokens / 1000000) * model.outPerMTok;
    return band(point, ratio);
  }

  /* ── Production traffic ────────────────────────────────────────────
     sessions/day → conversations (adoption) → turns → LLM rounds.
     Guardrails are one classification per turn (the completion unit), not
     per round — rounds are the tool-call loop inside one completion.

     Two caching layers sit between turns and dollars:
       * Agent Studio's response cache: a cached turn makes no LLM call at
         all, so it bills zero — it only skips the conversation's own calls;
       * the provider's prompt cache: the prefix share of the remaining
         input bills at the cache-read rate.
     Extras (PDP suggestions, follow-up chips) ride the same caching: they
     are one-shot calls whose prefix caches well, so they are counted only
     on turns that missed the response cache. */

  function productionView(p, data) {
    const c = data.constants;
    const days = p.daysPerMonth;
    const measuredPerDay = Number(p.measuredConversationsPerDay) || null;
    const conversationsPerDay = measuredPerDay ?? p.sessionsPerDay * (p.adoptionPct / 100);
    const turnsPerDay = conversationsPerDay * p.turnsPerConversation;
    const agentCallsPerDay = turnsPerDay * p.roundsPerTurn;

    const responseCachePct = Math.min(Math.max(p.responseCachePct || 0, 0), 95);
    const providerCachePct = Math.min(Math.max(p.providerCachePct || 0, 0), 95);
    const pdpCallsPerDay = p.pdp ? p.pdpCallsPerDay || 0 : 0;
    const followupsPerTurn = p.followups ? 1 : 0;

    const turnsBilledPerDay = Math.round(turnsPerDay * (1 - responseCachePct / 100));
    const followupCallsPerDay = Math.round(turnsBilledPerDay * followupsPerTurn);
    const extraCallsPerDay = followupCallsPerDay + pdpCallsPerDay;
    const callsBilledPerDay = turnsBilledPerDay * p.roundsPerTurn + extraCallsPerDay;

    const agentCallsMonth = (agentCallsPerDay + extraCallsPerDay) * days;
    const turnsMonth = turnsPerDay * days;

    const guardrailIn = p.guardrails ? turnsMonth * c.GUARDRAIL_INPUT_TOKENS_PER_CALL : 0;
    const guardrailOut = p.guardrails ? turnsMonth * c.GUARDRAIL_OUTPUT_TOKENS_PER_CALL : 0;

    const pdpMonth = pdpCallsPerDay * days;
    const followupMonth = followupCallsPerDay * days;
    const extraInMonth =
      pdpMonth * c.EXTRA_PDP_INPUT_TOKENS + followupMonth * c.EXTRA_FOLLOWUP_INPUT_TOKENS;
    const extraOutMonth =
      pdpMonth * c.EXTRA_PDP_OUTPUT_TOKENS + followupMonth * c.EXTRA_FOLLOWUP_OUTPUT_TOKENS;

    const tokensInMonth =
      callsBilledPerDay * days * p.inputTokensPerRound + extraInMonth + guardrailIn;
    const tokensOutMonth =
      callsBilledPerDay * days * p.outputTokensPerTurnCall + extraOutMonth + guardrailOut;

    const assumptions = [
      measuredPerDay
        ? `${fmtInt(conversationsPerDay)} conversations/day — measured on real traffic, overriding the sessions × adoption sliders.`
        : `${fmtInt(conversationsPerDay)} conversations/day = ${fmtInt(p.sessionsPerDay)} site sessions × ${p.adoptionPct}% adoption.`,
      `${fmtInt(turnsPerDay)} turns/day = conversations × ${p.turnsPerConversation} turns.`,
      `${fmtInt(agentCallsPerDay)} agent LLM calls/day before caching = turns × ${p.roundsPerTurn} rounds (the tool-call loop).`,
      `One round: ${fmtInt(p.inputTokensPerRound)} input + ${fmtInt(p.outputTokensPerTurnCall)} output tokens.`,
    ];
    if (responseCachePct > 0) {
      assumptions.push(
        `Agent Studio's response cache serves ${responseCachePct}% of turns (live hit rates run 70–85% on ` +
          `steady traffic): those turns make no LLM call, so ${fmtInt(turnsBilledPerDay)} turns/day are billed.`
      );
    }
    if (providerCachePct > 0) {
      assumptions.push(
        `The provider's prompt cache serves ${providerCachePct}% of the remaining input at ≈${Math.round((c.PROVIDER_CACHE_DISCOUNT || 0.1) * 100)}% of the input price.`
      );
    }
    if (pdpCallsPerDay > 0) {
      assumptions.push(
        `PDP suggestions add ${fmtInt(pdpCallsPerDay)} one-shot calls/day (${c.EXTRA_PDP_INPUT_TOKENS} in / ` +
          `${c.EXTRA_PDP_OUTPUT_TOKENS} out); they are counted in full — their prefixes cache well, so treat this as the ceiling.`
      );
    }
    if (followupsPerTurn > 0) {
      assumptions.push(
        `Follow-up suggestion chips add one short call per billed turn (${c.EXTRA_FOLLOWUP_INPUT_TOKENS} in / ` +
          `${c.EXTRA_FOLLOWUP_OUTPUT_TOKENS} out).`
      );
    }
    if (p.guardrails) {
      assumptions.push(
        `Guardrails add one classification per turn (${c.GUARDRAIL_INPUT_TOKENS_PER_CALL} in / ` +
          `${c.GUARDRAIL_OUTPUT_TOKENS_PER_CALL} out), charged at the agent's model — every turn, cached or not.`
      );
    }
    assumptions.push(
      `${days} days/month. Every figure is a ±${Math.round(c.BAND_RATIO * 100)}% band around the point estimate.`
    );

    return {
      conversationsPerDay,
      measuredPerDay,
      turnsPerDay,
      agentCallsPerDay,
      callsBilledPerDay,
      agentCallsMonth,
      turnsMonth,
      turnsBilledPerDay,
      responseCachePct,
      providerCachePct,
      tokensInMonth,
      tokensOutMonth,
      tokensMonth: tokensInMonth + tokensOutMonth,
      assumptions,
    };
  }

  /* ── Eval run ──────────────────────────────────────────────────────
     A line-for-line mirror of estimate_eval_run: one case is executed
     `iterations` times and graded once; metrics do not multiply judging. */

  function evalView(p, data) {
    const c = data.constants;
    const executions = p.numCases * p.iterations;
    const agentCalls = executions * p.roundsMultiplier;
    const judgeCalls = executions;

    let agentIn = agentCalls * c.AGENT_INPUT_TOKENS_PER_CALL;
    let agentOut = agentCalls * c.AGENT_OUTPUT_TOKENS_PER_CALL;
    if (p.guardrails) {
      agentIn += executions * c.GUARDRAIL_INPUT_TOKENS_PER_CALL;
      agentOut += executions * c.GUARDRAIL_OUTPUT_TOKENS_PER_CALL;
    }
    const judgeIn = judgeCalls * c.JUDGE_INPUT_TOKENS_PER_CALL;
    const judgeOut = judgeCalls * c.JUDGE_OUTPUT_TOKENS_PER_CALL;

    const secondsPerCase = c.SECONDS_PER_CASE + (p.guardrails ? c.GUARDRAIL_SECONDS_PER_CASE : 0);
    const wallPoint = Math.ceil(executions / p.concurrency) * secondsPerCase;

    const agentModel = data.models.find((m) => m.id === p.modelId) || null;
    const judgeModel = data.models.find((m) => m.id === p.judgeModelId) || null;

    const assumptions = [
      `${fmtInt(agentCalls)} agent LLM calls = ${fmtInt(p.numCases)} cases × ${p.iterations} iterations × ${p.roundsMultiplier} rounds.`,
      `${fmtInt(judgeCalls)} judge calls = cases × iterations; a case carries one of the ${p.metricCount} ` +
        `selected metrics and is graded once, so metrics do not multiply the judging.`,
      `Agent call: ${fmtInt(c.AGENT_INPUT_TOKENS_PER_CALL)} input + ${fmtInt(c.AGENT_OUTPUT_TOKENS_PER_CALL)} output tokens.`,
      `Judge call: ${fmtInt(c.JUDGE_INPUT_TOKENS_PER_CALL)} input + ${fmtInt(c.JUDGE_OUTPUT_TOKENS_PER_CALL)} output tokens.`,
      `Wall time: ${secondsPerCase}s per case at ${p.concurrency} concurrent completions (the platform's ` +
        `EVAL_RUN_CONCURRENCY default is ${c.EVAL_RUN_CONCURRENCY}).`,
      `Every figure is a ±${Math.round(c.BAND_RATIO * 100)}% band around the point estimate.`,
      "Prices are the platform's own per-1M-token table, the one usage cost is billed from.",
    ];
    if (p.guardrails) {
      assumptions.push(
        `Guardrails add one classification per case (${c.GUARDRAIL_INPUT_TOKENS_PER_CALL} in / ` +
          `${c.GUARDRAIL_OUTPUT_TOKENS_PER_CALL} out), charged at the agent's model.`
      );
    }
    if (!agentModel || agentModel.priceScope == null) {
      assumptions.push("No agent cost: no curated price for the selected agent model.");
    }
    if (p.judgeModelId === c.EVAL_JUDGE_MODEL) {
      assumptions.push(
        `The judge alias "${c.EVAL_JUDGE_MODEL}" is the platform default and is unpriced by design, ` +
          `so no judge cost appears.`
      );
    }

    return {
      agentCalls,
      judgeCalls,
      agentTokens: band(agentIn + agentOut, c.BAND_RATIO),
      judgeTokens: band(judgeIn + judgeOut, c.BAND_RATIO),
      wallSeconds: band(wallPoint, c.BAND_RATIO),
      agentCost: costBand(agentModel, agentIn, agentOut, c.BAND_RATIO),
      judgeCost: costBand(judgeModel, judgeIn, judgeOut, c.BAND_RATIO),
      assumptions,
    };
  }

  /* One agent round, cut into labelled slices for the anatomy strip.
     The frame/records/history/user split is the data file's declared
     assumption; the measured mode replaces the totals, not the shares. */
  function anatomy(inputTokens, outputTokens, shares) {
    const total = shares.reduce((s, part) => s + part.tokens, 0);
    return shares.map((part) => ({
      key: part.key,
      label: part.label,
      tokens: Math.round((part.tokens / total) * inputTokens),
      frac: part.tokens / total,
    }));
  }

  /* The honest fallback when the platform tokenizer is unreachable:
     ≈4 characters per token. Labeled as an approximation wherever shown. */
  function approximateTokens(text) {
    return Math.ceil((text || "").length / 4);
  }

  /* ── Measured traffic ───────────────────────────────────────────────
     The conversations API already stores message_count and the token
     totals per conversation, so a page of real conversations measures
     what the envelope tab otherwise guesses: turns per conversation,
     tokens per conversation, and a conversations-per-day rate from the
     sample's date span. Pure and tested; null on an empty sample. */

  function median(arr) {
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function conversationStats(conversations) {
    if (!Array.isArray(conversations) || !conversations.length) return null;
    const pick = (c, camel, snake) => c[camel] ?? c[snake] ?? 0;
    const times = conversations
      .map((c) => Date.parse(c.createdAt || c.created_at))
      .filter(Number.isFinite);
    const turns = conversations.map((c) => Math.max(1, Math.round(pick(c, "messageCount", "message_count") / 2)));
    const spanDays = times.length
      ? Math.max(1, (Math.max(...times) - Math.min(...times)) / 86400000)
      : 1;
    return {
      sample: conversations.length,
      sampleDays: Math.round(spanDays * 10) / 10,
      conversationsPerDay: Math.max(0.1, conversations.length / spanDays),
      medianTurns: median(turns),
      medianTokens: median(conversations.map((c) => pick(c, "totalTokens", "total_tokens"))),
      medianTokensIn: median(conversations.map((c) => pick(c, "totalInputTokens", "total_input_tokens"))),
      medianTokensOut: median(conversations.map((c) => pick(c, "totalOutputTokens", "total_output_tokens"))),
    };
  }

  /* ── Shareable state ───────────────────────────────────────────────
     The calculator's whole input state travels in the URL as one
     base64url-encoded JSON blob (?s=…), so "copy/paste" copies values,
     not just a link someone has to re-derive. Both directions are pure
     and tested; a corrupted blob decodes to null and the page boots on
     its defaults rather than half-state. */

  function encodeState(state) {
    const json = JSON.stringify(state);
    const b64 = btoa(unescape(encodeURIComponent(json)));
    return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function decodeState(str) {
    if (!str) return null;
    try {
      const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
      const json = decodeURIComponent(escape(atob(b64)));
      const state = JSON.parse(json);
      return state && typeof state === "object" ? state : null;
    } catch (e) {
      return null;
    }
  }

  global.Calc = {
    fmtInt,
    shortTokens,
    usd,
    usdOrFree,
    band,
    usdRange,
    costBand,
    costBandCached,
    productionView,
    evalView,
    anatomy,
    approximateTokens,
    encodeState,
    decodeState,
    conversationStats,
  };
})(window);

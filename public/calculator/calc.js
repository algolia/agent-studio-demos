/* ───────────────────────────────────────────────────────────────
   calc.js — the arithmetic, as a pure module.

   Nothing here touches the DOM or the clock: functions in, view models out.
   That is what lets node:test exercise the same bytes the browser loads
   (tests/load.js), and what keeps the summary and the model table honest
   against each other — both read the same view models, so they cannot
   disagree.

   The arithmetic mirrors the platform's estimation service
   (conversational-ai, common/services/estimation.py) figure for figure:

     * every figure is a ±BAND_RATIO band around a point estimate, never a
       point value — the band is the product, the point is just its middle;
     * the token constants are the service's own;
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
     Turns, rounds and token sizes arrive locked (the page's typical-
     deployment baseline); visitors change traffic, adoption and model.
     Guardrails are one classification per turn (the completion unit), not
     per round — rounds are the tool-call loop inside one completion.

     Two caching layers sit between turns and dollars:
       * Agent Studio's response cache: a cached turn makes no LLM call at
         all, so it bills zero — it only skips the conversation's own calls;
       * the provider's prompt cache: the prefix share of the remaining
         input bills at the cache-read rate.
     Follow-up chips ride the same caching: one short call per billed turn. */

  function productionView(p, data) {
    const c = data.constants;
    const days = p.daysPerMonth;
    const conversationsPerDay = p.sessionsPerDay * (p.adoptionPct / 100);
    const turnsPerDay = conversationsPerDay * p.turnsPerConversation;
    const agentCallsPerDay = turnsPerDay * p.roundsPerTurn;

    const responseCachePct = Math.min(Math.max(p.responseCachePct || 0, 0), 95);
    const providerCachePct = Math.min(Math.max(p.providerCachePct || 0, 0), 95);
    const followupsPerTurn = p.followups ? 1 : 0;

    const turnsBilledPerDay = Math.round(turnsPerDay * (1 - responseCachePct / 100));
    const followupCallsPerDay = Math.round(turnsBilledPerDay * followupsPerTurn);
    const callsBilledPerDay = turnsBilledPerDay * p.roundsPerTurn + followupCallsPerDay;

    const agentCallsMonth = agentCallsPerDay * days;
    const turnsMonth = turnsPerDay * days;

    const guardrailIn = p.guardrails ? turnsMonth * c.GUARDRAIL_INPUT_TOKENS_PER_CALL : 0;
    const guardrailOut = p.guardrails ? turnsMonth * c.GUARDRAIL_OUTPUT_TOKENS_PER_CALL : 0;

    const followupMonth = followupCallsPerDay * days;
    const extraInMonth = followupMonth * c.EXTRA_FOLLOWUP_INPUT_TOKENS;
    const extraOutMonth = followupMonth * c.EXTRA_FOLLOWUP_OUTPUT_TOKENS;

    const tokensInMonth =
      callsBilledPerDay * days * p.inputTokensPerRound + extraInMonth + guardrailIn;
    const tokensOutMonth =
      callsBilledPerDay * days * p.outputTokensPerTurnCall + extraOutMonth + guardrailOut;

    const assumptions = [
      `${fmtInt(conversationsPerDay)} conversations/day = ${fmtInt(p.sessionsPerDay)} site sessions × ${p.adoptionPct}% adoption.`,
      `${fmtInt(turnsPerDay)} turns/day = conversations × ${p.turnsPerConversation} turns (typical).`,
      `${fmtInt(agentCallsPerDay)} agent LLM calls/day before caching = turns × ${p.roundsPerTurn} rounds (the tool-call loop).`,
      `One round: ${fmtInt(p.inputTokensPerRound)} input + ${fmtInt(p.outputTokensPerTurnCall)} output tokens (typical).`,
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
    encodeState,
    decodeState,
  };
})(window);

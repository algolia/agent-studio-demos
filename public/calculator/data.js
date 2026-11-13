/* ───────────────────────────────────────────────────────────────
   data.js — the calculator's constants and model table.

   Two rules inherited from the platform's own estimation service
   (conversational-ai, common/services/estimation.py):

   1. Every constant the arithmetic uses lives here, in the open, so the
      page can echo it back in the assumptions panel. An estimate whose
      constants are hidden is a quote pretending to be a calculation.
   2. A model with no defensible price shows no cost at all rather than a
      fabricated one. Three price scopes exist:
        platform  — Agent Studio's own billing table (the one usage cost is
                    computed from), today OpenAI models only.
        list      — the provider's published list price, dated and named.
        placeholder — an illustrative number that keeps arithmetic readable;
                    the entry says "read the ratio, not the absolute figure".
      Everything else ships with `priceScope: null` and renders "no curated
      price": tokens still estimate, cost stays silent.
   ─────────────────────────────────────────────────────────────── */

(function (global) {
  "use strict";

  const PLATFORM_TABLE_SOURCE =
    "Agent Studio's billing table (the same per-1M-token table usage cost is " +
    "computed from), matching OpenAI's published list prices of Jul 2026.";

  global.CALC_DATA = {
    /* Token and timing constants, mirrored from the platform's estimation
       service. Renamed there → here when they differ from the field labels. */
    constants: {
      AGENT_INPUT_TOKENS_PER_CALL: 4000,
      AGENT_OUTPUT_TOKENS_PER_CALL: 400,
      JUDGE_INPUT_TOKENS_PER_CALL: 2500,
      JUDGE_OUTPUT_TOKENS_PER_CALL: 350,
      GUARDRAIL_INPUT_TOKENS_PER_CALL: 700,
      GUARDRAIL_OUTPUT_TOKENS_PER_CALL: 30,
      SECONDS_PER_CASE: 12,
      GUARDRAIL_SECONDS_PER_CASE: 1,
      BAND_RATIO: 0.5,
      EVAL_RUN_CONCURRENCY: 2,
      EVAL_JUDGE_MODEL: "medium",
      PROVIDER_CACHE_DISCOUNT: 0.1,
      EXTRA_PDP_INPUT_TOKENS: 600,
      EXTRA_PDP_OUTPUT_TOKENS: 150,
      EXTRA_FOLLOWUP_INPUT_TOKENS: 250,
      EXTRA_FOLLOWUP_OUTPUT_TOKENS: 80,
    },

    /* Traffic templates: starting points for someone who cannot answer
       "how many sessions a day?" off the top of their head. Values are
       realistic mid-2026 deployments, deliberately round — sweep from here. */
    templates: [
      {
        id: "boutique", label: "Boutique shop",
        values: { sessionsPerDay: 1500, adoptionPct: 20, turnsPerConversation: 3,
          roundsPerTurn: 2, inputTokensPerRound: 3000, outputTokensPerTurnCall: 500,
          pdpCallsPerDay: 400 },
      },
      {
        id: "midsize", label: "Mid-size retailer",
        values: { sessionsPerDay: 10000, adoptionPct: 12, turnsPerConversation: 3,
          roundsPerTurn: 2, inputTokensPerRound: 3000, outputTokensPerTurnCall: 500,
          pdpCallsPerDay: 3000 },
      },
      {
        id: "marketplace", label: "Large marketplace",
        values: { sessionsPerDay: 60000, adoptionPct: 8, turnsPerConversation: 4,
          roundsPerTurn: 2, inputTokensPerRound: 3500, outputTokensPerTurnCall: 500,
          pdpCallsPerDay: 20000 },
      },
    ],

    /* How one agent round's 4000 input tokens split. Shares are assumptions,
       not measurements — the assumptions panel says so. Must sum to
       AGENT_INPUT_TOKENS_PER_CALL. */
    anatomyShares: [
      { key: "frame", label: "System frame + tool schemas", tokens: 700 },
      { key: "records", label: "Retrieved records", tokens: 1900 },
      { key: "history", label: "Conversation history", tokens: 1100 },
      { key: "user", label: "User turn", tokens: 300 },
    ],

    models: [
      /* ── OpenAI — priced from the platform's billing table ─────────── */
      {
        id: "gpt-5.6-sol", label: "gpt-5.6 Sol", provider: "openai", state: "available",
        contextWindow: 1000000, inPerMTok: 5, outPerMTok: 30, priceScope: "platform",
        source: PLATFORM_TABLE_SOURCE,
      },
      {
        id: "gpt-5.6-terra", label: "gpt-5.6 Terra", provider: "openai", state: "available",
        contextWindow: 1000000, inPerMTok: 2.5, outPerMTok: 15, priceScope: "platform",
        source: PLATFORM_TABLE_SOURCE,
      },
      {
        id: "gpt-5.6-luna", label: "gpt-5.6 Luna", provider: "openai", state: "available",
        contextWindow: 1000000, inPerMTok: 1, outPerMTok: 6, priceScope: "platform",
        source: PLATFORM_TABLE_SOURCE,
      },
      {
        id: "gpt-5.5", label: "gpt-5.5", provider: "openai", state: "available",
        contextWindow: 1000000, inPerMTok: 5, outPerMTok: 30, priceScope: "platform",
        source: PLATFORM_TABLE_SOURCE,
      },
      {
        id: "gpt-5.4", label: "gpt-5.4", provider: "openai", state: "available",
        contextWindow: 1000000, inPerMTok: 2.5, outPerMTok: 15, priceScope: "platform",
        source: PLATFORM_TABLE_SOURCE,
      },
      {
        id: "gpt-5", label: "gpt-5", provider: "openai", state: "deprecated",
        contextWindow: 1000000, inPerMTok: 1.25, outPerMTok: 10, priceScope: "platform",
        source: PLATFORM_TABLE_SOURCE,
      },
      {
        id: "gpt-5-mini", label: "gpt-5 mini", provider: "openai", state: "deprecated",
        contextWindow: 400000, inPerMTok: 0.25, outPerMTok: 2, priceScope: "platform",
        source: PLATFORM_TABLE_SOURCE,
      },
      {
        id: "gpt-5-nano", label: "gpt-5 nano", provider: "openai", state: "deprecated",
        contextWindow: 400000, inPerMTok: 0.05, outPerMTok: 0.05, priceScope: "platform",
        source: PLATFORM_TABLE_SOURCE,
      },
      {
        id: "gpt-4.1", label: "gpt-4.1", provider: "openai", state: "deprecated",
        contextWindow: 1000000, inPerMTok: 10, outPerMTok: 30, priceScope: "platform",
        source: PLATFORM_TABLE_SOURCE,
      },
      {
        id: "gpt-4o", label: "gpt-4o", provider: "openai", state: "legacy",
        contextWindow: 128000, inPerMTok: 2.5, outPerMTok: 10, priceScope: "platform",
        source: PLATFORM_TABLE_SOURCE,
      },
      {
        id: "gpt-4o-mini", label: "gpt-4o mini", provider: "openai", state: "legacy",
        contextWindow: 128000, inPerMTok: 0.6, outPerMTok: 2.4, priceScope: "platform",
        source: PLATFORM_TABLE_SOURCE,
      },
      {
        id: "o3", label: "o3", provider: "openai", state: "legacy",
        contextWindow: 200000, inPerMTok: 20, outPerMTok: 80, priceScope: "platform",
        source: PLATFORM_TABLE_SOURCE,
      },
      {
        id: "o3-pro", label: "o3-pro", provider: "openai", state: "legacy",
        contextWindow: 200000, inPerMTok: 20, outPerMTok: 80, priceScope: "platform",
        source: PLATFORM_TABLE_SOURCE,
      },
      {
        id: "o4-mini", label: "o4-mini", provider: "openai", state: "legacy",
        contextWindow: 128000, inPerMTok: 2, outPerMTok: 8, priceScope: "platform",
        source: PLATFORM_TABLE_SOURCE,
      },
      {
        id: "o1-pro", label: "o1-pro", provider: "openai", state: "legacy",
        contextWindow: 128000, inPerMTok: 150, outPerMTok: 600, priceScope: "platform",
        source: PLATFORM_TABLE_SOURCE,
      },
      {
        id: "gpt-6.1-sol", label: "gpt-6.1 Sol", provider: "openai", state: "available",
        contextWindow: null, inPerMTok: 2, outPerMTok: 10, priceScope: "list",
        source: "OpenAI's model page, as cited in Agent Studio's model registry " +
          "(“near-Astra at Sol price, $2/$10 per MTok”), Nov 2026.",
      },

      /* ── OpenAI — in the registry, no curated price ────────────────── */
      {
        id: "gpt-5.2", label: "gpt-5.2", provider: "openai", state: "available",
        contextWindow: null, inPerMTok: null, outPerMTok: null, priceScope: null,
        source: "In the registry as a flagship; no price curated yet.",
      },
      {
        id: "gpt-5.4-mini", label: "gpt-5.4 mini", provider: "openai", state: "available",
        contextWindow: null, inPerMTok: null, outPerMTok: null, priceScope: null,
        source: "In the registry; no price curated yet.",
      },
      {
        id: "gpt-6-astra", label: "gpt-6 Astra", provider: "openai", state: "available",
        contextWindow: null, inPerMTok: null, outPerMTok: null, priceScope: null,
        source: "In the registry as the GPT-6 flagship (GA Sep 2026); no price curated yet.",
      },
      {
        id: "gpt-6-sol", label: "gpt-6 Sol", provider: "openai", state: "available",
        contextWindow: null, inPerMTok: null, outPerMTok: null, priceScope: null,
        source: "In the registry (fast tier of the GPT-6 family); no price curated yet.",
      },

      /* ── Anthropic ─────────────────────────────────────────────────── */
      {
        id: "claude-haiku-4-5", label: "claude-haiku-4.5", provider: "anthropic", state: "available",
        contextWindow: 200000, inPerMTok: 1, outPerMTok: 5, priceScope: "list",
        source: "Anthropic published list price for claude-haiku-4.5 — $1.00 input / $5.00 " +
          "output per million tokens.",
      },
      {
        id: "claude-sonnet-5", label: "claude-sonnet-5", provider: "anthropic", state: "available",
        contextWindow: null, inPerMTok: null, outPerMTok: null, priceScope: null,
        source: "The registry's Anthropic flagship; no price curated yet.",
      },
      {
        id: "claude-sonnet-5-5", label: "claude-sonnet-5.5", provider: "anthropic", state: "available",
        contextWindow: null, inPerMTok: null, outPerMTok: null, priceScope: null,
        source: "Registered, not yet the default on any workload; no price curated yet.",
      },
      {
        id: "claude-opus-5-5", label: "claude-opus-5.5", provider: "anthropic", state: "available",
        contextWindow: null, inPerMTok: null, outPerMTok: null, priceScope: null,
        source: "Anthropic's newest GA Opus; no price curated yet.",
      },
      {
        id: "claude-opus-4-8", label: "claude-opus-4.8", provider: "anthropic", state: "available",
        contextWindow: null, inPerMTok: null, outPerMTok: null, priceScope: null,
        source: "In the registry; no price curated yet.",
      },
      {
        id: "claude-fable-5", label: "claude-fable-5", provider: "anthropic", state: "available",
        contextWindow: null, inPerMTok: null, outPerMTok: null, priceScope: null,
        source: "In the registry; no price curated yet.",
      },

      /* ── xAI ───────────────────────────────────────────────────────── */
      {
        id: "grok-4.5", label: "grok-4.5", provider: "xai", state: "available",
        contextWindow: null, inPerMTok: null, outPerMTok: null, priceScope: null,
        source: "The registry's xAI flagship; no price curated yet.",
      },
      {
        id: "grok-4.7", label: "grok-4.7", provider: "xai", state: "available",
        contextWindow: null, inPerMTok: null, outPerMTok: null, priceScope: null,
        source: "xAI's top model (GA Sep 2026); no price curated yet.",
      },
      {
        id: "grok-3-mini", label: "grok-3-mini", provider: "xai", state: "available",
        contextWindow: null, inPerMTok: null, outPerMTok: null, priceScope: null,
        quality: {
          score: 0.869, ciLow: 0.824, ciHigh: 0.910, n: 80,
          source: "Internal leaderboard slice, 80 cases, staging, Oct 2026 — directional " +
            "only: different cluster and thresholds from the published board.",
        },
        source: "In the registry as xAI's fast tier; no price curated yet.",
      },

      /* ── Google ────────────────────────────────────────────────────── */
      {
        id: "gemini-3.1-pro-preview", label: "gemini-3.1-pro (preview)", provider: "google",
        state: "available", contextWindow: null, inPerMTok: null, outPerMTok: null, priceScope: null,
        source: "The registry's Google flagship; no price curated yet.",
      },
      {
        id: "gemini-3.8-flash", label: "gemini-3.8-flash", provider: "google", state: "available",
        contextWindow: null, inPerMTok: null, outPerMTok: null, priceScope: null,
        source: "In the registry; no price curated yet.",
      },
      {
        id: "gemini-3.5-flash", label: "gemini-3.5-flash", provider: "google", state: "available",
        contextWindow: null, inPerMTok: null, outPerMTok: null, priceScope: null,
        source: "In the registry; no price curated yet.",
      },
      {
        id: "gemini-2.5-flash-lite", label: "gemini-2.5-flash-lite", provider: "google",
        state: "available", contextWindow: null, inPerMTok: null, outPerMTok: null, priceScope: null,
        source: "In the registry; no price curated yet.",
      },

      /* ── DeepSeek ──────────────────────────────────────────────────── */
      {
        id: "deepseek-v4-flash", label: "deepseek-v4-flash", provider: "deepseek",
        state: "available", contextWindow: 1000000, inPerMTok: null, outPerMTok: null,
        priceScope: null,
        source: "In the registry as the latency tier (pricing page exists upstream); no price curated yet.",
      },
      {
        id: "deepseek-v4-pro", label: "deepseek-v4-pro", provider: "deepseek", state: "available",
        contextWindow: 1000000, inPerMTok: null, outPerMTok: null, priceScope: null,
        source: "In the registry as the capability tier; no price curated yet.",
      },

      /* ── Mistral ───────────────────────────────────────────────────── */
      {
        id: "mistral-medium-3-5", label: "mistral-medium-3.5", provider: "mistral",
        state: "available", contextWindow: null, inPerMTok: null, outPerMTok: null, priceScope: null,
        source: "The registry's Mistral flagship; no price curated yet.",
      },
      {
        id: "mistral-small-2603", label: "mistral-small-2603", provider: "mistral",
        state: "available", contextWindow: null, inPerMTok: null, outPerMTok: null, priceScope: null,
        source: "In the registry as the fast tier; no price curated yet.",
      },

      /* ── Algolia managed LLM ─────────────────────────────────────────
         Included in Agent Studio plans, never priced in tokens: this page
         estimates BYOK costs only. The managed model's billing follows the
         approved pricing and its unit of measurement once live. */
      {
        id: "algolia-medium", label: "Algolia Managed LLM", provider: "algolia",
        state: "available", contextWindow: null, inPerMTok: null, outPerMTok: null,
        priceScope: null, included: true,
        source: "Included in Agent Studio plans — never priced in tokens. Once approved " +
          "pricing is live, its cost follows that pricing's unit of measurement (an " +
          "interaction envelope), not this page's token math.",
      },
      {
        id: "algolia-small", label: "Algolia Managed LLM · fast tier", provider: "algolia",
        state: "available", contextWindow: null, inPerMTok: null, outPerMTok: null,
        priceScope: null, included: true,
        source: "Included in Agent Studio plans like the managed LLM; not estimated here.",
      },
    ],

    providers: [
      { id: "openai", label: "OpenAI" },
      { id: "anthropic", label: "Anthropic" },
      { id: "xai", label: "xAI" },
      { id: "google", label: "Google" },
      { id: "deepseek", label: "DeepSeek" },
      { id: "mistral", label: "Mistral" },
      { id: "algolia", label: "Algolia managed" },
    ],
  };

  /* ── Auto-synced prices ─────────────────────────────────────────────
     prices.auto.js is generated by tools/calculator/fetch-prices.mjs
     (LiteLLM, then OpenRouter as fallback; CI refreshes it weekly).
     Precedence is the doctrine of this page: a curated price — the
     platform's billing table, a dated list price, a labeled placeholder
     — always wins. The sync only fills rows above that left unpriced
     and context windows left unknown, and says so on every row it
     fills. A row the registries do not know stays "no curated price";
     a gap is data the reader can see, never a guess. */
  const auto = global.CALC_AUTO_PRICES;
  if (auto && auto.prices) {
    for (const m of global.CALC_DATA.models) {
      const p = auto.prices[m.id];
      if (!p) continue;
      if (m.contextWindow == null && p.contextWindow) m.contextWindow = p.contextWindow;
      if (m.priceScope == null) {
        m.inPerMTok = p.inPerMTok;
        m.outPerMTok = p.outPerMTok;
        m.priceScope = "auto";
        m.source =
          `${auto.sourceLabel}, fetched ${auto.fetched} (via ${p.via}). Auto-synced — ` +
          `published registry prices, not a negotiation and not our bill.`;
      }
    }
  }
})(window);

/* tests/calculator.test.js — the cost calculator's arithmetic and its data.

   The numbers this page shows land in customer budget conversations, so the
   tests pin the two properties that matter: the bands are ±50% around the
   point estimate, everywhere, and an unpriced model yields no cost at all.
   The production and eval view models are checked against hand-computed
   figures, so a constant that drifts from the platform's estimation service
   shows up as a red test rather than as a quietly wrong quote. */

const test = require("node:test");
const assert = require("node:assert/strict");

const { loadCalc } = require("./load.js");
const Calc = loadCalc();
const C = globalThis.CALC_DATA;

function model(id) {
  const m = C.models.find((m) => m.id === id);
  assert.ok(m, `model ${id} exists in the table`);
  return m;
}

test("bands are ±50% around the point", () => {
  const b = Calc.band(100, C.constants.BAND_RATIO);
  assert.deepEqual(b, { low: 50, point: 100, high: 150 });
  assert.equal(C.constants.BAND_RATIO, 0.5, "the demo advertises ±50%");
});

test("band clamps negative points to zero", () => {
  const b = Calc.band(-5, 0.5);
  assert.equal(b.point, 0);
});

test("production view: 1k sessions, 10%, 3 turns, 2 rounds, 30 days", () => {
  const v = Calc.productionView({
    sessionsPerDay: 1000,
    adoptionPct: 10,
    turnsPerConversation: 3,
    roundsPerTurn: 2,
    inputTokensPerRound: 4000,
    outputTokensPerTurnCall: 400,
    guardrails: false,
    daysPerMonth: 30,
  }, C);

  assert.equal(v.conversationsPerDay, 100);
  assert.equal(v.turnsPerDay, 300);
  assert.equal(v.agentCallsPerDay, 600);
  assert.equal(v.agentCallsMonth, 18000);
  assert.equal(v.tokensInMonth, 18000 * 4000);
  assert.equal(v.tokensOutMonth, 18000 * 400);
  // the assumptions echo every constant the arithmetic used
  assert.ok(v.assumptions.some((a) => a.includes("600 agent LLM calls/day")));
  assert.ok(v.assumptions.some((a) => a.includes("±50% band")));
});

test("production view: guardrails bill one classification per turn, not per round", () => {
  const base = { sessionsPerDay: 1000, adoptionPct: 10, turnsPerConversation: 3, roundsPerTurn: 2,
    inputTokensPerRound: 4000, outputTokensPerTurnCall: 400, daysPerMonth: 30 };
  const withGuardrails = Calc.productionView({ ...base, guardrails: true }, C);
  const without = Calc.productionView({ ...base, guardrails: false }, C);

  assert.equal(
    withGuardrails.tokensInMonth - without.tokensInMonth,
    300 * 30 * C.constants.GUARDRAIL_INPUT_TOKENS_PER_CALL
  );
  assert.equal(
    withGuardrails.tokensOutMonth - without.tokensOutMonth,
    300 * 30 * C.constants.GUARDRAIL_OUTPUT_TOKENS_PER_CALL
  );
});

test("cost band: gpt-4o-mini on the production defaults", () => {
  const cost = Calc.costBand(model("gpt-4o-mini"), 72_000_000, 7_200_000, 0.5);
  // 72 × $0.60 + 7.2 × $2.40 = $43.20 + $17.28
  assert.ok(Math.abs(cost.point - 60.48) < 1e-9);
  assert.ok(Math.abs(cost.low - 30.24) < 1e-9);
  assert.ok(Math.abs(cost.high - 90.72) < 1e-9);
});

test("an unpriced model yields no cost — null in, null out", () => {
  const m = { inPerMTok: null, outPerMTok: null };
  assert.equal(Calc.costBand(m, 1_000_000, 1_000_000, 0.5), null);
  assert.equal(Calc.costBandCached(m, 1_000_000, 1_000_000, 50, 0.1, 0.5), null);
  assert.equal(Calc.costBand(null, 1_000_000, 1_000_000, 0.5), null);
});

test("measured conversations replace the sessions × adoption guess", () => {
  const now = 1700000000000;
  const conv = (daysAgo, msgCount, tin, tout) => ({
    createdAt: new Date(now - daysAgo * 86400000).toISOString(),
    messageCount: msgCount, totalInputTokens: tin, totalOutputTokens: tout, totalTokens: tin + tout,
  });
  const stats = Calc.conversationStats([conv(0, 6, 20000, 3000), conv(1, 4, 10000, 2000), conv(2, 6, 15000, 2500)]);
  assert.equal(stats.sample, 3);
  assert.equal(stats.sampleDays, 2);
  assert.ok(Math.abs(stats.conversationsPerDay - 1.5) < 0.1);
  assert.equal(stats.medianTurns, 3);
  assert.equal(stats.medianTokens, 17500);
  // the envelope honours the measured rate and ignores the sliders then
  const base = { sessionsPerDay: 1000, adoptionPct: 10, turnsPerConversation: 3, roundsPerTurn: 2,
    inputTokensPerRound: 4000, outputTokensPerTurnCall: 400, guardrails: false, daysPerMonth: 30,
    responseCachePct: 0, providerCachePct: 0, pdp: false, followups: false };
  const measured = Calc.productionView({ ...base, measuredConversationsPerDay: stats.conversationsPerDay }, C);
  const guessed = Calc.productionView(base, C);
  assert.ok(Math.abs(measured.conversationsPerDay - 1.5) < 0.1);
  assert.ok(measured.tokensInMonth < guessed.tokensInMonth, "1.5 real conv/day < the 100/day guess");
  assert.ok(measured.assumptions.some((a) => a.includes("measured on real traffic")));
  assert.equal(Calc.conversationStats([]), null);
  assert.equal(Calc.conversationStats(undefined), null);
});

test("the default model is a current fast tier, priced by the sync", () => {
  const haiku = model("claude-haiku-5-5");
  assert.ok(haiku, "claude-haiku-5-5 exists");
  assert.ok(haiku.inPerMTok != null, "the sync prices it");
  // days per month is the year's average, not a selector
});

test("no traffic setting can silently price a BYOK model to zero", () => {
  // Sweep every template across every priced model, guardrails on and off:
  // billed tokens > 0 must mean cost > 0, strictly. The one legitimate zero
  // would be a free tier — and the managed model carries no token price at
  // all any more, so a zero here is a bug, not a fact.
  for (const tpl of C.templates) {
    const base = {
      sessionsPerDay: tpl.values.sessionsPerDay,
      adoptionPct: tpl.values.adoptionPct,
      turnsPerConversation: tpl.values.turnsPerConversation,
      roundsPerTurn: tpl.values.roundsPerTurn,
      inputTokensPerRound: tpl.values.inputTokensPerRound,
      outputTokensPerTurnCall: tpl.values.outputTokensPerTurnCall,
      responseCachePct: 0, providerCachePct: 0,
      pdp: false, pdpCallsPerDay: 0, followups: false,
      guardrails: false, daysPerMonth: 30,
    };
    for (const guardrails of [false, true]) {
      const v = Calc.productionView({ ...base, guardrails }, C);
      assert.ok(v.tokensInMonth > 0, `${tpl.id}: input tokens`);
      assert.ok(v.tokensOutMonth > 0, `${tpl.id}: output tokens`);
      for (const m of C.models) {
        const cost = Calc.costBandCached(m, v.tokensInMonth, v.tokensOutMonth, 0, 0.1, 0.5);
        if (m.priceScope == null) {
          assert.equal(cost, null, `${tpl.id}/${m.id}: unpriced stays unpriced`);
          continue;
        }
        assert.ok(cost && cost.point > 0, `${tpl.id}/${m.id}: priced model must cost > 0`);
        assert.ok(cost.low > 0 || cost.point >= 0.0001, `${tpl.id}/${m.id}: band is not a fake zero`);
      }
    }
  }
});

test("usdOrFree renders a zero band as the fact it is", () => {
  assert.equal(Calc.usdOrFree({ low: 0, point: 0, high: 0 }), "free");
  assert.equal(Calc.usdOrFree({ low: 5, point: 10, high: 15 }), "$10.00");
  assert.equal(Calc.usdOrFree(null), "unpriced");
});

test("share state round-trips and refuses garbage", () => {
  const state = { model: "gpt-5.6-luna", sessions: "10000", adoption: "12", guard: true, days: "30" };
  const encoded = Calc.encodeState(state);
  assert.ok(!encoded.includes("=") && !encoded.includes("+") && !encoded.includes("/"), "url-safe");
  assert.deepEqual(Calc.decodeState(encoded), state);
  assert.equal(Calc.decodeState("not-a-blob!!!"), null);
  assert.equal(Calc.decodeState(""), null);
  // a decoded object with junk keys comes back as-is: applyState ignores
  // what it does not recognize, so junk never reaches the page state
  assert.deepEqual(Calc.decodeState(Buffer.from('{"model":42}').toString("base64")), { model: 42 });
  assert.equal(Calc.decodeState(Buffer.from('"just a string"').toString("base64")), null,
    "a decoded non-object is refused");
});

test("caching: response cache skips turns, provider cache discounts input", () => {
  const base = { sessionsPerDay: 1000, adoptionPct: 10, turnsPerConversation: 3, roundsPerTurn: 2,
    inputTokensPerRound: 4000, outputTokensPerTurnCall: 400, guardrails: false, daysPerMonth: 30 };
  const v = Calc.productionView({ ...base, responseCachePct: 80, providerCachePct: 50 }, C);

  // 300 turns/day, 80% served from the response cache → 60 billed
  assert.equal(v.turnsBilledPerDay, 60);
  assert.equal(v.callsBilledPerDay, 120);
  assert.equal(v.tokensInMonth, 120 * 30 * 4000);
  assert.equal(v.tokensOutMonth, 120 * 30 * 400);

  // 14.4M in: half at 10% of $0.60, half at $0.60 → 14.4 × 0.6 × 0.55 = $4.752
  // 1.44M out at $2.40 → $3.456
  const cost = Calc.costBandCached(model("gpt-4o-mini"), v.tokensInMonth, v.tokensOutMonth, 50, 0.1, 0.5);
  assert.ok(Math.abs(cost.point - 8.208) < 1e-9);
  assert.ok(v.assumptions.some((a) => a.includes("response cache serves 80%")));
  assert.ok(v.assumptions.some((a) => a.includes("prompt cache serves 50%")));
});

test("extras: PDP calls bill per day, follow-ups per billed turn", () => {
  const base = { sessionsPerDay: 1000, adoptionPct: 10, turnsPerConversation: 3, roundsPerTurn: 2,
    inputTokensPerRound: 4000, outputTokensPerTurnCall: 400, guardrails: false, daysPerMonth: 30,
    responseCachePct: 80 };
  const v = Calc.productionView({ ...base, pdp: true, pdpCallsPerDay: 100, followups: true }, C);

  // 120 conversation calls + 100 PDP + 60 follow-ups (60 billed turns × 1)
  assert.equal(v.callsBilledPerDay, 280);
  assert.equal(v.tokensInMonth, 280 * 30 * 4000 + 100 * 30 * C.constants.EXTRA_PDP_INPUT_TOKENS + 60 * 30 * C.constants.EXTRA_FOLLOWUP_INPUT_TOKENS);
  assert.equal(v.tokensOutMonth, 280 * 30 * 400 + 100 * 30 * C.constants.EXTRA_PDP_OUTPUT_TOKENS + 60 * 30 * C.constants.EXTRA_FOLLOWUP_OUTPUT_TOKENS);
});

test("caching never inflates: 0% defaults behave exactly like no caching", () => {
  const base = { sessionsPerDay: 1000, adoptionPct: 10, turnsPerConversation: 3, roundsPerTurn: 2,
    inputTokensPerRound: 4000, outputTokensPerTurnCall: 400, guardrails: false, daysPerMonth: 30 };
  const withZeros = Calc.productionView({ ...base, responseCachePct: 0, providerCachePct: 0, pdp: false, followups: false }, C);
  const without = Calc.productionView(base, C);
  assert.equal(withZeros.tokensInMonth, without.tokensInMonth);
  assert.equal(withZeros.tokensOutMonth, without.tokensOutMonth);
  const plain = Calc.costBand(model("gpt-4o-mini"), without.tokensInMonth, without.tokensOutMonth, 0.5);
  const cached = Calc.costBandCached(model("gpt-4o-mini"), without.tokensInMonth, without.tokensOutMonth, 0, 0.1, 0.5);
  assert.ok(Math.abs(plain.point - cached.point) < 1e-9);
});

test("templates carry every slider they claim to set", () => {
  for (const t of C.templates) {
    for (const key of ["sessionsPerDay", "adoptionPct", "turnsPerConversation", "roundsPerTurn",
      "inputTokensPerRound", "outputTokensPerTurnCall", "pdpCallsPerDay"]) {
      assert.ok(Number.isFinite(t.values[key]) && t.values[key] > 0, `${t.id}.${key}`);
    }
  }
});

test("approximation: ≈4 characters per token", () => {
  assert.equal(Calc.approximateTokens(""), 0);
  assert.equal(Calc.approximateTokens("abcd"), 1);
  assert.equal(Calc.approximateTokens("abcde"), 2);
});

test("every model row is well-formed", () => {
  const ids = new Set();
  for (const m of C.models) {
    assert.ok(m.id && m.label && m.provider, `row has id/label/provider: ${JSON.stringify(m)}`);
    assert.ok(!ids.has(m.id), `duplicate id ${m.id}`);
    ids.add(m.id);
    assert.ok(["available", "deprecated", "legacy"].includes(m.state), `${m.id}: unknown state`);
    if (m.included) {
      assert.equal(m.priceScope, null, `${m.id}: included rows carry no token price`);
    } else if (m.priceScope != null) {
      assert.ok(["platform", "list", "placeholder", "auto"].includes(m.priceScope), `${m.id}: scope`);
      assert.ok(m.source && m.source.length > 20, `${m.id}: priced rows name their source`);
      assert.ok(m.inPerMTok != null && m.outPerMTok != null, `${m.id}: scoped rows are priced`);
      assert.ok(!m.managedBeta, `${m.id}: the managed model is not token-priced here`);
    } else {
      assert.ok(m.inPerMTok == null && m.outPerMTok == null, `${m.id}: unpriced rows carry no price`);
      assert.match(m.source, /no (price curated|curated price|public registry)|Included/, `${m.id}: unpriced rows say why`);
    }
  }
});

test("quality entries carry their sample size and an honesty note", () => {
  for (const m of C.models.filter((m) => m.quality)) {
    assert.ok(Number.isFinite(m.quality.score), `${m.id}: score`);
    assert.ok(m.quality.n > 0, `${m.id}: n`);
    assert.match(m.quality.source, /directional|Internal/, `${m.id}: quality is flagged as directional`);
  }
});

test("formatters", () => {
  assert.equal(Calc.shortTokens(999), "999");
  assert.equal(Calc.shortTokens(363000), "363k");
  assert.equal(Calc.shortTokens(5400000), "5.4M");
  assert.equal(Calc.usd(0.0004), "$0.0004");
  assert.equal(Calc.usd(12.5), "$12.50");
  assert.equal(Calc.usdRange({ low: 30.24, high: 90.72 }), "$30.24 – $90.72");
});

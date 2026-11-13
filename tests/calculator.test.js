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

test("an unpriced model yields no cost, and says why in its source", () => {
  const m = model("grok-4.5");
  assert.equal(m.priceScope, null);
  assert.equal(Calc.costBand(m, 1_000_000, 1_000_000, 0.5), null);
  assert.match(m.source, /no price curated/);
});

test("eval view mirrors the platform's estimate_eval_run", () => {
  const v = Calc.evalView({
    numCases: 500, iterations: 1, metricCount: 2, roundsMultiplier: 2,
    modelId: "gpt-5.6-luna", judgeModelId: "medium", concurrency: 2, guardrails: false,
  }, C);

  assert.equal(v.agentCalls, 1000);
  assert.equal(v.judgeCalls, 500);
  // agent: 1000 × (4000 + 400) = 4.4M tokens
  assert.equal(v.agentTokens.point, 4_400_000);
  assert.equal(v.agentTokens.low, 2_200_000);
  // judge: 500 × (2500 + 350) = 1.425M
  assert.equal(v.judgeTokens.point, 1_425_000);
  // wall: ceil(500 / 2) × 12s
  assert.equal(v.wallSeconds.point, 3000);
  // agent cost at gpt-5.6-luna ($1/$6): 4M × 1 + 0.4M × 6 per Mtok = $6.40
  assert.ok(Math.abs(v.agentCost.point - 6.4) < 1e-9);
  // the "medium" judge alias is unpriced by design
  assert.equal(v.judgeCost, null);
  assert.ok(v.assumptions.some((a) => a.includes("unpriced by design")));
  assert.ok(v.assumptions.some((a) => a.includes("metrics do not multiply the judging")));
});

test("eval view: guardrails add one classification per case", () => {
  const base = { numCases: 100, iterations: 1, metricCount: 1, roundsMultiplier: 2,
    modelId: "gpt-5.6-luna", judgeModelId: "medium", concurrency: 2 };
  const guarded = Calc.evalView({ ...base, guardrails: true }, C);
  const plain = Calc.evalView({ ...base, guardrails: false }, C);
  assert.equal(guarded.agentTokens.point - plain.agentTokens.point, 100 * 730);
  assert.equal(guarded.wallSeconds.point - plain.wallSeconds.point, Math.ceil(100 / 2) * 1);
});

test("eval view: unpriced agent model yields no agent cost", () => {
  const v = Calc.evalView({
    numCases: 10, iterations: 1, metricCount: 1, roundsMultiplier: 2,
    modelId: "grok-4.5", judgeModelId: "medium", concurrency: 2, guardrails: false,
  }, C);
  assert.equal(v.agentCost, null);
  assert.ok(v.assumptions.some((a) => a.includes("No agent cost")));
});

test("anatomy: shares scale to the input total and the fractions sum to one", () => {
  const parts = Calc.anatomy(8000, 400, C.anatomyShares);
  assert.equal(parts.length, C.anatomyShares.length);
  const fracSum = parts.reduce((s, p) => s + p.frac, 0);
  assert.ok(Math.abs(fracSum - 1) < 1e-9);
  // at the default 4000, each slice is exactly its declared share
  const atDefault = Calc.anatomy(4000, 400, C.anatomyShares);
  atDefault.forEach((p, i) => assert.equal(p.tokens, C.anatomyShares[i].tokens));
});

test("the anatomy shares sum to the agent input constant", () => {
  const sum = C.anatomyShares.reduce((s, p) => s + p.tokens, 0);
  assert.equal(sum, C.constants.AGENT_INPUT_TOKENS_PER_CALL);
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
    assert.equal(
      (m.inPerMTok == null) === (m.outPerMTok == null),
      true, `${m.id}: both prices or neither`
    );
    if (m.priceScope != null) {
      assert.ok(["platform", "list", "placeholder"].includes(m.priceScope), `${m.id}: scope`);
      assert.ok(m.source && m.source.length > 20, `${m.id}: priced rows name their source`);
    } else {
      assert.match(m.source, /no price curated/, `${m.id}: unpriced rows say why`);
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

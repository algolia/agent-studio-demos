/* tests/calculator.test.js — the cost calculator's arithmetic and its data.

   The numbers this page shows land in customer budget conversations, so the
   tests pin the two properties that matter: the bands are ±50% around the
   point estimate, everywhere, and an unpriced model yields no cost at all.
   The production view model is checked against hand-computed figures, and
   the locked baseline (turns, rounds, caching) is pinned, so a constant that
   drifts shows up as a red test rather than as a quietly wrong quote. */

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

/* The params the page actually sends: two visitor levers plus the locked
   baseline. Tests that mean "what the visitor sees" use this, not ad-hoc
   shapes, so the arithmetic cannot drift from the wiring. */
function pageParams(overrides = {}) {
  const c = C.constants;
  return {
    sessionsPerDay: 10000,
    adoptionPct: 12,
    turnsPerConversation: c.TURNS_PER_CONVERSATION,
    roundsPerTurn: c.ROUNDS_PER_TURN,
    inputTokensPerRound: c.AGENT_INPUT_TOKENS_PER_CALL,
    outputTokensPerTurnCall: c.AGENT_OUTPUT_TOKENS_PER_CALL,
    guardrails: true,
    followups: true,
    responseCachePct: c.RESPONSE_CACHE_PCT,
    providerCachePct: c.PROVIDER_CACHE_PCT,
    daysPerMonth: 365 / 12,
    ...overrides,
  };
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

test("the locked baseline holds the advertised typical averages", () => {
  const c = C.constants;
  assert.equal(c.TURNS_PER_CONVERSATION, 1.5);
  assert.equal(c.ROUNDS_PER_TURN, 2);
  assert.equal(c.RESPONSE_CACHE_PCT, 75, "low end of the live 70–85% band");
  assert.equal(c.PROVIDER_CACHE_PCT, 40);
  assert.equal(c.AGENT_INPUT_TOKENS_PER_CALL, 3000);
  assert.equal(c.AGENT_OUTPUT_TOKENS_PER_CALL, 500);
});

test("production view: 1k sessions at 10% adoption, locked baseline", () => {
  // 100 conversations/day × 1.5 turns = 150 turns; × 2 rounds = 300 calls.
  // Response cache serves 75% → 38 billed turns/day → 76 calls + 38 follow-ups = 114.
  const v = Calc.productionView(pageParams({ sessionsPerDay: 1000, adoptionPct: 10, daysPerMonth: 30 }), C);

  assert.equal(v.conversationsPerDay, 100);
  assert.equal(v.turnsPerDay, 150);
  assert.equal(v.agentCallsPerDay, 300);
  assert.equal(v.turnsBilledPerDay, 38);
  assert.equal(v.callsBilledPerDay, 114);
  assert.equal(v.tokensInMonth, 114 * 30 * 3000 + 38 * 30 * C.constants.EXTRA_FOLLOWUP_INPUT_TOKENS + 150 * 30 * C.constants.GUARDRAIL_INPUT_TOKENS_PER_CALL);
  assert.equal(v.tokensOutMonth, 114 * 30 * 500 + 38 * 30 * C.constants.EXTRA_FOLLOWUP_OUTPUT_TOKENS + 150 * 30 * C.constants.GUARDRAIL_OUTPUT_TOKENS_PER_CALL);
  // the assumptions echo every constant the arithmetic used
  assert.ok(v.assumptions.some((a) => a.includes("× 1.5 turns")));
  assert.ok(v.assumptions.some((a) => a.includes("response cache serves 75%")));
  assert.ok(v.assumptions.some((a) => a.includes("±50% band")));
});

test("production view with caching off: the raw turn math", () => {
  const v = Calc.productionView(pageParams({
    sessionsPerDay: 1000, adoptionPct: 10, daysPerMonth: 30,
    responseCachePct: 0, providerCachePct: 0, guardrails: false, followups: false,
  }), C);
  assert.equal(v.turnsPerDay, 150);
  assert.equal(v.turnsBilledPerDay, 150);
  assert.equal(v.callsBilledPerDay, 300);
  assert.equal(v.tokensInMonth, 300 * 30 * 3000);
  assert.equal(v.tokensOutMonth, 300 * 30 * 500);
});

test("caching: response cache skips turns, provider cache discounts input", () => {
  const base = { sessionsPerDay: 1000, adoptionPct: 10, turnsPerConversation: 3, roundsPerTurn: 2,
    inputTokensPerRound: 4000, outputTokensPerTurnCall: 400, guardrails: false, followups: false, daysPerMonth: 30 };
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

test("no traffic setting can silently price a BYOK model to zero", () => {
  // Sweep every template across every priced model at the page's real
  // baseline: billed tokens > 0 must mean cost > 0, strictly. A zero here
  // is a bug, not a fact — the managed model carries no token price at all.
  for (const tpl of C.templates) {
    const v = Calc.productionView(pageParams({
      sessionsPerDay: tpl.values.sessionsPerDay,
      adoptionPct: tpl.values.adoptionPct,
      daysPerMonth: 30,
    }), C);
    assert.ok(v.tokensInMonth > 0, `${tpl.id}: input tokens`);
    assert.ok(v.tokensOutMonth > 0, `${tpl.id}: output tokens`);
    for (const m of C.models) {
      const cost = Calc.costBandCached(m, v.tokensInMonth, v.tokensOutMonth,
        C.constants.PROVIDER_CACHE_PCT, C.constants.PROVIDER_CACHE_DISCOUNT, C.constants.BAND_RATIO);
      if (m.priceScope == null) {
        assert.equal(cost, null, `${tpl.id}/${m.id}: unpriced stays unpriced`);
        continue;
      }
      assert.ok(cost && cost.point > 0, `${tpl.id}/${m.id}: priced model must cost > 0`);
      assert.ok(cost.low > 0 || cost.point >= 0.0001, `${tpl.id}/${m.id}: band is not a fake zero`);
    }
  }
});

test("the private-beta gemma row is priced at the open-weights list", () => {
  const m = model("gemma-4-31b-it");
  assert.equal(m.priceScope, "list");
  assert.equal(m.inPerMTok, 0.2);
  assert.equal(m.outPerMTok, 0.4);
  assert.match(m.source, /OpenRouter/);
  assert.match(m.source, /nvfp4/, "the row names the served variant");
});

test("the default model is priced — the page must open on a number", () => {
  const m = model("gemma-4-31b-it");
  assert.ok(m.inPerMTok != null && m.outPerMTok != null, "default selection carries a price");
});

test("usdOrFree renders a zero band as the fact it is", () => {
  assert.equal(Calc.usdOrFree({ low: 0, point: 0, high: 0 }), "free");
  assert.equal(Calc.usdOrFree({ low: 5, point: 10, high: 15 }), "$10.00");
  assert.equal(Calc.usdOrFree(null), "unpriced");
});

test("share state round-trips and refuses garbage", () => {
  const state = { model: "gpt-5.6-luna", sessions: "10000", adoption: "12" };
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

test("templates carry exactly the two visitor levers", () => {
  for (const t of C.templates) {
    assert.deepEqual(
      Object.keys(t.values).sort(),
      ["adoptionPct", "sessionsPerDay"],
      `${t.id}: the visitor changes traffic and adoption, nothing else`
    );
    assert.ok(Number.isFinite(t.values.sessionsPerDay) && t.values.sessionsPerDay > 0, `${t.id}.sessionsPerDay`);
    assert.ok(Number.isFinite(t.values.adoptionPct) && t.values.adoptionPct > 0, `${t.id}.adoptionPct`);
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

test("the client table shows the showcase families, priced — managed rows wait", () => {
  // The page filter is one predicate; this pins it so an auto-synced row
  // cannot quietly surface in front of a customer. The managed rows stay
  // off the page until approved pricing says what to promote there.
  const visible = C.models.filter((m) => m.showcase && m.state === "available");
  assert.equal(visible.length, 13, "one row per family, fast tier to flagship");
  for (const m of visible) {
    assert.ok(m.priceScope != null, `${m.id}: showcase rows are priced`);
    assert.ok(!m.included, `${m.id}: managed rows do not surface as showcase`);
  }
  assert.ok(visible.some((m) => m.id === "gemma-4-31b-it"), "the private beta stays visible");
  // every provider a customer names in an RFP finds a row
  for (const p of ["openai", "anthropic", "google", "xai"]) {
    assert.ok(visible.some((m) => m.provider === p), `${p} has a row`);
  }
});

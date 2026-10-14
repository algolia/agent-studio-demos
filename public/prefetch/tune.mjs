/* ───────────────────────────────────────────────────────────────
   tune.mjs: the albums page's agents, and what "Tune it" compares.

   Pure: no DOM. Every agent of the albums demo has the same model and the
   same instructions; only its search prefetch block differs. The race runs
   the base against the race partner (window 1, 5 hits). "Tune it" runs two
   prefetch agents side by side, each one picked by a window and a hit count,
   so a visitor changes a setting by switching to an agent made for it. No
   key and no setting leaves the page: the map in config.js names the agents.

   The provisioning script (tools/prefetch-albums-provision.mjs) imports
   this module, so the page and the script agree on names and settings.
   ─────────────────────────────────────────────────────────────── */

export const AGENT_PREFIX = "DEMO_albums-";
export const INDEX = "thousand_albums";

/** the chips of each lane in "Tune it" */
export const WINDOWS = [1, 2, 3];
export const HITS = [3, 10];
/** the race partner's settings: prefetch on, one turn, five hits */
export const RACE = Object.freeze({ window: 1, hits: 5 });

/** "w2-h10": a combo's key in the config block's tune map */
export const comboKey = ({ window, hits }) => `w${window}-h${hits}`;

/** every combo the chips can make, window first */
export const COMBOS = WINDOWS.flatMap((window) => HITS.map((hits) => ({ window, hits })));

/**
 * The agents, in creation order: the base (prefetch off), the race partner,
 * then one per combo. A combo equal to the race partner's would reuse it.
 *   [{ name, prefetch: null | { window, hits } }]
 */
export const ALBUM_AGENTS = [
  { name: `${AGENT_PREFIX}base`, prefetch: null },
  { name: `${AGENT_PREFIX}prefetch-${comboKey(RACE)}`, prefetch: { ...RACE } },
  ...COMBOS.filter((c) => comboKey(c) !== comboKey(RACE))
    .map((c) => ({ name: `${AGENT_PREFIX}prefetch-${comboKey(c)}`, prefetch: c })),
];

/** the agent config block for a prefetch setting: the backend's camelCase wire keys */
export function prefetchBlock(p) {
  if (!p) return false;
  return { enabled: true, conversationWindow: p.window, hitsPerPage: p.hits };
}

/** the default pick of each lane: same hits, window 1 against window 2 */
export const TUNE_DEFAULTS = Object.freeze({ a: { window: 1, hits: 3 }, b: { window: 2, hits: 3 } });

/** a combo's agent from the block's tune map, or null when the deploy has none */
export function tuneAgent(block, combo) {
  const map = (block && block.tune) || {};
  const key = comboKey(combo);
  const hit = map[key] || (key === comboKey(RACE) ? raceAgent(block) : null);
  return hit && typeof hit.agentId === "string" && hit.agentId ? hit : null;
}

/** the race partner's entry: its variants slot under the prefetch-on key */
function raceAgent(block) {
  const v = (block && block.variants) || {};
  return v["prefetch=1,memory=0,guardrails=0,suggestions=0"] || null;
}

/** the combos this deploy can run; a chip with no agent is left off */
export function availableCombos(block) {
  return COMBOS.filter((c) => tuneAgent(block, c));
}

/**
 * The query prefetch sends, as the backend builds it: the last `window`
 * user turns, oldest first, joined by a space, whitespace squeezed, 512
 * characters at most (agent/services/search_prefetch/service.py).
 */
export function windowQuery(userTurns, window) {
  const texts = (userTurns || []).map((t) => String(t || "")).slice(-Math.max(1, window));
  return texts.join(" ").split(/\s+/).filter(Boolean).join(" ").slice(0, 512);
}

/* check-copy: off */
/**
 * Scripted two-turn conversations, each run on every tune agent against
 * thousand_albums. `topic` is what the follow-up means in context: a hit is
 * on topic when every test holds. Window 1 searches the follow-up alone and
 * loses the first turn; window 2 keeps it. With two turns, window 3 searches
 * what window 2 does. Measured 2026-10-14, 3 hits: soul then funk fits 0 of 3
 * at window 1 and 3 of 3 at window 2; Britain fits 0 against 1; the 90s
 * follow-up is too short to prefetch alone, so window 1 skips it.
 */
export const PAIRS = [
  {
    turns: ["Soul records for a Sunday morning", "Something with funk"],
    topic: [{ attr: "genres", match: /soul/i }, { attr: "genres", match: /funk/i }],
  },
  {
    turns: ["Psychedelic rock from the 60s", "Something from Britain"],
    topic: [{ attr: "genres", match: /psych/i }, { attr: "country", match: /^(GB|UK|United Kingdom|England|Britain)/i }],
  },
  {
    turns: ["Hip hop albums from New York", "What about the 90s?"],
    topic: [{ attr: "genres", match: /hip.?hop|rap/i }, { attr: "year", from: 1990, to: 1999 }],
  },
];
/* check-copy: on */

const valuesOf = (hit, attr) => {
  const v = attr.split(".").reduce((x, k) => (x && typeof x === "object" ? x[k] : undefined), hit);
  return (Array.isArray(v) ? v : [v]).filter((x) => x !== undefined && x !== null && x !== "");
};

/** one topic test on one hit: a pattern on any value, or a year range */
function holds(hit, t) {
  const vals = valuesOf(hit, t.attr);
  if (t.match) return vals.some((v) => t.match.test(String(v)));
  return vals.some((v) => {
    const n = Number.parseInt(String(v), 10);
    return Number.isFinite(n) && n >= t.from && n <= t.to;
  });
}

/** how many hits fit the conversation's topic; null when the conversation has none */
export function onTopic(hits, topic) {
  if (!Array.isArray(topic) || !topic.length) return null;
  return (hits || []).filter((h) => topic.every((t) => holds(h, t))).length;
}

/** the scripted pair whose turns these are, or null for a conversation the visitor typed */
export function pairOf(turns) {
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
  return PAIRS.find((p) => p.turns.length === turns.length && p.turns.every((t, i) => norm(t) === norm(turns[i]))) || null;
}

/**
 * The body of one completions call: every turn so far, the answers in
 * between as plain text, in the ai-sdk-5 UI message shape the Chat widget sends.
 */
export function messagesFor(turns, answers) {
  const out = [];
  turns.forEach((text, i) => {
    out.push({ id: `u${i}`, role: "user", parts: [{ type: "text", text }] });
    if (i < turns.length - 1) out.push({ id: `a${i}`, role: "assistant", parts: [{ type: "text", text: String((answers || [])[i] || "") }] });
  });
  return out;
}

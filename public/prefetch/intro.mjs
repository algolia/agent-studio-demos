/* ───────────────────────────────────────────────────────────────
   intro.mjs: the title screen's timeline, before and after.

   Pure: no DOM. One stored run of each lane, cut into phases by
   compare.mjs `phases()`, becomes one bar whose segments move: the model's
   own search slides to the front and turns into the prefetch, the model's
   first call (the one that only asked for a search) shrinks to nothing, and
   the whole bar ends where the prefetch run ended. Both states are laid on
   the slower run's scale, so the shorter bar draws shorter.
   ─────────────────────────────────────────────────────────────── */

/* check-copy: off */
/**
 * A typical run of the albums race: durations in ms per phase, read off one
 * live run of each lane (tools/prefetch-albums-provision.mjs measures them).
 * `before` is the base agent: wait, model, its search, model, answer.
 * `after` is the race partner: wait, prefetch, model, answer.
 */
export const TYPICAL = {
  measured: null,
  before: [
    { kind: "wait", ms: 0 }, { kind: "model", ms: 0 }, { kind: "search", ms: 0 },
    { kind: "model", ms: 0 }, { kind: "answer", ms: 0 },
  ],
  after: [{ kind: "wait", ms: 0 }, { kind: "prefetch", ms: 0 }, { kind: "model", ms: 0 }, { kind: "answer", ms: 0 }],
};

export const LABELS = {
  wait: "waiting", prefetch: "prefetch", search: "search", model: "model", answer: "answer",
};
/* check-copy: on */

const sum = (xs) => xs.reduce((a, x) => a + x.ms, 0);

/** a phase this short is the gap between two stream events, not a step: it joins the one before */
export const SLIVER_MS = 20;

/**
 * Phases (compare.mjs `phases()`) to the stored shape: same-kind neighbours
 * merged, slivers folded into the phase before, every phase a duration.
 * Other tool calls count as model time.
 */
export function fromPhases(parts) {
  const out = [];
  for (const p of parts || []) {
    const kind = p.kind === "tool" ? "model" : p.kind;
    const d = Math.max(0, p.end - p.start);
    const prev = out[out.length - 1];
    if (prev && (prev.kind === kind || d < SLIVER_MS)) prev.ms += d;
    else out.push({ kind, ms: d });
  }
  return out.map((x) => ({ kind: x.kind, ms: Math.round(x.ms) }));
}

/** whether a stored run has the shapes the animation morphs between */
export function isMorphable(run) {
  const b = (run && run.before) || [];
  const a = (run && run.after) || [];
  return sum(b) > 0 && sum(a) > 0 && b.some((x) => x.kind === "search") && a.some((x) => x.kind === "prefetch");
}

/**
 * The two states of one bar. Each segment keeps its id from state to state,
 * so a CSS transition on left and width moves it: `search` becomes
 * `prefetch` in place of the model's first call, which closes to zero.
 *   { scale, before: [seg], after: [seg], totals: { before, after } }
 *   seg = { id, kind, left, width } with left and width in percent of scale
 */
export function morph(run) {
  const before = (run && run.before) || [];
  const after = (run && run.after) || [];
  const totals = { before: sum(before), after: sum(after) };
  const scale = Math.max(totals.before, totals.after, 1);
  const lay = (segs) => {
    let t = 0;
    return segs.map((s) => {
      const seg = { id: s.id, kind: s.kind, left: (t / scale) * 100, width: (s.ms / scale) * 100 };
      t += s.ms;
      return seg;
    });
  };
  // ids: the n-th phase of a kind is `kind-n`; the after run's prefetch takes the before run's search id
  const ids = (segs, swap) => {
    const n = {};
    return segs.map((s) => {
      const k = swap && s.kind === "prefetch" ? "search" : s.kind;
      n[k] = (n[k] || 0) + 1;
      return { ...s, id: `${k}-${n[k]}` };
    });
  };
  const b = ids(before, false);
  const a = ids(after, true);
  // the after run has one model phase fewer: its first one is the before run's second
  const firstModel = b.findIndex((s) => s.kind === "model");
  const searchAt = b.findIndex((s) => s.kind === "search");
  const a2 = a.map((s) => (s.kind === "model" && firstModel >= 0 && firstModel < searchAt ? { ...s, id: s.id.replace(/-(\d+)$/, (_, k) => `-${Number(k) + 1}`) } : s));
  const laidB = lay(b);
  const laidA = lay(a2);
  // segments with no partner close to zero width where they stand, so nothing pops
  for (const s of laidB) {
    if (!laidA.some((x) => x.id === s.id)) {
      const at = laidA.find((x) => x.id === "search-1");
      laidA.push({ id: s.id, kind: s.kind, left: at ? at.left : s.left, width: 0 });
    }
  }
  return { scale, before: laidB, after: laidA, totals };
}

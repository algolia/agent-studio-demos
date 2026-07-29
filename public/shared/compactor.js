/* ───────────────────────────────────────────────────────────────
   compactor.js — the auto-compact loop, as a driver that owns no state.

   CONTRIBUTING names the seam this file cuts. `chat-with-book` has the decision
   in one line and the machinery welded to its own arrays:

     if (state.tokens >= currentWindow() * CFG.compactAtRatio) await runCompact()

   Everything around that line reaches into one demo's `messages`, `weights`,
   `kinds`, fold record, ledger bands and chat bubbles — which is why moving it
   into the kit would have exported the entanglement rather than the idea. So
   this driver holds no history, no weights and no DOM. It reads the demo's
   history through a getter, decides, calls two endpoints, and hands the result
   back for the demo to apply.

   What it does, in one sentence: fold the oldest end of a conversation into a
   summary, repeatedly, until what is carried is back under the threshold.

   Why repeatedly. A conversation that arrives already 200k tokens long cannot
   be folded in one call — that payload has to fit the summarizer's own window,
   and past roughly 80% of it the endpoint answers 500 rather than a summary.
   So a pass takes as much of the oldest end as fits under `maxPayload`, and the
   next pass folds its summary together with the next stretch. One summary
   always sits at the head of the history: each pass absorbs the previous one
   rather than stacking beside it.

   What it deliberately does NOT do: sectioned parallel folds of a single
   oversized message, and keeping each section's original text so it can be
   reopened later. That is `chat-with-book`'s own subject matter and stays
   there.

   Published as a plain browser global like every other module in the kit, so
   the tests require the same bytes the browser loads.
   ─────────────────────────────────────────────────────────────── */

(function (global) {
  "use strict";

  /** the token count at which compaction fires — a share of the working budget */
  function threshold(budget, ratio) {
    const b = Number.isFinite(budget) ? budget : Infinity;
    const r = Number.isFinite(ratio) ? ratio : 1;
    if (!Number.isFinite(b)) return Infinity;
    return b * r;
  }

  /**
   * The one line from chat-with-book, and the boundary is inclusive: a
   * conversation sitting exactly on the threshold has reached it. Erring the
   * other way means the demo overflows on the turn after the one that filled it.
   */
  function shouldCompact(tokens, budget, ratio) {
    const t = threshold(budget, ratio);
    if (!Number.isFinite(t)) return false;
    return (tokens || 0) >= t;
  }

  /**
   * Plan one compact call over the oldest end of the history.
   *
   * `weights` is the demo's own per-message token estimate, passed in and never
   * stored — that parallel array is exactly the entanglement this file exists to
   * avoid inheriting.
   *
   * Two constraints shape the slice:
   *   · the last `keepLast` messages are never folded, so the visitor keeps the
   *     part of the conversation they are actually reading;
   *   · the slice's own token total stays under `maxPayload`, because that
   *     payload has to fit the summarizer's window as well as the model's.
   *
   * Returns null when there is nothing foldable. A single message larger than
   * `maxPayload` is still taken — a plan that returns nothing would leave the
   * demo stuck — and flagged `oversize` so the caller can say so on screen.
   */
  function planPass({ weights, keepLast, maxPayload }) {
    const w = Array.isArray(weights) ? weights : [];
    const keep = Math.max(0, Math.floor(keepLast || 0));
    const cap = Number.isFinite(maxPayload) && maxPayload > 0 ? maxPayload : Infinity;
    const foldable = w.length - keep;
    if (foldable < 1) return null;

    let cut = 0;
    let tokens = 0;
    for (let i = 0; i < foldable; i++) {
      const next = tokens + Math.max(0, w[i] || 0);
      // one message always goes, however large: the alternative is a plan that
      // can never make progress
      if (cut > 0 && next > cap) break;
      tokens = next;
      cut = i + 1;
    }
    if (cut < 1) return null;
    return { cut, tokens, oversize: tokens > cap, remaining: w.length - cut };
  }

  /**
   * Bind the driver to a demo once, then let it decide.
   *
   * Every dependency is either a live reader or a callback, so the driver can be
   * asked its opinion at any time without holding a stale copy of anything:
   *
   *   history()                     → { messages, weights, tokens }
   *   probe(messages)               → { tokens }                  (context/trim)
   *   compact(messages, opts)       → { messages, stats }       (context/compact)
   *   budget() ratio() keepLast() maxPayload()   the thresholds, read live
   *   onHistory(messages, stats, meta)  the demo swaps its history and redraws
   *   onCharge(stats, meta)             the demo bills the summarizer to the meter
   *   onPass(meta)                      optional narration, before the call goes out
   *
   * The contract with the demo is one sentence: by the time `onHistory` returns,
   * `history()` must answer with what was just handed to it. The driver re-reads
   * it before every pass rather than keeping its own copy.
   */
  function createCompactor(deps) {
    const d = deps || {};
    const read = (fn, fallback) => (typeof fn === "function" ? fn() : fallback);
    // A ceiling on one run, not a tuning knob: without it a history whose
    // summary is as large as the stretch it replaced would fold forever.
    const maxPasses = Number.isFinite(d.maxPasses) ? d.maxPasses : 8;

    let inFlight = null;
    let folds = 0;

    function budget() { return read(d.budget, Infinity); }
    function ratio() { return read(d.ratio, 1); }
    function keepLast() { return read(d.keepLast, 6); }
    function maxPayload() { return read(d.maxPayload, Infinity); }

    function state() {
      const h = d.history() || {};
      return {
        messages: h.messages || [],
        weights: h.weights || [],
        tokens: Number.isFinite(h.tokens) ? h.tokens : 0,
      };
    }

    /** is the conversation over the line right now? */
    function needed() {
      return shouldCompact(state().tokens, budget(), ratio());
    }

    /** what the next pass would take, without taking it */
    function plan() {
      const s = state();
      return planPass({ weights: s.weights, keepLast: keepLast(), maxPayload: maxPayload() });
    }

    async function pass(index) {
      const s = state();
      const p = planPass({ weights: s.weights, keepLast: keepLast(), maxPayload: maxPayload() });
      if (!p) return null;

      const meta = {
        pass: index,
        folding: p.cut,
        remaining: p.remaining,
        payloadTokens: p.tokens,
        oversize: p.oversize,
        tokensBefore: s.tokens,
      };
      if (typeof d.onPass === "function") d.onPass(meta);

      // keepLastMessages: 0 — the tail is protected by the slice itself, so the
      // endpoint is asked for a summary and nothing else. Its messages[0] is it.
      const out = await d.compact(s.messages.slice(0, p.cut), { keepLastMessages: 0 });
      const summary = (out && out.messages && out.messages[0]) || null;
      if (!summary) throw new Error("context/compact returned no summary message");

      const next = [summary].concat(s.messages.slice(p.cut));
      if (typeof d.onCharge === "function") d.onCharge(out.stats, meta);

      // The honest count of what is now carried comes from the endpoint that
      // counts, not from arithmetic on estimates. context/trim runs no model, so
      // this costs nothing on either side of the meter.
      const probed = await d.probe(next);
      const tokens = (probed && Number.isFinite(probed.tokens)) ? probed.tokens : s.tokens;
      folds += 1;

      const done = Object.assign({}, meta, {
        tokensAfter: tokens,
        reclaimed: Math.max(0, s.tokens - tokens),
        fold: folds,
      });
      d.onHistory(next, out.stats, done);
      return done;
    }

    /**
     * `force` is the difference between the visitor pressing a button and the
     * loop noticing on its own: a forced run always folds once, an automatic one
     * only folds when the threshold has been reached.
     */
    async function run(opts) {
      const o = opts || {};
      if (inFlight) return inFlight;
      const limit = Number.isFinite(o.maxPasses) ? o.maxPasses : maxPasses;
      const tokensBefore = state().tokens;

      inFlight = (async () => {
        const passes = [];
        let stalled = false;
        for (let i = 0; i < limit; i++) {
          const forced = o.force && i === 0;
          if (!forced && !needed()) break;
          const result = await pass(i + 1);
          if (!result) break;
          passes.push(result);
          // A pass that reclaimed nothing is a pass that will reclaim nothing
          // next time either: the plan is folding a summary back into itself, or
          // the summarizer is writing as much as it is replacing. Either way,
          // stop and let the demo say the conversation is still over — churning
          // through the pass limit would spend real money for no room.
          if (result.reclaimed <= 0) { stalled = true; break; }
        }
        const tokensAfter = state().tokens;
        return {
          passes: passes.length,
          detail: passes,
          tokensBefore,
          tokensAfter,
          reclaimed: Math.max(0, tokensBefore - tokensAfter),
          stillOver: needed(),
          stalled,
        };
      })();

      try {
        return await inFlight;
      } finally {
        inFlight = null;
      }
    }

    return {
      /** the visitor asked, or the arrival did: fold once, then while still over */
      now(opts) { return run(Object.assign({ force: true }, opts)); },
      /** after every answer, without being asked: fold only if the line was crossed */
      afterTurn(opts) { return run(Object.assign({ force: false }, opts)); },
      needed,
      plan,
      threshold() { return threshold(budget(), ratio()); },
      get folds() { return folds; },
      get busy() { return !!inFlight; },
    };
  }

  global.DemoCompactor = { threshold, shouldCompact, planPass, createCompactor };
})(window);

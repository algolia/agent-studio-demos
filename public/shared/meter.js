/* ───────────────────────────────────────────────────────────────
   meter.js — the cost strip, shared by every demo on this site.

   The question colleagues actually ask about these demos is "how many tokens,
   and how much money, does context management save?" — so the answer is on
   screen, live, and accounted for in the direction least flattering to the
   demo.

   Two running totals, priced on the same per-model rates:

     NAIVE  what the same conversation would have cost with no context APIs at
            all: the full original document plus the entire unsummarized history
            re-sent on every turn, with the answer charged at the size it really
            came back. This is the counterfactual, so it never pays for a
            summarizer call — there are none in that world.
     REAL   what was actually spent. Every /completions payload, AND every
            /context/compact call the folds, refolds, rebuilt digests and
            agent-driven unfolds needed. The summarizer is not free and this
            meter does not pretend it is: put its bill on the other side and a
            fold "saves" money it never saved.

   ── The two modes ──────────────────────────────────────────────────
   Subtracting is only honest while both runs are possible.

     FEASIBLE    the largest single naive payload still fits the model's real
                 window. Naive − real = saved, and the difference is allowed to
                 be negative: on the first turn after a fold the summarizer has
                 been billed and nothing has benefited from it yet, which is
                 true and worth showing rather than hiding.
     IMPOSSIBLE  the largest single naive payload is bigger than the window. The
                 provider would refuse that request, so there is no naive run to
                 be cheaper than, and a dollar delta against it means nothing —
                 "$0.0071 saved" is a smaller claim than "this conversation
                 cannot happen without the fold". So the subtraction stops and
                 the third tile says what was unlocked instead.

   The boundary belongs to the feasible side: a payload exactly the size of the
   window fits.

   `meterView` is pure — a cost object and a context in, a view model out, no
   DOM and no clock. That is what makes both modes testable in node:test, and
   the renderer below is the only part that touches the page.

   Loaded as a plain script like every other shared module here: no build step,
   and tests require this file unchanged.
   ─────────────────────────────────────────────────────────────── */

(function (global) {
  "use strict";

  /**
   * Published list prices, per million tokens. Deliberately here and not in
   * config.js: config.js carries credentials and environment, and a price list
   * is neither. Every entry states where its number came from, and the one
   * number with no public source says so in those words.
   */
  const PRICING = {
    "claude-haiku-4-5": {
      label: "claude-haiku-4.5", inPerMTok: 1.00, outPerMTok: 5.00,
      source: "Anthropic published list price for claude-haiku-4.5\u00a0— $1.00 input / $5.00 output " +
        "per million tokens.",
    },
    "gpt-4.1-mini": {
      label: "gpt-4.1-mini", inPerMTok: 0.40, outPerMTok: 1.60,
      source: "OpenAI published list price for gpt-4.1-mini\u00a0— $0.40 input / $1.60 output per " +
        "million tokens.",
    },
    "gpt-4.1-nano": {
      label: "gpt-4.1-nano", inPerMTok: 0.10, outPerMTok: 0.40,
      source: "OpenAI published list price for gpt-4.1-nano\u00a0— $0.10 input / $0.40 output per " +
        "million tokens.",
    },
    "small": {
      label: "Enablers small", inPerMTok: 0.10, outPerMTok: 0.10, placeholder: true,
      source: "Internal model\u00a0— illustrative pricing. There is no public list price for it, so " +
        "$0.10 / $0.10 per million tokens is a placeholder chosen to keep the arithmetic " +
        "readable, not a quote. Read the ratio, not the absolute figure.",
    },
  };

  const NO_PRICE = {
    label: "unpriced", inPerMTok: 0, outPerMTok: 0, placeholder: true,
    source: "No price is configured for this model, so both sides of the meter are billed at " +
      "zero for it\u00a0— the figures below undercount rather than guess.",
  };

  /** longest matching key wins: config ids are dated, e.g. claude-haiku-4-5-20251001 */
  function priceOf(modelName) {
    const name = String(modelName || "").toLowerCase();
    let best = NO_PRICE, bestLen = -1;
    for (const key of Object.keys(PRICING)) {
      if ((name === key || name.startsWith(key)) && key.length > bestLen) {
        best = PRICING[key];
        bestLen = key.length;
      }
    }
    return best;
  }

  function priceLine(price) {
    const q = price || NO_PRICE;
    return `${q.label}: $${q.inPerMTok.toFixed(2)} in / $${q.outPerMTok.toFixed(2)} out per ` +
      `million tokens${q.placeholder ? " (illustrative)" : ""}. ${q.source}`;
  }

  function freshCost() {
    return {
      realUsd: 0, naiveUsd: 0,
      // billed tokens, input + output, on each side
      realTokens: 0, naiveTokens: 0,
      // the summarizer's share of the real side, broken out for the tooltip
      summUsd: 0, summTokens: 0, summCalls: 0,
      chatCalls: 0, turns: 0,
      // the counterfactual history: what would still be carried if nothing folded
      naiveHistory: 0,
      // largest single naive payload — the number the mode switch turns on
      naivePeak: 0,
    };
  }

  const nf = new Intl.NumberFormat("en-US");
  const fmt = (n) => nf.format(Math.round(n || 0));

  /** 4 decimals under a dollar, 2 above — a demo turn costs fractions of a cent */
  function usd(v) {
    const n = Number.isFinite(v) ? v : 0;
    const a = Math.abs(n);
    return `${n < -1e-12 ? "-" : ""}$${a < 1 ? a.toFixed(4) : a.toFixed(2)}`;
  }

  function signedTokens(n) {
    const r = Math.round(n || 0);
    return `${r < 0 ? "-" : ""}${fmt(Math.abs(r))}\u00a0tok`;
  }

  /** 363k, 1.2M — for the copy where the order of magnitude is the point */
  function shortTokens(n) {
    if (!Number.isFinite(n)) return "∞";
    const a = Math.round(Math.abs(n));
    if (a < 1000) return String(a);
    if (a < 1e6) return `${Math.round(a / 1000)}k`;
    return `${(a / 1e6).toFixed(1)}M`;
  }

  /**
   * Add one call to one side of the ledger. Pure bookkeeping on the cost object
   * it is handed — it neither reads global state nor draws anything, so a caller
   * decides when to re-render.
   */
  function charge(cost, side, inTok, outTok, price) {
    const p = price || NO_PRICE;
    const i = Math.max(inTok, 0), o = Math.max(outTok, 0);
    const value = (i * p.inPerMTok + o * p.outPerMTok) / 1e6;
    if (side === "real") { cost.realUsd += value; cost.realTokens += i + o; }
    else { cost.naiveUsd += value; cost.naiveTokens += i + o; }
    return value;
  }

  /**
   * The whole strip as data. `ctx` carries the model's REAL window (never a
   * demo's working budget), its label, and the price the totals were billed at.
   *
   * The mode is decided before anything else and from one number only — the
   * largest single naive payload against the window — because the state the
   * demo hits first is an oversize document ingested before any question has
   * been asked, where both dollar totals are still zero.
   */
  function meterView(cost, ctx) {
    const c = cost || freshCost();
    const o = ctx || {};
    const win = Number.isFinite(o.modelWindow) ? o.modelWindow : Infinity;
    const modelLabel = o.modelLabel || "this model";
    const price = o.price || NO_PRICE;

    const peak = Math.max(0, c.naivePeak || 0);
    // the boundary belongs to the feasible side: a payload the exact size of the
    // window is one the provider accepts
    const overWindow = peak > win;
    const mode = overWindow ? "impossible" : "feasible";

    const view = {
      mode,
      modelLabel,
      price: { label: price.label, placeholder: !!price.placeholder, line: priceLine(price) },
      naive: {
        usd: c.naiveUsd, usdText: usd(c.naiveUsd),
        tokens: c.naiveTokens, tokensText: signedTokens(c.naiveTokens),
        peak, window: win, overWindow,
        badge: overWindow
          ? `wouldn't even fit ✗ (${shortTokens(peak)}\u00a0tok > ${shortTokens(win)}\u00a0window)`
          : null,
      },
      real: {
        usd: c.realUsd, usdText: usd(c.realUsd),
        tokens: c.realTokens, tokensText: signedTokens(c.realTokens),
        estimated: c.summCalls > 0,
      },
      // the operators are part of the claim: nothing is being subtracted in
      // impossible mode, so nothing on screen says it is
      ops: overWindow ? { minus: "·", equals: "→" } : { minus: "−", equals: "=" },
      counts: {
        turns: c.turns, chatCalls: c.chatCalls, summCalls: c.summCalls,
        summUsd: c.summUsd, summTokens: c.summTokens,
      },
      saved: null,
      unlocked: null,
    };

    if (mode === "feasible") {
      const saved = c.naiveUsd - c.realUsd;
      const behind = saved < -1e-12;
      // a ratio of naive, so it cannot exceed 100% and the track needs no other scale
      const pct = c.naiveUsd > 0 ? (saved / c.naiveUsd) * 100 : 0;
      view.saved = {
        label: "Saved",
        usd: saved, usdText: usd(saved),
        tokens: c.naiveTokens - c.realTokens,
        tokensText: signedTokens(c.naiveTokens - c.realTokens),
        pct, fillPct: Math.max(0, Math.min(100, pct)), behind,
        // a fold with no question after it has a bill but no ratio: say which
        chipText: c.naiveUsd > 0
          ? (behind ? "paying itself back" : `${Math.round(pct)}% of naive`)
          : (c.realUsd > 0 ? "no turn yet" : "—"),
      };
    } else {
      view.unlocked = {
        label: "Unlocked",
        value: `${shortTokens(peak)} on a ${shortTokens(win)}\u00a0window`,
        sub: "naive run: impossible\u00a0— no price to subtract",
        headline: `${fmt(peak)}\u00a0tokens of history riding a ${fmt(win)}-token window\u00a0— a naive ` +
          `run of this conversation is not expensive, it is impossible.`,
      };
    }
    return view;
  }

  /**
   * The tooltip copy, kept beside the model that produces the numbers so a demo
   * cannot show one and explain the other. Each takes a view and returns a
   * sentence; the page's own tooltip engine decides how to display it.
   */
  const tileCopy = {
    eyebrow: "Two prices for the same conversation. **Naive** re-sends the full document and " +
      "history every turn. **Real** is what was actually spent\u00a0— the summarizer's own bill " +
      "included. The third tile is the difference, while a naive run is still possible at all.",

    naive(v) {
      const base = `**${fmt(v.naive.tokens)}\u00a0tokens over ${v.counts.turns} ` +
        `turn${v.counts.turns === 1 ? "" : "s"}**: the whole document plus the whole history, ` +
        `re-sent every turn. No summarizer on this side\u00a0— nothing to summarize with.`;
      const fit = v.naive.overWindow
        ? ` Its largest payload, ${fmt(v.naive.peak)}\u00a0tokens, is past ${v.modelLabel}'s ` +
          `${fmt(v.naive.window)}-token window\u00a0— the provider would refuse it outright.`
        : "";
      return `${base}${fit} ${v.price.line}`;
    },
    naiveFormula: () => "naive = Σ (original document + full history) × $in  +  answer × $out",

    badge(v) {
      return `**${fmt(v.naive.peak)}\u00a0tokens in one payload, against a ${fmt(v.naive.window)}\u00a0` +
        `window.** A naive run would be refused, not billed\u00a0— the price beside this badge is ` +
        `what it would have cost, had it been possible at all.`;
    },

    real(v) {
      const k = v.counts;
      return `**${k.chatCalls} chat call${k.chatCalls === 1 ? "" : "s"} + ${k.summCalls} ` +
        `summarizer call${k.summCalls === 1 ? "" : "s"}** (${usd(k.summUsd)} · ` +
        `${fmt(k.summTokens)}\u00a0tokens of summarizing). The fold bills itself here\u00a0— a saving ` +
        `that hides its own cost never saved anything. Summarizer usage is estimated; the API ` +
        `does not expose it yet. ${v.price.line}`;
    },
    realFormula: () => "real = Σ every /completions payload  +  Σ every /context/compact call",

    /** the third tile, whichever state it is in */
    saved(v) {
      if (v.mode === "impossible") return tileCopy.unlocked(v);
      const s = v.saved;
      if (v.naive.usd <= 0) {
        return `Naive minus real. Nothing asked yet, so nothing to compare\u00a0— load a document, ` +
          `ask a question, and both sides start moving. ${v.price.line}`;
      }
      const head = `**${v.naive.usdText} − ${v.real.usdText} = ${s.usdText}** — ` +
        `${Math.abs(Math.round(s.pct))}% of the naive bill. Same rates on both sides, and the ` +
        `real side carries the summarizer, so this is the honest difference.`;
      const tail = s.behind
        ? ` Negative for now, and that is not a bug: the fold is paid, and the turns it pays ` +
          `for have not happened yet.`
        : ` Paid once; every later turn carries the digest instead of the document.`;
      return `${head}${tail} ${v.price.line}`;
    },
    savedFormula(v) {
      return v.mode === "impossible"
        ? "naive run: refused by the provider   ·   no subtraction is defined"
        : "saved = naive − real   ·   ratio = saved ÷ naive";
    },

    unlocked(v) {
      return `${v.unlocked.headline} There is nothing to subtract: the largest naive payload ` +
        `(${fmt(v.naive.peak)}\u00a0tokens) is past ${v.modelLabel}'s ${fmt(v.naive.window)}-token ` +
        `window, where the provider answers 400, not an invoice. **The fold did not buy a ` +
        `discount here\u00a0— it bought the conversation.** Real spend stays on the tile beside ` +
        `this one, summarizer included. ${v.price.line}`;
    },
  };

  /* ── Rendering the strip ──────────────────────────────────────────
     Everything below touches the DOM; everything above does not. Nothing here
     runs at load — a demo calls createStrip() once its elements exist, which is
     also what lets the tests require this file under Node. ────────── */

  /**
   * A taxi meter, not a slot machine. The value eases to its target over ~600ms
   * so the reader sees it climb, and the digits that actually changed roll into
   * place on the landing — plus, mid-climb, any digit slow enough that a roll
   * reads as a tick rather than a blur. prefers-reduced-motion gets the number
   * and none of it.
   *
   * Digits animate through the Web Animations API rather than a class toggle: no
   * forced reflow per digit, and a re-fired animation replaces the running one
   * instead of needing to be restarted by hand.
   */
  function makeRoller(node, format) {
    let shown = 0, from = 0, target = 0, t0 = 0, raf = null;
    const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const roll = (span) => {
      if (reduced() || !span.animate) return;
      span.animate(
        [{ transform: "translateY(-0.62em)", opacity: 0.12 }, { transform: "none", opacity: 1 }],
        { duration: 240, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
    };

    function paint(v, settle) {
      const chars = Array.from(format(v));
      // a length change (crossing $1, gaining a digit) rebuilds; otherwise the
      // spans are reused so an unchanged digit is never touched
      if (node.children.length !== chars.length) {
        node.textContent = "";
        chars.forEach((ch) => {
          const sp = document.createElement("span");
          sp.className = "dg";
          sp.textContent = ch;
          node.appendChild(sp);
        });
        return;
      }
      for (let i = 0; i < chars.length; i++) {
        const sp = node.children[i];
        if (sp.textContent === chars[i]) continue;
        sp.textContent = chars[i];
        // mid-climb the last three places change every frame; rolling them would
        // restart the animation before it moved and read as a smear
        if (settle || chars.length - i > 3) roll(sp);
      }
    }

    function step(now) {
      const k = Math.min((now - t0) / 600, 1);
      const eased = 1 - Math.pow(1 - k, 3);
      shown = from + (target - from) * eased;
      if (k < 1) {
        paint(shown, false);
        raf = requestAnimationFrame(step);
      } else {
        raf = null;
        shown = target;
        paint(shown, true);
      }
    }

    paint(0, false);
    return {
      set(v) {
        const next = Number.isFinite(v) ? v : 0;
        if (Math.abs(next - target) < 1e-12) return;
        target = next;
        if (reduced()) {
          if (raf !== null) { cancelAnimationFrame(raf); raf = null; }
          shown = next;
          paint(next, true);
          return;
        }
        from = shown;
        t0 = performance.now();
        if (raf === null) raf = requestAnimationFrame(step);
      },
      reset() {
        if (raf !== null) { cancelAnimationFrame(raf); raf = null; }
        shown = from = target = 0;
        paint(0, false);
      },
    };
  }

  /**
   * Bind the strip to its elements once; then hand it a view per turn. `els`
   * names every node the strip writes to — a demo that omits an optional one
   * (the pct chip, say) simply does not get that part drawn.
   */
  function createStrip(els) {
    const rollers = {
      naive: makeRoller(els.naiveUsd, usd),
      real: makeRoller(els.realUsd, usd),
      saved: makeRoller(els.savedUsd, usd),
    };
    const show = (node, on) => { if (node) node.hidden = !on; };
    const text = (node, s) => { if (node) node.textContent = s; };

    function render(view) {
      rollers.naive.set(view.naive.usd);
      rollers.real.set(view.real.usd);

      text(els.naiveTok, view.naive.tokensText);
      text(els.realTok, view.real.tokensText);
      show(els.realEst, view.real.estimated);

      show(els.naiveBadge, view.naive.overWindow);
      if (view.naive.overWindow) text(els.naiveBadge, view.naive.badge);
      text(els.opMinus, view.ops.minus);
      text(els.opEquals, view.ops.equals);

      const impossible = view.mode === "impossible";
      if (els.tileSaved) {
        els.tileSaved.classList.toggle("is-unlocked", impossible);
        els.tileSaved.classList.toggle("is-behind", !impossible && view.saved.behind);
      }
      // the two states of the third tile are two sets of nodes, so neither has
      // to be talked out of the other's formatting
      show(els.savedUsd, !impossible);
      show(els.savedSub, !impossible);
      show(els.unlockedValue, impossible);
      show(els.unlockedSub, impossible);
      show(els.unlockedInfo, impossible);

      if (impossible) {
        text(els.savedLabel, view.unlocked.label);
        text(els.unlockedValue, view.unlocked.value);
        text(els.unlockedSub, view.unlocked.sub);
      } else {
        text(els.savedLabel, view.saved.label);
        rollers.saved.set(view.saved.usd);
        text(els.savedTok, view.saved.tokensText);
        text(els.savedPct, view.saved.chipText);
        if (els.savedFill) els.savedFill.style.width = `${view.saved.fillPct.toFixed(1)}%`;
      }
    }

    function reset() {
      rollers.naive.reset(); rollers.real.reset(); rollers.saved.reset();
    }

    return { render, reset };
  }

  global.DemoMeter = {
    PRICING, NO_PRICE, priceOf, priceLine,
    freshCost, charge, meterView, tileCopy,
    usd, fmt, signedTokens, shortTokens,
    createStrip,
  };
})(window);

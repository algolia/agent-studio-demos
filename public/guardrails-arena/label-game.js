/* ───────────────────────────────────────────────────────────────
   label-game.js → window.GuardrailGame

   The labeling game: one message per card, answered with a key or a tap.

     A  or ←     allowed          U     unsure
     B  or →     blocked, then a reason (1–9), or B again for none
     1–9         blocked, with that reason, in one key
     Z           undo the last answer, from any screen
     ↑ ↓         scroll a long message      ?   all keys (pauses the timer)
     Enter       next round                 Esc  cancel a reason

   A timer runs per card. Fast answers (under 8 s) build a streak, and the
   streak multiplies the points, as in the label game it is ported from.
   Speed is a bonus, never a rule: unsure scores 0 and leaves the streak alone.

   Labels are an append-only event log kept in this tab: a label event sets
   a message, an undo event clears it, so the effective label of a message is
   the last one after its last undo. Nothing is stored or sent.

   The top half is pure (sampling a round, the undo replay, points, labels as
   CSV or as judgement-store NDJSON, you vs models): tests/guardrail-game.test.js
   and tests/guardrails-game.test.js. mount() is the DOM half.
   ─────────────────────────────────────────────────────────────── */

(function (global) {
  "use strict";

  const ROUND = 10;
  const FAST_MS = 8000;

  const rng = (seed) => global.GuardrailStats.rng(seed);
  const isNum = (x) => typeof x === "number" && isFinite(x);

  function shuffle(xs, rand) {
    const a = xs.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /**
   * k cases for one round, the same for the same seed. Half allowed, half
   * blocked (the other side takes the slack when one runs short), at least
   * `hard` hard ones split across both sides, and slices spread out: a slice
   * gets a second pick only once every slice that fits has one. Shuffled.
   * cases: [{ gold, difficulty, slice }]
   */
  function sampleRound(cases, { k = ROUND, seed = 1, hard = 3 } = {}) {
    const rand = rng(seed);
    const pool = shuffle(cases.map((_, i) => i), rand);
    if (cases.length <= k) return pool.map((i) => cases[i]);
    const count = (g) => cases.filter((c) => c.gold === g).length;
    const want = { allowed: Math.ceil(k / 2), blocked: Math.floor(k / 2) };
    for (const [g, o] of [["allowed", "blocked"], ["blocked", "allowed"]]) {
      if (count(g) < want[g]) { want[o] += want[g] - count(g); want[g] = count(g); }
    }
    const have = { allowed: 0, blocked: 0 }, per = {}, used = new Set(), taken = [];
    const fits = (i, cap) => {
      const c = cases[i];
      return !used.has(i) && have[c.gold] < want[c.gold] && (per[c.slice] || 0) < cap;
    };
    const take = (i) => {
      const c = cases[i];
      used.add(i); taken.push(i); have[c.gold]++; per[c.slice] = (per[c.slice] || 0) + 1;
    };
    const side = Math.ceil(hard / 2);
    let h = 0;
    for (const i of pool) {
      if (h >= hard) break;
      const c = cases[i];
      if (c.difficulty === "hard" && fits(i, 1) && have[c.gold] < side) { take(i); h++; }
    }
    for (let cap = 1; taken.length < k && cap <= k + 1; cap++) {
      for (const i of pool) if (taken.length < k && fits(i, cap)) take(i);
    }
    return shuffle(taken, rand).map((i) => cases[i]);
  }

  /**
   * The undo contract. events: [{ id, verdict, category, ms } | { id, undo: true }]
   * → Map id → label, in the order the effective labels were made.
   */
  function replay(events) {
    const m = new Map();
    for (const e of events || []) {
      if (!e || e.id == null) continue;
      m.delete(e.id);
      if (!e.undo) m.set(e.id, e);
    }
    return m;
  }
  const commits = (events) => [...replay(events).values()];
  /** the message the next undo clears: the newest effective label, or null */
  const lastLabeled = (events) => {
    const c = commits(events);
    return c.length ? c[c.length - 1].id : null;
  };

  const mult = (streak) => Math.min(3, 1 + Math.floor(streak / 5) * 0.5);

  /** points from the effective labels in order: 100 per decided answer, +50 under 8 s, × the streak */
  function score(rows, fastMs = FAST_MS) {
    let streak = 0, best = 0, points = 0;
    const out = rows.map((l) => {
      let pts = 0;
      if (l.verdict !== "unsure") {
        const fast = (l.ms || 0) < fastMs;
        streak = fast ? streak + 1 : 0;
        pts = Math.round((100 + (fast ? 50 : 0)) * mult(streak));
      }
      best = Math.max(best, streak);
      points += pts;
      return { ...l, streak, pts };
    });
    return { rows: out, streak, best, points };
  }

  function median(xs) {
    const a = xs.filter(isNum).sort((x, y) => x - y), m = a.length >> 1;
    if (!a.length) return null;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  /**
   * One CSV row per message, in the race's format. Your label wins; an unsure
   * one leaves expected empty and says so in the note; a message you did not
   * label keeps the label its file came with, if any.
   * items: [{ id, text, expected, category, note }]
   */
  function labelRows(items, labels) {
    return items.map((it) => {
      const l = labels.get(it.id), note = it.note || "";
      if (!l) return { message: it.text, expected: it.expected || "", category: it.category || "", note };
      if (l.verdict === "unsure") return { message: it.text, expected: "", category: "", note: note ? `${note}; unsure` : "unsure" };
      return { message: it.text, expected: l.verdict, category: l.verdict === "blocked" ? l.category || "" : "", note };
    });
  }
  const labelsCsv = (items, labels) => global.GuardrailCsv.toCsv(labelRows(items, labels), global.GuardrailCsv.COLUMNS);

  /** what a race can use: labeled rows only; unsure and unlabeled ones are counted, not raced */
  function raceCases(items, labels) {
    let unsure = 0, unlabeled = 0;
    const cases = [];
    labelRows(items, labels).forEach((r, k) => {
      const l = labels.get(items[k].id);
      if (l && l.verdict === "unsure") { unsure++; return; }
      if (r.expected !== "allowed" && r.expected !== "blocked") { unlabeled++; return; }
      cases.push(r);
    });
    return { cases, unsure, unlabeled };
  }

  /**
   * You and each model on the same items. A mark per item: right, wrong,
   * unsure (you only), failed (a call that broke) or pending. Best first.
   * contestants: [{ key, name, rows: [{ index, verdict, ms }] }], index into items
   */
  function versus(items, labels, contestants = []) {
    const mark = (verdict, gold) => (verdict === gold ? "right" : "wrong");
    const rows = [{
      key: "you", name: "You", you: true,
      marks: items.map((it) => {
        const l = labels.get(it.id);
        return !l ? "pending" : l.verdict === "unsure" ? "unsure" : mark(l.verdict, it.gold);
      }),
      times: items.map((it) => (labels.get(it.id) || {}).ms),
    }].concat(contestants.map((c) => {
      const by = new Map();
      for (const r of c.rows || []) if (!by.has(r.index)) by.set(r.index, r);
      return {
        key: c.key, name: c.name, you: false,
        marks: items.map((it, i) => {
          const r = by.get(i);
          return !r ? "pending" : !r.verdict ? "failed" : mark(r.verdict, it.gold);
        }),
        times: items.map((_, i) => (by.get(i) || {}).ms),
      };
    }));
    for (const r of rows) {
      const n = (m) => r.marks.filter((x) => x === m).length;
      Object.assign(r, {
        n: items.length, right: n("right"), wrong: n("wrong"), unsure: n("unsure"),
        failed: n("failed"), pending: n("pending"), p50ms: median(r.times),
      });
      delete r.times;
    }
    const t = (r) => (r.p50ms == null ? Infinity : r.p50ms);
    return rows.sort((a, b) => b.right - a.right || t(a) - t(b));
  }

  /* ── labels for the judgement store: one NDJSON line per effective label ── */

  /** SHA-256 of the exact text as UTF-8, in hex; `subtle` is crypto.subtle in a browser and in Node */
  async function sha256Hex(text, subtle = global.crypto.subtle) {
    const buf = await subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  /** the labeler tag: one short line, "anon" when empty */
  const cleanTag = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, 32) || "anon";

  /**
   * One judgement-store record, pure: the hash is made by the caller. An
   * allowed label is no_violation, a blocked one carries its reason or null,
   * an unsure one is null, as the store files them.
   */
  function judgementLine({ text, sha, verdict, category, ms, at }, { tag, source }) {
    return {
      case_id: `gg-${sha.slice(0, 16)}`,
      text_sha256: sha,
      text,
      verdict,
      category: verdict === "allowed" ? "no_violation" : verdict === "blocked" ? category || null : null,
      latency_ms: Math.max(0, Math.round(ms || 0)),
      created_at: new Date(at).toISOString(),
      labeler_family: "human",
      labeler_model: `guardrails-game:${cleanTag(tag)}`,
      source,
    };
  }

  /**
   * The effective labels as NDJSON, in the order they were made; undone ones
   * leave no line. hash(text) → hex is injected so tests can pin it.
   * items: [{ id, text }]; labels: replay(events); source: "exam" or "csv"
   */
  async function judgementsNdjson(items, labels, { tag, source, hash = sha256Hex, now = Date.now } = {}) {
    const byId = new Map(items.map((it) => [it.id, it]));
    const out = [];
    for (const l of labels.values()) {
      const it = byId.get(l.id);
      if (!it) continue;
      out.push(JSON.stringify(judgementLine({
        text: it.text, sha: await hash(it.text), verdict: l.verdict, category: l.category, ms: l.ms, at: l.at == null ? now() : l.at,
      }, { tag, source })));
    }
    return out.length ? out.join("\n") + "\n" : "";
  }

  /* ── the exam, shared by the Arena and the Game; each page fetches it ── */

  /** the exam as game items: the gold rides along for the reveal, never on screen before it */
  const examItems = (data) => data.cases.map((c, i) => ({
    id: i, text: c.text, gold: c.gold, expected: c.gold, category: c.category, note: c.slice,
    difficulty: c.difficulty, slice: c.slice,
  }));
  /** the exam's reasons, keyed 1 to 6 in the order of the Arena's rules */
  const EXAM_CATS = ["off_topic", "competitor_promotion", "pii_solicitation", "unauthorized_commitment", "jailbreak", "harmful_content"]
    .map((name) => ({ name }));

  /* the one thing the page remembers: your best round, a number. Never a
     label, never a message, never a key; private mode just forgets it */
  const BEST_KEY = "gb-best-round";
  const best = {
    read() {
      try { return parseInt(global.localStorage.getItem(BEST_KEY), 10) || 0; } catch (e) { return 0; }
    },
    save(n) {
      try { if (n > best.read()) global.localStorage.setItem(BEST_KEY, String(n)); } catch (e) { /* private mode */ }
    },
  };

  /* ── the DOM half ──────────────────────────────────────────────── */

  const GLOSS = {
    off_topic: "not a shopping task",
    competitor_promotion: "pushes another brand",
    pii_solicitation: "asks for personal data",
    unauthorized_commitment: "wants a promise off policy",
    jailbreak: "tries to break the rules",
    harmful_content: "harmful diet or body talk",
  };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const human = (s) => String(s || "").replace(/_/g, " ");
  const clip = (s, n = 28) => (String(s || "").length > n ? String(s).slice(0, n - 1) + "…" : String(s || ""));
  const secs = (ms) => (ms == null ? "–" : `${(ms / 1000).toFixed(1)}\u00a0s`);
  const wait = (t) => new Promise((r) => setTimeout(r, t));
  const now = () => performance.now();
  const calm = () => global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /** the round's misses, each with the right answer; an unsure answer counts as a miss */
  function missedHtml(items, labels) {
    const missed = items.filter((it) => { const l = labels.get(it.id); return l && l.verdict !== it.gold; });
    if (!missed.length) return "<p>No misses. Try another round.</p>";
    return `<h3>What you missed (${missed.length})</h3><ol class="gm-miss">${missed.map((it) => {
      const l = labels.get(it.id);
      return `<li><p>${esc(it.text)}</p><span class="lab ${l.verdict === "unsure" ? "sl" : l.verdict}">you: ${l.verdict}</span>` +
        `<span class="lab ${it.gold}">answer: ${it.gold}${it.gold === "blocked" ? ` · ${esc(human(it.category))}` : ""}</span>` +
        `<span class="lab sl">${esc(it.difficulty)} · ${esc(human(it.slice))}</span></li>`;
    }).join("")}</ol>`;
  }

  /** hand the reader a file made in this tab; nothing leaves it */
  function save(name, text, type = "text/csv") {
    const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* one game takes the keyboard at a time: the last one started or touched */
  let active = null;
  if (global.document) {
    global.document.addEventListener("keydown", (e) => { if (active) active._key(e); });
  }

  /**
   * Build a game inside `host`. items: [{ id, text, gold? }]; categories:
   * [{ name, description? }], up to nine, keyed 1–9 in that order.
   * onFinish(game) fires on the end screen, which game.endEl holds for the
   * page to fill; onChange(game) fires after every answer and undo.
   */
  function mount(host, { items, categories = [], round = ROUND, onFinish = () => {}, onChange = () => {} }) {
    const cats = categories.slice(0, 9).map((c, k) => ({
      key: k + 1, name: c.name, gloss: GLOSS[c.name] || clip(c.description),
    }));
    const el = document.createElement("div");
    el.className = "gm";
    el.innerHTML =
      '<div class="gm-hud">' +
        '<div class="gm-prog" data-r="prog" role="progressbar" aria-label="Messages labeled" aria-valuemin="0"><div data-r="bar"></div></div>' +
        '<span class="gm-chip"><b data-r="n"></b></span>' +
        '<span class="gm-chip" title="Fast answers in a row">streak <b data-r="streak">0</b></span>' +
        '<span class="gm-chip gm-score" data-r="scorechip">score <b data-r="score">0</b></span>' +
        '<span class="gm-chip gm-timer" data-r="timerchip"><b data-r="timer">0.0</b>\u00a0s</span>' +
      "</div>" +
      '<div class="gm-play" data-r="play">' +
        '<div class="gm-card" data-r="card" tabindex="-1">' +
          '<div class="gm-meta"><span data-r="no"></span><span>message to the shop</span></div>' +
          '<div class="gm-msg" data-r="msg"></div>' +
          '<div class="gm-stamp" data-r="stamp" aria-hidden="true"></div>' +
        "</div>" +
        '<p class="gm-hint" data-r="hint" aria-live="polite"></p>' +
        '<div class="gm-acts">' +
          '<button type="button" class="gm-act allowed" data-v="allowed">Allow <kbd>A</kbd></button>' +
          '<button type="button" class="gm-act unsure" data-v="unsure">Unsure <kbd>U</kbd></button>' +
          '<button type="button" class="gm-act blocked" data-v="blocked">Block <kbd>B</kbd></button>' +
        "</div>" +
        `<div class="gm-cats" data-r="cats" aria-label="Block with a reason">${cats.map((c) =>
          `<button type="button" class="gm-cat" data-cat="${esc(c.name)}"><kbd>${c.key}</kbd><b>${esc(human(c.name))}</b><small>${esc(c.gloss)}</small></button>`).join("")}</div>` +
      "</div>" +
      '<div class="gm-round" data-r="round" hidden></div>' +
      '<div class="gm-end" data-r="end" hidden></div>' +
      '<div class="gm-help" data-r="help" hidden>' +
        "<h3>Keys</h3><ul>" +
        "<li><kbd>A</kbd> or <kbd>←</kbd> allow</li><li><kbd>U</kbd> unsure</li>" +
        "<li><kbd>B</kbd> or <kbd>→</kbd> block, then pick a reason</li>" +
        `<li><kbd>1</kbd> to <kbd>${Math.max(1, cats.length)}</kbd> block with that reason</li>` +
        "<li><kbd>Z</kbd> undo</li><li><kbd>↑</kbd> <kbd>↓</kbd> scroll a long message</li>" +
        "<li><kbd>Enter</kbd> next round</li><li><kbd>Esc</kbd> cancel a reason</li></ul>" +
        '<p class="note">The timer waits while this is open.</p>' +
        '<button type="button" data-do="help">Close the keys</button>' +
      "</div>" +
      '<div class="gm-foot"><span class="gm-keys"><kbd>Z</kbd> undo <kbd>?</kbd> all keys</span>' +
        '<button type="button" class="gm-undo" data-r="undo">Undo</button>' +
        '<span data-r="status" role="status"></span></div>';
    host.replaceChildren(el);
    const R = {};
    el.querySelectorAll("[data-r]").forEach((n) => { R[n.dataset.r] = n; });
    R.prog.setAttribute("aria-valuemax", String(items.length));

    const S = {
      events: [], view: "idle", picking: false, busy: false, cur: null,
      shownAt: 0, pausedMs: 0, pauseStart: null, help: false, raf: 0, dead: false,
    };
    const elapsed = () => Math.max(0, now() - S.shownAt - S.pausedMs - (S.pauseStart != null ? now() - S.pauseStart : 0));
    const pause = () => { if (S.pauseStart == null) S.pauseStart = now(); };
    const resume = () => { if (S.pauseStart != null) { S.pausedMs += now() - S.pauseStart; S.pauseStart = null; } };
    const nextItem = () => {
      const done = replay(S.events);
      return items.find((it) => !done.has(it.id)) || null;
    };
    const status = (t) => { R.status.textContent = t || ""; };

    function setView(v) {
      S.view = v;
      el.dataset.view = v;
      R.play.hidden = v !== "play";
      R.round.hidden = v !== "round";
      R.end.hidden = v !== "end";
    }

    function hud() {
      const c = commits(S.events), st = score(c);
      R.n.textContent = `${c.length}/${items.length}`;
      R.bar.style.width = `${items.length ? (100 * c.length) / items.length : 0}%`;
      R.prog.setAttribute("aria-valuenow", String(c.length));
      R.streak.textContent = String(st.streak);
      R.score.textContent = st.points.toLocaleString("en-US");
      return st;
    }

    function setPicking(on) {
      S.picking = on;
      R.card.classList.toggle("picking", on);
      R.cats.classList.toggle("picking", on);
      R.hint.textContent = on ? "Pick a reason below, or Block again for none." : "";
    }

    function bump(node) {
      node.classList.remove("bump");
      void node.offsetWidth;
      node.classList.add("bump");
    }

    function showCase() {
      hud();
      const it = nextItem();
      if (!it) return finish();
      S.cur = it;
      setView("play");
      R.card.className = "gm-card";
      void R.card.offsetWidth;
      R.card.classList.add("enter");
      R.msg.textContent = it.text;
      R.msg.scrollTop = 0;
      const p = items.indexOf(it);
      R.no.textContent = items.length > round
        ? `round ${Math.floor(p / round) + 1} · ${p + 1} of ${items.length}`
        : `${p + 1} of ${items.length}`;
      R.stamp.className = "gm-stamp";
      R.stamp.textContent = "";
      setPicking(false);
      S.shownAt = now();
      S.pausedMs = 0;
      S.pauseStart = document.hidden || S.help ? now() : null;
      const f = document.activeElement;
      if (!f || f === document.body || !el.contains(f) || f.closest("[hidden]")) R.card.focus({ preventScroll: true });
      onChange(ctrl);
    }

    async function commit(verdict, category) {
      if (S.busy || S.view !== "play" || !S.cur) return;
      S.busy = true;
      const it = S.cur;
      const rec = { id: it.id, verdict, category: verdict === "blocked" ? category || null : null, ms: Math.round(elapsed()), at: Date.now() };
      S.events.push(rec);
      status("");
      const st = hud(), last = st.rows[st.rows.length - 1];
      bump(R.streak);
      if (last.pts) {
        bump(R.score);
        const pop = document.createElement("span");
        pop.className = "gm-pop";
        pop.textContent = `+${last.pts}${mult(last.streak) > 1 ? ` ×${mult(last.streak)}` : ""}`;
        R.scorechip.appendChild(pop);
        setTimeout(() => pop.remove(), 900);
      }
      R.stamp.textContent = verdict === "blocked" && category ? `blocked · ${human(category)}` : verdict;
      R.stamp.className = `gm-stamp ${verdict} show`;
      setPicking(false);
      if (!calm()) {
        await wait(170);
        R.card.classList.add(`out-${verdict}`);
        await wait(230);
      }
      S.busy = false;
      S.cur = null;
      if (S.dead) return;
      onChange(ctrl);
      if (!nextItem()) return finish();
      const done = commits(S.events).length;
      if (items.length > round && done % round === 0) return roundCard();
      showCase();
    }

    function undo() {
      if (S.busy || S.dead) return;
      const id = lastLabeled(S.events);
      if (id == null) { status("Nothing to undo."); return; }
      S.events.push({ id, undo: true });
      showCase();
      status("Undone.");
    }

    function roundCard() {
      const c = commits(S.events);
      const r = Math.ceil(c.length / round), total = Math.ceil(items.length / round);
      const last = c.slice(-round);
      R.round.innerHTML =
        `<h3>Round ${r} of ${total} done</h3>` +
        `<p class="note">${c.length} of ${items.length} labeled. Median ${secs(median(last.map((x) => x.ms)))} per message.` +
        ` ${last.filter((x) => x.verdict === "unsure").length} unsure.</p>` +
        `<div class="toolbar"><button type="button" class="primary" data-do="next">Start round ${r + 1} <kbd>Enter</kbd></button>` +
        '<button type="button" data-do="finish">Stop here</button></div>';
      setView("round");
      R.round.querySelector("[data-do=next]").focus({ preventScroll: true });
      onChange(ctrl);
    }

    function finish() {
      S.cur = null;
      setPicking(false);
      hud();
      setView("end");
      onFinish(ctrl);
      const f = R.end.querySelector("button");
      if (f) f.focus({ preventScroll: true });
    }

    function toggleHelp(on) {
      S.help = on;
      R.help.hidden = !on;
      if (on) { pause(); R.help.querySelector("button").focus({ preventScroll: true }); } else if (!document.hidden) {
        resume();
        if (S.view === "play") R.card.focus({ preventScroll: true });
      }
    }

    function tick() {
      if (S.dead) return;
      if (S.view === "play" && S.cur) {
        const s = elapsed() / 1000;
        R.timer.textContent = s < 100 ? s.toFixed(1) : String(Math.round(s));
        R.timerchip.classList.toggle("slow", s >= FAST_MS / 1000);
      }
      S.raf = requestAnimationFrame(tick);
    }

    const onVis = () => { if (document.hidden) pause(); else if (!S.help) resume(); };
    document.addEventListener("visibilitychange", onVis);

    function act(v) {
      if (v !== "blocked") return commit(v, null);
      if (S.picking) return commit("blocked", null);
      if (S.view === "play" && !S.busy) setPicking(true);
    }

    el.addEventListener("pointerdown", () => { active = ctrl; });
    el.addEventListener("focusin", () => { active = ctrl; });
    el.addEventListener("click", (ev) => {
      const b = ev.target.closest("button");
      if (!b || !el.contains(b)) return;
      active = ctrl;
      if (b.dataset.v) act(b.dataset.v);
      else if (b.dataset.cat) commit("blocked", b.dataset.cat);
      else if (b.dataset.r === "undo") undo();
      else if (b.dataset.do === "next") showCase();
      else if (b.dataset.do === "finish") finish();
      else if (b.dataset.do === "help") toggleHelp(false);
    });

    function onKey(e) {
      if (S.dead || e.repeat || e.metaKey || e.ctrlKey || e.altKey || S.view === "idle") return;
      if (!el.isConnected || el.closest("[hidden]")) return;
      const t = e.target && e.target.closest ? e.target : null;
      if (t && t.closest("input, select, textarea, [contenteditable]")) return;
      const k = e.key, low = k.toLowerCase();
      // a focused button answers Enter and Space by itself
      if ((k === "Enter" || k === " ") && t && t.closest("button, a, summary")) return;
      if (S.help) {
        if (k === "Escape" || k === "?" || k === "Enter") { e.preventDefault(); toggleHelp(false); }
        return;
      }
      if (k === "?") { e.preventDefault(); return toggleHelp(true); }
      if (low === "z") { e.preventDefault(); return undo(); }
      if (S.view === "round") {
        if (k === "Enter") { e.preventDefault(); showCase(); }
        return;
      }
      if (S.view !== "play" || S.busy) return;
      if (k === "ArrowDown" || k === "ArrowUp") {
        if (R.msg.scrollHeight > R.msg.clientHeight + 2) {
          e.preventDefault();
          R.msg.scrollBy({ top: k === "ArrowDown" ? 80 : -80 });
        }
        return;
      }
      if (/^[1-9]$/.test(k)) {
        const c = cats.find((x) => x.key === Number(k));
        if (c) { e.preventDefault(); commit("blocked", c.name); }
        return;
      }
      if (S.picking) {
        if (k === "Escape") { e.preventDefault(); return setPicking(false); }
        if (low === "b" || k === "ArrowRight" || k === "Enter") { e.preventDefault(); return commit("blocked", null); }
      }
      if (low === "a" || k === "ArrowLeft") { e.preventDefault(); return commit("allowed", null); }
      if (low === "b" || k === "ArrowRight") { e.preventDefault(); return setPicking(true); }
      if (low === "u") { e.preventDefault(); return commit("unsure", null); }
    }

    const ctrl = {
      el, items, endEl: R.end,
      view: () => S.view,
      events: () => S.events.slice(),
      labels: () => replay(S.events),
      commits: () => commits(S.events),
      stats() {
        const c = commits(S.events), st = score(c);
        return {
          labeled: c.length, unsure: c.filter((x) => x.verdict === "unsure").length,
          p50ms: median(c.map((x) => x.ms)), points: st.points, best: st.best,
        };
      },
      status, undo, finish,
      /** start, or carry on from the first unlabeled message */
      start() {
        active = ctrl;
        if (!S.raf) S.raf = requestAnimationFrame(tick);
        showCase();
      },
      destroy() {
        S.dead = true;
        cancelAnimationFrame(S.raf);
        document.removeEventListener("visibilitychange", onVis);
        if (active === ctrl) active = null;
        el.remove();
      },
      _key: onKey,
    };
    return ctrl;
  }

  global.GuardrailGame = {
    ROUND, FAST_MS, GLOSS, sampleRound, replay, commits, lastLabeled, score, median,
    labelRows, labelsCsv, raceCases, versus, best, BEST_KEY, examItems, EXAM_CATS, missedHtml, save, mount,
    sha256Hex, cleanTag, judgementLine, judgementsNdjson,
  };
})(window);

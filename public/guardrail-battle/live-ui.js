/* ───────────────────────────────────────────────────────────────
   live-ui.js — the "Play" tab, on top of live.js, csv.js, stats.js,
   race-charts.js and label-game.js.

   Three steps, one game:
     connect   optional; the keys stay in this closure
     play      ten exam messages in the labeling game; if connected, the
               picked models race the same ten while you play
     label     your CSV, or the exam, labeled in the same game, then
               downloaded or raced in full (leaderboard and charts)
   Everything else (fighters, rules, reruns, cleanup) sits under Advanced.

   The key is read from its input when you connect or race, and kept in
   `creds`, a variable inside this closure. Nothing writes it anywhere else:
   no storage, no URL, no console. "Forget" clears the input and the variable.

   Two kinds of fighter:
     temporary  one agent per picked model, made with the chosen guardrail
                rules, raced, then deleted (also on stop, error or tab close)
     own        agent IDs you pick from your list or paste

   A full race runs its messages once per rerun. "Rerun once more" adds a rerun to the
   same fighters and the same messages, so the stats grow with every click.
   ─────────────────────────────────────────────────────────────── */

(function () {
  "use strict";

  const L = window.GuardrailLive, C = window.GuardrailCsv, S = window.GuardrailStats, G = window.GuardrailCharts;
  const Gm = window.GuardrailGame;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const p1 = (x) => (x == null ? "–" : (x * 100).toFixed(1) + "%");
  const ci = (r) => (r && r.ci ? `${p1(r.ci[0])}–${p1(r.ci[1])}` : "–");
  const ms = (x) => (x == null ? "–" : x >= 10000 ? `${(x / 1000).toFixed(1)}\u00a0s` : `${Math.round(x)}\u00a0ms`);
  const secs = (x) => (x == null ? "–" : `${(x / 1000).toFixed(1)}\u00a0s`);
  const human = (x) => String(x || "").replace(/_/g, " ");
  const f = (...a) => window.fetch(...a);
  const MAX_CALLS = 4000;

  if (!$("#live")) return;

  let creds = null;
  let runCreds = null;
  let heldout = null;
  let uploaded = null;
  let running = null;
  let runData = null;
  let session = null;
  let providers = [];
  let ranked = [];
  let agents = [];
  const picked = new Set();
  const temps = new Set();

  /* ── the exam: the shipped synthetic held-out set, or the reader's CSV ── */

  const heldoutData = async () => {
    if (heldout) return heldout;
    const r = await fetch("data/heldout.json");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (heldout = await r.json());
  };
  const exampleCases = async () => (await heldoutData()).cases
    .map((c) => ({ message: c.text, expected: c.gold, category: c.category, note: c.slice }));
  /** the exam as game items: the gold rides along for the reveal, never on screen before it */
  const examItems = async () => (await heldoutData()).cases.map((c, i) => ({
    id: i, text: c.text, gold: c.gold, expected: c.gold, category: c.category, note: c.slice,
    difficulty: c.difficulty, slice: c.slice,
  }));
  /** the exam's reasons, keyed 1 to 6 in the order of the battle's rules */
  const DEMO_CATS = ["off_topic", "competitor_promotion", "pii_solicitation", "unauthorized_commitment", "jailbreak", "harmful_content"]
    .map((name) => ({ name }));

  function download(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /** half allowed, half blocked where the set allows it, so both error rates get an n */
  function pick(cases, k) {
    const a = cases.filter((c) => c.expected === "allowed"), b = cases.filter((c) => c.expected === "blocked");
    const ka = Math.min(a.length, Math.max(k - b.length, Math.ceil(k / 2)));
    return S.sample(a, ka).concat(S.sample(b, Math.min(b.length, k - ka)));
  }

  const size = () => Math.max(1, Math.min(L.MAX_CASES, parseInt($("#lv-size").value, 10) || 0));
  const reps = () => Math.max(1, Math.min(L.MAX_REPEATS, parseInt($("#lv-reps").value, 10) || 1));

  function preview(cases, errors, total) {
    const head = cases.slice(0, 5).map((c) =>
      `<tr><td>${esc(c.message.slice(0, 160))}${c.message.length > 160 ? "…" : ""}</td>` +
      `<td>${c.expected ? `<span class="lab ${c.expected}">${c.expected}</span>` : '<span class="note">to label</span>'}</td></tr>`).join("");
    const labeled = cases.filter((c) => c.expected).length;
    $("#lb-preview").innerHTML =
      `<p class="note">${cases.length} usable rows of ${total}, ${labeled} with a label. The first five:</p>` +
      (errors.length ? `<ul class="lv-errs">${errors.slice(0, 6).map((e) => `<li>${esc(e)}</li>`).join("")}</ul>` : "") +
      (head ? `<div class="scroll"><table><thead><tr><th>message</th><th>expected</th></tr></thead><tbody>${head}</tbody></table></div>` : "");
  }

  $("#lv-download").addEventListener("click", async () => {
    try {
      download("guardrail-exam-example.csv", C.toCsv(await exampleCases(), C.COLUMNS));
    } catch (e) {
      $("#lb-status").textContent = "Could not load the example set. Reload the page and try again.";
    }
  });

  /* ── keys and connection ───────────────────────────────────────── */

  function readCreds() {
    const appId = $("#lv-app").value.trim(), apiKey = $("#lv-key").value.trim();
    if (!/^[A-Za-z0-9]{6,20}$/.test(appId)) return "Enter your application ID: letters and digits, as on the dashboard.";
    if (!apiKey) return "Enter an API key.";
    creds = { region: $("#lv-region").value, appId, apiKey };
    return null;
  }

  /**
   * Delete every temporary agent at once (a closing tab only lets the first
   * awaited request out). `c` is the run's own copy of the keys, so a mid-run
   * "Forget" still cleans up; with no keys at all, the count is reported left.
   */
  async function dropTemps(c = creds, { keepalive = false } = {}) {
    if (!temps.size) return { gone: 0, left: 0 };
    if (!c) return { gone: 0, left: temps.size };
    const ids = [...temps];
    const ok = await Promise.all(ids.map((id) => L.removeTemp(f, c, id, { keepalive }).catch(() => false)));
    ids.forEach((id, k) => { if (ok[k]) temps.delete(id); });
    return { gone: ok.filter(Boolean).length, left: temps.size };
  }
  const leftText = (r) => (r.left ? ` ${r.left} left over: press “Delete leftovers”.` : "");

  function forget() {
    if (running) running.stop();
    creds = null;
    $("#lv-key").value = "";
    $("#lv-app").value = "";
    $("#lv-conn").textContent = runCreds
      ? "Keys cleared. The race stops, deletes its temporary agents, then drops its copy."
      : "Keys cleared from this tab.";
    updateWho();
  }
  $("#lv-forget").addEventListener("click", forget);
  window.addEventListener("pagehide", (ev) => {
    // a page kept in the back-forward cache may come back mid-race: keep it whole
    if (ev.persisted) return;
    if (temps.size) dropTemps(runCreds || creds, { keepalive: true });
    creds = null;
  });

  /* ── fighters: ranked models, or your own agents ───────────────── */

  const TIER_NAME = { fast: "Fast and cheap: good first picks", strong: "Strong: slower, costlier", other: "Probably not chat models" };
  const keyOf = (r) => `${r.providerId}|${r.model}`;
  const dupes = () => {
    const n = {};
    ranked.forEach((r) => { n[r.model] = (n[r.model] || 0) + 1; });
    return n;
  };
  const modelLabel = (r) => (dupes()[r.model] > 1 ? `${r.model} · ${r.providerName}` : r.model);

  function renderModels() {
    const q = $("#lv-mq").value.trim().toLowerCase();
    const hit = ranked.filter((r) => !q || `${r.model} ${r.providerName}`.toLowerCase().includes(q));
    let tier = "", html = "";
    for (const r of hit) {
      if (r.tier !== tier) { tier = r.tier; html += `<p class="lv-tier">${TIER_NAME[tier]}</p>`; }
      const k = keyOf(r), on = picked.has(k);
      html += `<label class="lv-agent"><input type="checkbox" data-k="${esc(k)}"${on ? " checked" : ""}` +
        `${!on && picked.size >= L.MAX_AGENTS ? " disabled" : ""}><b>${esc(r.model)}</b><span class="cid">${esc(r.providerName)}</span></label>`;
    }
    $("#lv-models").innerHTML = html || `<p class="note">${ranked.length ? "No model matches." : "Connect your app to list its models, ranked for a guardrail."}</p>`;
    $("#lv-count").textContent = ranked.length ? `${picked.size} of ${L.MAX_AGENTS} picked` : "";
    updateWho();
  }

  /* a tick updates the list in place, so keyboard focus stays on the box */
  function syncModels() {
    const full = picked.size >= L.MAX_AGENTS;
    document.querySelectorAll("#lv-models input[data-k]").forEach((b) => {
      b.checked = picked.has(b.dataset.k);
      b.disabled = full && !b.checked;
    });
    $("#lv-count").textContent = `${picked.size} of ${L.MAX_AGENTS} picked`;
    updateWho();
  }

  function fillRules() {
    const sel = $("#lv-rules");
    const keep = sel.value;
    const mine = agents.filter((a) => L.guardrailOn(a) && !String(a.name).startsWith(L.TEMP_PREFIX));
    sel.innerHTML =
      '<optgroup label="This demo"><option value="demo:final">Tuned rules (final)</option><option value="demo:r0">Starting rules (round 0)</option></optgroup>' +
      (mine.length ? `<optgroup label="Copied from my agents">${mine.map((a) =>
        `<option value="agent:${esc(a.id)}">${esc(a.name)}</option>`).join("")}</optgroup>` : "");
    if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
  }

  function renderList() {
    const q = $("#lv-q").value.trim().toLowerCase();
    const ids = new Set(ownIds());
    const hit = agents.filter((a) => !q || [a.name, a.model, a.id].some((s) => String(s || "").toLowerCase().includes(q)));
    $("#lv-list").innerHTML = hit.slice(0, 60).map((a) => {
      const on = L.guardrailOn(a);
      return `<label class="lv-agent"><input type="checkbox" data-id="${esc(a.id)}"${ids.has(a.id) ? " checked" : ""}>` +
        `<b>${esc(a.name)}</b><span class="cid">${esc(a.model || "–")}${a.status === "published" ? "" : " · draft"}</span>` +
        `<span class="badge ${on ? "" : "no"}">guardrail ${on ? "on" : "off"}</span></label>`;
    }).join("") + (hit.length > 60 ? `<p class="note">${hit.length - 60} more. Narrow the search.</p>` : "") +
      (agents.length && !hit.length ? '<p class="note">No agent matches.</p>' : "");
  }

  $("#lv-connect").addEventListener("click", async () => {
    const out = $("#lv-conn");
    const bad = readCreds();
    if (bad) { out.textContent = bad; return; }
    out.textContent = "Reading your agents and providers…";
    try {
      [providers, agents] = await Promise.all([L.providersWithModels(f, creds), L.listAll(f, creds, "/1/agents")]);
      agents.sort((a, b) => L.guardrailOn(b) - L.guardrailOn(a) || String(a.name).localeCompare(String(b.name)));
      ranked = L.rankModels(providers);
      picked.clear();
      L.suggestLineup(ranked, 3).forEach((r) => picked.add(keyOf(r)));
      fillRules();
      renderModels();
      renderList();
      const left = agents.filter((a) => String(a.name).startsWith(L.TEMP_PREFIX)).length;
      const noModels = providers.filter((p) => !p.models.length).length;
      out.textContent = `Connected: ${agents.length} agents, ${ranked.length} models.` +
        (noModels ? ` ${noModels} providers list no models.` : "") +
        (left ? ` ${left} temporary agent${left > 1 ? "s" : ""} left over from an earlier race.` : "");
    } catch (e) {
      out.textContent = e.status === 401 || e.status === 403
        ? "This key cannot read settings. Pick “My own agents” and paste their IDs, or use a key with editSettings."
        : `Could not connect (${e.message}). Check the region and the application ID.`;
    }
  });

  const mode = () => ($("#lv-mode-own").checked ? "own" : "temp");
  const ownIds = () => [...new Set($("#lv-agents").value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];
  function showMode() {
    $("#lv-temp").hidden = mode() !== "temp";
    $("#lv-own").hidden = mode() !== "own";
    if (!running) $("#lv-status").textContent = "";
    updateWho();
  }
  $("#lv-mode-temp").addEventListener("change", showMode);
  $("#lv-mode-own").addEventListener("change", showMode);

  $("#lv-mq").addEventListener("input", renderModels);
  $("#lv-models").addEventListener("change", (ev) => {
    const k = ev.target.dataset && ev.target.dataset.k;
    if (!k) return;
    if (ev.target.checked && picked.size < L.MAX_AGENTS) picked.add(k); else picked.delete(k);
    syncModels();
  });
  $("#lv-suggest").addEventListener("click", () => {
    picked.clear();
    L.suggestLineup(ranked, 4).forEach((r) => picked.add(keyOf(r)));
    renderModels();
  });
  $("#lv-none").addEventListener("click", () => { picked.clear(); renderModels(); });

  $("#lv-q").addEventListener("input", renderList);
  $("#lv-list").addEventListener("change", (ev) => {
    const id = ev.target.dataset && ev.target.dataset.id;
    if (!id) return;
    const ids = ownIds().filter((x) => x !== id);
    if (ev.target.checked) ids.push(id);
    if (ids.length > L.MAX_AGENTS) { ev.target.checked = false; return; }
    $("#lv-agents").value = ids.join("\n");
  });
  $("#lv-agents").addEventListener("input", () => { renderList(); updateWho(); });

  async function chosenRules() {
    const v = $("#lv-rules").value;
    if (v.startsWith("agent:")) {
      const a = agents.find((x) => x.id === v.slice(6));
      if (a && L.guardrailOf(a)) return L.rulesOf(L.guardrailOf(a));
    }
    const id = (await heldoutData()).configs[v === "demo:r0" ? "r0" : "final"];
    if (!runData) {
      const r = await fetch("data/run.json");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      runData = await r.json();
    }
    return L.rulesOf(L.runConfig(runData, id));
  }

  $("#lv-cleanup").addEventListener("click", async () => {
    const out = $("#lv-conn");
    const bad = readCreds();
    if (bad) { out.textContent = bad; return; }
    try {
      const left = await L.findLeftovers(f, creds);
      if (!left.length) { out.textContent = "No leftover temporary agents."; return; }
      const names = left.slice(0, 8).map((a) => a.name).join("\n");
      if (!window.confirm(`Delete these ${left.length} temporary agents?\n\n${names}${left.length > 8 ? "\n…" : ""}`)) return;
      left.forEach((a) => temps.add(a.id));
      const r = await dropTemps();
      out.textContent = `Deleted ${r.gone}.` + (r.left ? ` ${r.left} could not be deleted.` : "");
    } catch (e) {
      out.textContent = `Could not clean up (${e.message}).`;
    }
  });

  /* ── the race ──────────────────────────────────────────────────── */

  function lanes(s) {
    const total = s.cases.length * s.repeats;
    $("#lv-lanes").innerHTML = s.fighters.map((fi, k) => {
      const mine = s.results.filter((r) => r.fighter === fi.key);
      const ok = mine.filter((r) => r.verdict && r.verdict === r.expected).length;
      const bad = mine.filter((r) => r.verdict && r.verdict !== r.expected).length;
      const fail = mine.filter((r) => !r.verdict).length;
      const w = (x) => (100 * x / total).toFixed(2);
      return `<div class="lane"><div class="lane-h"><span class="swatch" style="--c:${G.color(k)}"></span><b>${esc(fi.label)}</b>` +
        `<span class="note">${mine.length}/${total}</span></div>` +
        `<div class="lane-t"><div class="ok" style="width:${w(ok)}%"></div><div class="bad" style="width:${w(bad)}%"></div><div class="fail" style="width:${w(fail)}%"></div></div></div>`;
    }).join("") + '<div class="legend"><span style="--c:var(--ok)">right</span><span style="--c:var(--over)">wrong</span><span style="--c:var(--ink-3)">failed call</span></div>';
  }

  function vsTop(r) {
    if (!r.vsTop) return '<span class="badge">leader</span>';
    const v = r.vsTop, d = v.delta == null ? "–" : `${(v.delta * 100).toFixed(1)}\u00a0pts`;
    const p = v.p < 0.001 ? "p\u00a0<\u00a00.001" : `p\u00a0=\u00a0${v.p.toFixed(3)}`;
    return `${v.p < 0.05 ? "behind" : "tied"} <span class="note">${d} · ${p}</span>`;
  }

  const narrowMq = window.matchMedia("(max-width: 600px)");
  narrowMq.addEventListener("change", () => { if (session && session.results.length && !running) summary(session); });

  function summary(s) {
    G.size(narrowMq.matches);
    const rows = L.summarize(s.fighters.map((x) => x.key), s.results);
    const label = Object.fromEntries(s.fighters.map((x) => [x.key, x.label]));
    const nameOf = (r) => label[r.fighter];
    const multi = s.repeats > 1;
    const body = rows.map((r, k) =>
      `<tr><td class="rhead" data-label="fighter"><span class="swatch" style="--c:${G.color(k)}"></span><b>${k + 1}. ${esc(nameOf(r))}</b></td>` +
      `<td class="num" data-label="balanced accuracy"><b>${p1(r.ba.rate)}</b> <span class="note">${ci(r.ba)}</span></td>` +
      `<td class="num" data-label="over-refusal">${p1(r.overRefusal.rate)} <span class="note">n\u00a0=\u00a0${r.overRefusal.n}</span></td>` +
      `<td class="num" data-label="leak">${p1(r.leak.rate)} <span class="note">n\u00a0=\u00a0${r.leak.n}</span></td>` +
      (multi ? `<td class="num" data-label="verdict flips">${p1(r.flips.rate)} <span class="note">n\u00a0=\u00a0${r.flips.n}</span></td>` : "") +
      `<td class="num" data-label="median time">${ms(r.p50ms)}</td>` +
      `<td class="num" data-label="vs no. 1">${vsTop(r)}</td>` +
      `<td class="num" data-label="failed calls">${r.failed}</td></tr>`).join("");
    const errs = [...new Set(s.results.filter((r) => r.error).map((r) => r.error))].slice(0, 4);
    const blocked = s.results.some((r) => r.verdict === "blocked");
    $("#lv-summary").innerHTML =
      `<h3>Leaderboard · ${s.cases.length}\u00a0messages × ${s.repeats} ${s.repeats > 1 ? "reruns" : "run"}</h3>` +
      `<div class="scroll"><table class="reflow"><thead><tr><th>fighter</th><th class="num">balanced accuracy · 95% CI</th>` +
      `<th class="num">over-refusal</th><th class="num">leak</th>${multi ? '<th class="num">verdict flips</th>' : ""}` +
      `<th class="num">median time</th><th class="num">vs no. 1</th><th class="num">failed calls</th></tr></thead><tbody>${body}</tbody></table></div>` +
      '<p class="note">“Tied” means the race cannot tell it from no.&nbsp;1 yet (paired McNemar test, p&nbsp;≥&nbsp;0.05). More messages or reruns can split them.</p>' +
      (errs.length ? `<p class="err">Failed calls: ${errs.map(esc).join(" · ")}</p>` : "") +
      (s.results.length && !blocked ? '<p class="err">Nothing was blocked. Check that the guardrail is on for these agents.</p>' : "") +
      '<div class="grid2 lv-charts">' +
      `<div class="card"><h3>Balanced accuracy</h3>${G.accuracy(rows, nameOf)}` +
      `<p class="note">Bar and big dot: all runs. Line: 95% interval. ${multi ? "Small dots: one rerun each." : "Rerun to see the spread."}</p></div>` +
      `<div class="card"><h3>What each one gets wrong</h3>${G.tradeoff(rows, nameOf)}` +
      '<p class="note">Closer to the bottom-left corner is better. Numbers match the leaderboard.</p></div>' +
      `<div class="card wide"><h3>Time to a verdict</h3>${G.speed(rows, nameOf)}` +
      '<p class="note">Bar: median. Tick: 90th percentile. An allowed message waits for the full answer.</p></div></div>';
  }

  function setBusy(on) {
    $("#lv-more").disabled = on || !session;
    $("#lv-stop").disabled = !on;
    $("#lv-export").disabled = on || !(session && session.results.length);
    $("#lb-race").disabled = on;
  }

  /* where a race reports: the full race paints lanes and the leaderboard; a
     round's race only feeds the game's reveal */
  const fullView = {
    status: (t) => { $("#lv-race").hidden = false; $("#lv-status").textContent = t; },
    lanes: (s) => lanes(s),
    done: (s) => { if (s.results.length) summary(s); },
  };

  /** race `count` more reruns of the session; temporary agents live only for this call */
  async function raceMore(s, count, view = fullView) {
    // the run keeps its own copy of the keys, so "Forget" mid-run cannot strand temporary agents
    runCreds = creds;
    setBusy(true);
    const ids = {};
    let tail = "", stopped = false;
    try {
      if (s.temp) {
        for (const fi of s.fighters) {
          if (!creds) throw new Error("keys cleared");
          view.status(`Making a temporary agent for ${fi.label}…`);
          try {
            const t = await L.createTemp(f, runCreds, { providerId: fi.providerId, model: fi.model, rules: s.rules });
            temps.add(t.id);
            ids[fi.key] = t.id;
          } catch (e) {
            if (e.id) temps.add(e.id);
            throw e;
          }
        }
      } else {
        s.fighters.forEach((fi) => { ids[fi.key] = fi.key; });
      }
      const byId = Object.fromEntries(Object.entries(ids).map(([k, id]) => [id, k]));
      const first = s.repeats;
      s.repeats += count;
      view.lanes(s);
      for (let rep = first; rep < first + count && !stopped; rep++) {
        view.status(`Racing${s.repeats > 1 ? `, rerun ${rep + 1} of ${s.repeats}` : ""}…`);
        let painted = 0;
        running = L.race({
          fetchImpl: f, creds: runCreds, agents: Object.values(ids), cases: s.cases, repeat: rep,
          inFlight: s.fighters.length > 5 ? 2 : L.IN_FLIGHT,
          onResult: (r) => {
            s.results.push({ ...r, fighter: byId[r.agentId] });
            if (Date.now() - painted > 120) { painted = Date.now(); view.lanes(s); }
          },
        });
        const stop = running.stop;
        running.stop = () => { stopped = true; stop(); };
        await running.done;
      }
      s.repeats = Math.max(...s.results.map((r) => r.repeat + 1), first);
      view.lanes(s);
      view.done(s);
    } catch (e) {
      tail = ` Stopped: ${e.message}.`;
    } finally {
      running = null;
      if (s.temp) {
        const r = await dropTemps(runCreds);
        tail += ` Deleted ${r.gone} temporary agents.${leftText(r)}`;
      }
      runCreds = null;
      setBusy(false);
    }
    view.status(`Done: ${s.results.length} answers.${tail}`);
  }

  function confirmText(s, count) {
    const n = s.fighters.length, calls = s.cases.length * n * count;
    return `Send ${calls}\u00a0messages (${s.cases.length} × ${n} fighters × ${count}) to your app?` +
      (s.temp ? ` This makes ${n} temporary agents named ${L.TEMP_PREFIX}… and deletes them after.` : "") +
      " Each allowed message runs a full answer and uses tokens.";
  }

  /** the fighters Advanced describes right now → { temp, fighters } or { err } */
  function fightersNow() {
    const temp = mode() === "temp";
    if (temp) {
      if (!picked.size) return { err: "Connect, then tick at least one model." };
      return {
        temp, fighters: ranked.filter((r) => picked.has(keyOf(r)))
          .map((r) => ({ key: keyOf(r), label: modelLabel(r), providerId: r.providerId, model: r.model })),
      };
    }
    const own = ownIds();
    if (!own.length) return { err: "Tick or paste at least one agent ID." };
    if (own.length > L.MAX_AGENTS) return { err: `Pick ${L.MAX_AGENTS} agents at most.` };
    if (!own.every(L.isUuid)) return { err: "One agent ID looks wrong. Copy it from the dashboard." };
    return {
      temp, fighters: own.map((id, k) => {
        const a = agents.find((x) => x.id === id);
        return { key: id, label: a ? a.name : `agent ${k + 1} · ${id.slice(0, 8)}` };
      }),
    };
  }

  /* ── play: one round of ten, you against the guardrail ────────── */

  const freshSeed = () => {
    try { return crypto.getRandomValues(new Uint32Array(1))[0]; } catch (e) { return (Date.now() * 2654435761) >>> 0; }
  };

  let play = null;

  function updateWho() {
    if (play && play.race && play.race.racing) return;
    const fl = creds ? fightersNow() : {};
    $("#pl-who").textContent = fl.fighters
      ? `The models race the same 10: ${fl.fighters.map((x) => x.label).join(", ")}.`
      : "Solo round. Connect your app to see models take the same 10.";
    if (play && !play.race && play.game.view() === "end") reveal();
  }

  const caseOf = (it) => ({ message: it.text, expected: it.gold, category: it.category, note: it.slice });

  /** if keys and fighters are ready, a race on the round's ten, after a yes */
  async function roundRace(items) {
    if (!$("#lv-app").value.trim() || !$("#lv-key").value.trim() || readCreds()) return null;
    if (running) { $("#pl-who").textContent = "A race is running, so this round is solo."; return null; }
    const fl = fightersNow();
    if (!fl.fighters) return null;
    const s = { temp: fl.temp, fighters: fl.fighters, cases: items.map(caseOf), rules: null, results: [], repeats: 0 };
    try {
      if (s.temp) s.rules = await chosenRules();
    } catch (e) { $("#pl-who").textContent = "Could not load the rules, so this round is solo."; return null; }
    if (s.cases.length * s.fighters.length > MAX_CALLS) return null;
    return window.confirm(confirmText(s, 1)) ? s : null;
  }

  async function startRound() {
    if (play && play.race && play.race.racing && running) {
      running.stop();
      await play.racing;
    }
    let items;
    try {
      items = Gm.sampleRound(await examItems(), { k: 10, seed: freshSeed(), hard: 3 });
    } catch (e) { $("#pl-who").textContent = "Could not load the exam. Reload the page and try again."; return; }
    const race = await roundRace(items);
    if (play) play.game.destroy();
    $("#pl-intro").hidden = true;
    const game = Gm.mount($("#pl-game"), { items, categories: DEMO_CATS, onFinish: () => reveal() });
    play = { game, items, race, best: Gm.best.read(), racing: null };
    game.start();
    $("#pl-game").scrollIntoView({ block: "nearest" });
    if (race) play.racing = roundRaceRun(race);
    else updateWho();
  }

  async function roundRaceRun(s) {
    s.racing = true;
    const mine = () => play && play.race === s;
    $("#pl-stop").hidden = false;
    const view = {
      status: (t) => { if (mine()) $("#pl-who").textContent = `Models: ${t}`; },
      lanes: (x) => {
        if (!mine()) return;
        $("#pl-who").textContent = `Models: ${x.results.length} of ${x.cases.length * x.fighters.length} answers.`;
        if (play.game.view() === "end") reveal();
      },
      done: () => {},
    };
    await raceMore(s, 1, view);
    s.racing = false;
    $("#pl-stop").hidden = true;
    if (mine() && play.game.view() === "end") reveal();
  }
  $("#pl-stop").addEventListener("click", () => { if (running && play && play.race && play.race.racing) running.stop(); });

  const markHtml = (r) => `<span class="vs-marks">${r.marks.map((m, i) =>
    `<i class="mk ${m}" title="message ${i + 1}: ${m}"></i>`).join("")}</span>`;

  /** the round's end: your score against the gold, the models on the same ten, what you missed */
  function reveal() {
    if (!play) return;
    const { game, items, race } = play;
    const labels = game.labels();
    const cont = race ? race.fighters.map((fi) => ({
      key: fi.key, name: fi.label, rows: race.results.filter((r) => r.fighter === fi.key && (r.repeat || 0) === 0),
    })) : [];
    const rows = Gm.versus(items, labels, cont);
    const me = rows.find((r) => r.you);
    const st = game.stats();
    if (!me.pending) Gm.best.save(me.right);
    const best = Math.max(play.best, me.right);
    let h = `<p class="gm-big"><b>${me.right}</b> of ${me.n} right</p>` +
      `<p class="note">Median ${secs(me.p50ms)} per message${me.unsure ? `, ${me.unsure} unsure` : ""}. ` +
      `Score ${st.points.toLocaleString("en-US")}. Best round: ${best} of 10. With n\u00a0=\u00a010, one message is 10 points.</p>`;
    if (cont.length) {
      h += "<h3>You vs models, same 10\u00a0messages</h3>" +
        '<div class="scroll"><table class="vs"><thead><tr><th>who</th><th>each message</th><th class="num">right</th><th class="num">median</th></tr></thead><tbody>' +
        rows.map((r) => `<tr${r.you ? ' class="me"' : ""}><td>${esc(r.name)}</td><td>${markHtml(r)}</td>` +
          `<td class="num"><b>${r.right}</b>/${r.n}</td><td class="num">${secs(r.p50ms)}</td></tr>`).join("") +
        "</tbody></table></div>" +
        '<div class="legend vs-legend"><span class="mk right"></span>right <span class="mk wrong"></span>wrong ' +
        '<span class="mk unsure"></span>unsure <span class="mk failed"></span>failed call <span class="mk pending"></span>waiting</div>' +
        (race.racing ? '<p class="note">The models are still racing.</p>' : "");
    } else {
      h += creds && fightersNow().fighters
        ? '<p class="nudge">Connected. Play again and the models take the same 10 as you.</p>'
        : '<p class="nudge">Connect your app above to see models take the same 10.</p>';
    }
    const missed = items.filter((it) => { const l = labels.get(it.id); return l && l.verdict !== it.gold; });
    h += missed.length
      ? `<h3>What you missed (${missed.length})</h3><ol class="gm-miss">${missed.map((it) => {
        const l = labels.get(it.id);
        return `<li><p>${esc(it.text)}</p><span class="lab ${l.verdict === "unsure" ? "sl" : l.verdict}">you: ${l.verdict}</span>` +
          `<span class="lab ${it.gold}">answer: ${it.gold}${it.gold === "blocked" ? ` · ${esc(human(it.category))}` : ""}</span>` +
          `<span class="lab sl">${esc(it.difficulty)} · ${esc(human(it.slice))}</span></li>`;
      }).join("")}</ol>`
      : "<p>No misses. Try another round.</p>";
    h += '<div class="toolbar"><button type="button" class="primary" data-act="again">Play again</button>' +
      '<button type="button" data-r="undo">Undo the last answer</button></div>';
    game.endEl.innerHTML = h;
  }

  $("#pl-start").addEventListener("click", startRound);
  $("#pl-game").addEventListener("click", (ev) => {
    if (ev.target.closest("[data-act=again]")) startRound();
  });

  /* ── label: your CSV or the exam, in the same game ─────────────── */

  let lbItems = null, lbGame = null;
  const lbSay = (t) => { $("#lb-status").textContent = t; };
  const lbLabels = () => (lbGame ? lbGame.labels() : new Map());
  const fromCsv = () => $("#lb-src-csv").checked;

  async function labelItems() {
    if (lbItems) return lbItems;
    if (fromCsv()) {
      if (!uploaded) return null;
      lbItems = uploaded.map((c, i) => ({ id: i, text: c.message, gold: c.expected || null, expected: c.expected, category: c.category, note: c.note }));
    } else {
      lbItems = Gm.sampleRound(await examItems(), { k: size(), seed: 11, hard: 0 });
    }
    return lbItems;
  }

  /** a new source drops the labels made on the old one, after a yes */
  function resetLabels() {
    const n = lbGame ? lbGame.commits().length : 0;
    if (n && !window.confirm(`Drop your ${n} labels?`)) return false;
    if (lbGame) lbGame.destroy();
    lbGame = null;
    lbItems = null;
    lbSay("");
    return true;
  }

  async function labelCats() {
    try { return (await chosenRules()).categories.map((c) => ({ name: c.name, description: c.description })); } catch (e) { return DEMO_CATS; }
  }

  function lbCount() {
    if (!lbGame || !lbItems) return;
    const st = lbGame.stats();
    lbSay(`${st.labeled} of ${lbItems.length} labeled${st.unsure ? `, ${st.unsure} unsure` : ""}.`);
  }

  function lbReveal() {
    const items = lbItems, labels = lbGame.labels(), st = lbGame.stats();
    const sure = items.filter((it) => it.gold && labels.has(it.id) && labels.get(it.id).verdict !== "unsure");
    const agree = sure.filter((it) => labels.get(it.id).verdict === it.gold).length;
    const left = items.length - st.labeled;
    lbCount();
    lbGame.endEl.innerHTML =
      `<p class="gm-big"><b>${st.labeled}</b> of ${items.length} labeled</p>` +
      `<p class="note">Median ${secs(st.p50ms)} per message. ${st.unsure} unsure, left out of a race.</p>` +
      (sure.length ? `<p>You agree with ${fromCsv() ? "the file" : "the exam"} on ${agree} of ${sure.length}.</p>` : "") +
      '<div class="toolbar">' +
      (left ? `<button type="button" class="primary" data-do="next">Label the other ${left}</button>` : "") +
      '<button type="button" data-act="download">Download labels</button>' +
      '<button type="button" data-act="race">Race the models on my labels</button>' +
      '<button type="button" data-r="undo">Undo the last label</button></div>';
  }

  $("#lb-file").addEventListener("change", (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    if (!resetLabels()) { ev.target.value = ""; return; }
    $("#lb-src-csv").checked = true;
    if (file.size > 2 * 1024 * 1024) {
      uploaded = null;
      $("#lb-preview").innerHTML = '<p class="err">That file is over 2&nbsp;MB. Split it, or keep the first 200 rows.</p>';
      return;
    }
    const rd = new FileReader();
    rd.onload = () => {
      const v = C.validate(C.parse(rd.result), { expectedOptional: true });
      uploaded = v.cases.length ? v.cases : null;
      lbItems = null;
      preview(v.cases, v.errors, v.total);
    };
    rd.readAsText(file);
  });
  for (const id of ["#lb-src-ex", "#lb-src-csv"]) {
    $(id).addEventListener("change", () => {
      if (!resetLabels()) { (fromCsv() ? $("#lb-src-ex") : $("#lb-src-csv")).checked = true; return; }
      $("#lb-preview").innerHTML = "";
      if (fromCsv() && uploaded) preview(uploaded, [], uploaded.length);
    });
  }
  $("#lv-size").addEventListener("change", () => {
    if (!fromCsv() && !(lbGame && lbGame.commits().length)) { if (lbGame) lbGame.destroy(); lbGame = null; lbItems = null; }
  });

  async function startLabels() {
    let items;
    try { items = await labelItems(); } catch (e) { lbSay("Could not load the exam. Reload the page and try again."); return; }
    if (!items || !items.length) { lbSay("Load a CSV with a message column first."); return; }
    if (!lbGame) lbGame = Gm.mount($("#lb-game"), { items, categories: await labelCats(), onFinish: lbReveal, onChange: lbCount });
    lbGame.start();
    $("#lb-game").scrollIntoView({ block: "nearest" });
  }

  async function downloadLabels() {
    let items;
    try { items = await labelItems(); } catch (e) { items = null; }
    if (!items) { lbSay("Load a CSV with a message column first."); return; }
    download("guardrail-labels.csv", Gm.labelsCsv(items, lbLabels()));
  }

  /** the full race, with your labels as the gold; unsure and unlabeled rows sit out, counted */
  async function raceLabels() {
    if (running) return;
    let items;
    try { items = await labelItems(); } catch (e) { items = null; }
    if (!items) { lbSay("Load a CSV with a message column first."); return; }
    const rc = Gm.raceCases(items, lbLabels());
    const out = [rc.unsure && `${rc.unsure} unsure`, rc.unlabeled && `${rc.unlabeled} not labeled`].filter(Boolean).join(", ");
    const sitOut = out ? ` Left out: ${out}.` : "";
    if (!rc.cases.length) { lbSay(`Nothing labeled to race yet.${sitOut}`); return; }
    const bad = readCreds();
    if (bad) { lbSay(`Connect your app first. ${bad}`); return; }
    const fl = fightersNow();
    if (fl.err) { lbSay(fl.err); return; }
    const cases = pick(rc.cases, size());
    let rules = null;
    try {
      if (fl.temp) rules = await chosenRules();
    } catch (e) { lbSay("Could not load the rules. Reload the page and try again."); return; }
    const s = { temp: fl.temp, fighters: fl.fighters, cases, rules, results: [], repeats: 0 };
    const count = reps();
    if (cases.length * fl.fighters.length * count > MAX_CALLS) {
      lbSay(`That is over ${MAX_CALLS}\u00a0messages. Use fewer messages, fighters or reruns.`);
      return;
    }
    if (!window.confirm(confirmText(s, count))) return;
    lbSay(`Racing ${cases.length} of your labels.${sitOut}`);
    session = s;
    $("#lv-summary").innerHTML = "";
    $("#lv-lanes").innerHTML = "";
    $("#lv-race").hidden = false;
    $("#lv-race").scrollIntoView({ block: "nearest" });
    await raceMore(s, count);
  }

  $("#lb-start").addEventListener("click", startLabels);
  $("#lb-download").addEventListener("click", downloadLabels);
  $("#lb-race").addEventListener("click", raceLabels);
  $("#lb-game").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-act]");
    if (b && b.dataset.act === "download") downloadLabels();
    if (b && b.dataset.act === "race") raceLabels();
  });

  /* ── Advanced: more reruns, results, stop ──────────────────────── */

  $("#lv-more").addEventListener("click", async () => {
    if (running || !session) return;
    const bad = readCreds();
    if (bad) { fullView.status(bad); return; }
    if (!window.confirm(confirmText(session, 1))) return;
    await raceMore(session, 1);
  });

  $("#lv-stop").addEventListener("click", () => { if (running) running.stop(); });

  $("#lv-export").addEventListener("click", () => {
    if (!session) return;
    const keys = session.fighters.map((x) => x.key);
    const labels = Object.fromEntries(session.fighters.map((x) => [x.key, x.label]));
    download("guardrail-race-results.csv", L.resultsCsv(session.cases, keys, session.results, labels));
  });

  showMode();
  renderModels();
  setBusy(false);
  updateWho();
})();

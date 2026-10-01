/* ───────────────────────────────────────────────────────────────
   live-ui.js — the "Your agents" tab, on top of live.js, csv.js, stats.js.

   The key is read from its input when you connect or race, and kept in
   `creds`, a variable inside this closure. Nothing writes it anywhere else:
   no storage, no URL, no console. "Forget" clears the input and the variable.

   Two kinds of fighter:
     temporary  one agent per picked model, made with the chosen guardrail
                rules, raced, then deleted (also on stop, error or tab close)
     own        agent IDs you pick from your list or paste
   ─────────────────────────────────────────────────────────────── */

(function () {
  "use strict";

  const L = window.GuardrailLive, C = window.GuardrailCsv, S = window.GuardrailStats;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const p1 = (x) => (x == null ? "–" : (x * 100).toFixed(1) + "%");
  const ci = (r) => (r && r.ci ? `${p1(r.ci[0])}–${p1(r.ci[1])}` : "–");
  const f = (...a) => window.fetch(...a);

  if (!$("#live")) return;

  let creds = null;
  let heldout = null;
  let uploaded = null;
  let running = null;
  let last = null;
  let providers = [];
  let agents = [];
  let picked = [];
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

  async function chosenCases() {
    if ($("#lv-src-csv").checked) return uploaded ? pick(uploaded, size()) : [];
    return pick(await exampleCases(), size());
  }

  function preview(cases, errors, total) {
    const head = cases.slice(0, 5).map((c) =>
      `<tr><td>${esc(c.message.slice(0, 160))}${c.message.length > 160 ? "…" : ""}</td><td><span class="lab ${c.expected}">${c.expected}</span></td></tr>`).join("");
    $("#lv-preview").innerHTML =
      `<p class="note">${cases.length} usable rows of ${total}. Below: the first five, read in this tab only.</p>` +
      (errors.length ? `<ul class="lv-errs">${errors.slice(0, 6).map((e) => `<li>${esc(e)}</li>`).join("")}</ul>` : "") +
      (head ? `<div class="scroll"><table><thead><tr><th>message</th><th>expected</th></tr></thead><tbody>${head}</tbody></table></div>` : "");
  }

  $("#lv-download").addEventListener("click", async () => {
    try {
      download("guardrail-exam-example.csv", C.toCsv(await exampleCases(), C.COLUMNS));
    } catch (e) {
      $("#lv-status").textContent = "Could not load the example set.";
    }
  });

  $("#lv-file").addEventListener("change", (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    $("#lv-src-csv").checked = true;
    if (file.size > 2 * 1024 * 1024) {
      uploaded = null;
      $("#lv-preview").innerHTML = '<p class="err">That file is over 2&nbsp;MB.</p>';
      return;
    }
    const rd = new FileReader();
    rd.onload = () => {
      const v = C.validate(C.parse(rd.result));
      uploaded = v.cases.length ? v.cases : null;
      preview(v.cases, v.errors, v.total);
    };
    rd.readAsText(file);
  });

  /* ── keys and connection ───────────────────────────────────────── */

  function readCreds() {
    const appId = $("#lv-app").value.trim(), apiKey = $("#lv-key").value.trim();
    if (!/^[A-Za-z0-9]{6,20}$/.test(appId)) return "Enter your application ID.";
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
  const leftText = (r) => (r.left ? ` ${r.left} left: use Clean up.` : "");

  let runCreds = null;
  function forget() {
    if (running) running.stop();
    creds = null;
    $("#lv-key").value = "";
    $("#lv-app").value = "";
    $("#lv-conn").textContent = runCreds
      ? "Keys cleared. The run stops, deletes its temporary agents, then drops its copy."
      : "Keys cleared from this tab.";
  }
  $("#lv-forget").addEventListener("click", forget);
  window.addEventListener("pagehide", (ev) => {
    // a page kept in the back-forward cache may come back mid-race: keep it whole
    if (ev.persisted) return;
    if (temps.size) dropTemps(runCreds || creds, { keepalive: true });
    creds = null;
  });

  function fillModels() {
    const sel = $("#lv-model");
    const groups = providers.filter((p) => p.models.length).map((p) =>
      `<optgroup label="${esc(p.name)} · ${esc(p.providerName)}">` +
      p.models.map((m) => `<option value="${esc(p.id)}|${esc(m)}">${esc(m)}</option>`).join("") + "</optgroup>").join("");
    sel.innerHTML = groups || '<option value="">No provider with models</option>';
  }

  function fillRules() {
    const sel = $("#lv-rules");
    const keep = sel.value;
    const mine = agents.filter((a) => L.guardrailOn(a) && !String(a.name).startsWith(L.TEMP_PREFIX));
    sel.innerHTML =
      '<optgroup label="This demo"><option value="demo:final">Battle, final config</option><option value="demo:r0">Battle, starting config</option></optgroup>' +
      (mine.length ? `<optgroup label="From my agents">${mine.map((a) =>
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
      fillModels();
      fillRules();
      renderList();
      const left = agents.filter((a) => String(a.name).startsWith(L.TEMP_PREFIX)).length;
      out.textContent = `${agents.length} agents · ${providers.length} providers` +
        (left ? ` · ${left} leftover temporary agents` : "");
    } catch (e) {
      out.textContent = e.status === 401 || e.status === 403
        ? "This key cannot read settings. Use your own agent IDs, or a key with editSettings."
        : `Could not connect: ${e.message}`;
    }
  });

  /* ── fighters ──────────────────────────────────────────────────── */

  const mode = () => ($("#lv-mode-own").checked ? "own" : "temp");
  const ownIds = () => [...new Set($("#lv-agents").value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];
  function showMode() {
    $("#lv-temp").hidden = mode() !== "temp";
    $("#lv-own").hidden = mode() !== "own";
    if (!running) $("#lv-status").textContent = "";
  }
  $("#lv-mode-temp").addEventListener("change", showMode);
  $("#lv-mode-own").addEventListener("change", showMode);

  function renderPicked() {
    $("#lv-picked").innerHTML = picked.map((p, k) =>
      `<span class="chip">${esc(p.model)} <span class="cid">${esc(p.providerName)}</span>` +
      `<button type="button" data-k="${k}" aria-label="Remove ${esc(p.model)}">×</button></span>`).join("") ||
      '<span class="note">No model picked yet.</span>';
  }
  $("#lv-add").addEventListener("click", () => {
    const v = $("#lv-model").value;
    if (!v) return;
    const [providerId, model] = v.split("|");
    if (picked.length >= L.MAX_AGENTS || picked.some((p) => p.providerId === providerId && p.model === model)) return;
    const prov = providers.find((p) => p.id === providerId);
    picked.push({ providerId, model, providerName: prov ? prov.name : "" });
    renderPicked();
  });
  $("#lv-picked").addEventListener("click", (ev) => {
    const k = ev.target.dataset && ev.target.dataset.k;
    if (k == null) return;
    picked.splice(+k, 1);
    renderPicked();
  });

  $("#lv-q").addEventListener("input", renderList);
  $("#lv-list").addEventListener("change", (ev) => {
    const id = ev.target.dataset && ev.target.dataset.id;
    if (!id) return;
    const ids = ownIds().filter((x) => x !== id);
    if (ev.target.checked) ids.push(id);
    if (ids.length > L.MAX_AGENTS) { ev.target.checked = false; return; }
    $("#lv-agents").value = ids.join("\n");
  });
  $("#lv-agents").addEventListener("input", renderList);

  async function chosenRules() {
    const v = $("#lv-rules").value;
    if (v.startsWith("agent:")) {
      const a = agents.find((x) => x.id === v.slice(6));
      if (a && L.guardrailOf(a)) return L.rulesOf(L.guardrailOf(a));
    }
    const id = (await heldoutData()).configs[v === "demo:r0" ? "r0" : "final"];
    const r = await fetch("data/run.json");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return L.rulesOf(L.runConfig(await r.json(), id));
  }

  $("#lv-cleanup").addEventListener("click", async () => {
    const out = $("#lv-conn");
    const bad = readCreds();
    if (bad) { out.textContent = bad; return; }
    try {
      const left = await L.findLeftovers(f, creds);
      if (!left.length) { out.textContent = "No leftover temporary agents."; return; }
      const names = left.slice(0, 8).map((a) => a.name).join("\n");
      if (!window.confirm(`Delete these ${left.length} agents?\n\n${names}${left.length > 8 ? "\n…" : ""}`)) return;
      left.forEach((a) => temps.add(a.id));
      const r = await dropTemps();
      out.textContent = `Deleted ${r.gone}.` + (r.left ? ` ${r.left} could not be deleted.` : "");
    } catch (e) {
      out.textContent = `Could not clean up: ${e.message}`;
    }
  });

  /* ── the race ──────────────────────────────────────────────────── */

  const nameOf = (labels, id, k) => labels[id] || `agent ${k + 1}`;

  function lanes(ids, labels, total, results) {
    $("#lv-lanes").innerHTML = ids.map((id, k) => {
      const mine = results.filter((r) => r.agentId === id);
      const ok = mine.filter((r) => r.verdict && r.verdict === r.expected).length;
      const bad = mine.filter((r) => r.verdict && r.verdict !== r.expected).length;
      const fail = mine.filter((r) => !r.verdict).length;
      const w = (x) => (100 * x / total).toFixed(2);
      return `<div class="lane"><div class="lane-h"><b>${esc(nameOf(labels, id, k))}</b> <span class="cid">· id ${esc(id.slice(0, 8))}…</span>` +
        `<span class="note">${mine.length}/${total}</span></div>` +
        `<div class="lane-t"><div class="ok" style="width:${w(ok)}%"></div><div class="bad" style="width:${w(bad)}%"></div><div class="fail" style="width:${w(fail)}%"></div></div></div>`;
    }).join("") + '<div class="legend"><span style="--c:var(--ok)">right</span><span style="--c:var(--over)">wrong</span><span style="--c:var(--ink-3)">failed call</span></div>';
  }

  function summary(ids, labels, results) {
    const rows = L.summarize(ids, results).map((s, k) =>
      `<tr><td data-label="agent"><b>${esc(nameOf(labels, s.agentId, k))}</b> <span class="cid">· id ${esc(s.agentId.slice(0, 8))}…</span></td>` +
      `<td class="num" data-label="scored · failed">${s.n} · ${s.failed}</td>` +
      `<td class="num" data-label="balanced acc.">${p1(s.balanced)}</td>` +
      `<td class="num" data-label="over-refusal · 95% CI">${p1(s.overRefusal.rate)} <span class="note">n\u00a0=\u00a0${s.overRefusal.n} · ${ci(s.overRefusal)}</span></td>` +
      `<td class="num" data-label="leak · 95% CI">${p1(s.leak.rate)} <span class="note">n\u00a0=\u00a0${s.leak.n} · ${ci(s.leak)}</span></td>` +
      `<td class="num" data-label="p50 time">${s.p50ms == null ? "–" : Math.round(s.p50ms) + "\u00a0ms"}</td></tr>`).join("");
    const errs = [...new Set(results.filter((r) => r.error).map((r) => r.error))].slice(0, 4);
    $("#lv-summary").innerHTML =
      `<div class="scroll"><table class="reflow"><thead><tr><th>agent</th><th class="num">scored · failed</th><th class="num">balanced acc.</th>` +
      `<th class="num">over-refusal · 95% CI</th><th class="num">leak · 95% CI</th><th class="num">p50 time</th></tr></thead><tbody>${rows}</tbody></table></div>` +
      (errs.length ? `<p class="err">Failed calls: ${errs.map(esc).join(" · ")}</p>` : "") +
      (results.length && results.every((r) => r.verdict !== "blocked")
        ? '<p class="err">No message was blocked. Check that the guardrail is on for these agents.</p>' : "") +
      '<p class="note">Time runs to the verdict: an allowed message waits for the full answer.</p>';
  }

  $("#lv-run").addEventListener("click", async () => {
    if (running) return;
    const status = $("#lv-status");
    const bad = readCreds();
    if (bad) { status.textContent = bad; return; }
    const temp = mode() === "temp";
    if (temp && !picked.length) { status.textContent = "Connect, then add at least one model."; return; }
    const own = temp ? [] : ownIds();
    if (!temp) {
      if (!own.length) { status.textContent = "Pick or paste at least one agent ID."; return; }
      if (own.length > L.MAX_AGENTS) { status.textContent = `${L.MAX_AGENTS} agents at most.`; return; }
      if (!own.every(L.isUuid)) { status.textContent = "An agent ID looks wrong. Copy it from the dashboard."; return; }
    }
    let cases, rules = null;
    try {
      cases = await chosenCases();
      if (temp) rules = await chosenRules();
    } catch (e) { status.textContent = "Could not load the example set."; return; }
    if (!cases.length) { status.textContent = "Pick a CSV with at least one usable row."; return; }
    const n = temp ? picked.length : own.length;
    const ask = `Send ${cases.length * n}\u00a0messages (${cases.length} × ${n}) to your app?` +
      (temp ? ` This makes ${n} temporary agents named ${L.TEMP_PREFIX}… and deletes them after.` : "") +
      " Each allowed message runs a full answer and uses tokens.";
    if (!window.confirm(ask)) return;

    $("#lv-summary").innerHTML = "";
    $("#lv-lanes").innerHTML = "";
    $("#lv-export").disabled = true;
    const labels = {};
    let ids = own;
    // the run keeps its own copy of the keys, so "Forget" mid-run cannot strand temporary agents
    runCreds = creds;
    $("#lv-stop").disabled = false;
    if (temp) {
      ids = [];
      try {
        for (const p of picked) {
          if (!creds) throw new Error("keys cleared");
          status.textContent = `Making a temporary agent for ${p.model}…`;
          const t = await L.createTemp(f, runCreds, { providerId: p.providerId, model: p.model, rules });
          temps.add(t.id);
          ids.push(t.id);
          labels[t.id] = p.model;
        }
      } catch (e) {
        if (e.id) temps.add(e.id);
        const r = await dropTemps(runCreds);
        runCreds = null;
        $("#lv-stop").disabled = true;
        status.textContent = `Could not make the agents (${e.message}). Removed ${r.gone}.${leftText(r)}`;
        return;
      }
    }

    const results = [];
    let tail = "";
    try {
      lanes(ids, labels, cases.length, results);
      status.textContent = "Racing…";
      let painted = 0;
      running = L.race({
        fetchImpl: f, creds: runCreds, agents: ids, cases,
        onResult: (r) => {
          results.push(r);
          if (Date.now() - painted > 120) { painted = Date.now(); lanes(ids, labels, cases.length, results); }
        },
      });
      await running.done;
      lanes(ids, labels, cases.length, results);
      summary(ids, labels, results);
    } finally {
      running = null;
      $("#lv-stop").disabled = true;
      if (temp) {
        const r = await dropTemps(runCreds);
        tail = ` Deleted ${r.gone} temporary agents.${leftText(r)}`;
      }
      runCreds = null;
    }
    last = { cases, ids, labels, results };
    $("#lv-export").disabled = !results.length;
    status.textContent = `Done: ${results.length} answers.${tail}`;
  });

  $("#lv-stop").addEventListener("click", () => { if (running) running.stop(); });

  $("#lv-export").addEventListener("click", () => {
    if (last) download("guardrail-race-results.csv", L.resultsCsv(last.cases, last.ids, last.results, last.labels));
  });

  showMode();
  renderPicked();
})();

/* ───────────────────────────────────────────────────────────────
   live-ui.js — the "Your agents" tab, on top of live.js, csv.js, stats.js.

   The key is read from its input at the moment a run starts and kept in
   `creds`, a variable inside this closure. Nothing writes it anywhere else:
   no storage, no URL, no console. "Forget" clears the input and the variable.
   ─────────────────────────────────────────────────────────────── */

(function () {
  "use strict";

  const L = window.GuardrailLive, C = window.GuardrailCsv, S = window.GuardrailStats;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const p1 = (x) => (x == null ? "–" : (x * 100).toFixed(1) + "%");
  const ci = (r) => (r && r.ci ? `${p1(r.ci[0])}–${p1(r.ci[1])}` : "–");

  if (!$("#live")) return;

  let creds = null;
  let example = null;
  let uploaded = null;
  let running = null;
  let last = null;

  /* ── the exam: the shipped synthetic held-out set, or the reader's CSV ── */

  const exampleCases = () => fetch("data/heldout.json").then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }).then((d) => d.cases.map((c) => ({ message: c.text, expected: c.gold, category: c.category, note: c.slice })));

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

  const source = () => ($("#lv-src-csv").checked ? "csv" : "example");
  const size = () => Math.max(1, Math.min(L.MAX_CASES, parseInt($("#lv-size").value, 10) || 0));

  async function chosenCases() {
    if (source() === "csv") return uploaded ? pick(uploaded, size()) : [];
    example = example || await exampleCases();
    return pick(example, size());
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
      example = example || await exampleCases();
      download("guardrail-exam-example.csv", C.toCsv(example, C.COLUMNS));
    } catch (e) {
      $("#lv-status").textContent = "Could not load the example set.";
    }
  });

  $("#lv-file").addEventListener("change", (ev) => {
    const f = ev.target.files && ev.target.files[0];
    if (!f) return;
    $("#lv-src-csv").checked = true;
    if (f.size > 2 * 1024 * 1024) {
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
    rd.readAsText(f);
  });

  /* ── keys ──────────────────────────────────────────────────────── */

  const agentIds = () => [...new Set($("#lv-agents").value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];

  function readCreds() {
    const appId = $("#lv-app").value.trim(), apiKey = $("#lv-key").value.trim();
    if (!/^[A-Za-z0-9]{6,20}$/.test(appId)) return "Enter your application ID.";
    if (!apiKey) return "Enter an API key.";
    creds = { region: $("#lv-region").value, appId, apiKey };
    return null;
  }

  function forget() {
    if (running) running.stop();
    creds = null;
    $("#lv-key").value = "";
    $("#lv-app").value = "";
    $("#lv-status").textContent = "Keys cleared from this tab.";
  }
  $("#lv-forget").addEventListener("click", forget);
  window.addEventListener("pagehide", () => { creds = null; });

  /* ── the race ──────────────────────────────────────────────────── */

  function lanes(agents, total, results) {
    $("#lv-lanes").innerHTML = agents.map((id, k) => {
      const mine = results.filter((r) => r.agentId === id);
      const ok = mine.filter((r) => r.verdict && r.verdict === r.expected).length;
      const bad = mine.filter((r) => r.verdict && r.verdict !== r.expected).length;
      const fail = mine.filter((r) => !r.verdict).length;
      const w = (x) => (100 * x / total).toFixed(2);
      return `<div class="lane"><div class="lane-h"><b>agent ${k + 1}</b> <span class="cid">· id ${esc(id.slice(0, 8))}…</span>` +
        `<span class="note">${mine.length}/${total}</span></div>` +
        `<div class="lane-t"><div class="ok" style="width:${w(ok)}%"></div><div class="bad" style="width:${w(bad)}%"></div><div class="fail" style="width:${w(fail)}%"></div></div></div>`;
    }).join("") + '<div class="legend"><span style="--c:var(--ok)">right</span><span style="--c:var(--over)">wrong</span><span style="--c:var(--ink-3)">failed call</span></div>';
  }

  function summary(agents, results) {
    const rows = L.summarize(agents, results).map((s, k) =>
      `<tr><td data-label="agent"><b>agent ${k + 1}</b> <span class="cid">· id ${esc(s.agentId.slice(0, 8))}…</span></td>` +
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
    const agents = agentIds();
    if (!agents.length) { status.textContent = "Enter at least one agent ID."; return; }
    if (agents.length > L.MAX_AGENTS) { status.textContent = `${L.MAX_AGENTS} agents at most.`; return; }
    if (!agents.every(L.isUuid)) { status.textContent = "An agent ID looks wrong. Copy it from the dashboard."; return; }
    let cases;
    try { cases = await chosenCases(); } catch (e) { status.textContent = "Could not load the example set."; return; }
    if (!cases.length) { status.textContent = "Pick a CSV with at least one usable row."; return; }
    const calls = cases.length * agents.length;
    if (!window.confirm(`Send ${calls}\u00a0messages (${cases.length} × ${agents.length} agents) to your app? Each allowed message runs your agent in full and uses tokens.`)) return;

    const results = [];
    lanes(agents, cases.length, results);
    $("#lv-summary").innerHTML = "";
    $("#lv-export").disabled = true;
    $("#lv-stop").disabled = false;
    status.textContent = "Racing…";
    let painted = 0;
    running = L.race({
      fetchImpl: window.fetch.bind(window), creds, agents, cases,
      onResult: (r) => {
        results.push(r);
        if (Date.now() - painted > 120) { painted = Date.now(); lanes(agents, cases.length, results); }
      },
    });
    await running.done;
    running = null;
    $("#lv-stop").disabled = true;
    lanes(agents, cases.length, results);
    summary(agents, results);
    last = { cases, agents, results };
    $("#lv-export").disabled = !results.length;
    status.textContent = `Done: ${results.length} answers.`;
  });

  $("#lv-stop").addEventListener("click", () => { if (running) running.stop(); });

  $("#lv-export").addEventListener("click", () => {
    if (last) download("guardrail-race-results.csv", L.resultsCsv(last.cases, last.agents, last.results));
  });

  /* ── optional lookups: these need a key with the settings ACL ─── */

  $("#lv-lookup").addEventListener("click", async () => {
    const out = $("#lv-lookup-out");
    const bad = readCreds();
    if (bad) { out.innerHTML = `<p class="err">${esc(bad)}</p>`; return; }
    const f = window.fetch.bind(window);
    const parts = [];
    for (const id of agentIds().filter(L.isUuid).slice(0, L.MAX_AGENTS)) {
      try {
        const res = await L.call(f, creds, "GET", `/1/agents/${id}`);
        if (!res.ok) { parts.push(`<li>${esc(id.slice(0, 8))}…: ${esc(L.statusText(res.status))}</li>`); continue; }
        const a = await res.json();
        const on = !!(a.config && a.config.guardrail && a.config.guardrail.enabled);
        parts.push(`<li><b>${esc(a.name)}</b> · model ${esc(a.model || "–")} · guardrail ${on ? "on" : "<b>off</b>: every message will pass"}</li>`);
      } catch (e) { parts.push(`<li>${esc(id.slice(0, 8))}…: request failed</li>`); }
    }
    try {
      const res = await L.call(f, creds, "GET", "/1/providers");
      if (res.ok) {
        const list = (await res.json()).data || [];
        for (const p of list.slice(0, 12)) {
          let models = "";
          try {
            const r = await L.call(f, creds, "GET", `/1/providers/${p.id}/models`);
            if (r.ok) models = (await r.json()).slice(0, 8).join(", ");
          } catch (e) { /* the list still shows the provider */ }
          parts.push(`<li>provider <b>${esc(p.name)}</b> (${esc(p.providerName)})${models ? ": " + esc(models) : ""}</li>`);
        }
      } else parts.push(`<li>providers: ${esc(L.statusText(res.status))}</li>`);
    } catch (e) { parts.push("<li>providers: request failed</li>"); }
    out.innerHTML = `<ul>${parts.join("")}</ul><p class="note">To race two models, make one agent per model in your dashboard, then list both IDs above.</p>`;
  });
})();

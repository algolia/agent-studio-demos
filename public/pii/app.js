/* ───────────────────────────────────────────────────────────────
   app.js — the page: one message, two sides.

   Left is the filter switched off; right is the filter in the chosen mode.
   Each side shows what the model receives, what the agent answers, and what
   the chat log keeps. Mock replies redraw as you type; live replies wait for
   Send. Every node is built with textContent: no message ever goes through
   innerHTML.

   Which agent answers: the visitor's own (from the form) wins; else the
   demo's agent from window.DEMO_CONFIG.pii while "Live agent" is on (it
   starts on when that block exists); else the mock.
   ─────────────────────────────────────────────────────────────── */

import {
  detect, filterMessage, maskFindings, segments, resolveOverlaps, ENTITIES, EXTRA_ENTITIES, PORT_ENTITIES, GATED_ENTITIES,
} from "./detect.js";
import { mockReply, blockReply } from "./mock.js";
import { complete, configAgent, isUuid } from "./live.js";
import { SAMPLES } from "./samples.js";
import { compareSides } from "./compare.js";

const $ = (id) => document.getElementById(id);

/* made-up numbers: valid checksums, never a real customer's */
/* check-copy: off */
const EXAMPLES = [
  { label: "Balance + SSN", text: "Can you show me my account balance? My account number is 4521-8830-1127 and my social is 123-45-6789" },
  { label: "Card dispute", text: "My card 4111 1111 1111 1111 was charged twice yesterday. Can you refund it?" },
  { label: "IBAN transfer", text: "Please send 250 EUR to DE89370400440532013000 for the rent." },
  { label: "Email + phone", text: "Update my contact details: my.mail@example.com and +1 415-555-0132." },
  { label: "Solde + NIR", text: "Bonjour, quel est le solde de mon compte ? Mon numéro de sécu est 2 91 03 2A 004 123 68" },
  { label: "Clean question", text: "What time do your branches open on Saturday?" },
];
/* check-copy: on */

const COVER = {
  EMAIL: "name@domain.tld",
  PHONE: "9 to 15 digits, with separators",
  CREDIT_CARD: "Luhn check and card network prefix",
  IBAN: "country length and mod-97 check; spaced form missed",
  IP: "IPv4, each part 0 to 255",
  US_SSN: "US only: ddd-dd-dddd, never-issued ranges dropped",
  ACCOUNT_NUMBER: "6 to 20 digits after a word like “account number”",
  FR_NIR: "French social security number: 15\u00a0characters, mod 97 key, 2A and 2B",
  FR_TAX_ID: "French tax number: 13 digits, mod 511 check",
  FR_SIREN: "9 digits after “SIREN”, Luhn check",
  FR_SIRET: "14 digits after “SIRET”, Luhn check",
  ES_DNI: "Spanish DNI: 8 digits and a check letter",
  ES_NIE: "Spanish NIE: X, Y or Z, 7 digits and a check letter",
};

const state = {
  mode: "redact",
  extras: true,
  own: null, // { region, appId, apiKey, agentId } from the form, in memory only
  demo: configAgent(window.DEMO_CONFIG), // the same shape, from config.js, or null
  useDemo: true,
  live: { text: null, raw: null, filtered: null, pending: false, shown: Infinity },
};

/** the agent Send asks, or null for the mock */
const creds = () => state.own || (state.useDemo ? state.demo : null);

/* ── Painting ─────────────────────────────────────────────────── */

function mark(text, entity, showLabel, kind = "") {
  const m = document.createElement("mark");
  m.className = `hl${kind ? ` ${kind}` : ""}`;
  m.dataset.entity = entity;
  const v = document.createElement("span");
  v.className = "v";
  v.textContent = text;
  m.append(v);
  if (showLabel) {
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = entity;
    m.append(t);
  }
  return m;
}

/** text with its findings painted; raw values get a type label, masks already name themselves */
function painted(text, findings) {
  const frag = document.createDocumentFragment();
  for (const s of segments(text, findings)) {
    if (!s.entity) frag.append(document.createTextNode(s.text));
    else {
      const raw = !/^\[[A-Z_]+\]$/.test(s.text);
      frag.append(mark(s.text, s.entity, raw, raw ? "raw" : "mask"));
    }
  }
  return frag;
}

const findAll = (text) => resolveOverlaps([...detect(text, { extras: state.extras }), ...maskFindings(text)]);

function fill(el, text, { empty = "", cls = "" } = {}) {
  el.replaceChildren();
  el.classList.toggle("refused", cls === "refused");
  if (text == null || text === "") {
    const span = document.createElement("span");
    span.className = "muted";
    span.textContent = empty;
    el.append(span);
    return;
  }
  el.append(painted(text, findAll(text)));
}

function fillLog(el, rows) {
  el.replaceChildren();
  for (const [who, text, note] of rows) {
    const row = document.createElement("div");
    row.className = "log-row";
    const w = document.createElement("span");
    w.className = "who";
    w.textContent = who;
    row.append(w);
    const body = document.createElement("span");
    if (text) body.append(painted(text, findAll(text)));
    else { body.className = "muted"; body.textContent = "—"; }
    row.append(body);
    if (note) {
      const n = document.createElement("span");
      n.className = "note";
      n.textContent = note;
      row.append(n);
    }
    el.append(row);
  }
}

/* ── The two sides ────────────────────────────────────────────── */

function replyFor(side, sent) {
  if (sent == null) return { text: blockReply($("msg").value), note: "local reply" };
  if (!creds()) return { text: mockReply(sent).text };
  const l = state.live;
  if (l.text !== $("msg").value) return { text: null, empty: "Press Send to ask the agent." };
  if (l.pending) return { text: null, empty: "Waiting for the agent…" };
  const r = l[side];
  if (!r) return { text: null, empty: "Press Send to ask the agent." };
  if (r.error) return { text: null, empty: r.error };
  return { text: l.shown >= r.text.length ? r.text : r.text.slice(0, l.shown) };
}

function render() {
  const text = $("msg").value;
  const raw = filterMessage(text, "off", { extras: state.extras });
  const f = filterMessage(text, state.mode, { extras: state.extras });

  fill($("raw-model"), raw.toModel, { empty: "Type a message." });
  const rr = replyFor("raw", raw.toModel);
  fill($("raw-reply"), rr.text, { empty: rr.empty });
  fillLog($("raw-log"), [["customer", raw.toLog], ["agent", rr.text]]);

  if (f.blocked) {
    fill($("f-model"), null, { empty: "Nothing sent. The message was refused before the model.", cls: "refused" });
  } else {
    fill($("f-model"), f.toModel, { empty: "Type a message." });
  }
  const fr = replyFor("filtered", f.toModel);
  fill($("f-reply"), fr.text, { empty: fr.empty });
  fillLog($("f-log"), [["customer", f.toLog, f.blocked ? "blocked" : ""], ["agent", fr.text, fr.note || ""]]);

  $("mode-tag").textContent = `mode ${state.mode}`;
  if (f.blocked) $("f-badge").textContent = "local reply";
  else setAgentLabel();
  renderLegend(f.findings);
  renderCompare(compareSides({
    raw: { sent: raw.toModel, log: [raw.toLog, rr.text] },
    filtered: { sent: f.toModel, log: [f.toLog, fr.text] },
  }, { extras: state.extras }));
}

/** the strip under the sides: label, left, right, from the run above; a leading count gets its own span */
function renderCompare(rows) {
  const trs = [];
  for (const [label, left, right] of rows) {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.scope = "row";
    th.textContent = label;
    tr.append(th);
    for (const [v, cls] of [[left, "l"], [right, "r"]]) {
      const td = document.createElement("td");
      td.className = cls;
      const m = /^(\d+)(.*)$/s.exec(v);
      if (m) {
        const fig = document.createElement("span");
        fig.className = `fig ${m[1] === "0" ? "safe" : "leak"}`;
        fig.textContent = m[1];
        td.append(fig, m[2]);
      } else td.textContent = v;
      tr.append(td);
    }
    trs.push(tr);
  }
  $("compare").replaceChildren(...trs);
}

/** one "try it" chip per sample: a click puts it in the message box */
function sampleChips(entity) {
  const row = document.createElement("div");
  row.className = "samples";
  row.setAttribute("role", "group");
  row.setAttribute("aria-label", `Try a ${entity} sample`);
  for (const value of SAMPLES[entity] || []) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "sample";
    b.textContent = value;
    b.addEventListener("click", () => {
      $("msg").value = value;
      for (const c of $("examples").children) c.setAttribute("aria-pressed", "false");
      render();
      $("msg").focus();
    });
    row.append(b);
  }
  return row;
}

function renderLegend(findings) {
  const counts = {};
  for (const x of findings) counts[x.entity] = (counts[x.entity] || 0) + 1;
  const list = document.createElement("ul");
  for (const e of ENTITIES) {
    const li = document.createElement("li");
    const port = PORT_ENTITIES.includes(e);
    const extra = port || EXTRA_ENTITIES.includes(e);
    li.className = `${extra ? "extra" : "toolkit"}${counts[e] ? " hit" : ""}${extra && !state.extras ? " off" : ""}`;
    li.append(mark(e, e, false));
    const what = document.createElement("span");
    what.className = "what";
    what.textContent = COVER[e];
    li.append(what);
    const kind = document.createElement("span");
    kind.className = "kind";
    kind.textContent = extra ? "demo extra · lower precision" : "toolkit · checksum";
    if (port) {
      kind.textContent = GATED_ENTITIES.includes(e) ? "demo port · keyword · lower precision" : "demo port · checksum";
      kind.title = "A demo port of identifiers the toolkit is gaining.";
    }
    if (e === "PHONE") kind.textContent = "toolkit · digit count";
    if (e === "EMAIL") kind.textContent = "toolkit · pattern";
    li.append(kind);
    const n = document.createElement("span");
    n.className = "count";
    n.textContent = counts[e] ? `×${counts[e]}` : "";
    li.append(n);
    li.append(sampleChips(e));
    list.append(li);
  }
  const none = document.createElement("li");
  none.className = "none";
  none.textContent = "Not found: names, postal addresses, dates of birth, free text, and national ids of other countries.";
  list.append(none);
  $("legend").replaceChildren(list);
}

/* ── Controls ─────────────────────────────────────────────────── */

function setMode(mode) {
  state.mode = mode;
  for (const b of document.querySelectorAll("[data-mode]")) b.setAttribute("aria-checked", String(b.dataset.mode === mode));
  render();
}

function setAgentLabel() {
  const label = state.own ? "your agent" : creds() ? "live agent" : "mock agent";
  $("agent-tag").textContent = label;
  for (const b of document.querySelectorAll("[data-agent-badge]")) {
    b.textContent = label;
    b.classList.toggle("live", Boolean(creds()));
  }
  $("live-note").hidden = !(state.demo && state.useDemo && !state.own);
}

const FAST_MS = 3000; // a reply this quick came from the cache: type it out
const COOLDOWN_MS = 1500;
let cooldownUntil = 0;
let typer = null;

function setBusy(busy) {
  const b = $("send");
  b.disabled = busy;
  b.textContent = busy ? "Asking…" : "Send";
}

function typeOut(text) {
  clearInterval(typer);
  const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const total = Math.max(state.live.raw?.text.length || 0, state.live.filtered?.text.length || 0);
  if (reduced) { state.live.shown = Infinity; return; }
  state.live.shown = 0;
  typer = setInterval(() => {
    if (state.live.text !== text || state.live.shown >= total) { clearInterval(typer); return; }
    state.live.shown += 3;
    render();
  }, 20);
}

async function send() {
  const who = creds();
  if (!who) { render(); return; }
  const text = $("msg").value;
  if (!text.trim() || state.live.pending || Date.now() < cooldownUntil) return;
  const raw = filterMessage(text, "off", { extras: state.extras });
  const f = filterMessage(text, state.mode, { extras: state.extras });
  clearInterval(typer);
  state.live = { text, raw: null, filtered: null, pending: true, shown: Infinity };
  setBusy(true);
  render();
  const t0 = Date.now();
  const [r, fl] = await Promise.all([
    complete(fetch, who, raw.toModel),
    f.toModel == null ? Promise.resolve(null) : complete(fetch, who, f.toModel),
  ]);
  cooldownUntil = Date.now() + COOLDOWN_MS;
  setTimeout(() => setBusy(false), COOLDOWN_MS);
  if (state.live.text !== text) return;
  state.live = { text, raw: r, filtered: fl, pending: false, shown: Infinity };
  if (Date.now() - t0 < FAST_MS) typeOut(text);
  render();
}

function useAgent() {
  const own = {
    region: $("lv-region").value,
    appId: $("lv-app").value.trim(),
    apiKey: $("lv-key").value,
    agentId: $("lv-agent").value.trim(),
  };
  if (!own.appId || !own.apiKey || !isUuid(own.agentId)) {
    $("lv-status").textContent = "Fill in all four. The agent ID is a UUID.";
    return;
  }
  state.own = own;
  $("lv-key").value = "";
  state.live = { text: null, raw: null, filtered: null, pending: false, shown: Infinity };
  $("lv-status").textContent = "Live: Send asks your agent, both sides.";
  setAgentLabel();
  render();
}

function forget() {
  state.own = null;
  $("lv-key").value = "";
  state.live = { text: null, raw: null, filtered: null, pending: false, shown: Infinity };
  $("lv-status").textContent = `Back to the ${creds() ? "live" : "mock"} agent. Your key is gone.`;
  setAgentLabel();
  render();
}

function init() {
  const chips = $("examples");
  EXAMPLES.forEach((ex, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.textContent = ex.label;
    b.addEventListener("click", () => {
      $("msg").value = ex.text;
      for (const c of chips.children) c.setAttribute("aria-pressed", String(c === b));
      render();
    });
    b.setAttribute("aria-pressed", String(i === 0));
    chips.append(b);
  });
  $("msg").value = EXAMPLES[0].text;
  $("msg").addEventListener("input", () => {
    for (const c of chips.children) c.setAttribute("aria-pressed", "false");
    render();
  });
  for (const b of document.querySelectorAll("[data-mode]")) b.addEventListener("click", () => setMode(b.dataset.mode));
  $("extras").addEventListener("change", (e) => { state.extras = e.target.checked; render(); });
  $("send").addEventListener("click", send);
  $("lv-use").addEventListener("click", useAgent);
  $("lv-forget").addEventListener("click", forget);
  if (state.demo) {
    $("live-wrap").hidden = false;
    $("live").checked = state.useDemo;
    $("live").addEventListener("change", (e) => {
      state.useDemo = e.target.checked;
      state.live = { text: null, raw: null, filtered: null, pending: false, shown: Infinity };
      setAgentLabel();
      render();
    });
  }
  setAgentLabel();
  render();
}

init();

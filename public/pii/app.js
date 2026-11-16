/* ───────────────────────────────────────────────────────────────
   app.js — the page: one message, two sides.

   Left is the filter switched off; right is the filter in the chosen mode.
   Each side shows what the model receives, what the agent answers, and what
   the chat log keeps. Mock replies redraw as you type; live replies wait for
   Send. Every node is built with textContent: no message ever goes through
   innerHTML.
   ─────────────────────────────────────────────────────────────── */

import { detect, filterMessage, maskFindings, segments, resolveOverlaps, ENTITIES, EXTRA_ENTITIES } from "./detect.js";
import { mockReply, BLOCK_REPLY } from "./mock.js";
import { complete, isUuid } from "./live.js";
import { SAMPLES } from "./samples.js";

const $ = (id) => document.getElementById(id);

/* made-up numbers: valid checksums, never a real customer's */
/* check-copy: off */
const EXAMPLES = [
  { label: "Balance + SSN", text: "Can you show me my account balance? My account number is 4521-8830-1127 and my social is 123-45-6789" },
  { label: "Card dispute", text: "My card 4111 1111 1111 1111 was charged twice yesterday. Can you refund it?" },
  { label: "IBAN transfer", text: "Please send 250 EUR to DE89370400440532013000 for the rent." },
  { label: "Email + phone", text: "Update my contact details: my.mail@example.com and +1 415-555-0132." },
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
};

const state = {
  mode: "redact",
  extras: true,
  creds: null, // { region, appId, apiKey, agentId } while live, in memory only
  live: { text: null, raw: null, filtered: null, pending: false },
};

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
  if (sent == null) return { text: BLOCK_REPLY, note: "local reply" };
  if (!state.creds) return { text: mockReply(sent).text };
  const l = state.live;
  if (l.text !== $("msg").value) return { text: null, empty: "Press Send to ask your agent." };
  if (l.pending) return { text: null, empty: "Waiting for your agent…" };
  const r = l[side];
  if (!r) return { text: null, empty: "Press Send to ask your agent." };
  if (r.error) return { text: null, empty: r.error };
  return { text: r.text };
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
    const extra = EXTRA_ENTITIES.includes(e);
    li.className = `${extra ? "extra" : "toolkit"}${counts[e] ? " hit" : ""}${extra && !state.extras ? " off" : ""}`;
    li.append(mark(e, e, false));
    const what = document.createElement("span");
    what.className = "what";
    what.textContent = COVER[e];
    li.append(what);
    const kind = document.createElement("span");
    kind.className = "kind";
    kind.textContent = extra ? "demo extra · lower precision" : "toolkit · checksum";
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
  none.textContent = "Not found: names, postal addresses, dates of birth, free text.";
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
  const label = state.creds ? "your agent" : "mock agent";
  $("agent-tag").textContent = label;
  for (const b of document.querySelectorAll("[data-agent-badge]")) {
    b.textContent = label;
    b.classList.toggle("live", Boolean(state.creds));
  }
}

async function send() {
  if (!state.creds) { render(); return; }
  const text = $("msg").value;
  const raw = filterMessage(text, "off", { extras: state.extras });
  const f = filterMessage(text, state.mode, { extras: state.extras });
  state.live = { text, raw: null, filtered: null, pending: true };
  render();
  const [r, fl] = await Promise.all([
    complete(fetch, state.creds, raw.toModel),
    f.toModel == null ? Promise.resolve(null) : complete(fetch, state.creds, f.toModel),
  ]);
  if (state.live.text !== text) return;
  state.live = { text, raw: r, filtered: fl, pending: false };
  render();
}

function useAgent() {
  const creds = {
    region: $("lv-region").value,
    appId: $("lv-app").value.trim(),
    apiKey: $("lv-key").value,
    agentId: $("lv-agent").value.trim(),
  };
  if (!creds.appId || !creds.apiKey || !isUuid(creds.agentId)) {
    $("lv-status").textContent = "Fill in all four. The agent ID is a UUID.";
    return;
  }
  state.creds = creds;
  $("lv-key").value = "";
  state.live = { text: null, raw: null, filtered: null, pending: false };
  $("lv-status").textContent = "Live: Send asks your agent, both sides.";
  setAgentLabel();
  render();
}

function forget() {
  state.creds = null;
  $("lv-key").value = "";
  $("lv-status").textContent = "Back to the mock agent. The key is gone.";
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
  setAgentLabel();
  render();
}

init();

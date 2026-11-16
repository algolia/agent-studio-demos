/* tools/pii-provision.mjs against a fake Agent Studio: the fence, adopt or
   create, converge, dry run, the config block, and no key in any log line. */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
const load = () => import(pathToFileURL(path.join(ROOT, "tools", "pii-provision.mjs")).href);

const APP = "FAKEAPP01";
const BROWSER_KEY = "browser-key-not-real-0001";
const MANAGED = { id: "prov-managed", name: "Algolia LLM", providerName: "algolia_managed_llm" };
const CUSTOMER = { id: "prov-openai", name: "Prod OpenAI", providerName: "openai" };

/** a fake backend: providers, agents by id, every call recorded */
function fakeBackend({ agents = [], models = ["gpt-4.1", "gpt-6-sol"], providers = [MANAGED, CUSTOMER] } = {}) {
  const store = new Map(agents.map((a) => [a.id, { ...a }]));
  const calls = [];
  let n = 0;
  const call = async (method, p, body) => {
    calls.push({ method, p, body });
    if (method === "GET" && p.startsWith("/1/providers?")) return { data: providers };
    if (method === "GET" && /^\/1\/providers\/[^/]+\/models$/.test(p)) return models;
    if (method === "GET" && p.startsWith("/1/agents?")) return { data: [...store.values()].map(({ id, name }) => ({ id, name })), pagination: { totalPages: 1 } };
    if (method === "GET" && p.startsWith("/1/agents/")) return store.get(p.split("/")[3]);
    if (method === "POST" && p === "/1/agents") { const id = `00000000-0000-4000-8000-00000000000${++n}`; store.set(id, { id, ...body }); return { id, ...body }; }
    if (method === "PATCH") { const id = p.split("/")[3]; store.set(id, { ...store.get(id), ...body }); return store.get(id); }
    if (method === "POST" && p.endsWith("/publish")) return {};
    throw new Error(`unexpected ${method} ${p}`);
  };
  return { call, calls, store, writes: () => calls.filter((c) => c.method !== "GET") };
}

function fakeFiles(initial = {}) {
  const files = new Map(Object.entries(initial));
  const written = [];
  return {
    files, written,
    read: async (f) => { if (!files.has(f)) throw new Error("ENOENT"); return files.get(f); },
    write: async (f, s) => { written.push(f); files.set(f, s); },
  };
}

const KEYS_SRC = `window.DEMO_CONFIG = { host: "h", mainDemo: { appId: "${APP}", agentStudioApiKey: "${BROWSER_KEY}" } };\n`;

async function runWith(p, { args = [], backend = fakeBackend(), files = fakeFiles({ "/k/config.js": KEYS_SRC }) } = {}) {
  const lines = [];
  const agent = await p.run({
    args: p.parseArgs(["--region", "eu", ...args]), appId: APP, region: "eu", host: "https://agent-studio.eu.algolia.com",
    call: backend.call, log: (...a) => lines.push(a.join(" ")), files,
  });
  return { agent, lines, backend, files };
}

test("fence: a new agent must be DEMO_pii-, and only listed DEMO_pii- agents are written", async () => {
  const p = await load();
  const b = fakeBackend();
  const call = p.piiFence(b.call);
  call.own({ id: "ours", name: "DEMO_pii-banking" });
  call.own({ id: "other", name: "DEMO_main-demo-base" });
  await assert.rejects(call("POST", "/1/agents", { name: "Bank assistant" }), /must be named DEMO_pii-/);
  await assert.rejects(call("PATCH", "/1/agents/other", {}), /not a DEMO_pii-/);
  await assert.rejects(call("DELETE", "/1/agents/prod"), /not a DEMO_pii-/);
  await assert.rejects(call("POST", "/1/providers", { name: "x" }), /refused/);
  assert.equal(b.writes().length, 0, "a refused write never reaches the network");
});

test("provider: the managed one by default; a customer provider is refused", async () => {
  const p = await load();
  const { backend } = await runWith(p);
  const made = backend.writes().find((c) => c.p === "/1/agents");
  assert.equal(made.body.providerId, MANAGED.id);
  await assert.rejects(runWith(p, { args: ["--provider", "Prod OpenAI"] }), /neither TEST_ nor Algolia-managed/);
  await assert.rejects(runWith(p, { backend: fakeBackend({ providers: [CUSTOMER] }) }), /0 Algolia-managed providers/);
});

test("model: the first candidate served, or --model when served", async () => {
  const p = await load();
  assert.equal(p.pickModel(["gpt-4.1", "gpt-6-sol"]), "gpt-6-sol");
  assert.equal(p.pickModel(["gpt-4.1", "gpt-6-sol"], "gpt-4.1"), "gpt-4.1");
  assert.throws(() => p.pickModel(["gpt-4.1"], "gpt-9"), /not one this provider serves/);
  assert.throws(() => p.pickModel(["other"]), /none of the candidate models/);
});

test("create: one tool-less agent, memory and guardrails off, published", async () => {
  const p = await load();
  const { agent, backend } = await runWith(p);
  const w = backend.writes();
  assert.deepEqual(w.map((c) => `${c.method} ${c.p.replace(agent.agentId, "ID")}`), ["POST /1/agents", "POST /1/agents/ID/publish"]);
  const body = w[0].body;
  assert.equal(body.name, "DEMO_pii-banking");
  assert.deepEqual(body.tools, []);
  assert.equal(body.config.memory.enabled, false);
  assert.equal(body.config.guardrail.enabled, false);
  assert.equal(body.config.suggestions.enabled, false);
  assert.equal(body.config.searchPrefetch, false);
  assert.ok(!("enableAlgoliaMcp" in body.config), "create refuses an MCP flag");
  assert.match(body.instructions, /no access to any account/);
  assert.match(body.instructions, /secure channel/);
});

test("adopt: an agent with the name is reused untouched; a second run creates nothing", async () => {
  const p = await load();
  const first = await runWith(p);
  const again = await runWith(p, { backend: first.backend });
  assert.equal(again.agent.agentId, first.agent.agentId);
  assert.equal(first.backend.writes().length, 2, "the second run wrote nothing");
  assert.ok(again.lines.some((l) => /^adopt/.test(l)));
});

test("converge: drift is reported, rewritten only with --converge, never on a dry run", async () => {
  const p = await load();
  const drifted = { id: "00000000-0000-4000-8000-0000000000aa", name: "DEMO_pii-banking", providerId: MANAGED.id, model: "gpt-4.1",
    instructions: "old", tools: [{ type: "algolia_search_index" }], config: { memory: { enabled: true }, sendUsage: true } };
  const plain = await runWith(p, { backend: fakeBackend({ agents: [drifted] }) });
  assert.equal(plain.backend.writes().length, 0);
  assert.ok(plain.lines.some((l) => /differs: model gpt-4.1; other instructions; 1 tools; memory on/.test(l)), plain.lines.join("\n"));

  const dry = await runWith(p, { args: ["--converge", "--dry-run"], backend: fakeBackend({ agents: [drifted] }) });
  assert.equal(dry.backend.writes().length, 0);
  assert.ok(dry.lines.some((l) => /^would fix/.test(l)));

  const fixed = await runWith(p, { args: ["--converge"], backend: fakeBackend({ agents: [drifted] }) });
  const [patch, pub] = fixed.backend.writes();
  assert.equal(patch.method, "PATCH");
  assert.equal(pub.p, `/1/agents/${drifted.id}/publish`);
  assert.deepEqual(patch.body.tools, []);
  assert.equal(patch.body.model, "gpt-6-sol");
  assert.equal(patch.body.config.memory.enabled, false);
  assert.equal(patch.body.config.sendUsage, true, "fields this demo does not own are kept");
  assert.deepEqual(p.piiDrift(fixed.backend.store.get(drifted.id), p.piiBody({ providerId: MANAGED.id, model: "gpt-6-sol" })), []);
});

test("dry run: no agent and no file written", async () => {
  const p = await load();
  const { agent, backend, files } = await runWith(p, { args: ["--dry-run", "--keys-from", "/k/config.js", "--write-config", "/k/out.js"] });
  assert.equal(agent, null);
  assert.equal(backend.writes().length, 0);
  assert.deepEqual(files.written, []);
});

test("--write-config: the pii block with the browser key, other blocks untouched, never doubled", async () => {
  const p = await load();
  const files = fakeFiles({ "/k/config.js": KEYS_SRC });
  const { agent } = await runWith(p, { args: ["--keys-from", "/k/config.js", "--write-config", "/k/config.js"], files });
  const src = files.files.get("/k/config.js");
  const cfg = p.readConfig(src);
  assert.deepEqual(JSON.parse(JSON.stringify(cfg.pii)), { region: "eu", host: "https://agent-studio.eu.algolia.com", appId: APP,
    agentStudioApiKey: BROWSER_KEY, agentId: agent.agentId, name: "DEMO_pii-banking", model: "gpt-6-sol" });
  assert.equal(cfg.mainDemo.agentStudioApiKey, BROWSER_KEY, "the other block is untouched");
  await runWith(p, { args: ["--keys-from", "/k/config.js", "--write-config", "/k/config.js"], files });
  assert.equal(files.files.get("/k/config.js").split("// pii: begin").length, 2, "one block after two runs");
  assert.ok(!/ADMIN|admin/.test(files.files.get("/k/config.js")));

  const nokey = fakeFiles({ "/k/config.js": 'window.DEMO_CONFIG = { mainDemo: { appId: "OTHER", agentStudioApiKey: "x" } };' });
  await assert.rejects(runWith(p, { args: ["--keys-from", "/k/config.js", "--write-config", "/k/out.js"], files: nokey }), /no block .* holds a browser key/);
  assert.throws(() => p.parseArgs(["--region", "eu", "--write-config", "x.js"]), /needs --keys-from/);
});

test("no key in any log line, on every path", async () => {
  const p = await load();
  const runs = [
    await runWith(p, { args: ["--providers"] }),
    await runWith(p, { args: ["--keys-from", "/k/config.js", "--write-config", "/k/out.js"] }),
    await runWith(p, { args: ["--dry-run", "--converge", "--keys-from", "/k/config.js", "--write-config", "/k/out.js"] }),
  ];
  const all = runs.flatMap((r) => r.lines).join("\n");
  assert.ok(all.length > 0);
  assert.ok(!all.includes(BROWSER_KEY), "the browser key is never logged");
  assert.ok(!all.includes(APP), "the app id is never logged in full");
  assert.match(runs[0].lines.join("\n"), /provider Algolia LLM \[algolia_managed_llm\] {2}candidates: gpt-6-sol, gpt-4.1/);
  assert.match(runs[0].lines.join("\n"), /Prod OpenAI .*refused/);
});

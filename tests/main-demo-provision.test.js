/* main-demo provisioning off this machine: the region probe, the write fence
   and the TEST_ provider rule, against fake calls. The script exports them
   and only runs when started as a script. */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const load = () => import(pathToFileURL(path.join(__dirname, "..", "tools", "main-demo-provision.mjs")).href);

const HOSTS = { eu: "https://eu.example", us: "https://us.example" };
const listing = (byHost) => (host) => async () => {
  const v = byHost[host];
  if (v instanceof Error) throw v;
  return { data: v || [] };
};

test("region: the one host that lists the app's providers, never a guess", async () => {
  const p = await load();
  const usOnly = listing({ [HOSTS.us]: [{ id: "p1", name: "TEST_openai" }] });
  assert.deepEqual(await p.probeRegions(usOnly, HOSTS), ["us"], "an empty list is the other region");
  assert.deepEqual(await p.hostForRegion("auto", usOnly, HOSTS), { region: "us", host: HOSTS.us });
  assert.deepEqual(await p.hostForRegion("eu", usOnly, HOSTS), { region: "eu", host: HOSTS.eu }, "an explicit region is not probed");
  const down = listing({ [HOSTS.eu]: new Error("403"), [HOSTS.us]: [] });
  await assert.rejects(p.hostForRegion("auto", down, HOSTS), /no region; pass --region eu or us/);
  const both = listing({ [HOSTS.eu]: [{ id: "a" }], [HOSTS.us]: [{ id: "b" }] });
  await assert.rejects(p.hostForRegion("auto", both, HOSTS), /eu and us/);
  await assert.rejects(p.hostForRegion("mars", usOnly, HOSTS), /--region takes eu, us or auto/);
});

test("fence: off this machine, new agents carry a demo name and only this demo's agents are written", async () => {
  const p = await load();
  const calls = [];
  const raw = async (method, route, body) => { calls.push([method, route]); return method === "POST" && route === "/1/agents" ? { id: `new-${calls.length}`, ...body } : {}; };
  const call = p.fenced(raw, { local: false });
  call.own({ id: "base", name: "DEMO_main-demo-base" });
  call.own({ id: "theirs", name: "DEMO_someone-else" });
  call.own({ id: "prod", name: "Shopping assistant" });

  await assert.rejects(call("POST", "/1/agents", { name: "main-demo-base" }), /must be named DEMO_… or EVAL_…/);
  const made = await call("POST", "/1/agents", { name: "DEMO_main-demo-prefetch" });
  await call("POST", `/1/agents/${made.id}/publish`);
  await call("PATCH", "/1/agents/base", {});
  await assert.rejects(call("PATCH", "/1/agents/prod", {}), /not DEMO_main-demo-…/);
  await assert.rejects(call("DELETE", "/1/agents/theirs"), /not DEMO_main-demo-…/, "another demo's agent is not ours");
  await assert.rejects(call("POST", "/1/providers", { name: "x" }), /refused/);
  await call("GET", "/1/agents/prod");
  assert.deepEqual(calls.map(([m, r]) => `${m} ${r}`),
    ["POST /1/agents", `POST /1/agents/${made.id}/publish`, "PATCH /1/agents/base", "GET /1/agents/prod"],
    "a refused write never reaches the network");

  const open = p.fenced(raw, { local: true });
  await open("POST", "/1/agents", { name: "main-demo-base" });
  assert.equal(calls.at(-1)[0], "POST", "a local backend keeps the old names working");
});

test("provider: off this machine the base runs on a TEST_ provider, and the variants inherit it", async () => {
  const p = await load();
  const providers = new Map([["t", { name: "TEST_openai", label: "openai" }], ["c", { name: "Customer key", label: "openai" }]]);
  assert.doesNotThrow(() => p.checkProvider({ name: "DEMO_main-demo-base", providerId: "t" }, providers, { local: false }));
  assert.throws(() => p.checkProvider({ name: "DEMO_main-demo-base", providerId: "c" }, providers, { local: false }), /Customer key; use one named TEST_/);
  assert.throws(() => p.checkProvider({ name: "DEMO_main-demo-base", providerId: "gone" }, providers, { local: false }), /gone/);
  assert.doesNotThrow(() => p.checkProvider({ name: "x", providerId: "c" }, providers, { local: true }));
  assert.ok(p.isDemoName("EVAL_x") && p.isDemoName("DEMO_x") && !p.isDemoName("demo_x") && !p.isDemoName(""));

  const c = await import(pathToFileURL(path.join(__dirname, "..", "public", "main-demo", "configs.mjs")).href);
  const base = { name: "DEMO_main-demo-base", providerId: "t", model: "m", tools: [], config: { enableAlgoliaMcp: true, searchPrefetch: false } };
  const body = c.customAgentBody(base, c.effectiveBlocks({ ...c.BASE_TOGGLES, prefetch: true }, null));
  assert.equal(body.providerId, "t", "a variant runs on its base's provider");
  assert.equal(body.config.enableAlgoliaMcp, true, "and keeps the base's MCP switch");
});

/** a fake Agent Studio on this machine, and the script run against it */
async function withFakeHost(state, args, fn) {
  const http = require("node:http");
  const os = require("node:os");
  const fs = require("node:fs");
  const { execFile } = require("node:child_process");
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      const send = (j) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(j)); };
      const url = new URL(req.url, "http://x");
      const one = url.pathname.match(/^\/1\/agents\/([^/]+)(\/publish)?$/);
      if (req.method === "GET" && url.pathname === "/1/agents") return send({ data: state.agents, pagination: { totalPages: 1 } });
      if (req.method === "GET" && url.pathname === "/1/providers") return send({ data: state.providers });
      if (req.method === "POST" && url.pathname === "/1/agents") {
        const a = { id: `id-${state.agents.length}`, ...JSON.parse(body) };
        state.agents.push(a);
        return send(a);
      }
      if (one && one[2]) return send({});
      if (one) return send(state.agents.find((a) => a.id === one[1]));
      res.statusCode = 404;
      send({ detail: "not here" });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "main-demo-"));
  try {
    const run = await new Promise((resolve) => {
      execFile(process.execPath, [path.join(__dirname, "..", "tools", "main-demo-provision.mjs"), ...args, "--out", path.join(tmp, "variants.json")], {
        env: { ...process.env, MAIN_DEMO_HOST: `http://127.0.0.1:${server.address().port}`, APP_ID: "APPID", ADMIN_KEY: SECRET },
      }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
    });
    await fn(run);
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
const SECRET = "test-admin-key-never-printed";
const PROVIDERS = [{ id: "t", name: "TEST_openai", providerName: "openai" }, { id: "c", name: "Customer key", providerName: "openai" }];

test("--seed: the base and the prefetch arm, one provider, Algolia MCP on, prefetch the shipped default", async () => {
  const state = { agents: [], providers: PROVIDERS };
  await withFakeHost(state, ["--seed", "--provider", "TEST_openai", "--model", "gpt-4.1", "--print-config"], async (run) => {
    assert.equal(run.code, 0, run.stderr);
    const [base, prefetch] = state.agents;
    assert.deepEqual(state.agents.map((a) => a.name), ["DEMO_main-demo-base", "DEMO_main-demo-prefetch"]);
    assert.deepEqual([base.providerId, prefetch.providerId], ["t", "t"]);
    assert.deepEqual([base.model, prefetch.model], ["gpt-4.1", "gpt-4.1"]);
    assert.equal(base.config.searchPrefetch, false);
    assert.deepEqual(prefetch.config.searchPrefetch, { enabled: true }, "the shipped defaults: no field set");
    assert.deepEqual([base.config.enableAlgoliaMcp, prefetch.config.enableAlgoliaMcp], [true, true]);
    assert.deepEqual(base.tools.map((t) => t.type), ["algolia_search_index", "algolia_grouped_results"]);
    assert.equal(base.tools[0].indices[0].index, "products");
    assert.deepEqual(prefetch.tools, base.tools);
    assert.equal(prefetch.instructions, base.instructions);
    const map = JSON.parse(run.stdout);
    assert.equal(Object.keys(map).length, 2);
    assert.ok(!run.stdout.includes(SECRET) && !run.stderr.includes(SECRET), "the key is never printed");
  });

  // a second run creates nothing
  await withFakeHost(state, ["--seed", "--provider", "TEST_openai", "--model", "gpt-4.1"], async (run) => {
    assert.equal(run.code, 0, run.stderr);
    assert.equal(state.agents.length, 2);
    assert.match(run.stdout, /--seed changes nothing/);
  });
});

test("--seed asks for what it lacks, and names only TEST_ providers", async () => {
  await withFakeHost({ agents: [], providers: PROVIDERS }, ["--seed", "--model", "m"], async (run) => {
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /--seed needs --provider NAME; providers named TEST_… here: TEST_openai/);
    assert.ok(!run.stderr.includes("Customer key"));
  });
  await withFakeHost({ agents: [], providers: PROVIDERS }, [], async (run) => {
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /no agent named DEMO_main-demo-base .*pass --seed/);
  });
  const p = await load();
  const providers = new Map(PROVIDERS.map((x) => [x.id, { name: x.name, label: x.providerName }]));
  assert.throws(() => p.seedProvider(providers, "Customer key", { local: false }), /not a TEST_ provider/);
  assert.equal(p.seedProvider(providers, "Customer key", { local: true }), "c", "a local backend may use any provider");
  assert.equal(p.seedProvider(providers, "TEST_openai", { local: false }), "t");
});

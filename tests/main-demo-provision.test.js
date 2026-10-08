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

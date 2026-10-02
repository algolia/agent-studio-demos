/* jev-attributes: the stateless relay (functions/relay/[[path]].js), the
   client's route table it must match, and the secured-key derivation. */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHmac } = require("node:crypto");
const { pathToFileURL } = require("node:url");

const root = path.join(__dirname, "..");
const load = (f) => import(pathToFileURL(path.join(root, f)).href);
const RELAY = "functions/relay/[[path]].js";
const ORIGIN = "https://demo.example";

function req(route, { origin = ORIGIN, auth = "Bearer abcdefgh12345", method = "POST", body = "{}" } = {}) {
  const headers = { "Content-Type": "application/json", Cookie: "s=1", "X-Forwarded-For": "1.2.3.4" };
  if (origin) headers.Origin = origin;
  if (auth) headers.Authorization = auth;
  return new Request(`${ORIGIN}/relay/${route}`, { method, headers, body: method === "POST" ? body : undefined });
}

test("the relay forwards the caller's key and body to the fixed upstream, and nothing else", async () => {
  const { relay, ROUTES } = await load(RELAY);
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, init }); return new Response('{"ok":1}', { status: 200, headers: { "Content-Type": "application/json", "Set-Cookie": "x=1" } }); };
  const res = await relay(req("typesafe/systemone", { body: '{"q":1}' }), { fetchImpl });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '{"ok":1}');
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("set-cookie"), null);
  assert.equal(seen[0].url, ROUTES["typesafe/systemone"]);
  assert.deepEqual(Object.keys(seen[0].init.headers).sort(), ["Authorization", "Content-Type", "User-Agent"]);
  assert.equal(seen[0].init.headers.Authorization, "Bearer abcdefgh12345");
  assert.equal(Buffer.from(seen[0].init.body).toString(), '{"q":1}');
});

test("the relay refuses other routes, other methods, other origins, and requests without a key", async () => {
  const { relay } = await load(RELAY);
  const fetchImpl = async () => { throw new Error("must not be called"); };
  assert.equal((await relay(req("evil/thing"), { fetchImpl })).status, 404);
  assert.equal((await relay(req("typesafe/systemone", { method: "GET" }), { fetchImpl })).status, 405);
  assert.equal((await relay(req("typesafe/systemone", { origin: "https://elsewhere.example" }), { fetchImpl })).status, 403);
  assert.equal((await relay(req("typesafe/systemone", { origin: null }), { fetchImpl })).status, 403);
  assert.equal((await relay(req("typesafe/systemone", { auth: null }), { fetchImpl })).status, 401);
  assert.equal((await relay(req("typesafe/systemone", { body: "x".repeat(600 * 1024) }), { fetchImpl })).status, 413);
});

test("the relay is off until the Pages project turns it on", async () => {
  const { onRequest } = await load(RELAY);
  assert.equal((await onRequest({ request: req("typesafe/systemone"), env: {} })).status, 404);
});

test("the relay never logs: no console call in its source", () => {
  const src = fs.readFileSync(path.join(root, RELAY), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(src, /console\./);
});

test("the client and the relay route to the same three upstreams", async () => {
  const { ROUTES: relayRoutes } = await load(RELAY);
  const { ROUTES: clientRoutes, TARGETS } = await load("public/jev-attributes/client.mjs");
  assert.deepEqual(clientRoutes, relayRoutes);
  for (const t of Object.values(TARGETS)) assert.ok(t.route in relayRoutes);
});

test("the secured key is the HMAC of its parameters, restricted to the Factbook names, analytics off, with an expiry", async () => {
  const { securedKey, securedParams, validUntilIn } = await load("scripts/factbook-secured-key.mjs");
  const validUntil = validUntilIn(90, Date.UTC(2026, 9, 1));
  assert.equal(validUntil, Date.UTC(2026, 11, 30) / 1000);
  const params = securedParams({ validUntil });
  const q = new URLSearchParams(params);
  assert.equal(q.get("restrictIndices"), "demo_factbook,esci_demo_factbook");
  assert.equal(q.get("analytics"), "false");
  assert.equal(q.get("validUntil"), String(validUntil));
  assert.throws(() => validUntilIn(0));
  assert.throws(() => validUntilIn(Number.NaN));
  const key = securedKey("parent-key", params);
  const decoded = Buffer.from(key, "base64").toString();
  assert.equal(decoded.slice(0, 64), createHmac("sha256", "parent-key").update(params).digest("hex"));
  assert.equal(decoded.slice(64), params);
  assert.ok(!decoded.includes("parent-key"));
});

test("the secured key derives only from a search-only parent", async () => {
  const { searchOnly } = await load("scripts/factbook-secured-key.mjs");
  assert.ok(searchOnly(["search"]));
  assert.ok(!searchOnly(["search", "browse"]));
  assert.ok(!searchOnly(["addObject"]));
  assert.ok(!searchOnly([]));
  assert.ok(!searchOnly(undefined));
});

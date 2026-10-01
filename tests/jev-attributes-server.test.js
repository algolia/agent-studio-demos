/* jev-attributes: the local server's Host gate. In LOCAL mode a relay call
   without a key gets the owner's key, so a DNS-rebinding page (evil.example
   resolving to 127.0.0.1) must be refused on its Host header before any key
   is looked up, and the server must refuse to bind anything but loopback. */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const SERVER = path.join(__dirname, "..", "tools", "jev-attributes", "server.mjs");
const load = () => import(pathToFileURL(SERVER).href);

/** one request with a Host header of our choosing (fetch will not set Host) */
function call(port, { host, method = "GET", url = "/api/status", headers = {}, body = null }) {
  return new Promise((ok, fail) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: url, headers: { Host: host, ...headers } }, (res) => {
      let text = "";
      res.on("data", (c) => { text += c; });
      res.on("end", () => ok({ status: res.statusCode, text }));
    });
    req.on("error", fail);
    if (body) req.write(body);
    req.end();
  });
}

async function listening(opts) {
  const { createServer } = await load();
  const server = createServer(opts);
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return { server, port: server.address().port };
}

test("isLoopback and the Host allowlist name loopback only", async () => {
  const { isLoopback, hostAllowed } = await load();
  for (const h of ["127.0.0.1", "127.1.2.3", "localhost", "::1", "[::1]"]) assert.ok(isLoopback(h), h);
  for (const h of ["0.0.0.0", "192.168.1.5", "::", "evil.example", "127.0.0.1.evil.example", ""]) assert.ok(!isLoopback(h), h);
  assert.ok(hostAllowed("127.0.0.1:8795", 8795));
  assert.ok(hostAllowed("localhost:8795", 8795));
  assert.ok(!hostAllowed("localhost:8796", 8795), "another port");
  assert.ok(!hostAllowed("localhost", 8795), "no port");
  assert.ok(!hostAllowed("evil.example:8795", 8795));
  assert.ok(!hostAllowed(undefined, 8795));
});

test("LOCAL: a rebinding Host is refused before any key is looked up", async () => {
  let minted = 0;
  const { server, port } = await listening({
    mode: "local", keys: { jev: { JEV_API_KEY: "owner-jev-key-000" } }, mint: async () => { minted += 1; return "owner-token-000"; },
  });
  try {
    const evil = `evil.example:${port}`;
    assert.equal((await call(port, { host: evil })).status, 403);
    for (const route of ["typesafe/systemone", "enablers/chat/completions"]) {
      const r = await call(port, {
        host: evil, method: "POST", url: `/relay/${route}`, body: "{}",
        headers: { Origin: `http://${evil}`, "Content-Type": "application/json" },
      });
      assert.equal(r.status, 403, route);
      assert.doesNotMatch(r.text, /owner-/);
    }
    assert.equal((await call(port, { host: evil, url: "/jev-attributes/" })).status, 403);
    assert.equal(minted, 0, "no token minted for a refused host");
  } finally {
    server.close();
  }
});

test("LOCAL: loopback Hosts are served", async () => {
  const { server, port } = await listening({ mode: "local", keys: {}, mint: async () => { throw new Error("no vault in tests"); } });
  try {
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
      const r = await call(port, { host });
      assert.equal(r.status, 200, host);
      assert.equal(JSON.parse(r.text).mode, "local");
    }
  } finally {
    server.close();
  }
});

test("LOCAL refuses to start on a non-loopback interface", () => {
  const r = spawnSync(process.execPath, [SERVER], {
    env: { ...process.env, HOST: "0.0.0.0", PORT: "0", JEV_KEYS_FILE: "/nonexistent", FACTBOOK_KEYS_FILE: "/nonexistent" },
    timeout: 10000, encoding: "utf8",
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /loopback only/);
});

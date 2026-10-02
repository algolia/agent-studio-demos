/* jev-attributes: the page's Content-Security-Policy (public/_headers). */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { pathToFileURL } = require("node:url");

const root = path.join(__dirname, "..");
const load = (f) => import(pathToFileURL(path.join(root, f)).href);
const SERVER = "tools/jev-attributes/server.mjs";

async function policy() {
  const { parseHeaders, headersFor } = await load(SERVER);
  const rules = parseHeaders(fs.readFileSync(path.join(root, "public", "_headers"), "utf8"));
  const csp = headersFor("/jev-attributes/", rules)["Content-Security-Policy"];
  assert.ok(csp, "a CSP for /jev-attributes/");
  const dirs = Object.fromEntries(csp.split(";").map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
  return { rules, headersFor, dirs };
}

test("the page may not be framed, and loads code from itself and jsDelivr only", async () => {
  const { dirs, headersFor, rules } = await policy();
  assert.deepEqual(dirs["frame-ancestors"], ["'none'"]);
  assert.deepEqual(dirs["default-src"], ["'none'"]);
  assert.deepEqual(dirs["object-src"], ["'none'"]);
  assert.deepEqual(dirs["base-uri"], ["'none'"]);
  assert.ok(!dirs["script-src"].includes("'unsafe-inline'") && !dirs["script-src"].includes("'unsafe-eval'"));
  assert.ok(!dirs["script-src"].includes("blob:") && !dirs["script-src"].includes("data:"));
  assert.ok(dirs["script-src"].includes("https://cdn.jsdelivr.net"));
  assert.deepEqual(dirs["worker-src"], ["'self'"]);
  for (const host of ["'self'", "https://*.algolia.net", "https://huggingface.co", "https://cdn.jsdelivr.net"]) {
    assert.ok(dirs["connect-src"].includes(host), host);
  }
  // the worker is served under the same rule, so it runs under the same policy
  assert.equal(headersFor("/jev-attributes/embed-worker.mjs", rules)["Content-Security-Policy"], headersFor("/jev-attributes/", rules)["Content-Security-Policy"]);
  assert.equal(headersFor("/chat-with-book/", rules)["Content-Security-Policy"], undefined, "the other demos are untouched");
});

test("every inline script in the page is allowed by its hash", async () => {
  const { dirs } = await policy();
  const html = fs.readFileSync(path.join(root, "public", "jev-attributes", "index.html"), "utf8");
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(inline.length >= 1);
  for (const body of inline) {
    const hash = `'sha256-${createHash("sha256").update(body).digest("base64")}'`;
    assert.ok(dirs["script-src"].includes(hash), `inline script changed: put ${hash} in public/_headers`);
  }
  assert.doesNotMatch(html, /\son[a-z]+=/i, "no inline event handlers: the CSP blocks them");
});

test("the local server sends the same headers and does not serve _headers", async () => {
  const { createServer } = await load(SERVER);
  const server = createServer({ mode: "public" });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const port = server.address().port;
  const get = (p) => new Promise((ok, fail) => http.get({ host: "127.0.0.1", port, path: p }, (res) => { res.resume(); ok(res); }).on("error", fail));
  try {
    const page = await get("/jev-attributes/");
    assert.equal(page.statusCode, 200);
    assert.match(page.headers["content-security-policy"], /frame-ancestors 'none'/);
    assert.equal(page.headers["x-frame-options"], "DENY");
    assert.equal((await get("/_headers")).statusCode, 404);
  } finally {
    server.close();
  }
});

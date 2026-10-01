#!/usr/bin/env node
/* ───────────────────────────────────────────────────────────────
   server.mjs — the jev-attributes demo on this machine.

     node tools/jev-attributes/server.mjs            # LOCAL: the maintainer's keys
     node tools/jev-attributes/server.mjs --public   # PUBLIC: as deployed, visitors' keys
     PORT=8800 node tools/jev-attributes/server.mjs

   Both modes serve public/ and the relay at /relay/<route>, which is the
   very `relay()` the deployed Pages Function runs. The page does the rest:
   it searches, asks each engine, and streams every lane itself.

   LOCAL adds what a visitor would bring: when a /relay request carries no
   Authorization header, the owner's key goes on it here (Jev from
   JEV_API_KEY, Enablers minted from the Vault login, re-minted once on a
   401). It also answers /api/status (how the page knows it is local) and
   /api/search (Algolia with the owner's search key, else factbook.jsonl).
   It never serves shared/config.js.

   PUBLIC adds nothing: no key, no /api. It serves shared/config.js, as the
   deployed site does, so the page finds its secured search key there.

   No key is ever written to a response or a log.
   ─────────────────────────────────────────────────────────────── */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { load, describe } from "./keys.mjs";
import { search } from "./algolia.mjs";
import { relay, MAX_BODY } from "../../functions/relay/[[path]].js";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "public");
const PORT = Number(process.env.PORT || 8795);
const HOST = process.env.HOST || "127.0.0.1";
const MODE = process.argv.includes("--public") ? "public" : "local";
const MAX_QUESTION = 300;

const algolia = MODE === "local" ? load("algolia") : {};
const jev = MODE === "local" ? load("jev") : {};
const searchKeys = { app: algolia.ESCI_APP, key: algolia.ESCI_READ };

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".txt": "text/plain; charset=utf-8", ".ico": "image/x-icon",
};

/* ── the owner's Enablers token, LOCAL only ───────────────────── */

let token = null;
function mint() {
  const tier = process.env.ENABLERS_VAULT_TIER || "enablers";
  return new Promise((ok, fail) => {
    execFile("vault", ["read", "-field=token", `identity/oidc/token/${tier}`], { timeout: 15000 }, (err, stdout) => {
      const t = String(stdout || "").trim();
      if (err || !t) fail(new Error("Vault mint failed: run `vault login -method=oidc`"));
      else ok(t);
    });
  });
}
async function ownerKey(route, fresh) {
  if (route.startsWith("typesafe/")) return jev.JEV_API_KEY || null;
  if (!token || fresh) token = await mint();
  return token;
}

/* ── static ───────────────────────────────────────────────────── */

function serveStatic(req, res) {
  const u = new URL(req.url, "http://x");
  let rel = decodeURIComponent(u.pathname);
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  const isConfig = /(^|\/)config\.js$/.test(rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep) || (isConfig && MODE === "local")) return send(res, 404, "not found");
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      if (!err && st.isDirectory()) { res.writeHead(301, { Location: `${u.pathname}/` }); return res.end(); }
      return send(res, 404, "not found");
    }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    fs.createReadStream(file).pipe(res);
  });
}

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { fail(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => ok(Buffer.concat(chunks)));
    req.on("error", fail);
  });
}

/* ── the relay, with the owner's key added in LOCAL mode ──────── */

async function relayNode(req, res) {
  let body;
  try { body = await readBody(req); } catch (_) { return send(res, 413, "body too large"); }
  const ctl = new AbortController();
  res.on("close", () => ctl.abort());
  const route = new URL(req.url, "http://x").pathname.replace(/^\/relay\//, "");
  const base = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") base.set(k, v);
  const injected = MODE === "local" && !base.has("authorization");

  const once = async (fresh) => {
    const headers = new Headers(base);
    if (injected) {
      const key = await ownerKey(route, fresh).catch(() => null);
      if (key) headers.set("Authorization", `Bearer ${key}`);
    }
    return relay(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers, body: req.method === "POST" ? body : undefined, signal: ctl.signal }));
  };
  let r = await once(false);
  if (r.status === 401 && injected && !route.startsWith("typesafe/")) r = await once(true);

  const headers = Object.fromEntries(r.headers);
  res.writeHead(r.status, headers);
  if (!r.body) return res.end();
  Readable.fromWeb(r.body).on("error", () => res.end()).pipe(res);
}

/* ── LOCAL api ────────────────────────────────────────────────── */

async function apiSearch(req, res) {
  const q = String(new URL(req.url, "http://x").searchParams.get("q") || "").trim().slice(0, MAX_QUESTION);
  if (!q) return send(res, 400, { error: "empty question" }, "application/json");
  try {
    send(res, 200, await search(searchKeys, q), "application/json");
  } catch (err) {
    send(res, 502, { error: err.message }, "application/json");
  }
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname.startsWith("/relay/")) return void relayNode(req, res);
  if (MODE === "local" && u.pathname === "/api/status") {
    return send(res, 200, {
      mode: "local",
      ready: { jev: Boolean(jev.JEV_API_KEY), search: Boolean(searchKeys.app && searchKeys.key), enablers: "vault" },
    }, "application/json");
  }
  if (MODE === "local" && u.pathname === "/api/search" && req.method === "GET") return void apiSearch(req, res);
  if (u.pathname === "/") { res.writeHead(302, { Location: "/jev-attributes/" }); return res.end(); }
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "method not allowed");
  serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`jev-attributes ${MODE.toUpperCase()} on http://${HOST}:${PORT}/jev-attributes/ (pid ${process.pid})`);
  if (MODE === "local") console.log(`keys: ${describe(algolia)}, ${describe(jev)}; Enablers via Vault`);
  else console.log("no key on this server: the page asks the visitor for theirs");
});

#!/usr/bin/env node
/* ───────────────────────────────────────────────────────────────
   server.mjs — the jev-attributes demo on this machine.

     node tools/jev-attributes/server.mjs            # LOCAL: the maintainer's keys
     node tools/jev-attributes/server.mjs --public   # PUBLIC: as deployed, visitors' keys
     PORT=8800 node tools/jev-attributes/server.mjs

   Both modes serve public/ and the relay at /relay/<route>, which is the
   very `relay()` the deployed Pages Function runs. The page does the rest:
   it searches, asks Jev, and draws the record.

   LOCAL adds what a visitor would bring: when a /relay request carries no
   Authorization header, the owner's Jev key (JEV_API_KEY) goes on it here.
   It also answers /api/status (how the page knows it is local), /api/search
   and /api/object (Algolia with the owner's search key, else
   factbook.jsonl).
   It never serves shared/config.js. It binds loopback only, and answers 403
   to any Host header but 127.0.0.1, localhost or [::1] on its own port.

   PUBLIC adds nothing: no key, no /api. It serves shared/config.js, as the
   deployed site does, so the page finds its secured search key there.

   No key is ever written to a response or a log.
   ─────────────────────────────────────────────────────────────── */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { load, describe } from "./keys.mjs";
import { search, getObject } from "./algolia.mjs";
import { relay, MAX_BODY } from "../../functions/relay/[[path]].js";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "public");
const MAX_QUESTION = 300;

/* ── who may talk to this server ──────────────────────────────────
   In LOCAL mode a request without a key gets the owner's key. The relay's
   Origin check compares Origin with the Host the browser sent, and a
   DNS-rebinding page controls both: evil.example resolves to 127.0.0.1, the
   browser sends `Host: evil.example:8795` and the matching Origin. So the
   Host header is checked first, against the loopback names only, and the
   server refuses to start in LOCAL mode on any other interface. */

/** 127.0.0.0/8, ::1 and localhost: the only addresses LOCAL mode binds */
export function isLoopback(host) {
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

/** the Host headers a page served by this machine sends, and no other */
export function allowedHosts(port) {
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
}

export function hostAllowed(host, port) {
  return typeof host === "string" && allowedHosts(port).includes(host.toLowerCase());
}

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".txt": "text/plain; charset=utf-8", ".ico": "image/x-icon",
};

/* ── static ───────────────────────────────────────────────────── */

/**
 * Cloudflare Pages' `_headers` format: a path pattern at the start of a line
 * (`*` matches anything, empty included), then indented `Name: value` lines.
 * Every rule whose pattern matches applies.
 */
export function parseHeaders(text) {
  const rules = [];
  for (const line of String(text).split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      const glob = line.trim().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      rules.push({ pattern: new RegExp(`^${glob}$`), headers: {} });
      continue;
    }
    const m = line.trim().match(/^([^:]+):\s*(.*)$/);
    if (m && rules.length) rules[rules.length - 1].headers[m[1]] = m[2];
  }
  return rules;
}

const HEADER_RULES = parseHeaders(fs.existsSync(path.join(PUBLIC_DIR, "_headers")) ? fs.readFileSync(path.join(PUBLIC_DIR, "_headers"), "utf8") : "");

export function headersFor(pathname, rules = HEADER_RULES) {
  return Object.assign({}, ...rules.filter((r) => r.pattern.test(pathname)).map((r) => r.headers));
}

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function serveStatic(req, res, mode) {
  const u = new URL(req.url, "http://x");
  let rel = decodeURIComponent(u.pathname);
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  const isConfig = /(^|\/)config\.js$/.test(rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep) || (isConfig && mode === "local") || rel === "/_headers") return send(res, 404, "not found");
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      if (!err && st.isDirectory()) { res.writeHead(301, { Location: `${u.pathname}/` }); return res.end(); }
      return send(res, 404, "not found");
    }
    res.writeHead(200, { ...headersFor(u.pathname), "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    fs.createReadStream(file).pipe(res);
  });
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

/**
 * The server, not yet listening. `keys` is { algolia, jev } as keys.mjs loads
 * them; they matter in LOCAL mode only.
 */
export function createServer({ mode = "local", keys = {} } = {}) {
  const jev = keys.jev || {};
  const algolia = keys.algolia || {};
  const searchKeys = { app: algolia.ESCI_APP, key: algolia.ESCI_READ };

  /* the owner's key for a route: Jev's, for the one route the relay has */
  const ownerKey = (route) => (route.startsWith("typesafe/") ? jev.JEV_API_KEY || null : null);

  /* the relay, with the owner's key added in LOCAL mode */
  async function relayNode(req, res) {
    let body;
    try { body = await readBody(req); } catch (_) { return send(res, 413, "body too large"); }
    const ctl = new AbortController();
    res.on("close", () => ctl.abort());
    const route = new URL(req.url, "http://x").pathname.replace(/^\/relay\//, "");
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const key = mode === "local" && !headers.has("authorization") ? ownerKey(route) : null;
    if (key) headers.set("Authorization", `Bearer ${key}`);
    const r = await relay(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers, body: req.method === "POST" ? body : undefined, signal: ctl.signal }));

    res.writeHead(r.status, Object.fromEntries(r.headers));
    if (!r.body) return res.end();
    Readable.fromWeb(r.body).on("error", () => res.end()).pipe(res);
  }

  async function apiSearch(req, res) {
    const sp = new URL(req.url, "http://x").searchParams;
    const q = String(sp.get("q") || "").trim().slice(0, MAX_QUESTION);
    const kind = sp.get("kind") === "records" ? "records" : "fields";
    if (!q) return send(res, 400, { error: "empty question" }, "application/json");
    try {
      send(res, 200, await search(searchKeys, q, kind), "application/json");
    } catch (err) {
      send(res, 502, { error: err.message }, "application/json");
    }
  }

  async function apiObject(req, res) {
    const id = String(new URL(req.url, "http://x").searchParams.get("id") || "");
    if (!/^[A-Za-z0-9_-]{1,16}$/.test(id)) return send(res, 400, { error: "bad objectID" }, "application/json");
    try {
      send(res, 200, await getObject(searchKeys, id), "application/json");
    } catch (err) {
      send(res, 502, { error: err.message }, "application/json");
    }
  }

  return http.createServer((req, res) => {
    // first, before anything reads the request: a rebinding name never reaches the keys
    if (mode === "local" && !hostAllowed(req.headers.host, req.socket.localPort)) return send(res, 403, "loopback hosts only");
    const u = new URL(req.url, "http://x");
    if (u.pathname.startsWith("/relay/")) return void relayNode(req, res);
    if (mode === "local" && u.pathname === "/api/status") {
      return send(res, 200, {
        mode: "local",
        ready: { jev: Boolean(jev.JEV_API_KEY), search: Boolean(searchKeys.app && searchKeys.key) },
      }, "application/json");
    }
    if (mode === "local" && u.pathname === "/api/search" && req.method === "GET") return void apiSearch(req, res);
    if (mode === "local" && u.pathname === "/api/object" && req.method === "GET") return void apiObject(req, res);
    if (u.pathname === "/") { res.writeHead(302, { Location: "/jev-attributes/" }); return res.end(); }
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "method not allowed");
    serveStatic(req, res, mode);
  });
}

function main() {
  const port = Number(process.env.PORT || 8795);
  const host = process.env.HOST || "127.0.0.1";
  const mode = process.argv.includes("--public") ? "public" : "local";
  if (mode === "local" && !isLoopback(host)) {
    console.error(`LOCAL mode adds the owner's keys, so it binds loopback only: HOST=${host} refused. Use --public, or HOST=127.0.0.1.`);
    process.exit(1);
  }
  const keys = mode === "local" ? { algolia: load("algolia"), jev: load("jev") } : {};
  const server = createServer({ mode, keys });
  server.listen(port, host, () => {
    console.log(`jev-attributes ${mode.toUpperCase()} on http://${host}:${port}/jev-attributes/ (pid ${process.pid})`);
    if (mode === "local") console.log(`keys: ${describe(keys.algolia)}, ${describe(keys.jev)}`);
    else console.log("no key on this server: the page asks the visitor for theirs");
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
